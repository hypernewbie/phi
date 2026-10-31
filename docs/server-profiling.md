# Go server diagnostics

Phi's Go process can publish a private, opt-in diagnostics listener. It is separate from the application listener and binds only to IPv4 loopback. Diagnostics are disabled unless `--diagnostics-dir` is set.

## Build requirement

Diagnostics exist only in binaries built with `-tags=profiling`. Normal builds accept `--diagnostics-dir` but log one rebuild warning and start no listener, create no files, and record no captures:

```bash
go build -tags=profiling -o phi-profiling .
```

Use `-tags=profiling,otel` to include OpenTelemetry as well. The tags are independent: `otel` alone does not include diagnostics. Normal release builds (`embedassets`) also exclude diagnostics; use `-tags=embedassets,profiling` after generating release assets to include both.

The build tag includes the instrumentation. The flag starts the private service. An authenticated capture request starts recording. A profiling build without the flag has no private listener or active capture, but still includes worker labels and inactive timing checks.

## Start

The selected parent directory must exist and must be an absolute path. Phi creates one private `phi-diag-*` directory for the process. It writes the listener URL and a curl configuration with a random bearer token into that directory. The session directory is mode `0700`; its files are mode `0600`.

```bash
mkdir -p /tmp/phi-diagnostics
./phi-profiling --diagnostics-dir=/tmp/phi-diagnostics
```

If setup fails, Phi logs a warning and continues without diagnostics. Relative paths are rejected before application startup. Windows is not supported. Do not share the session directory or the `client.curl` file: it contains the bearer token. Do not print the curl file into shared logs or shell history.

## Read a snapshot

Use the URL and curl configuration from the current process's session directory. Do not put the bearer token on the command line.

```bash
DIAG_DIR=/tmp/phi-diagnostics
find "$DIAG_DIR" -maxdepth 1 -type d -name 'phi-diag-*' -print
read -r -p 'Session directory from this process startup log: ' DIAG_SESSION
DIAG_URL="$(<"$DIAG_SESSION/url")"
curl --fail-with-body --max-time 5 --config "$DIAG_SESSION/client.curl" "$DIAG_URL/debug/phi" | jq
```

`GET /debug/phi` returns JSON with schema version 1:

- `process.rss_bytes`: resident bytes for the Phi process.
- `process.cpu_total_seconds`: cumulative user plus system CPU seconds for the Phi process.
- `go.heap_alloc_bytes`, `heap_inuse_bytes`, `heap_sys_bytes`, and `heap_released_bytes`: distinct Go runtime memory statistics.
- `go.stack_inuse_bytes`, `num_gc`, and `goroutines`: Go runtime state at collection time.
- `started_at`, `elapsed_seconds`, `pid`, and `build_commit`: process identity and age.
- `unavailable`: stable reason codes for process fields that could not be read. Other fields remain available.

RSS and Go heap values overlap. Do not add them together. One snapshot is served at a time; a competing request gets HTTP 503 and can retry. The existing `/api/diag` and `/api/system/cpu` application endpoints are unchanged; `/api/system/cpu` reports host CPU, not Phi process CPU.

For snapshots from the same `pid`, `started_at`, and build, calculate CPU over an interval as:

```text
cpu_seconds = second.process.cpu_total_seconds - first.process.cpu_total_seconds
elapsed_seconds = second.elapsed_seconds - first.elapsed_seconds
percent_of_one_core = 100 * cpu_seconds / elapsed_seconds
```

Require `elapsed_seconds > 0` and a nondecreasing CPU counter. Do not divide by the number of cores or clamp the result: it is process CPU as a percentage of one core, not host CPU percentage.

The optional `ownership` object reports known live/archive pane owners and three separate measures: `ring_capacity_bytes` (allocated backing capacity), `checkpoint_capacity_bytes` (retained ANSI checkpoint capacity), and `wasm_linear_bytes` (addressable WASM memory). These values are not additive and are not RSS estimates. `complete=false` means the view skipped one or more busy owners; check `skipped_owner_count`. A busy hub returns null counters and `reason="hub_busy"`. A missing hub returns `ownership: null`.

## Capture operation timings (primary flame-graph path)

Timing capture records explicit start/end intervals for API-handler requests plus fixed nested operation spans. It retains short requests that a ~100 Hz CPU sampler misses. Units are nanoseconds of handler elapsed time, which includes waits. This is not CPU usage, client latency, or an individual request timeline.

Check status first. Never start a second capture while one is active.

```bash
curl --fail-with-body --max-time 5 --config "$DIAG_SESSION/client.curl" "$DIAG_URL/debug/phi/timing/status"
# {"active":false,"capture_id":0,"schema_version":1}
```

In the first terminal, start the capture:

```bash
curl --fail-with-body --max-time 45 --config "$DIAG_SESSION/client.curl" \
  --dump-header timing.headers --output timing.pprof \
  "$DIAG_URL/debug/phi/timing?seconds=30"
```

In a second terminal, repeat the status request with the same connection variables. Wait for `active:true` and a newer `capture_id`. Run the workload before that capture becomes inactive. After the first command exits successfully, open its profile.

