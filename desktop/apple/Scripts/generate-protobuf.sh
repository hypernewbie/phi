#!/bin/sh
# Regenerates Sources/PhiWire/Generated from proto/websocket. Maintenance
# command, not a build step: normal builds consume the committed output.
# usage: generate-protobuf.sh [--check]
set -eu

case "${1:-}" in
  "" | --check) ;;
  *)
    echo "usage: $0 [--check]" >&2
    exit 2
    ;;
esac
check="${1:-}"

script_dir=$(cd "$(dirname "$0")" && pwd)
macos_dir=$(dirname "$script_dir")
repo=$(cd "$macos_dir/../.." && pwd)
tools="$macos_dir/.tools"
out="$macos_dir/Sources/PhiWire/Generated"

protoc_zip="$tools/protoc-32.1.artifactbundle.zip"
protoc_url="https://github.com/apple/swift-protobuf/releases/download/protoc-artifactbundle-v32.1/protoc-32.1.artifactbundle.zip"
protoc_sha=3cfb7e13baac742c7f7ba2ff835d22356af18af2b8b7c4d630aacea5eb893fb3
generator="$tools/swift-protobuf"
generator_commit=3d537cb81aef272a03cb3be815439e9bf0eb3bd3

mkdir -p "$tools"
if [ ! -f "$protoc_zip" ]; then
  curl --fail --location --silent --show-error --output "$protoc_zip" "$protoc_url"
fi
printf '%s  %s\n' "$protoc_sha" "$protoc_zip" | shasum -a 256 -c - >/dev/null

case "$(uname -m)" in
  arm64) host=osx-aarch_64 ;;
  x86_64) host=osx-x86_64 ;;
  *)
    echo "unsupported host arch: $(uname -m)" >&2
    exit 1
    ;;
esac
protoc="$tools/protoc-32.1.artifactbundle/protoc-32.1-$host/bin/protoc"
if [ ! -x "$protoc" ]; then
  unzip -q -o "$protoc_zip" -d "$tools"
fi
test "$("$protoc" --version)" = "libprotoc 32.1"

if [ ! -d "$generator" ]; then
  git clone --branch 1.39.0 --depth 1 https://github.com/apple/swift-protobuf.git "$generator"
fi
test "$(git -C "$generator" rev-parse HEAD)" = "$generator_commit"

plugin_dir=$(swift build --package-path "$generator" -c release \
  --product protoc-gen-swift --show-bin-path)
plugin="$plugin_dir/protoc-gen-swift"
test -x "$plugin"

generate() {
  mkdir -p "$1"
  # events.proto is terminal.proto's import, so both are named explicitly.
  "$protoc" -I "$repo/proto/websocket" \
    --plugin="protoc-gen-swift=$plugin" \
    --swift_opt=Visibility=Public \
    --swift_out="$1" events.proto terminal.proto
}

if [ "$check" = "--check" ]; then
  tmp=$(mktemp -d "$tools/gen-check.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  generate "$tmp"
  diff -r "$out" "$tmp"
  echo "generated protobuf is current: $(cd "$out" && ls ./*.pb.swift | tr '\n' ' ')"
else
  rm -f "$out"/*.pb.swift
  generate "$out"
  echo "generated: $(cd "$out" && ls ./*.pb.swift | tr '\n' ' ')"
fi
