#!/bin/sh
# Claude Code statusLine command
# Displays: current directory, git branch, model name, context usage %, and current time

input=$(cat)

cwd=$(echo "$input" | jq -r '.cwd // .workspace.current_dir // empty')
model=$(echo "$input" | jq -r '.model.display_name // empty')
used_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
now=$(date +%H:%M:%S)

# Shorten home directory to ~
home="$HOME"
if [ -n "$home" ] && [ -n "$cwd" ]; then
  short_cwd=$(echo "$cwd" | sed "s|^$home|~|")
else
  short_cwd="$cwd"
fi

# Get git branch (skip optional locks to avoid contention)
branch=$(git -C "$cwd" --no-optional-locks symbolic-ref --short HEAD 2>/dev/null)

# Build status line segments
parts=""

# Directory
if [ -n "$short_cwd" ]; then
  parts="${short_cwd}"
fi

# Git branch
if [ -n "$branch" ]; then
  parts="${parts} | ${branch}"
fi

# Model
if [ -n "$model" ]; then
  parts="${parts} | ${model}"
fi

# Context usage
if [ -n "$used_pct" ]; then
  printf_pct=$(printf '%.0f' "$used_pct")
  parts="${parts} | ctx:${printf_pct}%"
fi

# Time
parts="${parts} | ${now}"

printf '%s' "$parts"
