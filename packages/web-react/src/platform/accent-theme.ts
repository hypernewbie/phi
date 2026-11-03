// Accent swatches copied verbatim from web/theme.js ACCENT_COLORS.
export interface AccentTheme {
    accent: string;
    accentGlow: string;
    accentDim: string;
    accentBright: string;
}

export const ACCENT_COLORS: Record<string, AccentTheme> = {
    purple: {
        accent: '#7c6af7',
        accentGlow: 'rgba(124, 106, 247, 0.15)',
        accentDim: '#5b4ec2',
        accentBright: '#9a8dfa',
    },
    blue: {
        accent: '#38bdf8',
        accentGlow: 'rgba(56, 189, 248, 0.15)',
        accentDim: '#0284c7',
        accentBright: '#7dd3fc',
    },
    green: {
        accent: '#10b981',
        accentGlow: 'rgba(16, 185, 129, 0.15)',
        accentDim: '#047857',
        accentBright: '#34d399',
    },
    amber: {
        accent: '#fbbf24',
        accentGlow: 'rgba(251, 191, 36, 0.15)',
        accentDim: '#b45309',
        accentBright: '#fcd34d',
    },
    red: {
        accent: '#f87171',
        accentGlow: 'rgba(248, 113, 113, 0.15)',
        accentDim: '#b91c1c',
        accentBright: '#fca5a5',
    },
    pink: {
        accent: '#ec4899',
        accentGlow: 'rgba(236, 72, 153, 0.15)',
        accentDim: '#be185d',
        accentBright: '#f472b6',
    },
    teal: {
        accent: '#14b8a6',
        accentGlow: 'rgba(20, 184, 166, 0.15)',
        accentDim: '#0f766e',
        accentBright: '#5eead4',
    },
    indigo: {
        accent: '#6366f1',
        accentGlow: 'rgba(99, 102, 241, 0.15)',
        accentDim: '#4338ca',
        accentBright: '#818cf8',
    },
    orange: {
        accent: '#f97316',
        accentGlow: 'rgba(249, 115, 22, 0.15)',
        accentDim: '#c2410c',
        accentBright: '#fdba74',
    },
    cyan: {
        accent: '#06b6d4',
        accentGlow: 'rgba(6, 182, 212, 0.15)',
        accentDim: '#0e7490',
        accentBright: '#67e8f9',
    },
    rose: {
        accent: '#f43f5e',
        accentGlow: 'rgba(244, 63, 94, 0.15)',
        accentDim: '#be123c',
        accentBright: '#fb7185',
    },
    lime: {
        accent: '#84cc16',
        accentGlow: 'rgba(132, 204, 22, 0.15)',
        accentDim: '#4d7c0f',
        accentBright: '#a3e635',
    },
    white: {
        accent: '#ffffff',
        accentGlow: 'rgba(255, 255, 255, 0.15)',
        accentDim: '#94a3b8',
        accentBright: '#ffffff',
    },
    gold: {
        accent: '#d4af37',
        accentGlow: 'rgba(212, 175, 55, 0.15)',
        accentDim: '#997a15',
        accentBright: '#f3e5ab',
    },
    violet: {
        accent: '#a78bfa',
        accentGlow: 'rgba(167, 139, 250, 0.15)',
        accentDim: '#6d28d9',
        accentBright: '#ddd6fe',
    },
    emerald: {
        accent: '#059669',
        accentGlow: 'rgba(5, 150, 105, 0.15)',
        accentDim: '#065f46',
        accentBright: '#34d399',
    },
    neon: {
        accent: '#1a79ff',
        accentGlow: 'rgba(26, 121, 255, 0.16)',
        accentDim: '#004ab2',
        accentBright: '#70acff',
    },
    coral: {
        accent: '#e07a5f',
        accentGlow: 'rgba(224, 122, 95, 0.15)',
        accentDim: '#9e4731',
        accentBright: '#f4a261',
    },
    fuchsia: {
        accent: '#d946ef',
        accentGlow: 'rgba(217, 70, 239, 0.15)',
        accentDim: '#86198f',
        accentBright: '#f0abfc',
    },
    canary: {
        accent: '#ffee10',
        accentGlow: 'rgba(255, 238, 16, 0.18)',
        accentDim: '#b8ad00',
        accentBright: '#ffff66',
    },
    copper: {
        accent: '#d35400',
        accentGlow: 'rgba(211, 84, 0, 0.18)',
        accentDim: '#8a3700',
        accentBright: '#e59866',
    },
    mint: {
        accent: '#2ed573',
        accentGlow: 'rgba(46, 213, 115, 0.18)',
        accentDim: '#1a8a4a',
        accentBright: '#7bed9f',
    },
    arc: {
        accent: '#2952ff',
        accentGlow: 'rgba(41, 82, 255, 0.18)',
        accentDim: '#1433b8',
        accentBright: '#708cff',
    },
    ember: {
        accent: '#ff4500',
        accentGlow: 'rgba(255, 69, 0, 0.18)',
        accentDim: '#cc2200',
        accentBright: '#ff7733',
    },
    fog: {
        accent: '#94a3b8',
        accentGlow: 'rgba(148, 163, 184, 0.18)',
        accentDim: '#64748b',
        accentBright: '#cbd5e1',
    },
    ash: {
        accent: '#a8a29e',
        accentGlow: 'rgba(168, 162, 158, 0.18)',
        accentDim: '#78716c',
        accentBright: '#d6d3d1',
    },
    dusk: {
        accent: '#b8a9c9',
        accentGlow: 'rgba(184, 169, 201, 0.18)',
        accentDim: '#7c6f8a',
        accentBright: '#d4cae0',
    },
    pine: {
        accent: '#84a59d',
        accentGlow: 'rgba(132, 165, 157, 0.18)',
        accentDim: '#5b7065',
        accentBright: '#a8c2bc',
    },
    fern: {
        accent: '#9caf88',
        accentGlow: 'rgba(156, 175, 136, 0.18)',
        accentDim: '#6b8e5f',
        accentBright: '#bccbab',
    },
};

