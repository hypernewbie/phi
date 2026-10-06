# libghostty-vt artifacts

Source pin: https://github.com/ghostty-org/ghostty @ `c3203ea4b169a18eb2ccfe92847e426d8afea858`.
License: MIT.

Per-target static archives live in this directory. The Go adapter (`internal/termemu`) compiles against the headers in `include/` and links the matching archive through the cgo directives in `internal/termemu/ghostty_cgo.go`.

## Build contract

- Default `go build ./...` and `go test ./...` do not link the native library. The TUI then reports a precise error instead of substituting another parser.
- Native builds use `-tags=termemu_ghostty`. The linker reads the archive path for the current `GOOS/GOARCH`; a missing archive fails the link with that exact path. There is no runtime downloader and no hidden build step.
- The archives are maintainer-built and are intentionally not committed (see the repository `.gitignore`). The headers, this README, and `manifest.json` are committed. `manifest.json` records the source revision, flags, license, and the local artifact checksum for each verified target.
- Reproducing an archive requires Zig 0.16.0. Using an archive does not.

Reproduce with:

```sh
git clone https://github.com/ghostty-org/ghostty
cd ghostty
git checkout c3203ea4b169a18eb2ccfe92847e426d8afea858
zig build -Demit-lib-vt -Doptimize=ReleaseSafe
```

That emits `zig-out/lib/libghostty-vt.a` and copies the public headers under `include/ghostty/`. Move the resulting archive into this directory under the matching target subfolder (`darwin-arm64/`, `linux-amd64/`, and so on). CGO consumers then read it directly through the relative path declared in the adapter.

The Windows static consumer is `ghostty-vt-static.lib`. Building it on macOS/Linux requires Zig targeting `x86_64-windows`; the existing lab build in `temp/phic-tui-evaluation/ghostty-windows/` shows the resulting layout.

## Verified targets

| Target | Archive | Status |
|---|---|---|
| darwin-arm64 | `libghostty-vt.a` | Built and verified by `internal/termemu` conformance tests |
| darwin-amd64 | `libghostty-vt.a` | Declared; archive not yet built on this machine |
| linux-amd64 | `libghostty-vt.a` | Declared; archive not yet built on this machine |
| linux-arm64 | `libghostty-vt.a` | Declared; archive not yet built on this machine |
| windows-amd64 | `ghostty-vt-static.lib` | Declared; cross-build evaluated, runtime not verified |
