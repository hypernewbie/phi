import { describe, expect, it } from 'vitest';
import { v } from '../web/valibot.js';

// Guards the shipped browser runtime, not valibot itself: a facade that stops
// exporting a function breaks every converted module at load time. Schema
// behavior is covered by the modules that use it.
describe('shipped valibot runtime', () => {
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
