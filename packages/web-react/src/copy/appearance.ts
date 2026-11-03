// Appearance copy and option tables. Values and labels are copied
// verbatim from web/settings.js; ranges mirror its validation.
export interface FontOption {
    value: string;
    label: string;
}

export const UI_FONT_OPTIONS: ReadonlyArray<FontOption> = [
    { value: '', label: 'System default' },
    { value: 'Inter, system-ui, sans-serif', label: 'Inter' },
    { value: 'system-ui, -apple-system, sans-serif', label: 'System UI' },
    { value: '"Segoe UI", system-ui, sans-serif', label: 'Segoe UI' },
    {
        value: '"Helvetica Neue", Arial, sans-serif',
        label: 'Helvetica Neue',
    },
    {
        value: 'ui-monospace, "Cascadia Code", "Source Code Pro", monospace',
        label: 'Mono / dev-style',
    },
];

export const TERM_FONT_OPTIONS: ReadonlyArray<FontOption> = [
    { value: '', label: 'Default (JetBrains Mono)' },
    { value: "'Fira Code', ui-monospace, monospace", label: 'Fira Code' },
    {
        value: "'Cascadia Code', ui-monospace, monospace",
        label: 'Cascadia Code',
    },
    {
        value: "ui-monospace, 'SF Mono', Menlo, monospace",
        label: 'SF Mono / Menlo',
    },
    { value: "Consolas, 'Cascadia Mono', monospace", label: 'Consolas' },
    {
        value: "'Source Code Pro', ui-monospace, monospace",
        label: 'Source Code Pro',
    },
    {
        value: "'JetBrainsMono Nerd Font Mono', 'JetBrainsMono Nerd Font', 'JetBrains Mono', ui-monospace, monospace",
        label: 'JetBrainsMono Nerd Font',
    },
    {
        value: "'FiraCode Nerd Font Mono', 'FiraCode Nerd Font', 'Fira Code', ui-monospace, monospace",
        label: 'FiraCode Nerd Font',
    },
    {
        value: "'Hack Nerd Font Mono', 'Hack Nerd Font', Hack, ui-monospace, monospace",
        label: 'Hack Nerd Font',
    },
    {
        value: "'MesloLGS NF', 'MesloLGM Nerd Font Mono', Menlo, ui-monospace, monospace",
        label: 'MesloLGS NF',
    },
    {
        value: "'CaskaydiaCove Nerd Font Mono', 'CaskaydiaCove Nerd Font', 'Cascadia Code', ui-monospace, monospace",
        label: 'CaskaydiaCove Nerd Font',
    },
    {
        value: "'SauceCodePro Nerd Font Mono', 'SauceCodePro Nerd Font', 'Source Code Pro', ui-monospace, monospace",
        label: 'SauceCodePro Nerd Font',
    },
    { value: 'monospace', label: 'System monospace' },
];

export const CUSTOM_FONT_VALUE = 'Phi Custom Font';

export function customFontLabel(name: string): string {
    return `Custom: ${name}`;
}

export function currentFontLabel(family: string): string {
    return `Current: ${family}`;
}

export const PROFILE_OPTIONS: ReadonlyArray<FontOption> = [
    { value: 'auto', label: 'Auto' },
    { value: 'desktop', label: 'Desktop' },
    { value: 'mobile', label: 'Mobile' },
];

export const UI_FONT_ROW = {
    label: 'UI font',
    id: 'settings-ui-font',
    min: 10,
    max: 24,
    displayDefault: 14,
} as const;

export const TERM_FONT_ROW = {
    label: 'Terminal font',
    id: 'settings-term-font',
    min: 8,
    max: 32,
    displayDefault: 14,
} as const;

export const UI_SIZE_ROW = {
    label: 'UI font size',
    id: 'settings-ui-font-size',
    min: 10,
    max: 24,
    displayDefault: 14,
} as const;

export const TERM_SIZE_ROW = {
    label: 'Terminal font size',
    id: 'settings-term-font-size',
    min: 8,
    max: 32,
    displayDefault: 14,
} as const;

export const SCROLLBACK_ROW = {
    label: 'Mobile scrollback rows (0 = full, new tabs)',
    id: 'settings-mobile-scrollback',
    min: 0,
    max: 10000,
    displayDefault: 0,
} as const;

export const PROFILE_ROW = {
    label: 'Appearance profile',
    id: 'settings-appearance-profile',
} as const;

export const appearanceCopy = {
    thisBrowser: 'This browser',
    appearance: 'Appearance',
    highlightColor: 'Highlight color',
    resetAppearance: 'Reset appearance',
    nativeProfileWarning: 'Native desktop always uses the desktop appearance.',
    memoryOnlyProfileWarning:
        'Profile choice is memory-only; browser storage is unavailable.',
} as const;
