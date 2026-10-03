Phi Themes for OpenAI Codex CLI
================================

Official Phi color themes for OpenAI Codex CLI, matching all 29 Phi workspace accent palettes.
Formatted as standard TextMate (.tmTheme) property lists parsed by Codex CLI's syntect engine.

Installation:
- Copy the `phi_*.tmTheme` files into your Codex themes directory:
    mkdir -p ~/.codex/themes
    cp bonus/codex_themes/phi_*.tmTheme ~/.codex/themes/

  (Or if $CODEX_HOME is customized: `$CODEX_HOME/themes/`)

Usage:
- In Codex CLI, run `/theme` and select any "Phi [Color]" theme (e.g. Phi Purple, Phi Cyan, Phi Gold, etc.).
- Or configure directly in `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`):
    [tui]
    theme = "phi_purple"
