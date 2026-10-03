#!/usr/bin/env python3
"""
Generate Phi Themes for Codex CLI (.tmTheme format).
Builds all 29 Phi accent themes from canonical palettes into standard TextMate
property list XML files compatible with Codex CLI and syntect.
"""

import json
import os
import plistlib

PALETTES = [
    ('amber', 'Phi Amber', '#fbbf24', '#fcd34d', '#b45309', '#fde68a'),
    ('arc', 'Phi Arc', '#00d4ff', '#66e0ff', '#0080c0', '#99ebff'),
    ('ash', 'Phi Ash', '#a8a29e', '#d6d3d1', '#78716c', '#e7e5e4'),
    ('blue', 'Phi Blue', '#38bdf8', '#7dd3fc', '#0284c7', '#bae6fd'),
    ('canary', 'Phi Canary', '#ffee10', '#ffff66', '#b8aa00', '#ffffaa'),
    ('copper', 'Phi Copper', '#d35400', '#e59866', '#873600', '#f5cba7'),
    ('coral', 'Phi Coral', '#e07a5f', '#f4a261', '#9e4731', '#f8d7cc'),
    ('cyan', 'Phi Cyan', '#06b6d4', '#67e8f9', '#0e7490', '#a5f3fc'),
    ('dusk', 'Phi Dusk', '#b8a9c9', '#d4cae0', '#7c6f8a', '#ebe5f0'),
    ('ember', 'Phi Ember', '#ff4500', '#ff7733', '#cc2200', '#ffaa80'),
    ('emerald', 'Phi Emerald', '#059669', '#34d399', '#065f46', '#a7f3d0'),
    ('fern', 'Phi Fern', '#9caf88', '#bccbab', '#6b8e5f', '#d8e3ca'),
    ('fog', 'Phi Fog', '#94a3b8', '#cbd5e1', '#64748b', '#e2e8f0'),
    ('fuchsia', 'Phi Fuchsia', '#d946ef', '#f0abfc', '#86198f', '#fae8ff'),
    ('gold', 'Phi Gold', '#d4af37', '#f3e5ab', '#997a15', '#fbf5df'),
    ('green', 'Phi Green', '#10b981', '#34d399', '#047857', '#a7f3d0'),
    ('indigo', 'Phi Indigo', '#6366f1', '#818cf8', '#4338ca', '#a5b4fc'),
    ('lime', 'Phi Lime', '#84cc16', '#a3e635', '#4d7c0f', '#d9f99d'),
    ('mint', 'Phi Mint', '#2ed573', '#7bed9f', '#1e8449', '#b8f5cd'),
    ('neon', 'Phi Neon', '#00f0ff', '#70f8ff', '#008b99', '#b3fcff'),
    ('orange', 'Phi Orange', '#f97316', '#fdba74', '#c2410c', '#fed7aa'),
    ('pine', 'Phi Pine', '#84a59d', '#a8c2bc', '#5b7065', '#c8dad5'),
    ('pink', 'Phi Pink', '#ec4899', '#f472b6', '#be185d', '#fbcfe8'),
    ('purple', 'Phi Purple', '#7c6af7', '#9a8dfa', '#5b4ec2', '#c4b5fd'),
    ('red', 'Phi Red', '#f87171', '#fca5a5', '#b91c1c', '#fecaca'),
    ('rose', 'Phi Rose', '#f43f5e', '#fb7185', '#be123c', '#fecdd3'),
    ('teal', 'Phi Teal', '#14b8a6', '#5eead4', '#0f766e', '#99f6e4'),
    ('violet', 'Phi Violet', '#a78bfa', '#ddd6fe', '#6d28d9', '#ede9fe'),
    ('white', 'Phi White', '#ffffff', '#ffffff', '#94a3b8', '#e2e8f0'),
]


