import { describe, it, expect } from 'vitest';
import { MessageBuffer } from '../web/chat-pi/message-buffer.js';

const snap = (lastSeq, messages) => ({ lastSeq, messages: messages ?? [] });

describe('MessageBuffer', () => {
    it('applies a snapshot', () => {
        const b = new MessageBuffer();
        b.applySnapshot(snap(3, [{ role: 'user', content: 'hi' }]));
        expect(b.getMessages()).toHaveLength(1);
        expect(b.getLastSeq()).toBe(3);
    });

    it('ignores stale seq and detects gaps (including from zero)', () => {
        const b = new MessageBuffer();
        b.applySnapshot(snap(0));
        expect(b.applyEvent({ seq: 2, evt: 'stateChanged' }).gap).toBe(true);
        const b2 = new MessageBuffer();
        b2.applySnapshot(snap(0));
        expect(b2.applyEvent({ seq: 1 }).gap).toBe(false);
        expect(b2.applyEvent({ seq: 5 }).gap).toBe(true);
    });

    it('assembles deltas and commits message_end as authoritative', () => {
        const b = new MessageBuffer();
        b.applySnapshot(snap(0));
        b.applyEvent({
            seq: 1,
            evt: 'messageStart',
            data: { message: { role: 'assistant' } },
        });
        b.applyEvent({
            seq: 2,
            evt: 'messageUpdate',
            data: {
                assistantMessageEvent: {
                    type: 'text_delta',
                    contentIndex: 0,
                    delta: 'Hel',
                },
            },
        });
        b.applyEvent({
            seq: 3,
            evt: 'messageUpdate',
            data: {
                assistantMessageEvent: {
                    type: 'text_delta',
                    contentIndex: 0,
                    delta: 'lo',
                },
            },
        });
        expect(b.getPartial()).toBe('Hello');
        b.applyEvent({
            seq: 4,
            evt: 'messageEnd',
            data: {
                message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'Hello world' }],
                },
            },
        });
        expect(b.getPartial()).toBe('');
        const msgs = b.getMessages();
        expect(msgs).toHaveLength(1);
        expect(msgs[0].content).toEqual([
            { type: 'text', text: 'Hello world' },
        ]);
    });

    it('transcriptReset forces rehydrate', () => {
        const b = new MessageBuffer();
        b.applySnapshot(snap(0));
        expect(b.applyEvent({ seq: 1, evt: 'transcriptReset' }).gap).toBe(true);
    });
});

describe('MessageBuffer tool-result pairing (rpc.md envelope)', () => {
    // Regression: pi's ToolResultMessage carries toolCallId / toolName /
    // isError at the envelope level. messageEnd must preserve them so
    // getToolResultMap can pair the result with its call — otherwise bash
    // blocks stay "running…" forever in the chat-pi UI.
    it('keeps envelope fields from messageEnd and pairs by toolCallId', () => {
        const b = new MessageBuffer();
        b.applySnapshot(snap(0));
        b.applyEvent({
            seq: 1,
            evt: 'messageEnd',
            data: {
                message: {
                    role: 'toolResult',
                    toolCallId: 'call_9',
                    toolName: 'bash',
                    content: [{ type: 'text', text: 'total 48' }],
                    details: { diff: '-1 old\n+1 new' },
                    isError: true,
                },
            },
        });
        const entry = b.getToolResultMap().get('call_9');
        expect(entry).toBeDefined();
        expect(entry.isError).toBe(true);
        expect(entry.message.toolName).toBe('bash');
        expect(entry.message.content).toEqual([
            { type: 'text', text: 'total 48' },
        ]);
        expect(entry.message.details).toEqual({
            diff: '-1 old\n+1 new',
        });
    });

    it('retains details for hydrated and live tool results', () => {
        const hydrated = new MessageBuffer();
        hydrated.applySnapshot(
            snap(4, [
                {
                    role: 'toolResult',
                    toolCallId: 'hydrate-1',
                    content: [{ type: 'text', text: 'saved' }],
                    details: { diff: '+1 saved' },
                },
            ]),
        );
        expect(
            hydrated.getToolResultMap().get('hydrate-1').message.details,
        ).toEqual({ diff: '+1 saved' });

        const live = new MessageBuffer();
        live.applySnapshot(snap(0));
        live.applyEvent({
            seq: 1,
            evt: 'messageEnd',
            data: {
                message: {
                    role: 'toolResult',
                    toolCallId: 'live-1',
                    content: [{ type: 'text', text: 'live' }],
                    details: { diff: '-1 old\n+1 live' },
                },
            },
        });
        expect(live.getToolResultMap().get('live-1').message.details).toEqual({
            diff: '-1 old\n+1 live',
        });
    });

    it('still pairs legacy content-item toolCallId shapes', () => {
        const b = new MessageBuffer();
        b.applySnapshot(
            snap(2, [
                {
                    role: 'toolResult',
                    content: [{ toolCallId: 'old_1', text: 'out' }],
                },
            ]),
        );
        expect(b.getToolResultMap().get('old_1')).toBeDefined();
    });
});

