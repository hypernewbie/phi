import os
import json

THEMES = [
    ('amber', 'Phi Amber', '#fbbf24', '#fcd34d', '#b45309', '#fde68a'),
    ('blue', 'Phi Blue', '#38bdf8', '#7dd3fc', '#0284c7', '#bae6fd'),
    ('canary', 'Phi Canary', '#ffee10', '#ffff66', '#b8aa00', '#ffffaa'),
    ('copper', 'Phi Copper', '#d35400', '#e59866', '#873600', '#f5cba7'),
    ('coral', 'Phi Coral', '#e07a5f', '#f4a261', '#9e4731', '#f8d7cc'),
    ('cyan', 'Phi Cyan', '#06b6d4', '#67e8f9', '#0e7490', '#a5f3fc'),
    ('emerald', 'Phi Emerald', '#059669', '#34d399', '#065f46', '#a7f3d0'),
    ('fuchsia', 'Phi Fuchsia', '#d946ef', '#f0abfc', '#86198f', '#fae8ff'),
    ('gold', 'Phi Gold', '#d4af37', '#f3e5ab', '#997a15', '#fbf5df'),
    ('green', 'Phi Green', '#10b981', '#34d399', '#047857', '#a7f3d0'),
    ('indigo', 'Phi Indigo', '#6366f1', '#818cf8', '#4338ca', '#a5b4fc'),
    ('lime', 'Phi Lime', '#84cc16', '#a3e635', '#4d7c0f', '#d9f99d'),
    ('mint', 'Phi Mint', '#2ed573', '#7bed9f', '#1e8449', '#b8f5cd'),
    ('neon', 'Phi Neon', '#00f0ff', '#70f8ff', '#008b99', '#b3fcff'),
    ('orange', 'Phi Orange', '#f97316', '#fdba74', '#c2410c', '#fed7aa'),
    ('pink', 'Phi Pink', '#ec4899', '#f472b6', '#be185d', '#fbcfe8'),
    ('purple', 'Phi Purple', '#7c6af7', '#9a8dfa', '#5b4ec2', '#c4b5fd'),
    ('red', 'Phi Red', '#f87171', '#fca5a5', '#b91c1c', '#fecaca'),
    ('rose', 'Phi Rose', '#f43f5e', '#fb7185', '#be123c', '#fecdd3'),
    ('teal', 'Phi Teal', '#14b8a6', '#5eead4', '#0f766e', '#99f6e4'),
    ('violet', 'Phi Violet', '#a78bfa', '#ddd6fe', '#6d28d9', '#ede9fe'),
    ('white', 'Phi White', '#ffffff', '#ffffff', '#94a3b8', '#e2e8f0'),
]

out_dir = os.path.join('bonus', 'vscode_themes')
themes_dir = os.path.join(out_dir, 'themes')
os.makedirs(themes_dir, exist_ok=True)

