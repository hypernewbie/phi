#!/usr/bin/env python3
"""
Generate Phi Themes for VS Code and Cursor.
Builds all 29 Phi accent themes from canonical palettes into VS Code color theme JSONs.
"""

import json
import os

from gen_codex_themes import PALETTES

THEMES = PALETTES

CANONICAL_REF_PATH = os.path.join(
    os.path.dirname(__file__), '..', 'bonus', 'vscode_themes', 'themes', 'phi_purple.json'
)

with open(CANONICAL_REF_PATH, 'r', encoding='utf-8') as f:
    CANONICAL_TEMPLATE = json.load(f)


def make_theme(id_name, display_name, accent, accent_bright, accent_dim, accent_pale):
    raw = json.dumps(CANONICAL_TEMPLATE, indent=2)
    # The reference phi_purple tokens:
    raw = raw.replace('#7c6af7', accent)
    raw = raw.replace('#9a8dfa', accent_bright)
    raw = raw.replace('#5b4ec2', accent_dim)
    raw = raw.replace('#c4b5fd', accent_pale)
    theme = json.loads(raw)
    theme['name'] = display_name
    return theme


def generate_themes(out_dir=None):
    if out_dir is None:
        out_dir = os.path.join(os.path.dirname(__file__), '..', 'bonus', 'vscode_themes')
    themes_dir = os.path.join(out_dir, 'themes')
    os.makedirs(themes_dir, exist_ok=True)

    for id_name, display_name, accent, accent_bright, accent_dim, accent_pale in THEMES:
        theme_obj = make_theme(id_name, display_name, accent, accent_bright, accent_dim, accent_pale)
        filename = f"phi_{id_name}.json"
        filepath = os.path.join(themes_dir, filename)
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(theme_obj, f, indent=2)
            f.write("\n")

    print(f"Generated {len(THEMES)} VS Code themes in {themes_dir}")


if __name__ == '__main__':
    generate_themes()
