import { describe, expect, it } from 'vitest';
import {
    CAPABILITY_ATTACHMENTS,
    CAPABILITY_COMPACT,
    CAPABILITY_CONTEXT,
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
    it('accepts the context and compact capabilities independently', () => {
        expect(negotiateCapabilities([CAPABILITY_CONTEXT])).toEqual([
            CAPABILITY_CONTEXT,
        ]);
        expect(negotiateCapabilities([CAPABILITY_COMPACT])).toEqual([
            CAPABILITY_COMPACT,
        ]);
        expect(
            negotiateCapabilities([CAPABILITY_COMPACT, CAPABILITY_CONTEXT]),
        ).toEqual([CAPABILITY_COMPACT, CAPABILITY_CONTEXT]);
        expect(isKnownCapability(CAPABILITY_CONTEXT)).toBe(true);
        expect(isKnownCapability(CAPABILITY_COMPACT)).toBe(true);
    });
    it('negotiates attachment capability independently', () => {
        expect(negotiateCapabilities([CAPABILITY_ATTACHMENTS])).toEqual([
            CAPABILITY_ATTACHMENTS,
        ]);
        expect(isKnownCapability(CAPABILITY_ATTACHMENTS)).toBe(true);
    });
    it('yields empty for empty', () => {
        expect(negotiateCapabilities([])).toEqual([]);
        expect(isKnownCapability('nope')).toBe(false);
        expect(isKnownCapability(CAPABILITY_LIFECYCLE)).toBe(true);
    });
});
