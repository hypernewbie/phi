// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import {
    ACCENT_COLORS,
    accentTheme,
    applyAccentTheme,
    applyThemeTokens,
    readThemeColor,
    themeStorageKey,
} from '../src/platform/accent-theme.ts';

afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme-color');
});

it('keeps all 29 legacy swatches', () => {
    expect(Object.keys(ACCENT_COLORS)).toHaveLength(29);
    expect(ACCENT_COLORS.purple).toEqual({
        accent: '#7c6af7',
        accentGlow: 'rgba(124, 106, 247, 0.15)',
        accentDim: '#5b4ec2',
        accentBright: '#9a8dfa',
    });
});

it('applies the four accent variables and the theme attribute', () => {
    applyThemeTokens('teal');
    const root = document.documentElement;
    expect(root.getAttribute('data-theme-color')).toBe('teal');
    expect(root.style.getPropertyValue('--accent')).toBe('#14b8a6');
    expect(root.style.getPropertyValue('--accent-glow')).toBe(
        'rgba(20, 184, 166, 0.15)',
    );
    expect(root.style.getPropertyValue('--accent-dim')).toBe('#0f766e');
    expect(root.style.getPropertyValue('--accent-bright')).toBe('#5eead4');
});

it('falls back to purple variables while keeping the unknown key', () => {
    applyThemeTokens('chartreuse');
    const root = document.documentElement;
    expect(root.getAttribute('data-theme-color')).toBe('chartreuse');
    expect(root.style.getPropertyValue('--accent')).toBe(
        accentTheme('purple').accent,
    );
});

it('persists the theme under the profile key', () => {
    const store = new Map<string, string>();
    const storage = {
        setItem: (key: string, value: string) => {
            store.set(key, value);
        },
        getItem: (key: string) => store.get(key) ?? null,
    };
    applyAccentTheme('teal', '', storage);
    expect(store.get('phi_theme_color')).toBe('teal');
    applyAccentTheme('amber', 'p1', storage);
    expect(store.get('phi_theme_color:p1')).toBe('amber');
    expect(themeStorageKey('')).toBe('phi_theme_color');
    expect(themeStorageKey('p1')).toBe('phi_theme_color:p1');
});

it('reads the scoped key before the shared key', () => {
    window.localStorage.setItem('phi_theme_color', 'purple');
    window.localStorage.setItem('phi_theme_color:p1', 'amber');
    expect(readThemeColor('p1')).toBe('amber');
    expect(readThemeColor('')).toBe('purple');
    expect(readThemeColor('p2')).toBe('purple');
});
