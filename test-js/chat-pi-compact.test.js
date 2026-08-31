// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createReviewTranscriptView } from '../web/review-transcript.js';

function mkMsg(id, role, text) {
    return {
        id,
        role,
        segments: [{ kind: 'text', text }],
        stopReason: null,
        errorMessage: null,
    };
}

function countBlocks(root, sel) {
    return root.querySelectorAll(sel).length;
}

describe('compact robust A — keep + file on-demand with id dedup', () => {
    let root;
    beforeEach(() => {
        root = document.createElement('div');
        document.body.replaceChildren(root);
    });

    it('keeps old history dimmed with divider, not blank, after compact', () => {
        const view = createReviewTranscriptView(root, {
            title: 'Pi',
            coder: 'pi',
            mode: 'structured',
            windowSize: 100,
            pageSize: 10,
        });
        const old = Array.from({ length: 5 }, (_, i) =>
            mkMsg(`old-${i}`, i % 2 === 0 ? 'user' : 'assistant', `old ${i}`),
        );
        view.setStructuredMessages(old, '', new Map());
        expect(countBlocks(root, '.user-message')).toBeGreaterThan(0);
        // snapshot before compact
        view.setCompactSnapshot({
            messages: old,
            from: old.length,
            kept: 2,
            summary: 'compact summary',
            at: Date.now(),
        });
        const live = [
            mkMsg('new-1', 'assistant', 'new 1'),
            mkMsg('new-2', 'user', 'new 2'),
        ];
        view.setStructuredMessages(live, '', new Map());
        // Should show old dimmed + divider + live, not blank (badge may still read Start but old history must be visible)
        expect(root.querySelector('.compaction-divider')).not.toBeNull();
        expect(root.textContent).toContain('Compacted');
        expect(root.textContent).toContain('compact summary');
        expect(countBlocks(root, '.compacted-old')).toBe(old.length);
        expect(root.textContent).toContain('new 1');
    });

    it('dedups by id — hi hi duplication is impossible', () => {
        const view = createReviewTranscriptView(root, {
            title: 'Pi',
            coder: 'pi',
            mode: 'structured',
            windowSize: 100,
            pageSize: 10,
        });
        const hi = mkMsg('hi-id', 'user', 'hi');
        const old = [hi];
        view.setCompactSnapshot({
            messages: old,
            from: 1,
            kept: 1,
            summary: null,
            at: Date.now(),
        });
        // live also contains same hi (as would happen if we naively re-read jsonl after compact)
        const liveWithDup = [
            mkMsg('hi-id', 'user', 'hi'),
            mkMsg('new-2', 'assistant', 'after'),
        ];
        view.setStructuredMessages(liveWithDup, '', new Map());
        const userBlocks = [...root.querySelectorAll('.user-message')].map(
            (n) => n.textContent,
        );
        // Only one hi should appear (dedup), not hi hi
        const hiCount = userBlocks.filter((t) => t.includes('hi')).length;
        expect(hiCount).toBe(1);
        expect(root.textContent).toContain('after');
    });

    it('window slides over combined [snapshot + divider + live] and Load older works', () => {
        const view = createReviewTranscriptView(root, {
            title: 'Pi',
            coder: 'pi',
            mode: 'structured',
            windowSize: 2,
            pageSize: 1,
        });
        const old = Array.from({ length: 5 }, (_, i) =>
            mkMsg(`o-${i}`, 'user', `o-${i}`),
        );
        view.setCompactSnapshot({
            messages: old,
            from: 5,
            kept: 1,
            summary: null,
            at: Date.now(),
        });
        const live = [mkMsg('n-1', 'assistant', 'n-1')];
        view.setStructuredMessages(live, '', new Map());
        // total logical length = 5 +1 +1 =7, window 2 at newest shows last 2
        // prependOlder should slide and eventually expose old history
        let steps = 0;
        while (view.prependOlder(1) && steps < 10) steps++;
        expect(steps).toBeGreaterThan(0);
        expect(root.textContent).toContain('o-0');
    });

    it('new incognito: loadCompactSnapshotFromFile on demand fetches old pre-compact turns with id dedup', async () => {
        const view = createReviewTranscriptView(root, {
            title: 'Pi',
            coder: 'pi',
            mode: 'structured',
            windowSize: 100,
            pageSize: 10,
        });
        const live = [mkMsg('live-1', 'assistant', 'live 1')];
        view.setStructuredMessages(live, '', new Map());
        expect(view.hasCompactSnapshot()).toBe(false);
        const fakeJsonl = [
            JSON.stringify({
                type: 'message',
                message: mkMsg('old-1', 'user', 'old 1'),
            }),
            JSON.stringify({
                type: 'message',
                message: mkMsg('old-2', 'user', 'old 2'),
            }),
            JSON.stringify({
                type: 'compaction',
                summary: 'file summary',
                firstKeptEntryId: 'live-1',
            }),
            JSON.stringify({
                type: 'message',
                message: mkMsg('live-1', 'assistant', 'live 1'),
            }),
            // duplicate live id after compaction should be ignored
            JSON.stringify({
                type: 'message',
                message: mkMsg('live-1', 'assistant', 'live 1 dup'),
            }),
        ].join('\n');
        const fetchImpl = vi.fn(async (url) => {
            if (String(url).includes('/api/sessions')) {
                return {
                    ok: true,
                    json: async () => ({
                        sessions: [{ path: '/tmp/fake.jsonl' }],
                    }),
                };
            }
            if (String(url).includes('/api/fs/read')) {
                return { ok: true, text: async () => fakeJsonl };
            }
            return { ok: false };
        });
        const loaded = await view.loadCompactSnapshotFromFile({
            cwd: '/work/demo',
            fetchImpl,
        });
        expect(loaded).toBe(true);
        expect(view.hasCompactSnapshot()).toBe(true);
        expect(root.textContent).toContain('old 1');
        expect(root.textContent).toContain('old 2');
        expect(root.textContent).toContain('live 1');
        // Ensure dup live id not duplicated as old
        const liveCount = (root.textContent.match(/live 1/g) || []).length;
        expect(liveCount).toBe(1);
        expect(root.querySelector('.compaction-divider')).not.toBeNull();
    });

    it('file on-demand merges without hi hi when live already has hi', async () => {
        const view = createReviewTranscriptView(root, {
            title: 'Pi',
            coder: 'pi',
            mode: 'structured',
            windowSize: 100,
            pageSize: 10,
        });
        const hiLive = mkMsg('hi-id', 'user', 'hi');
        view.setStructuredMessages([hiLive], '', new Map());
        const fakeJsonl = [
            JSON.stringify({
                type: 'message',
                message: mkMsg('hi-id', 'user', 'hi old'),
            }),
            JSON.stringify({ type: 'compaction', summary: 's' }),
            JSON.stringify({
                type: 'message',
                message: mkMsg('hi-id', 'user', 'hi'),
            }),
        ].join('\n');
        const fetchImpl = vi.fn(async (url) => {
            if (String(url).includes('/api/fs/read'))
                return { ok: true, text: async () => fakeJsonl };
            return { ok: false, json: async () => ({ sessions: [] }) };
        });
        // Direct file read via explicit path
        const loaded = await view.loadCompactSnapshotFromFile({
            sessionPath: '/tmp/x.jsonl',
            fetchImpl,
        });
        // hi-id already in live, so old hi should be deduped and not create duplicate snapshot
        expect(loaded).toBe(false);
        expect(view.hasCompactSnapshot()).toBe(false);
    });
});
