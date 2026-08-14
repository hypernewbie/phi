/* Φ phi — Accent Theme & Prepaint Utilities */

export const ACCENT_COLORS = {
    purple: {
        accent: '#7c6af7',
        accentGlow: 'rgba(124, 106, 247, 0.15)',
        accentDim: '#5b4ec2',
        accentBright: '#9a8dfa'
    },
    blue: {
        accent: '#38bdf8',
        accentGlow: 'rgba(56, 189, 248, 0.15)',
        accentDim: '#0284c7',
        accentBright: '#7dd3fc'
    },
    green: {
        accent: '#10b981',
        accentGlow: 'rgba(16, 185, 129, 0.15)',
        accentDim: '#047857',
        accentBright: '#34d399'
    },
    amber: {
        accent: '#fbbf24',
        accentGlow: 'rgba(251, 191, 36, 0.15)',
        accentDim: '#b45309',
        accentBright: '#fcd34d'
    },
    red: {
        accent: '#f87171',
        accentGlow: 'rgba(248, 113, 113, 0.15)',
        accentDim: '#b91c1c',
        accentBright: '#fca5a5'
    },
    pink: {
        accent: '#ec4899',
        accentGlow: 'rgba(236, 72, 153, 0.15)',
        accentDim: '#be185d',
        accentBright: '#f472b6'
    },
    teal: {
        accent: '#14b8a6',
        accentGlow: 'rgba(20, 184, 166, 0.15)',
        accentDim: '#0f766e',
        accentBright: '#5eead4'
    },
    indigo: {
        accent: '#6366f1',
        accentGlow: 'rgba(99, 102, 241, 0.15)',
        accentDim: '#4338ca',
        accentBright: '#818cf8'
    },
    orange: {
        accent: '#f97316',
        accentGlow: 'rgba(249, 115, 22, 0.15)',
        accentDim: '#c2410c',
        accentBright: '#fdba74'
    },
    cyan: {
        accent: '#06b6d4',
        accentGlow: 'rgba(6, 182, 212, 0.15)',
        accentDim: '#0e7490',
        accentBright: '#67e8f9'
    },
    rose: {
        accent: '#f43f5e',
        accentGlow: 'rgba(244, 63, 94, 0.15)',
        accentDim: '#be123c',
        accentBright: '#fb7185'
    },
    lime: {
        accent: '#84cc16',
        accentGlow: 'rgba(132, 204, 22, 0.15)',
        accentDim: '#4d7c0f',
        accentBright: '#a3e635'
    },
    white: {
        accent: '#ffffff',
        accentGlow: 'rgba(255, 255, 255, 0.15)',
        accentDim: '#94a3b8',
        accentBright: '#ffffff'
    },
    gold: {
        accent: '#d4af37',
        accentGlow: 'rgba(212, 175, 55, 0.15)',
        accentDim: '#997a15',
        accentBright: '#f3e5ab'
    },
    violet: {
        accent: '#a78bfa',
        accentGlow: 'rgba(167, 139, 250, 0.15)',
        accentDim: '#6d28d9',
        accentBright: '#ddd6fe'
    },
    emerald: {
        accent: '#059669',
        accentGlow: 'rgba(5, 150, 105, 0.15)',
        accentDim: '#065f46',
        accentBright: '#34d399'
    },
    neon: {
        accent: '#00f0ff',
        accentGlow: 'rgba(0, 240, 255, 0.15)',
        accentDim: '#008b99',
        accentBright: '#70f8ff'
    },
    coral: {
        accent: '#e07a5f',
        accentGlow: 'rgba(224, 122, 95, 0.15)',
        accentDim: '#9e4731',
        accentBright: '#f4a261'
    },
    fuchsia: {
        accent: '#d946ef',
        accentGlow: 'rgba(217, 70, 239, 0.15)',
        accentDim: '#86198f',
        accentBright: '#f0abfc'
    },
    canary: {
        accent: '#ffee10',
        accentGlow: 'rgba(255, 238, 16, 0.18)',
        accentDim: '#b8ad00',
        accentBright: '#ffff66'
    },
    copper: {
        accent: '#d35400',
        accentGlow: 'rgba(211, 84, 0, 0.18)',
        accentDim: '#8a3700',
        accentBright: '#e59866'
    },
    mint: {
        accent: '#2ed573',
        accentGlow: 'rgba(46, 213, 115, 0.18)',
        accentDim: '#1a8a4a',
        accentBright: '#7bed9f'
    }
};

export function applyThemeTokens(colorKey) {
    const key = colorKey || 'purple';
    const theme = ACCENT_COLORS[key] || ACCENT_COLORS.purple;
    const root = document.documentElement;
    root.style.setProperty('--accent', theme.accent);
    root.style.setProperty('--accent-glow', theme.accentGlow);
    root.style.setProperty('--accent-dim', theme.accentDim);
    root.style.setProperty('--accent-bright', theme.accentBright);
    root.setAttribute('data-theme-color', key);
    return theme;
}

export function applyPrepaintAppearance() {
    try {
        const a = JSON.parse(localStorage.getItem('phi_appearance') || 'null');
        if (a && (a.ui_font_family || a.ui_font_size >= 10)) {
            let s = document.getElementById('phi-prepaint-appearance');
            if (!s) {
                s = document.createElement('style');
                s.id = 'phi-prepaint-appearance';
                document.head.appendChild(s);
            }
            s.textContent = 'body{' +
                (a.ui_font_family ? 'font-family:' + a.ui_font_family + ';' : '') +
                (a.ui_font_size >= 10 ? 'font-size:' + a.ui_font_size + 'px;' : '') + '}';
        }
    } catch { /* ignore */ }
}

export function applyPrepaintFavicon(accent, accentDim) {
    try {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><radialGradient id="glow" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="${accent}"/><stop offset="100%" stop-color="${accentDim}"/></radialGradient></defs><rect width="32" height="32" rx="8" fill="url(#glow)"/><text x="50%" y="60%" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="bold" fill="#ffffff" text-anchor="middle">Φ</text></svg>`;
        let link = document.querySelector("link[rel~='icon']");
        if (!link) {
            link = document.createElement('link');
            link.rel = 'icon';
            link.type = 'image/svg+xml';
            document.head.appendChild(link);
        }
        link.href = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    } catch { /* ignore */ }
}

export function runPrepaint() {
    try {
        const colorKey = localStorage.getItem('phi_theme_color') || 'purple';
        const theme = applyThemeTokens(colorKey);
        applyPrepaintFavicon(theme.accent, theme.accentDim);
    } catch { /* ignore */ }
    applyPrepaintAppearance();
}
