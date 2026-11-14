import { describe, expect, it } from 'vitest';
import {
    parseInheritedFamilies,
    parseMobileAppearance,
} from '../web/mobile-appearance.js';

// The appearance payload is cached in localStorage and read back on every
// boot, so the parser is the only thing standing between a corrupt or
// future-server payload and a reset of every saved setting. Each case below is
// a behavior the previous hand-written validators enforced.
const base = {
    revision: 0,
    ui_font_size: null,
    terminal_font_size: null,
    ui_font_family: null,
    terminal_font_family: null,
};

const appearance = (patch = {}) => ({ ...base, ...patch });
const without = (key, patch = {}) => {
    const copy = appearance(patch);
    delete copy[key];
    return copy;
};

describe('parseMobileAppearance', () => {
    it('accepts the empty record', () => {
        expect(parseMobileAppearance(base)).toEqual(base);
    });

    it('accepts and strips unknown fields from a newer server', () => {
        const parsed = parseMobileAppearance(
            appearance({ future_field: 'x', another: 2 }),
        );
        expect(parsed).toEqual(base);
        expect(parsed && Object.hasOwn(parsed, 'future_field')).toBe(false);
    });

    it('rejects a payload with a missing key instead of defaulting it', () => {
        expect(parseMobileAppearance(without('terminal_font_size'))).toBeNull();
        expect(parseMobileAppearance(without('ui_font_family'))).toBeNull();
    });

    it('rejects a non-object payload', () => {
        for (const value of [null, undefined, 0, '', 'x', [], true]) {
            expect(parseMobileAppearance(value), String(value)).toBeNull();
        }
    });

    it('requires a non-negative safe integer revision', () => {
        expect(
            parseMobileAppearance(appearance({ revision: 0 })),
        ).not.toBeNull();
        expect(parseMobileAppearance(appearance({ revision: -1 }))).toBeNull();
        expect(parseMobileAppearance(appearance({ revision: 1.5 }))).toBeNull();
        expect(
            parseMobileAppearance(appearance({ revision: 2 ** 53 })),
        ).toBeNull();
        expect(parseMobileAppearance(appearance({ revision: '1' }))).toBeNull();
    });

    it('bounds the font sizes and keeps null as "unset"', () => {
        expect(
            parseMobileAppearance(appearance({ ui_font_size: 10 })),
        ).not.toBeNull();
        expect(
            parseMobileAppearance(appearance({ ui_font_size: 24 })),
        ).not.toBeNull();
        for (const bad of [9, 25, 10.5, '17', Number.NaN]) {
            expect(
                parseMobileAppearance(appearance({ ui_font_size: bad })),
            ).toBeNull();
        }
        expect(
            parseMobileAppearance(appearance({ terminal_font_size: 8 })),
        ).not.toBeNull();
        expect(
            parseMobileAppearance(appearance({ terminal_font_size: 32 })),
        ).not.toBeNull();
        for (const bad of [7, 33, 12.5]) {
            expect(
                parseMobileAppearance(appearance({ terminal_font_size: bad })),
            ).toBeNull();
        }
    });

    it('caps font families at 512 UTF-8 bytes, not code units', () => {
        const at = 'a'.repeat(512);
        expect(
            parseMobileAppearance(appearance({ ui_font_family: at })),
        ).not.toBeNull();
        expect(
            parseMobileAppearance(appearance({ ui_font_family: `${at}a` })),
        ).toBeNull();
        // 'é' is one UTF-16 code unit but two UTF-8 bytes.
        expect(
            parseMobileAppearance(
                appearance({ terminal_font_family: 'é'.repeat(256) }),
            ),
        ).not.toBeNull();
        expect(
            parseMobileAppearance(
                appearance({ terminal_font_family: 'é'.repeat(257) }),
            ),
        ).toBeNull();
    });

    it('rejects control characters in a font family', () => {
        const control = String.fromCharCode(7);
        expect(
            parseMobileAppearance(
                appearance({ ui_font_family: `Inter${control}` }),
            ),
        ).toBeNull();
        expect(
            parseMobileAppearance(
                appearance({ terminal_font_family: 'ok, monospace' }),
            ),
        ).not.toBeNull();
    });

    it('accepts null families', () => {
        expect(
            parseMobileAppearance(
                appearance({
                    ui_font_family: null,
                    terminal_font_family: null,
                }),
            ),
        ).toEqual(base);
    });
});

describe('parseInheritedFamilies', () => {
    const families = { ui_font_family: 'Inter', terminal_font_family: 'Menlo' };

    it('accepts two non-empty strings', () => {
        expect(parseInheritedFamilies(families)).toEqual(families);
    });

    it('rejects null families, which the appearance schema allows', () => {
        expect(
            parseInheritedFamilies({ ...families, ui_font_family: null }),
        ).toBeNull();
        expect(parseInheritedFamilies({ ui_font_family: 'Inter' })).toBeNull();
    });

    it('applies the byte cap and the control-character rule', () => {
        expect(
            parseInheritedFamilies({
                ...families,
                ui_font_family: 'a'.repeat(513),
            }),
        ).toBeNull();
        expect(
            parseInheritedFamilies({
                ...families,
                terminal_font_family: `M${String.fromCharCode(27)}`,
            }),
        ).toBeNull();
    });
});
