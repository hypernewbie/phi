# windows amd64

Build a `GhosttyStatic` Windows consumer with `zig build -Demit-lib-vt -Dtarget=x86_64-windows -Doptimize=ReleaseSafe` from the pinned source. The Windows consumer archive is named `ghostty-vt-static.lib` and is what the Go adapter's `cgo_windows.go` directives reference.