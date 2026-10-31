#!/bin/sh
set -eu
# Build one patched libghostty-vt static archive.
# Usage: build.sh <ghostty-source-dir> <zig-bin> <target-id>
# Target IDs: darwin-arm64, darwin-amd64, linux-amd64, linux-arm64, windows-amd64
PIN=c3203ea4b169a18eb2ccfe92847e426d8afea858
REQUIRED_ZIG=0.16.0
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
source_dir=$(CDPATH= cd -- "${1:?path to pinned Ghostty source required}" && pwd)
zig_bin=${2:?zig binary required}
target_id=${3:?target id required}
case "$zig_bin" in
    /*) ;;
    */*) zig_bin=$(CDPATH= cd -- "$(dirname -- "$zig_bin")" && pwd)/$(basename -- "$zig_bin");;
    *) zig_bin=$(command -v "$zig_bin");;
esac
case "$target_id" in
    darwin-arm64) ghostty_target=aarch64-macos ;;
    darwin-amd64) ghostty_target=x86_64-macos ;;
    linux-amd64) ghostty_target=x86_64-linux-gnu ;;
    linux-arm64) ghostty_target=aarch64-linux-gnu ;;
    windows-amd64) ghostty_target=x86_64-windows-gnu ;;
    *) echo "unknown target: $target_id" >&2; exit 1 ;;
esac
actual_rev=$(git -C "$source_dir" rev-parse HEAD)
test "$actual_rev" = "$PIN" || { echo "source revision $actual_rev != $PIN" >&2; exit 1; }
actual_zig=$("$zig_bin" version)
test "$actual_zig" = "$REQUIRED_ZIG" || { echo "zig $actual_zig != $REQUIRED_ZIG" >&2; exit 1; }
python3 "$root/internal/termstate/patch-ghostty-vt.py" "$source_dir"
allowed_modified="src/terminal/c/formatter.zig src/terminal/c/main.zig src/lib_vt.zig src/terminal/snapshot/snapshot.zig src/terminal/c/snapshot.zig include/ghostty/vt/formatter.h include/ghostty/vt/snapshot.h"
allowed_untracked="src/terminal/c/phi_format.zig"
status_file=$(mktemp /tmp/ghostty-vt-status.XXXXXX)
git -C "$source_dir" status --porcelain > "$status_file"
while IFS= read -r line; do
    test -n "$line" || continue
    code=$(printf '%s' "$line" | cut -c1-2)
    file=$(printf '%s' "$line" | cut -c4-)
    case "$code" in
        ' M'|'M '|'MM')
            ok=0
            for allowed in $allowed_modified; do
                if test "$file" = "$allowed"; then ok=1; fi
            done
            if test "$ok" != 1; then echo "unrelated modified file: $file" >&2; rm -f "$status_file"; exit 1; fi
            ;;
        '??')
            if test "$file" != "$allowed_untracked"; then echo "unrelated untracked file: $file" >&2; rm -f "$status_file"; exit 1; fi
            ;;
        *) echo "unexpected git status: $line" >&2; rm -f "$status_file"; exit 1 ;;
    esac
done < "$status_file"
rm -f "$status_file"
grep -q ghostty_phi_state_format_alloc "$source_dir/include/ghostty/vt/formatter.h" || { echo "missing phi_state prototype" >&2; exit 1; }
grep -q ghostty_formatter_terminal_screen_new "$source_dir/include/ghostty/vt/formatter.h" || { echo "missing screen_new prototype" >&2; exit 1; }
grep -q ghostty_snapshot_encode_ready_alloc "$source_dir/include/ghostty/vt/snapshot.h" || { echo "missing encode_ready prototype" >&2; exit 1; }
staging=$(mktemp -d /tmp/ghostty-vt-build.XXXXXX)
(
    cd "$source_dir"
    "$zig_bin" build -Demit-lib-vt=true -Demit-xcframework=false -Doptimize=ReleaseSafe -Dcpu=baseline -Dtarget="$ghostty_target" --prefix "$staging"
)
if test "$target_id" = "windows-amd64"; then
    staged_archive="$staging/lib/ghostty-vt-static.lib"
else
    staged_archive="$staging/lib/libghostty-vt.a"
fi
test -s "$staged_archive" || { echo "missing staged archive: $staged_archive" >&2; exit 1; }
symbols=$(llvm-nm --defined-only --extern-only "$staged_archive")
echo "$symbols" | grep -E -q '_?ghostty_phi_state_format_alloc' || { echo "missing export ghostty_phi_state_format_alloc" >&2; exit 1; }
echo "$symbols" | grep -E -q '_?ghostty_snapshot_encode_ready_alloc' || { echo "missing export ghostty_snapshot_encode_ready_alloc" >&2; exit 1; }
echo "$symbols" | grep -E -q '_?ghostty_formatter_terminal_screen_new' || { echo "missing export ghostty_formatter_terminal_screen_new" >&2; exit 1; }
dest_dir="$root/native/libghostty-vt/$target_id"
dest_archive="$dest_dir/libghostty-vt.a"
tmp_archive="$dest_dir/.libghostty-vt.a.tmp"
cp "$staged_archive" "$tmp_archive"
mv "$tmp_archive" "$dest_archive"
repo_include="$root/native/libghostty-vt/include/ghostty/vt"
if grep -q ghostty_phi_state_format_alloc "$repo_include/formatter.h" 2>/dev/null; then
    cmp -s "$source_dir/include/ghostty/vt/formatter.h" "$repo_include/formatter.h" || { echo "formatter.h differs across targets" >&2; exit 1; }
    cmp -s "$source_dir/include/ghostty/vt/snapshot.h" "$repo_include/snapshot.h" || { echo "snapshot.h differs across targets" >&2; exit 1; }
else
    cp "$source_dir/include/ghostty/vt/formatter.h" "$repo_include/formatter.h"
    cp "$source_dir/include/ghostty/vt/snapshot.h" "$repo_include/snapshot.h"
fi
rm -rf "$staging"
echo "built $target_id: $dest_archive"
