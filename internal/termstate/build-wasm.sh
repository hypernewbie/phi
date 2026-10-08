#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
source_dir=$(CDPATH= cd -- "${1:?path to pinned Ghostty source required}" && pwd)
zig_bin=${2:-zig}
case "$zig_bin" in
    /*) ;;
    */*) zig_bin=$(CDPATH= cd -- "$(dirname -- "$zig_bin")" && pwd)/$(basename -- "$zig_bin");;
    *) zig_bin=$(command -v "$zig_bin");;
esac
python3 "$root/internal/termstate/patch-ghostty-vt.py" "$source_dir"
(
    cd "$source_dir"
    "$zig_bin" build -Demit-lib-vt=true -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast -Dlib-version-string=0.1.0
)
cp "$source_dir/zig-out/bin/ghostty-vt.wasm" "$root/internal/termstate/ghostty-vt.wasm"
