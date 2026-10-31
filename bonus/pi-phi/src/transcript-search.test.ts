import { describe, expect, it } from 'vitest';
import {
    MAX_TRANSCRIPT_ENTRIES_PER_PAGE,
    MAX_TRANSCRIPT_MATCHES_PER_PAGE,
    MAX_TRANSCRIPT_SNIPPET_BYTES,
    searchTranscriptPage,
    type TranscriptSessionManager,
} from './transcript-search.js';

interface Entry {
    id: string;
    parentId: string | null;
    type: string;
    message?: unknown;
}

function manager(
    entries: readonly Entry[],
    leaf = entries.at(-1)?.id ?? null,
): TranscriptSessionManager {
    return {
        getSessionId: () => 'session-1',
        getLeafId: () => leaf,
        getBranch: (fromId) => {
            if (entries.length === 0) return [];
            const end = fromId
                ? entries.findIndex((entry) => entry.id === fromId)
                : entries.length - 1;
            return end < 0 ? [] : entries.slice(0, end + 1);
        },
    };
}

function messageEntry(
    id: string,
    parentId: string | null,
    role: string,
    content: unknown,
): Entry {
    return { id, parentId, type: 'message', message: { role, content } };
}

function initial(query: string, signal = new AbortController().signal) {
    return {
        query,
        expectedSessionId: 'session-1',
        initial: true,
        anchorLeafId: '',
        startIndex: 0,
        signal,
        deadlineAt: Date.now() + 10_000,
    } as const;
}

describe('bounded active-branch transcript search', () => {
    it('searches only visible text with literal case-insensitive matching', async () => {
        const entries = [
            messageEntry('u1', null, 'user', [
                { type: 'image', data: 'secret' },
                { type: 'text', text: 'An exact [literal] phrase.' },
            ]),
            messageEntry('a1', 'u1', 'assistant', [
                { type: 'thinking', thinking: 'private [literal] state' },
                { type: 'text', text: 'Visible answer.' },
            ]),
            messageEntry('t1', 'a1', 'toolResult', 'tool [literal] payload'),
            messageEntry('c1', 't1', 'custom', 'excluded custom content'),
        ];
        const result = await searchTranscriptPage(
            manager(entries),
            initial('[LITERAL]'),
        );
        expect(result).toMatchObject({
            sessionId: 'session-1',
            anchorLeafId: 'c1',
            nextIndex: 4,
            complete: true,
            unavailable: false,
        });
        expect(result.matches).toEqual([
            {
                entryId: 'u1',
                role: 'user',
                snippet: 'An exact [literal] phrase.',
            },
            {
                entryId: 't1',
                role: 'toolResult',
                snippet: 'tool [literal] payload',
            },
        ]);
    });

    it('uses an active-branch leaf snapshot and refuses a sibling anchor', async () => {
        const entries = [
            messageEntry('root', null, 'user', 'needle'),
            messageEntry('left', 'root', 'assistant', 'left branch'),
            messageEntry('right', 'root', 'assistant', 'right branch'),
        ];
        const first = await searchTranscriptPage(
            manager(entries, 'left'),
            initial('needle'),
        );
        expect(first.anchorLeafId).toBe('left');
        expect(first.matches.map((match) => match.entryId)).toEqual(['root']);

        const continuation = await searchTranscriptPage(
            manager(entries, 'right'),
            {
                ...initial('needle'),
                initial: false,
                anchorLeafId: 'left',
                startIndex: 1,
            },
        );
        expect(continuation.unavailable).toBe(true);
        expect(continuation.matches).toEqual([]);
    });

    it('pages over branch entries even when there are no matches', async () => {
        const entries: Entry[] = [];
        for (let i = 0; i < MAX_TRANSCRIPT_ENTRIES_PER_PAGE + 7; i++) {
            entries.push({
                id: `e${i}`,
                parentId: i === 0 ? null : `e${i - 1}`,
                type: 'custom',
            });
        }
        const first = await searchTranscriptPage(
            manager(entries),
            initial('absent'),
        );
        expect(first).toMatchObject({
            nextIndex: MAX_TRANSCRIPT_ENTRIES_PER_PAGE,
            complete: false,
            unavailable: false,
            matches: [],
        });
        const second = await searchTranscriptPage(manager(entries), {
            ...initial('absent'),
            initial: false,
            anchorLeafId: `e${entries.length - 1}`,
            startIndex: first.nextIndex,
        });
        expect(second).toMatchObject({
            nextIndex: entries.length,
            complete: true,
            unavailable: false,
            matches: [],
        });
    });

    it('caps matches and advances the cursor without duplicate rows', async () => {
        const entries: Entry[] = [];
        for (let i = 0; i < MAX_TRANSCRIPT_MATCHES_PER_PAGE + 5; i++) {
            entries.push(
                messageEntry(
                    `e${i}`,
                    i === 0 ? null : `e${i - 1}`,
                    'user',
                    `needle ${i}`,
                ),
            );
        }
        const first = await searchTranscriptPage(
            manager(entries),
            initial('needle'),
        );
        expect(first.matches).toHaveLength(MAX_TRANSCRIPT_MATCHES_PER_PAGE);
        expect(first.nextIndex).toBe(MAX_TRANSCRIPT_MATCHES_PER_PAGE);
        expect(first.complete).toBe(false);
        const second = await searchTranscriptPage(manager(entries), {
            ...initial('needle'),
            initial: false,
            anchorLeafId: `e${entries.length - 1}`,
            startIndex: first.nextIndex,
        });
        expect(second.matches.map((match) => match.entryId)).toEqual([
            'e50',
            'e51',
            'e52',
            'e53',
            'e54',
        ]);
    });

    it('finds matches across UTF-8-bounded text chunks and bounds snippets', async () => {
        const content = `${'x'.repeat(32 * 1024 - 4)}before Needle🙂 after${'z'.repeat(5000)}`;
        const result = await searchTranscriptPage(
            manager([messageEntry('u1', null, 'user', content)]),
            initial('needle🙂'),
        );
        expect(result.unavailable).toBe(false);
        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]?.snippet.toLocaleLowerCase()).toContain(
            'needle🙂',
        );
        expect(
            new TextEncoder().encode(result.matches[0]?.snippet).byteLength,
        ).toBeLessThanOrEqual(MAX_TRANSCRIPT_SNIPPET_BYTES);
    });

    it('finds wider Unicode case folds across a chunk boundary', async () => {
        const content = `${'x'.repeat(32 * 1024 - 5)}Kx tail`;
        const result = await searchTranscriptPage(
            manager([messageEntry('u1', null, 'user', content)]),
            initial('kx'),
        );
        expect(result.unavailable).toBe(false);
        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]?.snippet).toContain('Kx');
    });

    it('treats an empty branch as a complete search and failures as unavailable', async () => {
        const empty = await searchTranscriptPage(
            manager([]),
            initial('needle'),
        );
        expect(empty).toMatchObject({
            anchorLeafId: '',
            nextIndex: 0,
            matches: [],
            complete: true,
            unavailable: false,
        });
        const controller = new AbortController();
        controller.abort();
        const aborted = await searchTranscriptPage(
            manager([]),
            initial('needle', controller.signal),
        );
        expect(aborted).toMatchObject({
            matches: [],
            complete: false,
            unavailable: true,
        });
    });
});
