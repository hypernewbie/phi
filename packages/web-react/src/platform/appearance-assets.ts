// Custom font/background assets. M2 stub: the editors only need the
// custom font name, which lives in the local appearance key. Full
// IndexedDB ownership joins in M5.
export function readCustomFontName(appearance: {
    custom_font_name?: unknown;
}): string {
    return typeof appearance.custom_font_name === 'string'
        ? appearance.custom_font_name
        : '';
}

export function hasCustomFont(appearance: {
    custom_font_name?: unknown;
}): boolean {
    return readCustomFontName(appearance).length > 0;
}
