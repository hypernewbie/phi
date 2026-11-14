import { describe, expect, it } from 'vitest';
import { normalizeThinkingPresetList } from '../web/thinking-presets.js';

describe('normalizeThinkingPresetList', () => {
    it('keeps the known levels in the given order', () => {
        expect(normalizeThinkingPresetList(['high', 'off'])).toEqual([
            'high',
            'off',
        ]);
        expect(normalizeThinkingPresetList([])).toEqual([]);
    });

    it('returns a copy rather than the input array', () => {
        const levels = ['high'];
        expect(normalizeThinkingPresetList(levels)).not.toBe(levels);
    });

    it('rejects an unknown level, a duplicate, or a non-string', () => {
        for (const value of [
            ['turbo'],
            ['high', 'high'],
            ['high', 1],
            ['HIGH'],
        ]) {
            expect(
                normalizeThinkingPresetList(value),
                JSON.stringify(value),
            ).toBeNull();
        }
    });

    it('rejects anything that is not an array', () => {
        for (const value of [null, undefined, 'high', { levels: ['high'] }]) {
            expect(normalizeThinkingPresetList(value)).toBeNull();
        }
    });
});
