#!/bin/bash
# Rebuilds Vendor/ghostty-vt.xcframework for macOS, iOS and the iOS simulator.
#
# The committed xcframework is what the apps link; this script only reproduces
# it. Requires Zig 0.16.0 and Xcode's iOS SDK.
set -euo pipefail

PIN=c3203ea4b169a18eb2ccfe92847e426d8afea858
ZIG_VERSION=0.16.0
WORK=${WORK:-/tmp/phi-ghostty}
ROOT=$(cd "$(dirname "$0")/.." && pwd)

if ! command -v zig >/dev/null 2>&1; then
  echo "zig $ZIG_VERSION is required (https://ziglang.org/download/$ZIG_VERSION/)" >&2
  exit 1
fi
if [ "$(zig version)" != "$ZIG_VERSION" ]; then
  echo "zig $ZIG_VERSION is required, found $(zig version)" >&2
  exit 1
fi

mkdir -p "$WORK"
if [ ! -d "$WORK/ghostty/.git" ]; then
  git init -q "$WORK/ghostty"
  git -C "$WORK/ghostty" remote add origin https://github.com/ghostty-org/ghostty
fi
git -C "$WORK/ghostty" fetch -q --depth 1 origin "$PIN"
git -C "$WORK/ghostty" checkout -q FETCH_HEAD

cd "$WORK/ghostty"
zig build -Demit-lib-vt -Demit-xcframework=true -Doptimize=ReleaseSafe

rm -rf "$ROOT/Vendor/ghostty-vt.xcframework" "$ROOT/Vendor/include"
cp -R zig-out/lib/ghostty-vt.xcframework "$ROOT/Vendor/"
cp -R zig-out/include "$ROOT/Vendor/include"
echo "updated $ROOT/Vendor/ghostty-vt.xcframework"
