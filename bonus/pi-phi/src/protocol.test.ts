import { describe, expect, it } from 'vitest';
import {
    CAPABILITY_HISTORY,
    CAPABILITY_LIFECYCLE,
    CAPABILITY_MODELS,
    CAPABILITY_THINKING,
    isKnownCapability,
    negotiateCapabilities,
} from './protocol.js';

describe('negotiateCapabilities', () => {
    it('accepts known and ignores unknown', () => {
        expect(
            negotiateCapabilities([CAPABILITY_LIFECYCLE, 'future.v9']),
        ).toEqual([CAPABILITY_LIFECYCLE]);
    });
    it('dedupes and preserves order', () => {
        expect(
            negotiateCapabilities([CAPABILITY_LIFECYCLE, CAPABILITY_LIFECYCLE]),
        ).toEqual([CAPABILITY_LIFECYCLE]);
    });
    it('accepts the history capability', () => {
        expect(negotiateCapabilities([CAPABILITY_HISTORY])).toEqual([
            CAPABILITY_HISTORY,
        ]);
        expect(isKnownCapability(CAPABILITY_HISTORY)).toBe(true);
    });
    it('accepts the models capability', () => {
        expect(negotiateCapabilities([CAPABILITY_MODELS])).toEqual([
            CAPABILITY_MODELS,
        ]);
        expect(isKnownCapability(CAPABILITY_MODELS)).toBe(true);
    });
    it('accepts the thinking capability independently', () => {
        expect(negotiateCapabilities([CAPABILITY_THINKING])).toEqual([
            CAPABILITY_THINKING,
        ]);
        expect(isKnownCapability(CAPABILITY_THINKING)).toBe(true);
    });
    it('yields empty for empty', () => {
        expect(negotiateCapabilities([])).toEqual([]);
        expect(isKnownCapability('nope')).toBe(false);
        expect(isKnownCapability(CAPABILITY_LIFECYCLE)).toBe(true);
    });
});
