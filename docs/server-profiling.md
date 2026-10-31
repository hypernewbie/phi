# Go server diagnostics

Phi's Go process can publish a private, opt-in diagnostics listener. It is separate from the application listener and binds only to IPv4 loopback. Diagnostics are disabled unless `--diagnostics-dir` is set.

## Start

The selected parent directory must exist and must be an absolute path. Phi creates one private `phi-diag-*` directory for the process. It writes the listener URL and a curl configuration with a random bearer token into that directory. The session directory is mode `0700`; its files are mode `0600`.

```bash
mkdir -p /tmp/phi-diagnostics
phi --diagnostics-dir=/tmp/phi-diagnostics
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

RSS and Go heap values overlap. Do not add them together. The existing `/api/diag` and `/api/system/cpu` application endpoints are unchanged; `/api/system/cpu` reports host CPU, not Phi process CPU.

For snapshots from the same `pid`, `started_at`, and build, calculate CPU over an interval as:

```text
cpu_seconds = second.process.cpu_total_seconds - first.process.cpu_total_seconds
elapsed_seconds = second.elapsed_seconds - first.elapsed_seconds
percent_of_one_core = 100 * cpu_seconds / elapsed_seconds
```

Require `elapsed_seconds > 0` and a nondecreasing CPU counter. Do not divide by the number of cores or clamp the result: it is process CPU as a percentage of one core, not host CPU percentage.

The optional `ownership` object reports known live/archive pane owners and three separate measures: `ring_capacity_bytes` (allocated backing capacity), `checkpoint_capacity_bytes` (retained ANSI checkpoint capacity), and `wasm_linear_bytes` (addressable WASM memory). These values are not additive and are not RSS estimates. `complete=false` means the view skipped one or more busy owners; check `skipped_owner_count`. A busy hub returns null counters and `reason="hub_busy"`. A missing hub returns `ownership: null`.

## Capture profiles

Profiles are captured to a mode-`0600` temporary file in the private session directory, then sent to the authenticated local client and removed. Only one profile capture can run at a time. Each profile is limited to 64 MiB. A slow or disconnected client cannot keep the server writing indefinitely. Server shutdown cancels an active CPU capture.

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
