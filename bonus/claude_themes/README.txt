Phi Themes for Claude Code CLI
==============================

Official Phi colour themes for Anthropic's Claude Code CLI, matching all 22 Phi workspace accent palettes.

Installation:
- Copy the `phi_*.json` files into `~/.claude/themes/`:
    mkdir -p ~/.claude/themes
    cp bonus/claude_themes/phi_*.json ~/.claude/themes/

Usage:
- In Claude Code CLI, run `/theme` and select any "Phi [Colour]" theme (e.g. Phi Purple, Phi Cyan, Phi Gold, etc.).
- Or configure directly in `~/.claude/settings.json`:
    {
      "theme": "custom:phi_purple"
    }
