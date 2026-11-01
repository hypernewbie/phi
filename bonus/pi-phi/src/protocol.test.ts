import { describe, expect, it } from 'vitest';
import {
    CAPABILITY_ATTACHMENTS,
    CAPABILITY_COMPACT,
    CAPABILITY_CONTEXT,
    CAPABILITY_HISTORY,
    CAPABILITY_LIFECYCLE,
    CAPABILITY_MODELS,
    CAPABILITY_STATE,
    CAPABILITY_SYNCBOARD,
    CAPABILITY_THINKING,
    CAPABILITY_TRANSCRIPT_SEARCH,
    isKnownCapability,
    negotiateCapabilities,
} from './protocol.js';
import { PhiToPi, PiToPhi } from './gen/bridge.js';

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
    it('negotiates current capabilities without aliasing older review protocols', () => {
        expect(CAPABILITY_ATTACHMENTS).toBe('pi.attachments.v3');
        expect(CAPABILITY_STATE).toBe('pi.state.v2');
        expect(
            negotiateCapabilities([
                'pi.attachments.v1',
                'pi.attachments.v2',
                'pi.state.v1',
                CAPABILITY_ATTACHMENTS,
                CAPABILITY_STATE,
                CAPABILITY_SYNCBOARD,
            ]),
        ).toEqual([
            CAPABILITY_ATTACHMENTS,
            CAPABILITY_STATE,
            CAPABILITY_SYNCBOARD,
        ]);
        expect(isKnownCapability(CAPABILITY_ATTACHMENTS)).toBe(true);
    });
    it('accepts search v2 but rejects legacy search without dropping lifecycle', () => {
        expect(
            negotiateCapabilities([
                'pi.transcript-search.v1',
                CAPABILITY_TRANSCRIPT_SEARCH,
                CAPABILITY_LIFECYCLE,
            ]),
        ).toEqual([CAPABILITY_TRANSCRIPT_SEARCH, CAPABILITY_LIFECYCLE]);
        expect(isKnownCapability('pi.transcript-search.v1')).toBe(false);
    });
    it('yields empty for empty', () => {
        expect(negotiateCapabilities([])).toEqual([]);
        expect(isKnownCapability('nope')).toBe(false);
        expect(isKnownCapability(CAPABILITY_LIFECYCLE)).toBe(true);
    });
});

describe('transcript search wire allocation', () => {
    it('uses request 26 and response 28, not attachment or state fields', () => {
        const request = PhiToPi.create({
            payload: { $case: 'transcriptSearchRequest', value: {} },
        });
        const response = PiToPhi.create({
            payload: { $case: 'transcriptSearchResponse', value: {} },
        });
        // Length-delimited field tags followed by an empty message.
        expect(Array.from(PhiToPi.encode(request).finish())).toEqual([
            0xd2, 0x01, 0x00,
        ]);
        expect(Array.from(PiToPhi.encode(response).finish())).toEqual([
            0xe2, 0x01, 0x00,
        ]);
    });
});
