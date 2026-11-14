// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { __test__ } from '../web/chat-pi/index.js';

const {
    isCanonicalState,
    mergeState,
    isSnapshot,
    validModels,
    validThinkingLevels,
} = __test__;

// A canonical state is the only message allowed to clear an optional field, so
// the difference between "missing" and "wrong type" decides what the pane
// forgets. These cases pin that boundary exactly.
const canonical = (over = {}) => ({
    sid: 'sid-1',
    title: 'demo',
    cwd: '/work/demo',
    status: 'live',
    busy: false,
    queueDepth: 0,
    inputTokens: 0,
    outputTokens: 0,
    contextUsedTokens: 0,
    contextWindowTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    skills: [],
    ...over,
});

describe('isCanonicalState', () => {
    it('accepts the full state', () => {
        expect(isCanonicalState(canonical(), 'sid-1')).toBe(true);
    });

    it('accepts null metrics and skills', () => {
        expect(
            isCanonicalState(
                canonical({ inputTokens: null, skills: null }),
                'sid-1',
            ),
        ).toBe(true);
    });

    it('requires the sid to match and to be known', () => {
        expect(isCanonicalState(canonical(), 'sid-2')).toBe(false);
        expect(isCanonicalState(canonical(), '')).toBe(false);
    });

    const rejected = {
        null: null,
        'a string': 'state',
        'a missing title': canonical({ title: undefined }),
        'a non-string title': canonical({ title: 7 }),
        'a missing cwd': canonical({ cwd: undefined }),
        'an unknown status': canonical({ status: 'running' }),
        'a non-boolean busy': canonical({ busy: 'yes' }),
        'a negative queueDepth': canonical({ queueDepth: -1 }),
        'a NaN queueDepth': canonical({ queueDepth: Number.NaN }),
        'a missing metric': canonical({ cacheWriteTokens: undefined }),
        'a non-numeric metric': canonical({ outputTokens: '7' }),
        'a NaN metric': canonical({ outputTokens: Number.NaN }),
        'a missing skills key': canonical({ skills: undefined }),
        'skills with a non-string': canonical({ skills: ['a', 1] }),
        'a non-string model': canonical({ model: 7 }),
        'a non-string thinking': canonical({ thinking: false }),
        'a non-string sessionPath': canonical({ sessionPath: 7 }),
    };
    for (const [name, state] of Object.entries(rejected)) {
        it(`rejects ${name}`, () => {
            expect(isCanonicalState(state, 'sid-1')).toBe(false);
        });
    }

    it('accepts the optional strings when they are present', () => {
        expect(
            isCanonicalState(
                canonical({
                    model: 'm',
                    thinking: 'high',
                    sessionPath: '/p.jsonl',
                }),
                'sid-1',
            ),
        ).toBe(true);
    });
});

describe('mergeState', () => {
    const status = (over = {}) => ({
        title: '',
        cwd: '',
        model: 'old',
        thinking: 'low',
        sessionPath: '/old.jsonl',
        inputTokens: 1,
        outputTokens: 1,
        contextUsedTokens: 1,
        contextWindowTokens: 1,
        cacheReadTokens: 1,
        cacheWriteTokens: 1,
        cost: 1,
        skills: null,
        ...over,
    });

    it('ignores a payload that is not an object', () => {
        expect(mergeState(status(), null)).toBe(false);
        expect(mergeState(status(), 'state')).toBe(false);
    });

    it('clears optional fields only for a canonical state', () => {
        const canonicalStatus = status();
        expect(mergeState(canonicalStatus, {}, true)).toBe(true);
        expect(canonicalStatus.model).toBeUndefined();
        expect(canonicalStatus.thinking).toBeUndefined();
        expect(canonicalStatus.sessionPath).toBeUndefined();

        const partial = status();
        expect(mergeState(partial, {}, false)).toBe(false);
        expect(partial.model).toBe('old');
    });

    it('keeps a non-empty optional string from a canonical state', () => {
        const s = status();
        mergeState(s, { model: 'fresh' }, true);
        expect(s.model).toBe('fresh');
    });

    it('clears first, then re-adds an explicitly empty string', () => {
        // The backend omits empty model/thinking (omitempty), so this order is
        // only reachable from a hand-written payload; it is pinned because the
        // clear and the generic string merge disagree about ''.
        const s = status();
        mergeState(s, { model: '', thinking: '' }, true);
        expect(s.model).toBe('');
        expect(s.thinking).toBe('');
    });

    it('ignores a blank title', () => {
        const s = status();
        expect(mergeState(s, { title: '   ' })).toBe(false);
        expect(s.title).toBe('');
    });

    it('sets a null metric and skips an unusable one', () => {
        const s = status();
        expect(mergeState(s, { inputTokens: null })).toBe(true);
        expect(s.inputTokens).toBeNull();
        expect(mergeState(s, { outputTokens: Number.NaN })).toBe(false);
        expect(mergeState(s, { cost: 'free' })).toBe(false);
    });

    it('copies the skills array instead of aliasing it', () => {
        const s = status();
        const skills = ['a', 'b'];
        mergeState(s, { skills });
        expect(s.skills).toEqual(['a', 'b']);
        expect(s.skills).not.toBe(skills);
    });
});

describe('isSnapshot', () => {
    const snapshot = (over = {}) => ({ lastSeq: 0, messages: [], ...over });

    it('accepts a sequence with a message list', () => {
        expect(isSnapshot(snapshot({ lastSeq: 7 }))).toBe(true);
    });

    it('rejects an unusable sequence or message list', () => {
        for (const value of [
            null,
            'x',
            snapshot({ lastSeq: -1 }),
            snapshot({ lastSeq: 1.5 }),
            snapshot({ lastSeq: '7' }),
            snapshot({ messages: undefined }),
            snapshot({ messages: {} }),
        ]) {
            expect(isSnapshot(value), JSON.stringify(value)).toBe(false);
        }
    });
});

describe('validModels', () => {
    it('maps the usable models and keeps a non-empty name', () => {
        expect(
            validModels({
                models: [
                    { provider: 'p', id: 'i', name: 'N' },
                    { provider: 'p', id: 'j' },
                    { provider: 'p', id: 'k', name: '' },
                ],
            }),
        ).toEqual([
            { provider: 'p', id: 'i', name: 'N' },
            { provider: 'p', id: 'j' },
            { provider: 'p', id: 'k' },
        ]);
    });

    it('drops an unusable model but keeps the list', () => {
        expect(
            validModels({
                models: [
                    { provider: '', id: 'i' },
                    { provider: 'p', id: '' },
                    { id: 'i' },
                    null,
                    'junk',
                    { provider: 'p', id: 'kept' },
                ],
            }),
        ).toEqual([{ provider: 'p', id: 'kept' }]);
    });

    it('throws when the list itself is missing', () => {
        for (const value of [null, {}, { models: 'x' }, undefined]) {
            expect(() => validModels(value), JSON.stringify(value)).toThrow(
                'Pi model list is malformed',
            );
        }
    });
});

describe('validThinkingLevels', () => {
    it('returns a copy of the level list', () => {
        const levels = ['low', 'high'];
        const result = validThinkingLevels({ levels });
        expect(result).toEqual(['low', 'high']);
        expect(result).not.toBe(levels);
    });

    it('throws when the list is missing or holds a non-string', () => {
        for (const value of [
            null,
            {},
            { levels: 'high' },
            { levels: ['high', 1] },
        ]) {
            expect(() => validThinkingLevels(value)).toThrow(
                'Pi thinking level list is malformed',
            );
        }
    });
});