def make_codex_theme(id_name, display_name, accent, accent_bright, accent_dim, accent_pale):
    return {
        "name": display_name,
        "settings": [
            {
                "settings": {
                    "background": "#141418",
                    "caret": accent,
                    "foreground": "#e4e3e9",
                    "invisibles": "#1f1f26",
                    "lineHighlight": "#1f1f2655",
                    "selection": "#252538",
                    "selectionBorder": accent,
                    "findHighlight": accent + "55",
                    "findHighlightForeground": "#ffffff",
                }
            },
            {
                "name": "Codex Accent",
                "scope": "codex.accent",
                "settings": {
                    "foreground": accent,
                },
            },
            {
                "name": "Comments",
                "scope": "comment, punctuation.definition.comment, string.comment",
                "settings": {
                    "fontStyle": "italic",
                    "foreground": "#505060",
                },
            },
            {
                "name": "Strings",
                "scope": "string, punctuation.definition.string, string.quoted, string.template",
                "settings": {
                    "foreground": accent_pale,
                },
            },
            {
                "name": "Keywords & Storage",
                "scope": "keyword, keyword.control, keyword.other, storage, storage.type, storage.modifier, markup.heading",
                "settings": {
                    "fontStyle": "bold",
                    "foreground": accent_bright,
                },
            },
            {
                "name": "Types & Classes",
                "scope": "entity.name.type, entity.name.class, entity.name.struct, entity.name.enum, entity.name.interface, support.class, support.type, support.variable",
                "settings": {
                    "fontStyle": "bold",
                    "foreground": accent_dim,
                },
            },
            {
                "name": "Functions & Methods",
                "scope": "entity.name.function, support.function, meta.function-call, entity.name.method, meta.method-call",
                "settings": {
                    "foreground": accent,
                },
            },
            {
                "name": "Numbers & Constants",
                "scope": "constant, constant.numeric, constant.language, constant.character, constant.other",
                "settings": {
                    "foreground": accent_bright,
                },
            },
            {
                "name": "Variables & Parameters",
                "scope": "variable, variable.other, variable.parameter, meta.parameter",
                "settings": {
                    "foreground": "#e4e3e9",
                },
            },
            {
                "name": "Object Properties & Keys",
                "scope": "variable.other.property, variable.other.object.property, meta.object-literal.key, support.type.property-name",
                "settings": {
                    "foreground": "#e4e3e9",
                },
            },
            {
                "name": "Operators",
                "scope": "keyword.operator, keyword.operator.arithmetic, keyword.operator.logical, keyword.operator.assignment",
                "settings": {
                    "foreground": accent,
                },
            },
            {
                "name": "Punctuation & Delimiters",
                "scope": "punctuation, punctuation.separator, punctuation.terminator, punctuation.accessor, meta.brace",
                "settings": {
                    "foreground": "#909098",
                },
            },
            {
                "name": "Diff Inserted",
                "scope": "markup.inserted, diff.inserted",
                "settings": {
                    "background": "#143324",
                    "foreground": "#34d399",
                },
            },
            {
                "name": "Diff Deleted",
                "scope": "markup.deleted, diff.deleted",
                "settings": {
                    "background": "#3b161a",
                    "foreground": "#f87171",
                },
            },
            {
                "name": "Diff Changed",
                "scope": "markup.changed, diff.changed",
                "settings": {
                    "background": "#3d3014",
                    "foreground": "#fbbf24",
                },
            },
            {
                "name": "Markdown Bold",
                "scope": "markup.bold",
                "settings": {
                    "fontStyle": "bold",
                    "foreground": accent_bright,
                },
            },
            {
                "name": "Markdown Italic",
                "scope": "markup.italic",
                "settings": {
                    "fontStyle": "italic",
                    "foreground": accent_bright,
                },
            },
            {
                "name": "Markdown Code",
                "scope": "markup.inline.raw, markup.raw.block",
                "settings": {
                    "foreground": accent_pale,
                },
            },
            {
                "name": "Markdown Links",
                "scope": "markup.underline.link, string.other.link.title, string.other.link.description",
                "settings": {
                    "fontStyle": "underline",
                    "foreground": accent,
                },
            },
            {
                "name": "JSON Keys",
                "scope": "support.type.property-name.json",
                "settings": {
                    "foreground": accent,
                },
            },
        ],
    }


def generate_themes(out_dir=None):
    if out_dir is None:
        out_dir = os.path.join('bonus', 'codex_themes')
    os.makedirs(out_dir, exist_ok=True)

    for id_name, display_name, accent, accent_bright, accent_dim, accent_pale in PALETTES:
        theme = make_codex_theme(id_name, display_name, accent, accent_bright, accent_dim, accent_pale)
        filepath = os.path.join(out_dir, f"phi_{id_name}.tmTheme")
        with open(filepath, "wb") as f:
            plistlib.dump(theme, f, fmt=plistlib.FMT_XML)

    readme_path = os.path.join(out_dir, "README.txt")
    readme_content = """Phi Themes for OpenAI Codex CLI
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
"""
    with open(readme_path, "w", encoding="utf-8") as f:
        f.write(readme_content)

    print(f"Generated {len(PALETTES)} Codex themes in {out_dir}")


if __name__ == '__main__':
    generate_themes()
