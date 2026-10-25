#!/bin/sh
# Install the Phi skills into every agent-harness skill directory present.
# Usage: ./install.sh [--dry-run]
set -eu

dry=0
case $# in
    0) ;;
    1)
        if [ "$1" = "--dry-run" ]; then
            dry=1
        else
            echo "Usage: $0 [--dry-run]" >&2
            exit 2
        fi
        ;;
    *)
        echo "Usage: $0 [--dry-run]" >&2
        exit 2
        ;;
esac

src=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

install_into() {
    dir=$1
    for skill in "$src"/*/; do
        [ -f "$skill/SKILL.md" ] || continue
        name=$(basename "$skill")
        if [ "$dry" = 1 ]; then
            echo "would install: $name -> $dir/$name"
        else
            mkdir -p "$dir/$name"
            cp -R "$skill"/. "$dir/$name/"
            echo "installed: $name -> $dir/$name"
        fi
    done
}

for pair in \
    "claude:$HOME/.claude/skills" \
    "pi:$HOME/.pi/agent/skills" \
    "codex:$HOME/.codex/skills" \
    "opencode:$HOME/.config/opencode/skill"
do
    harness=${pair%%:*}
    dir=${pair#*:}
    parent=$(dirname "$dir")
    if [ -d "$dir" ] || [ -d "$parent" ]; then
        install_into "$dir"
    else
        echo "skip: $harness ($dir not found)"
    fi
done