def make_theme(id_name, display_name, accent, accent_bright, accent_dim, accent_pale):
    return {
        "$schema": "vscode://schemas/color-theme",
        "name": display_name,
        "type": "dark",
        "colors": {
            "focusBorder": accent,
            "foreground": "#e4e3e9",
            "widget.shadow": "#00000088",
            "selection.background": accent + "40",
            "descriptionForeground": "#78768a",
            "errorForeground": "#f87171",
            "icon.foreground": "#e4e3e9",

            # Title Bar
            "titleBar.activeBackground": "#08080a",
            "titleBar.activeForeground": "#e4e3e9",
            "titleBar.inactiveBackground": "#08080a",
            "titleBar.inactiveForeground": "#78768a",
            "titleBar.border": "#1f1f26",

            # Activity Bar
            "activityBar.background": "#0d0d10",
            "activityBar.foreground": accent,
            "activityBar.inactiveForeground": "#78768a",
            "activityBar.border": "#1f1f26",
            "activityBarBadge.background": accent,
            "activityBarBadge.foreground": "#ffffff",

            # Side Bar
            "sideBar.background": "#0d0d10",
            "sideBar.foreground": "#e4e3e9",
            "sideBar.border": "#1f1f26",
            "sideBarTitle.foreground": "#e4e3e9",
            "sideBarSectionHeader.background": "#141418",
            "sideBarSectionHeader.foreground": "#e4e3e9",
            "sideBarSectionHeader.border": "#1f1f26",

            # Editor Groups & Tabs
            "editorGroupHeader.noTabsBackground": "#0d0d10",
            "editorGroupHeader.tabsBackground": "#0d0d10",
            "editorGroupHeader.tabsBorder": "#1f1f26",
            "editorGroup.border": "#1f1f26",
            "tab.activeBackground": "#141418",
            "tab.activeForeground": "#ffffff",
            "tab.activeBorderTop": accent,
            "tab.inactiveBackground": "#0d0d10",
            "tab.inactiveForeground": "#78768a",
            "tab.border": "#1f1f26",
            "tab.hoverBackground": "#181820",
            "tab.hoverForeground": "#e4e3e9",
            "tab.unfocusedActiveForeground": "#e4e3e9",
            "tab.unfocusedInactiveForeground": "#78768a",

            # Editor Base
            "editor.background": "#141418",
            "editor.foreground": "#e4e3e9",
            "editorLineNumber.foreground": "#505060",
            "editorLineNumber.activeForeground": accent_bright,
            "editorCursor.foreground": accent,
            "editor.selectionBackground": accent + "33",
            "editor.selectionHighlightBackground": accent + "22",
            "editor.inactiveSelectionBackground": accent + "20",
            "editor.wordHighlightBackground": accent + "25",
            "editor.wordHighlightStrongBackground": accent + "38",
            "editor.findMatchBackground": accent + "55",
            "editor.findMatchHighlightBackground": accent + "30",
            "editor.lineHighlightBackground": "#1f1f2655",
            "editor.lineHighlightBorder": "#00000000",
            "editorIndentGuide.background1": "#1f1f26",
            "editorIndentGuide.activeBackground1": accent + "66",
            "editorWhitespace.foreground": "#2a2a35",
            "editorBracketMatch.background": accent + "33",
            "editorBracketMatch.border": accent,
            "editorRuler.foreground": "#1f1f26",
            "editorGutter.background": "#141418",
            "editorGutter.modifiedBackground": "#fbbf24",
            "editorGutter.addedBackground": "#10b981",
            "editorGutter.deletedBackground": "#f87171",

            # Status Bar
            "statusBar.background": "#0d0d10",
            "statusBar.foreground": "#e4e3e9",
            "statusBar.border": "#1f1f26",
            "statusBar.noFolderBackground": "#0d0d10",
            "statusBar.debuggingBackground": "#0d0d10",
            "statusBarItem.remoteBackground": accent,
            "statusBarItem.remoteForeground": "#ffffff",
            "statusBarItem.hoverBackground": "#1f1f26",
            "statusBarItem.activeBackground": accent + "40",

            # Panel (Terminal / Output / Debug)
            "panel.background": "#0d0d10",
            "panel.border": "#1f1f26",
            "panelTitle.activeBorder": accent,
            "panelTitle.activeForeground": "#e4e3e9",
            "panelTitle.inactiveForeground": "#78768a",

            # Terminal ANSI
            "terminal.background": "#0d0d10",
            "terminal.foreground": "#e4e3e9",
            "terminalCursor.foreground": accent,
            "terminal.ansiBlack": "#141418",
            "terminal.ansiRed": "#f87171",
            "terminal.ansiGreen": "#10b981",
            "terminal.ansiYellow": "#fbbf24",
            "terminal.ansiBlue": "#38bdf8",
            "terminal.ansiMagenta": accent,
            "terminal.ansiCyan": "#06b6d4",
            "terminal.ansiWhite": "#e4e3e9",
            "terminal.ansiBrightBlack": "#78768a",
            "terminal.ansiBrightRed": "#fca5a5",
            "terminal.ansiBrightGreen": "#34d399",
            "terminal.ansiBrightYellow": "#fde68a",
            "terminal.ansiBrightBlue": "#7dd3fc",
            "terminal.ansiBrightMagenta": accent_bright,
            "terminal.ansiBrightCyan": "#67e8f9",
            "terminal.ansiBrightWhite": "#ffffff",

            # Lists and Trees
            "list.activeSelectionBackground": "#1f1f26",
            "list.activeSelectionForeground": accent_bright,
            "list.inactiveSelectionBackground": "#181820",
            "list.inactiveSelectionForeground": "#e4e3e9",
            "list.hoverBackground": "#181820",
            "list.hoverForeground": "#e4e3e9",
            "list.focusHighlightForeground": accent,
            "list.highlightForeground": accent_bright,

            # Inputs & Controls
            "input.background": "#0d0d10",
            "input.foreground": "#e4e3e9",
            "input.border": "#1f1f26",
            "input.placeholderForeground": "#78768a",
            "inputOption.activeBorder": accent,
            "dropdown.background": "#0d0d10",
            "dropdown.foreground": "#e4e3e9",
            "dropdown.border": "#1f1f26",
            "button.background": accent,
            "button.foreground": "#ffffff",
            "button.hoverBackground": accent_bright,
            "badge.background": accent,
            "badge.foreground": "#ffffff",

            # Git / Diff
            "gitDecoration.modifiedResourceForeground": "#fbbf24",
            "gitDecoration.deletedResourceForeground": "#f87171",
            "gitDecoration.untrackedResourceForeground": "#10b981",
            "gitDecoration.ignoredResourceForeground": "#505060",
            "gitDecoration.conflictingResourceForeground": "#ec4899",
            "diffEditor.insertedTextBackground": "#10b98122",
            "diffEditor.removedTextBackground": "#f8717122",

            # Breadcrumbs & Quick Pick
            "breadcrumb.foreground": "#78768a",
            "breadcrumb.focusForeground": accent_bright,
            "breadcrumb.activeSelectionForeground": accent,
            "quickInput.background": "#0d0d10",
            "quickInput.foreground": "#e4e3e9",
            "quickInputList.focusBackground": "#1f1f26",
            "quickInputList.focusForeground": accent_bright,
        },
        "tokenColors": [
            {
                "name": "Comments",
                "scope": ["comment", "punctuation.definition.comment"],
                "settings": {
                    "foreground": "#505060",
                    "fontStyle": "italic"
                }
            },
            {
                "name": "Strings",
                "scope": [
                    "string",
                    "punctuation.definition.string",
                    "string.quoted",
                    "string.template"
                ],
                "settings": {
                    "foreground": accent_pale
                }
            },
            {
                "name": "Constants & Numbers",
                "scope": [
                    "constant.numeric",
                    "constant.language",
                    "constant.character",
                    "constant.other"
                ],
                "settings": {
                    "foreground": accent_bright
                }
            },
            {
                "name": "Keywords & Storage",
                "scope": [
                    "keyword",
                    "keyword.control",
                    "storage.type",
                    "storage.modifier",
                    "keyword.operator.new",
                    "keyword.operator.expression",
                    "keyword.operator.logical"
                ],
                "settings": {
                    "foreground": accent_bright,
                    "fontStyle": "bold"
                }
            },
            {
                "name": "Operators",
                "scope": [
                    "keyword.operator",
                    "punctuation.separator.key-value"
                ],
                "settings": {
                    "foreground": accent
                }
            },
            {
                "name": "Functions & Methods",
                "scope": [
                    "entity.name.function",
                    "support.function",
                    "meta.function-call",
                    "entity.name.method"
                ],
                "settings": {
                    "foreground": accent
                }
            },
            {
                "name": "Types & Classes",
                "scope": [
                    "entity.name.type",
                    "entity.name.class",
                    "support.type",
                    "support.class",
                    "entity.other.inherited-class"
                ],
                "settings": {
                    "foreground": accent_dim,
                    "fontStyle": "bold"
                }
            },
            {
                "name": "Variables & Identifiers",
                "scope": [
                    "variable",
                    "variable.other",
                    "variable.parameter"
                ],
                "settings": {
                    "foreground": "#e4e3e9"
                }
            },
            {
                "name": "Special / Builtin Variables",
                "scope": [
                    "variable.language",
                    "variable.language.this",
                    "variable.language.self"
                ],
                "settings": {
                    "foreground": accent_bright,
                    "fontStyle": "italic"
                }
            },
            {
                "name": "Punctuation & Delimiters",
                "scope": [
                    "punctuation.separator",
                    "punctuation.terminator",
                    "punctuation.accessor",
                    "punctuation.definition.parameters"
                ],
                "settings": {
                    "foreground": "#78768a"
                }
            },
            {
                "name": "Tags & HTML/JSX",
                "scope": [
                    "entity.name.tag",
                    "meta.tag.sgml",
                    "punctuation.definition.tag"
                ],
                "settings": {
                    "foreground": accent_bright
                }
            },
            {
                "name": "Attributes",
                "scope": [
                    "entity.other.attribute-name"
                ],
                "settings": {
                    "foreground": accent
                }
            },
            {
                "name": "Markdown Headings",
                "scope": [
                    "markup.heading",
                    "entity.name.section"
                ],
                "settings": {
                    "foreground": accent,
                    "fontStyle": "bold"
                }
            },
            {
                "name": "Markdown Links",
                "scope": [
                    "markup.underline.link",
                    "string.other.link"
                ],
                "settings": {
                    "foreground": accent_bright
                }
            },
            {
                "name": "Markdown Code",
                "scope": [
                    "markup.raw.inline",
                    "markup.raw.block"
                ],
                "settings": {
                    "foreground": accent_pale
                }
            },
            {
                "name": "JSON Keys",
                "scope": [
                    "support.type.property-name.json"
                ],
                "settings": {
                    "foreground": accent
                }
            }
        ]
    }

