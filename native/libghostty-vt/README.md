# Pinned libghostty-vt archives

Source: https://github.com/ghostty-org/ghostty at `c3203ea4b169a18eb2ccfe92847e426d8afea858`.
License: MIT. The upstream license is in `LICENSE`.

The module includes the static archives, headers, and `manifest.json`.
A normal CGO build links the archive for its target. No special build tag is necessary.
Source installation requires Go and a supported C compiler. It does not require Zig or an external Ghostty installation.
Both `phi` and `phic` link this archive; CGO is mandatory for either binary.

```sh
go build .
go build -o phic ./cmd/phic
go install ./cmd/phic
```

Unsupported targets fail at compile time; there is no emulator-disabled fallback.
Neither binary downloads a native library at runtime or substitutes another emulator.
Windows source builds use `zig cc -target x86_64-windows-gnu` as the C compiler.

## Maintainer reproduction

Library reproduction requires Zig `0.16.0`, Python 3, `llvm-nm`, and `llvm-readobj`.
Application builds use the committed archives.

From the Phi repository, run:

```sh
git clone https://github.com/ghostty-org/ghostty ../ghostty-vt
git -C ../ghostty-vt checkout c3203ea4b169a18eb2ccfe92847e426d8afea858
native/libghostty-vt/build.sh ../ghostty-vt "$(command -v zig)" darwin-arm64
```

Repeat the last command with each target ID:
`darwin-arm64`, `darwin-amd64`, `linux-amd64`, `linux-arm64`, and `windows-amd64`.
The builder selects the target and baseline CPU flags, checks the pin and Zig version, and applies the Phi patch.
Before installation, it checks the object architecture, patched exports, and headers.
A failed check keeps the previous archive and manifest intact.
A plain upstream `zig build` does not include the required Phi exports.
The Windows archive keeps its COFF contents under the `.a` suffix that CGO accepts.
Headers and archives must come from the same pin.
The manifest records each checksum, compiler, target, and build flags.

## Build evidence

| Target | Server and client link evidence | Runtime evidence |
|---|---|---|
| macOS arm64 | Default Go build | Engine tests, browser attach/history, native client attach |
| macOS amd64 | Apple Clang cross-build | Not run locally |
| Linux amd64 | Zig C cross-build | Not run locally |
| Linux arm64 | Zig C cross-build | Not run locally |
| Windows amd64 | Zig C cross-build | Native Windows runtime awaits CI |

CGO-disabled builds do not provide a usable server or console.
Windows arm64 has no archive or runtime proof.
Release packaging remains a separate gate.