const FALLBACK_THEME = ACCENT_COLORS.purple as AccentTheme;

export function accentTheme(colorKey: string): AccentTheme {
    return ACCENT_COLORS[colorKey] ?? FALLBACK_THEME;
}

// Mirrors applyThemeTokens (web/theme.js): unknown keys keep the raw
// attribute while the variables fall back to purple.
export function applyThemeTokens(colorKey: string): AccentTheme {
    const key = colorKey || 'purple';
    const theme = accentTheme(key);
    const root = document.documentElement;
    root.style.setProperty('--accent', theme.accent);
    root.style.setProperty('--accent-glow', theme.accentGlow);
    root.style.setProperty('--accent-dim', theme.accentDim);
    root.style.setProperty('--accent-bright', theme.accentBright);
    root.setAttribute('data-theme-color', key);
    return theme;
}

export function themeStorageKey(profileId: string): string {
    return profileId ? `phi_theme_color:${profileId}` : 'phi_theme_color';
}

// Mirrors applyAccentTheme (web/app.js) minus terminal + favicon, which
// the React shell does not own.
export function applyAccentTheme(
    colorKey: string,
    profileId: string,
    storage: Pick<Storage, 'setItem'> | null | undefined = window.localStorage,
): void {
    applyThemeTokens(colorKey);
    if (storage === null || storage === undefined) return;
    try {
        storage.setItem(themeStorageKey(profileId), colorKey);
    } catch {
        /* storage stays unavailable; the applied theme still shows */
    }
}

export function readThemeColor(profileId: string): string | null {
    try {
        return (
            window.localStorage.getItem(themeStorageKey(profileId)) ??
            window.localStorage.getItem('phi_theme_color')
        );
    } catch {
        return null;
    }
}