themes_contrib = []
for id_name, display_name, accent, accent_bright, accent_dim, accent_pale in THEMES:
    theme_obj = make_theme(id_name, display_name, accent, accent_bright, accent_dim, accent_pale)
    filename = f"phi_{id_name}-color-theme.json"
    filepath = os.path.join(themes_dir, filename)
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(theme_obj, f, indent=2)
    themes_contrib.append({
        "label": display_name,
        "uiTheme": "vs-dark",
        "path": f"./themes/{filename}"
    })

pkg_json = {
    "name": "phi-themes",
    "displayName": "Phi Themes",
    "description": "22 Greek & Egyptian inspired Phi dark themes with high-contrast accent glow",
    "version": "0.19.2",
    "publisher": "hypernewbie",
    "engines": {
        "vscode": "^1.60.0"
    },
    "categories": [
        "Themes"
    ],
    "contributes": {
        "themes": themes_contrib
    }
}

with open(os.path.join(out_dir, "package.json"), "w", encoding="utf-8") as f:
    json.dump(pkg_json, f, indent=2)

readme_content = """# Phi VS Code Themes

Collection of 22 dark themes for VS Code matching the Phi palette:

- **Phi Amber**
- **Phi Blue**
- **Phi Canary**
- **Phi Copper**
- **Phi Coral**
- **Phi Cyan**
- **Phi Emerald**
- **Phi Fuchsia**
- **Phi Gold**
- **Phi Green**
- **Phi Indigo**
- **Phi Lime**
- **Phi Mint**
- **Phi Neon**
- **Phi Orange**
- **Phi Pink**
- **Phi Purple**
- **Phi Red**
- **Phi Rose**
- **Phi Teal**
- **Phi Violet**
- **Phi White**

## Installation

Copy the `bonus/vscode_themes` directory to your VS Code extensions folder:
- **Windows**: `%USERPROFILE%\\.vscode\\extensions\\phi-themes`
- **macOS / Linux**: `~/.vscode/extensions/phi-themes`
"""

with open(os.path.join(out_dir, "README.md"), "w", encoding="utf-8") as f:
    f.write(readme_content)

print(f"Generated {len(THEMES)} VS Code themes in {out_dir}")
