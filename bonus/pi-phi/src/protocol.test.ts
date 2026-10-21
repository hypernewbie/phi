import { describe, expect, it } from 'vitest';
import {
    CAPABILITY_LIFECYCLE,
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
    it('yields empty for empty', () => {
        expect(negotiateCapabilities([])).toEqual([]);
        expect(isKnownCapability('nope')).toBe(false);
        expect(isKnownCapability(CAPABILITY_LIFECYCLE)).toBe(true);
    });
});