describe('MessageBuffer accessors and render disposition', () => {
    it('getMessages returns a shallow copy; getMessageCount matches length', () => {
        const b = new MessageBuffer();
        b.applySnapshot(
            snap(3, [
                { role: 'user', content: 'a' },
                { role: 'assistant', content: 'b' },
                { role: 'user', content: 'c' },
            ]),
        );
        // getMessages returns a defensive shallow copy.
        const copy = b.getMessages();
        expect(copy).toHaveLength(3);
        expect(copy).not.toBe(b.getMessageView());
        // Mutating the copy must not leak back into the buffer.
        copy.push({ role: 'user', content: 'extra' });
        expect(b.getMessageCount()).toBe(3);
        expect(b.getMessageView()).toHaveLength(3);
    });

    it('populates the incremental tool-result index from hydrated snapshots', () => {
        const b = new MessageBuffer();
        b.applySnapshot(
            snap(2, [
                {
                    role: 'toolResult',
                    toolCallId: 'h-1',
                    content: [{ type: 'text', text: 'out' }],
                },
                { role: 'assistant', content: 'between' },
                {
                    role: 'toolResult',
                    toolCallId: 'h-2',
                    content: [{ type: 'text', text: 'out2' }],
                },
            ]),
        );
        const map = b.getToolResultMap();
        expect(map.get('h-1').message.content).toEqual([
            { type: 'text', text: 'out' },
        ]);
        expect(map.get('h-2').message.content).toEqual([
            { type: 'text', text: 'out2' },
        ]);
        expect(map.size).toBe(2);
    });

    it('updates the index on live messageEnd and drops stale entries on snapshot replacement', () => {
        const b = new MessageBuffer();
        b.applySnapshot(snap(1, [{ role: 'user', content: 'go' }]));
        expect(b.getToolResultMap().size).toBe(0);

        b.applyEvent({
            seq: 2,
            evt: 'messageEnd',
            data: {
                message: {
                    role: 'toolResult',
                    toolCallId: 'live-1',
                    content: [{ type: 'text', text: 'fresh' }],
                    isError: false,
                },
            },
        });
        expect(b.getToolResultMap().get('live-1').message.content).toEqual([
            { type: 'text', text: 'fresh' },
        ]);

        // Snapshot replacement must drop the stale 'live-1' entry.
        b.applySnapshot(snap(0, []));
        expect(b.getToolResultMap().size).toBe(0);
    });

    it('reports render disposition "full" on messageEnd and "partial" on text_delta', () => {
        const b = new MessageBuffer();
        b.applySnapshot(snap(0));
        b.applyEvent({
            seq: 1,
            evt: 'messageStart',
            data: { message: { role: 'assistant' } },
        });
        // No partial yet, so disposition is 'none'.
        const r = b.applyEvent({
            seq: 2,
            evt: 'messageUpdate',
            data: {
                assistantMessageEvent: {
                    type: 'text_delta',
                    contentIndex: 0,
                    delta: 'hi',
                },
            },
        });
        expect(r.renderDisposition).toBe('partial');
        const end = b.applyEvent({
            seq: 3,
            evt: 'messageEnd',
            data: {
                message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'hi' }],
                },
            },
        });
        expect(end.renderDisposition).toBe('full');
    });

    it('reports "partial-clear" when messageStart replaces a non-empty partial', () => {
        const b = new MessageBuffer();
        b.applySnapshot(snap(0));
        b.applyEvent({
            seq: 1,
            evt: 'messageStart',
            data: { message: { role: 'assistant' } },
        });
        b.applyEvent({
            seq: 2,
            evt: 'messageUpdate',
            data: {
                assistantMessageEvent: {
                    type: 'text_delta',
                    contentIndex: 0,
                    delta: 'still streaming',
                },
            },
        });
        const clear = b.applyEvent({
            seq: 3,
            evt: 'messageStart',
            data: { message: { role: 'assistant' } },
        });
        expect(clear.renderDisposition).toBe('partial-clear');
        expect(b.getPartial()).toBe('');
    });

    it('reports "none" for messageStart when no partial was open', () => {
        const b = new MessageBuffer();
        b.applySnapshot(snap(0));
        const r = b.applyEvent({
            seq: 1,
            evt: 'messageStart',
            data: { message: { role: 'assistant' } },
        });
        expect(r.renderDisposition).toBe('none');
    });

    it('reports "none" for non-text_delta messageUpdate event kinds', () => {
        const b = new MessageBuffer();
        b.applySnapshot(snap(0));
        b.applyEvent({
            seq: 1,
            evt: 'messageStart',
            data: { message: { role: 'assistant' } },
        });
        const r = b.applyEvent({
            seq: 2,
            evt: 'messageUpdate',
            data: {
                assistantMessageEvent: {
                    type: 'thinking_start',
                    contentIndex: 0,
                },
            },
        });
        expect(r.renderDisposition).toBe('none');
    });

    it('reports "none" for stateChanged events (Milestone 2 branching)', () => {
        const b = new MessageBuffer();
        b.applySnapshot(snap(0));
        const r = b.applyEvent({
            seq: 1,
            evt: 'stateChanged',
            data: { busy: true },
        });
        expect(r.renderDisposition).toBe('none');
        // Gap detection still wins over disposition.
        const g = b.applyEvent({ seq: 5, evt: 'stateChanged' });
        expect(g.gap).toBe(true);
        expect(g.renderDisposition).toBe('none');
    });

    it('ignores non-text_delta assistantMessageEvent types', () => {
        const b = new MessageBuffer();
        b.applySnapshot(snap(0));
        b.applyEvent({
            seq: 1,
            evt: 'messageStart',
            data: { message: { role: 'assistant' } },
        });
        const r = b.applyEvent({
            seq: 2,
            evt: 'messageUpdate',
            data: {
                assistantMessageEvent: {
                    type: 'thinking_start',
                    contentIndex: 0,
                },
            },
        });
        expect(r.renderDisposition).toBe('none');
        expect(b.getPartial()).toBe('');
    });

    it('exposes a structured transcript source whose length is captured at call time', () => {
        const b = new MessageBuffer();
        b.applySnapshot(snap(2, [{ role: 'user', content: 'go' }]));
        const source = b.getStructuredTranscript();
        expect(source.length).toBe(1);
        const slice = source.slice(0, 1);
        expect(slice).toHaveLength(1);
        expect(slice[0].role).toBe('user');
        // The captured length stays stable even when the buffer grows.
        b.applyEvent({
            seq: 3,
            evt: 'messageEnd',
            data: {
                message: { role: 'assistant', content: 'answer' },
            },
        });
        expect(source.length).toBe(1);
        // A fresh source reads the new length.
        expect(b.getStructuredTranscript().length).toBe(2);
    });
});
