// Local font application. Mirrors applyAppearanceFonts
// (web/mobile-appearance.js) for the desktop document: the UI scale,
// the profile dataset, the prepaint style node, and the body font.
// Mobile system-text observation and terminal application stay with
// the legacy shell, which owns those surfaces.

export interface AppliedAppearance {
    ui_font_family: string;
    ui_font_size: number;
}

const UI_SCALE_BASE = {
    mobile: 13,
    desktop: 14,
} as const;

export function appearanceFontScale(
    profile: 'desktop' | 'mobile',
    size: number,
): number {
    if (!Number.isFinite(size) || size < 10) return 1;
    const clamped = Math.min(24, Math.max(10, size));
    return clamped / UI_SCALE_BASE[profile];
}

export function applyAppearanceFonts(
    profile: 'desktop' | 'mobile',
    appearance: AppliedAppearance,
): void {
    document.documentElement.style.setProperty(
        '--ui-scale',
        String(appearanceFontScale(profile, appearance.ui_font_size)),
    );
    document.documentElement.dataset.appearanceProfile = profile;
    const size = appearance.ui_font_size || 0;
    document.documentElement.style.setProperty(
        '--mobile-ui-size',
        `${size || 17}px`,
    );
    let sheet = document.getElementById('phi-prepaint-appearance');
    if (!sheet) {
        sheet = document.createElement('style');
        sheet.id = 'phi-prepaint-appearance';
        document.head.appendChild(sheet);
    }
    const rules = (sheet as HTMLStyleElement).sheet;
    if (rules && !rules.cssRules.length) rules.insertRule('body {}');
    const style = rules?.cssRules[0] as CSSStyleRule | undefined;
    if (style) {
        style.style.fontFamily = appearance.ui_font_family;
        style.style.fontSize = appearance.ui_font_size >= 10 ? `${size}px` : '';
    }
    if (document.body) {
        document.body.style.fontFamily = appearance.ui_font_family;
        document.body.style.fontSize =
            appearance.ui_font_size >= 10 ? `${size}px` : '';
    }
}

export function removePrepaintNode(): void {
    document.getElementById('phi-prepaint-appearance')?.remove();
    if (document.body) {
        document.body.style.fontFamily = '';
        document.body.style.fontSize = '';
    }
}
