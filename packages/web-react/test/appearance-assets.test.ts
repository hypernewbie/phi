// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
    BG_MAX_BYTES,
    CUSTOM_FONT_FAMILY,
    FONT_MAX_BYTES,
    clearBackground,
    clearFont,
    fontFaceInstalled,
    getBackground,
    getFont,
    injectFontFace,
    memoryAssetDatabase,
    putBackground,
    putFont,
    readCustomBackgroundName,
    readCustomFontName,
    removeFontFace,
    type AssetDatabase,
} from '../src/platform/appearance-assets.ts';

const bytes = (size: number): Blob => new Blob([new Uint8Array(size)]);

afterEach(() => {
    removeFontFace();
    vi.unstubAllGlobals();
});

it('reads the local asset names, defaulting to empty', () => {
    expect(readCustomFontName({})).toBe('');
    expect(readCustomFontName({ custom_font_name: 'Fira.woff2' })).toBe(
        'Fira.woff2',
    );
    expect(readCustomFontName({ custom_font_name: 42 })).toBe('');
    expect(readCustomBackgroundName({})).toBe('');
    expect(
        readCustomBackgroundName({ terminal_bg_name: 'wallpaper.png' }),
    ).toBe('wallpaper.png');
});

it('rejects an oversize font before any database write', async () => {
    const put = vi.fn();
    const db: AssetDatabase = {
        ...memoryAssetDatabase(),
        put,
    };
    await expect(putFont(db, 'huge.woff2', bytes(FONT_MAX_BYTES + 1))).rejects
        .toThrow('Font too large (max 8MB)');
    expect(put).not.toHaveBeenCalled();
});

it('rejects an oversize background before any database write', async () => {
    const put = vi.fn();
    const db: AssetDatabase = {
        ...memoryAssetDatabase(),
        put,
    };
    await expect(
        putBackground(db, 'huge.png', bytes(BG_MAX_BYTES + 1)),
    ).rejects.toThrow('Background image too large (max 16MB)');
    expect(put).not.toHaveBeenCalled();
});

it('round-trips font and background records through memory storage', async () => {
    const db = memoryAssetDatabase();
    await putFont(db, 'Fira.woff2', bytes(10));
    await putBackground(db, 'wallpaper.png', bytes(20));
    expect(await getFont(db)).toMatchObject({ displayName: 'Fira.woff2' });
    expect(await getBackground(db)).toMatchObject({
        displayName: 'wallpaper.png',
    });
    await clearFont(db);
    await clearBackground(db);
    expect(await getFont(db)).toBeNull();
    expect(await getBackground(db)).toBeNull();
});

it('injects and removes the shared font-face style node', () => {
    vi.stubGlobal(
        'URL',
        Object.assign(URL, { createObjectURL: () => 'blob:mock-font' }),
    );
    expect(fontFaceInstalled()).toBe(false);
    injectFontFace(bytes(10));
    const style = document.getElementById('phi-custom-fonts');
    expect(style?.textContent).toContain(CUSTOM_FONT_FAMILY);
    expect(style?.textContent).toContain('blob:mock-font');
    expect(fontFaceInstalled()).toBe(true);
    removeFontFace();
    expect(document.getElementById('phi-custom-fonts')).toBeNull();
    expect(fontFaceInstalled()).toBe(false);
});

it('revokes the previous object URL on re-inject', () => {
    const revoke = vi.fn();
    vi.stubGlobal(
        'URL',
        Object.assign(URL, {
            createObjectURL: () => 'blob:mock-font',
            revokeObjectURL: revoke,
        }),
    );
    injectFontFace(bytes(10));
    injectFontFace(bytes(11));
    expect(revoke).toHaveBeenCalledWith('blob:mock-font');
    expect(document.querySelectorAll('#phi-custom-fonts')).toHaveLength(1);
});
