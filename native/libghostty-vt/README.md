# Pinned libghostty-vt archives

Source: https://github.com/ghostty-org/ghostty at `c3203ea4b169a18eb2ccfe92847e426d8afea858`.
License: MIT. The upstream license is in `LICENSE`.

The module includes the static archives, headers, and `manifest.json`.
A normal CGO build links the archive for its target. No special build tag is necessary.
Source installation requires Go and a supported C compiler. It does not require Zig or an external Ghostty installation.
The root `phi` server retains its pure-Go build path.

```sh
go build .
go build -o phic ./cmd/phic
go install ./cmd/phic
```

A client built with `CGO_ENABLED=0` cannot run the console.
That client reports the missing build requirement before it enters fullscreen.
Help and version commands remain available.
The client never downloads a native library at runtime or substitutes another emulator.

## Maintainer reproduction

Library reproduction requires Zig `0.16.0`. Application builds use the committed archives.

```sh
git clone https://github.com/ghostty-org/ghostty
cd ghostty
git checkout c3203ea4b169a18eb2ccfe92847e426d8afea858
zig build -Demit-lib-vt -Demit-xcframework=false -Doptimize=ReleaseSafe
```

Cross-target builds add `-Dtarget=TARGET -Dcpu=baseline`.
The targets are `x86_64-macos`, `x86_64-linux-gnu`, `aarch64-linux-gnu`, and `x86_64-windows`.
The Windows archive keeps its COFF contents under the `.a` suffix that CGO accepts.
Headers and archives must come from the same pin.
The manifest records each checksum, compiler, target, and build flags.

## Build evidence

| Target | Native client links | Runtime evidence |
|---|---|---|
| macOS arm64 | Yes, default Go build | Six installed backend presentations in an isolated native console |
| macOS amd64 | Yes, Apple Clang cross-build | Not run |
| Linux amd64 | Yes, Zig C cross-build | Not run locally |
| Linux arm64 | Yes, Zig C cross-build | Not run locally |
| Windows amd64 | Yes, Zig C cross-build | Windows Terminal runtime remains open |

The former CGO-disabled cross-builds only proved the unsupported-adapter path.
They did not prove a usable console binary.
Windows arm64 has no archive or runtime proof.
Release packaging remains a separate gate. In particular, the old CGO-disabled release job must not publish this console.
