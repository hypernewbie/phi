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
    darwin-arm64) ghostty_target=aarch64-macos; object_format='Mach-O arm64' ;;
    darwin-amd64) ghostty_target=x86_64-macos; object_format='Mach-O 64-bit x86-64' ;;
    linux-amd64) ghostty_target=x86_64-linux-gnu; object_format=elf64-x86-64 ;;
    linux-arm64) ghostty_target=aarch64-linux-gnu; object_format=elf64-littleaarch64 ;;
    windows-amd64) ghostty_target=x86_64-windows-gnu; object_format=COFF-x86-64 ;;
    *) echo "unknown target: $target_id" >&2; exit 1 ;;
esac
actual_rev=$(git -C "$source_dir" rev-parse HEAD)
test "$actual_rev" = "$PIN" || { echo "source revision $actual_rev != $PIN" >&2; exit 1; }
actual_zig=$("$zig_bin" version)
test "$actual_zig" = "$REQUIRED_ZIG" || { echo "zig $actual_zig != $REQUIRED_ZIG" >&2; exit 1; }
python3 "$root/internal/termstate/patch-ghostty-vt.py" "$source_dir"
allowed_modified="src/terminal/c/formatter.zig src/terminal/c/main.zig src/lib_vt.zig src/terminal/snapshot/snapshot.zig src/terminal/c/snapshot.zig include/ghostty/vt/formatter.h include/ghostty/vt/snapshot.h"
allowed_untracked="src/terminal/c/phi_format.zig"
staging=$(mktemp -d /tmp/ghostty-vt-build.XXXXXX)
tmp_archive=
cleanup() {
    rm -rf "$staging"
    if test -n "$tmp_archive"; then rm -f "$tmp_archive"; fi
}
trap cleanup 0
trap 'exit 1' 1 2 15
status_file="$staging/status.txt"
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
llvm-readobj --file-headers "$staged_archive" > "$staging/headers.txt"
formats=$(awk '/^Format: / { sub(/^Format: /, ""); print }' "$staging/headers.txt" | sort -u)
test "$formats" = "$object_format" || { echo "unexpected object format: $formats (want $object_format)" >&2; exit 1; }
llvm-nm --defined-only --extern-only "$staged_archive" > "$staging/symbols.txt"
for symbol in ghostty_phi_state_format_alloc ghostty_snapshot_encode_ready_alloc ghostty_formatter_terminal_screen_new; do
    grep -Eq "[[:space:]]_?${symbol}$" "$staging/symbols.txt" || { echo "missing export $symbol" >&2; exit 1; }
done
# Validate headers before replacing the installed archive. A failure must
# leave the previous archive and manifest intact.
repo_include="$root/native/libghostty-vt/include/ghostty/vt"
for header in formatter.h snapshot.h; do
    cmp -s "$source_dir/include/ghostty/vt/$header" "$repo_include/$header" || { echo "$header differs from pinned headers" >&2; exit 1; }
done
dest_dir="$root/native/libghostty-vt/$target_id"
dest_archive="$dest_dir/libghostty-vt.a"
tmp_archive=$(mktemp "$dest_dir/.libghostty-vt.a.XXXXXX")
cp "$staged_archive" "$tmp_archive"
chmod 644 "$tmp_archive"
mv "$tmp_archive" "$dest_archive"
echo "built $target_id: $dest_archive"
