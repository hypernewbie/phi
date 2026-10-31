// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createReviewTranscriptView } from '../web/review-transcript.js';
import { MessageBuffer } from '../web/chat-pi/message-buffer.js';

function mountView(windowSize = 100) {
    const root = document.createElement('div');
    const view = createReviewTranscriptView(root, {
        title: 'Pi RPC',
        coder: 'pi-rpc',
        status: 'Ready',
        mode: 'structured',
        windowSize,
        pageSize: 50,
    });
    return { root, view };
}

function subscribe(view, query) {
    const updates = [];
    const waiters = [];
    const wait = (predicate) => {
        const existing = updates.find(predicate);
        if (existing) return Promise.resolve(existing);
        return new Promise((resolve) => waiters.push({ predicate, resolve }));
    };
    const cancel = view.searchStructured(query, (update) => {
        updates.push(update);
        for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].predicate(update)) {
                waiters[i].resolve(update);
                waiters.splice(i, 1);
            }
        }
    });
    return { updates, wait, cancel };
}

function userMessage(text) {
    return { role: 'user', content: text };
}

describe('ReviewTranscriptView local search', () => {
    it('finds a literal Unicode query outside the DOM window and reveals its row', async () => {
        const buffer = new MessageBuffer();
        const messages = Array.from({ length: 220 }, (_, index) =>
            userMessage(
                index === 4
                    ? 'Early needle[0].* — crème BRÛLÉE'
                    : `ordinary transcript row ${index}`,
            ),
        );
        buffer.applySnapshot({ lastSeq: 220, messages });
        const { root, view } = mountView(100);
        view.setStructuredMessages(
            buffer.getStructuredTranscript(),
            '',
            buffer.getToolResultMap(),
        );
        const input = document.createElement('input');
        document.body.append(input);
        input.focus();

        expect(root.querySelector('[data-pi-message-index="4"]')).toBeNull();
        const search = subscribe(view, 'NEEDLE[0].*');
        const update = await search.wait((state) => state.complete);

        expect(update.results).toHaveLength(1);
        expect(update.results[0]).toMatchObject({
            combinedIndex: 4,
            kind: 'message',
        });
        expect(update.results[0].snippet).toContain('needle[0].*');
        expect(view.revealSearchResult(update.results[0])).toBe(true);
        expect(
            root.querySelector('[data-pi-message-index="4"]'),
        ).not.toBeNull();
        expect(
            root.querySelectorAll('[data-pi-message-index]').length,
        ).toBeLessThanOrEqual(100);
        expect(document.activeElement).toBe(input);

        const unicode = subscribe(view, 'brûlée');
        const unicodeUpdate = await unicode.wait((state) => state.complete);
        expect(unicodeUpdate.results[0].combinedIndex).toBe(4);
        search.cancel();
        unicode.cancel();
        input.remove();
    });

    it('searches tool names, declared arguments, and output; paired output reveals its call', async () => {
        const buffer = new MessageBuffer();
        buffer.applySnapshot({
            lastSeq: 2,
            messages: [
                {
                    role: 'assistant',
                    content: [
                        {
                            type: 'toolCall',
                            id: 'call-1',
                            name: 'bash',
                            arguments: { command: 'print result' },
                        },
                    ],
                },
                {
                    role: 'toolResult',
                    toolCallId: 'call-1',
                    content: [{ type: 'text', text: 'paired output needle' }],
                },
            ],
        });
        const { root, view } = mountView(1);
        view.setStructuredMessages(
            buffer.getStructuredTranscript(),
            '',
            buffer.getToolResultMap(),
        );

        const search = subscribe(view, 'output needle');
        const update = await search.wait((state) => state.complete);
        expect(update.results).toHaveLength(1);
        expect(update.results[0].combinedIndex).toBe(0);
        expect(update.results[0].snippet).toContain('output needle');
        expect(view.revealSearchResult(update.results[0])).toBe(true);
        expect(
            root.querySelector('[data-pi-message-index="0"]'),
        ).not.toBeNull();
        expect(root.textContent).toContain('paired output needle');
        expect(root.querySelectorAll('[data-pi-message-index]').length).toBe(1);
        search.cancel();

        const args = subscribe(view, 'print result');
        expect(
            (await args.wait((state) => state.complete)).results[0]
                .combinedIndex,
        ).toBe(0);
        args.cancel();

        const toolName = subscribe(view, 'bash');
        expect(
            (await toolName.wait((state) => state.complete)).results[0]
                .combinedIndex,
        ).toBe(0);
        toolName.cancel();
    });

    it('searches compaction summaries at their combined index and rejects stale results', async () => {
        const buffer = new MessageBuffer();
        buffer.applySnapshot({
            lastSeq: 1,
            messages: [userMessage('live tail')],
        });
        const { root, view } = mountView(10);
        view.setStructuredMessages(
            buffer.getStructuredTranscript(),
            '',
            buffer.getToolResultMap(),
        );
        view.setCompactSnapshot({
            messages: [
                {
                    role: 'user',
                    segments: [{ kind: 'text', text: 'compacted entry' }],
                    id: 'old-entry',
                },
            ],
            ids: new Set(['old-entry']),
            summary: 'Earlier summary marker',
            from: 8,
            kept: 1,
        });
        view.setStructuredMessages(
            buffer.getStructuredTranscript(),
            '',
            buffer.getToolResultMap(),
        );

        const search = subscribe(view, 'summary marker');
        const update = await search.wait((state) => state.complete);
        expect(update.results[0]).toMatchObject({
            combinedIndex: 1,
            kind: 'summary',
        });
        expect(view.revealSearchResult(update.results[0])).toBe(true);
        expect(
            root.querySelector('.compaction-block[data-pi-message-index="1"]'),
        ).not.toBeNull();

        view.clearCompactSnapshot();
        expect(view.revealSearchResult(update.results[0])).toBe(false);
        search.cancel();
    });

    it('continues append-only scans at the same revision and stops at 200 results', async () => {
        const buffer = new MessageBuffer();
        buffer.applySnapshot({
            lastSeq: 1,
            messages: [userMessage('needle first')],
        });
        const { view } = mountView(1);
        view.setStructuredMessages(
            buffer.getStructuredTranscript(),
            '',
            buffer.getToolResultMap(),
        );
        const search = subscribe(view, 'needle');
        const first = await search.wait((state) => state.complete);

        buffer.applyEvent({
            seq: 2,
            evt: 'messageEnd',
            data: { message: { role: 'user', content: 'needle appended' } },
        });
        view.setStructuredMessages(
            buffer.getStructuredTranscript(),
            '',
            buffer.getToolResultMap(),
        );
        const appended = await search.wait(
            (state) => state.complete && state.results.length === 2,
        );
        expect(appended.revision).toBe(first.revision);
        expect(appended.results.map((result) => result.combinedIndex)).toEqual([
            0, 1,
        ]);

        buffer.applySnapshot({
            lastSeq: 1,
            messages: [userMessage('fresh transcript with no match')],
        });
        view.setStructuredMessages(
            buffer.getStructuredTranscript(),
            '',
            buffer.getToolResultMap(),
        );
        const replaced = await search.wait(
            (state) => state.complete && state.revision !== first.revision,
        );
        expect(replaced.results).toHaveLength(0);
        expect(view.revealSearchResult(first.results[0])).toBe(false);
        search.cancel();

        const many = new MessageBuffer();
        many.applySnapshot({
            lastSeq: 205,
            messages: Array.from({ length: 205 }, (_, index) =>
                userMessage(`needle row ${index}`),
            ),
        });
        const cappedView = mountView(100).view;
        cappedView.setStructuredMessages(
            many.getStructuredTranscript(),
            '',
            many.getToolResultMap(),
        );
        const capped = subscribe(cappedView, 'needle');
        const result = await capped.wait((state) => state.capped);
        expect(result.results).toHaveLength(200);
        expect(result.complete).toBe(false);
        expect(result.results.at(-1).combinedIndex).toBe(199);
        capped.cancel();
    });

    it('searches a field across bounded chunks and cancels without publishing stale work', async () => {
        const buffer = new MessageBuffer();
        const large = `${'x'.repeat(32766)}needle[0]${'y'.repeat(40_000)}`;
        buffer.applySnapshot({ lastSeq: 1, messages: [userMessage(large)] });
        const { view } = mountView(10);
        view.setStructuredMessages(
            buffer.getStructuredTranscript(),
            '',
            buffer.getToolResultMap(),
        );
        const search = subscribe(view, 'needle[0]');
        const update = await search.wait((state) => state.complete);
        expect(update.results).toHaveLength(1);
        expect(update.results[0].snippet).toContain('needle[0]');
        search.cancel();

        const cancelled = subscribe(view, 'x');
        cancelled.cancel();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(cancelled.updates).toHaveLength(1);
    });
});
