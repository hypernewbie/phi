import { describe, expect, it } from 'vitest';
import { v } from '../web/valibot.js';

// Guards the shipped browser runtime, not valibot itself: a facade that stops
// exporting a function, or a bundle that is not self-contained, breaks every
// converted module at load time. The UTF-8 byte cap matters because font
// families are capped in bytes, not UTF-16 code units.
describe('shipped valibot runtime', () => {
    it('accepts a valid payload and strips an unknown field', () => {
        const schema = v.object({ id: v.string() });
        const parsed = v.safeParse(schema, { id: 'a', extra: 1 });
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.output).toEqual({ id: 'a' });
    });

    it('rejects a wrong type without throwing', () => {
        const parsed = v.safeParse(v.object({ id: v.string() }), { id: 7 });
        expect(parsed.success).toBe(false);
    });

    it('enforces the 512-byte UTF-8 cap used by font families', () => {
        const family = v.pipe(v.string(), v.maxBytes(512));
        expect(v.safeParse(family, 'a'.repeat(512)).success).toBe(true);
        expect(v.safeParse(family, 'a'.repeat(513)).success).toBe(false);
        expect(v.safeParse(family, 'é'.repeat(256)).success).toBe(true);
        expect(v.safeParse(family, 'é'.repeat(257)).success).toBe(false);
    });

    it('exposes every function the facade declares', () => {
        const expected = [
            'array',
            'boolean',
            'check',
            'exactOptional',
            'fallback',
            'finite',
            'integer',
            'literal',
            'maxBytes',
            'maxLength',
            'maxValue',
            'minLength',
            'minValue',
            'null',
            'nullable',
            'number',
            'object',
            'optional',
            'picklist',
            'pipe',
            'record',
            'safeInteger',
            'safeParse',
            'string',
            'strictObject',
            'transform',
            'union',
            'unknown',
        ];
        expect(Object.keys(v).sort()).toEqual(expected.sort());
        for (const name of expected) {
            expect(typeof v[name], name).toBe('function');
        }
    });
});