Duration accepts `1` through `120` seconds and defaults to 30. Only one profile or timing capture runs at a time; a competitor gets HTTP 409. Do not retry a 409: wait for the active capture to finish, then start a new one. The success headers `X-Phi-Timing-Capture-ID`, `X-Phi-Timing-Complete`, and `X-Phi-Timing-Roots-Exported` describe the delivered file. A truncated download is failed evidence even with saved headers.

Open the flame graph in the installed Go viewer:

```bash
go tool pprof -http=127.0.0.1:0 -no_browser timing.pprof
# Open the printed URL, then the flamegraph view.
```

The profile carries one `phi_timing=` JSON comment with machine-readable counts: `roots_seen/admitted/exported/dropped`, `discarded_open/invalid/capacity`, `nodes_recorded/dropped`, `root_duration_ns`, `exported_span_counts`, and `complete`. `complete=true` means no loss. An empty capture is valid: zero roots, zero duration. Partial loss never reports as zero cost; check the counters.

Each HTTP root name contains the fixed method and registered mux pattern, for example `http GET /api/version`. Raw paths, queries, headers, and IDs never become names.

The profile stores exclusive self time: each interval minus its direct children. The flame graph shows inclusive widths, which include descendant time. Do not add parent and child widths. Independent roots can overlap in time, so their sum can exceed the capture window.

Adjacent siblings are valid. Overlapping siblings or a child outside its parent makes the whole root invalid. A missing end makes the whole root open. Both types are discarded. Phi never clamps these intervals. The viewer aggregates identical paths but cannot reconstruct missing spans.

Nested coverage includes only the ten existing fixed operation names (`git.*`, `pty.spawn`, `clipboard.read`, `ws.connection`). Uninstrumented functions and unscoped background workers do not appear.

Budgets are fixed: 256 admitted roots, 4,096 nodes, depth 32 per capture. Overload discards with visible counts; capacity-limited captures favor earlier requests and are not a representative cost ranking.

## Capture profiles

CPU, heap, and goroutine profiles are drill-down tools alongside timing. They are captured to a mode-`0600` temporary file in the private session directory, then sent to the authenticated local client and removed. Only one profile capture can run at a time. Each profile is limited to 64 MiB. A slow or disconnected client cannot keep the server writing indefinitely. Server shutdown cancels an active CPU capture.

```bash
curl --fail-with-body --max-time 140 --config "$DIAG_SESSION/client.curl" \
  --output cpu.pprof \
  "$DIAG_URL/debug/pprof/profile?seconds=30"

go tool pprof -top cpu.pprof

curl --fail-with-body --max-time 30 --config "$DIAG_SESSION/client.curl" \
  --output heap.pprof \
  "$DIAG_URL/debug/pprof/heap?gc=0"
go tool pprof -top -inuse_space heap.pprof

curl --fail-with-body --max-time 30 --config "$DIAG_SESSION/client.curl" \
  --output goroutine.pprof \
  "$DIAG_URL/debug/pprof/goroutine"
go tool pprof -top goroutine.pprof
```

To compare retained heap from two captures of the same process, use the first profile as the diff base and keep the GC setting the same:

```bash
curl --fail-with-body --max-time 30 --config "$DIAG_SESSION/client.curl" --output heap-before.pprof \
  "$DIAG_URL/debug/pprof/heap?gc=0"
# Run the workload being measured.
curl --fail-with-body --max-time 30 --config "$DIAG_SESSION/client.curl" --output heap-after.pprof \
  "$DIAG_URL/debug/pprof/heap?gc=0"
PHI_BIN=/path/to/the-running-phi-binary
go tool pprof -diff_base=heap-before.pprof -top -inuse_space "$PHI_BIN" heap-after.pprof
```

The diff is sampled evidence, not exact ownership. `alloc_space` is cumulative allocation volume, not current live memory. Do not compare profiles from different PIDs or process epochs.

CPU profile duration defaults to 30 seconds and accepts `1` through `120` seconds. The heap profile accepts `gc=0` (default) or `gc=1`; `gc=1` forces a full GC and changes the process being measured. The goroutine profile accepts no query parameters. A competing capture receives HTTP 409; a profile over the size limit or a local profiler conflict returns an error instead of a partial profile.

CPU and goroutine profiles use fixed `feature` labels where available: `terminal`, `sessions`, `filesystem`, `fleet`, and `updates`. Labels are attached to worker goroutines, not individual panes, paths, sessions, or requests. Disabled workers have no samples. Heap profiles identify allocation stacks, not feature labels. Use labels only for CPU/goroutine attribution; do not interpret them as heap ownership.

```bash
go tool pprof -tags goroutine.pprof
go tool pprof -top -tagfocus='feature=terminal' cpu.pprof
```

## Stop

On normal shutdown Phi closes the private listener, cancels active captures, removes its known connection files, and removes its session directory only if it is empty. If a handler does not stop within the shutdown bound, Phi retains the directory rather than deleting files that may still be in use. Remove an abandoned directory only after confirming that its owning Phi process has exited.
