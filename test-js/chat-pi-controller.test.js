// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('../web/chat-pi/client.js', () => ({
    connectControl: vi.fn(),
}));
vi.mock('../web/chat-pi/persist.js', () => ({
    savePersisted: vi.fn(),
}));
vi.mock('../web/review-transcript.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        createReviewTranscriptView: vi.fn(actual.createReviewTranscriptView),
    };
});

import { connectControl } from '../web/chat-pi/client.js';
import { createReviewTranscriptView } from '../web/review-transcript.js';
import { savePersisted } from '../web/chat-pi/persist.js';
import {
    destroyRpcChat,
    getPiRpcStatus,
    mountRpcChat,
    rpcChatInterrupt,
    rpcChatSetName,
    subscribePiRpcStatus,
} from '../web/chat-pi/controller.js';
import { mountChatPi } from '../web/chat-pi/index.js';

function fakeClient() {
    const sent = [];
    let listener = () => {};
    return {
        sent,
        client: {
            send(frame) {
                sent.push(frame);
            },
            onMessage(callback) {
                listener = callback;
                return () => {
                    listener = () => {};
                };
            },
            close() {},
        },
        emit(frame) {
            listener(frame);
        },
    };
}

describe('Pi RPC transcript controller', () => {
    it('rejects a blocked slash command, sends prompts, and renders bubbles', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        const chat = mountChatPi(root, '/work/demo', wire.client);
        expect(chat.send('before bootstrap')).toBe(false);
        expect(wire.sent[0]).toMatchObject({
            op: 'spawn',
            args: { cwd: '/work/demo' },
        });
        expect(wire.sent[0].args.sessionPath).toBeUndefined();
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: {
                sid: 's1',
                title: 'Pi RPC · demo',
                snapshot: {
                    lastSeq: 0,
                    messages: [{ role: 'user', content: 'saved text' }],
                },
            },
        });
        await Promise.resolve();
        await Promise.resolve(); // drain the microtask-coalesced paint()
        expect(createReviewTranscriptView).toHaveBeenCalledWith(
            root,
            expect.objectContaining({ title: 'Pi RPC', coder: '/work/demo' }),
        );
        const view = createReviewTranscriptView.mock.results.at(-1).value;
        const setStructuredMessages = vi.spyOn(view, 'setStructuredMessages');
        const setStructuredPartial = vi.spyOn(view, 'setStructuredPartial');

        expect(root.querySelector('.user-message')?.textContent).toContain(
            'saved text',
        );
        expect(chat.send('/status')).toBe(false);
        expect(chat.send('hello')).toBe(true);
        expect(wire.sent.at(-1)).toMatchObject({
            op: 'prompt',
            sid: 's1',
            args: { message: 'hello', streamingBehavior: 'steer' },
        });

        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'messageEnd',
            data: { message: { role: 'user', content: 'hello' } },
        });
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 2,
            evt: 'messageEnd',
            data: { message: { role: 'assistant', content: 'world' } },
        });
        await Promise.resolve();
        await Promise.resolve(); // drain paint() microtasks
        expect(
            [...root.querySelectorAll('.user-message')].some((node) =>
                node.textContent?.includes('hello'),
            ),
        ).toBe(true);
        expect(root.querySelector('.assistant-message')?.textContent).toContain(
            'world',
        );
        expect(setStructuredMessages).toHaveBeenCalledWith(
            expect.objectContaining({
                length: expect.any(Number),
                slice: expect.any(Function),
            }),
            '',
            expect.any(Map),
        );

        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 3,
            evt: 'messageStart',
            data: { message: { role: 'assistant' } },
        });
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 4,
            evt: 'messageUpdate',
            data: {
                assistantMessageEvent: {
                    type: 'text_delta',
                    delta: 'streaming',
                },
            },
        });
        await Promise.resolve();
        await Promise.resolve(); // drain paint() microtask
        // Milestone 2: streaming `text_delta` no longer triggers a full
        // structured repaint. The narrow live-text path uses
        // setStructuredPartial instead, leaving setStructuredMessages
        // untouched for partials.
        const structuredCallsBeforeStreaming =
            setStructuredMessages.mock.calls.length;
        expect(setStructuredPartial).toHaveBeenLastCalledWith('streaming');
        expect(root.querySelector('.pi-partial')?.textContent).toBe(
            'streaming',
        );
        expect(setStructuredMessages.mock.calls.length).toBe(
            structuredCallsBeforeStreaming,
        );
        // Settling the partial via messageEnd runs the normal full paint
        // and clears the live block.
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 5,
            evt: 'messageEnd',
            data: {
                message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'streaming world' }],
                },
            },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(setStructuredMessages.mock.calls.length).toBe(
            structuredCallsBeforeStreaming + 1,
        );
        expect(root.querySelector('.pi-streaming')).toBeNull();
    });

    it('reconciles an accepted prompt when Pi emits the user event first', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        const chat = mountChatPi(root, '/work/event-first', wire.client);
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: {
                sid: 's1',
                snapshot: { lastSeq: 0, messages: [] },
                state: { busy: true },
            },
        });
        await Promise.resolve();
        await Promise.resolve();
        const view = createReviewTranscriptView.mock.results.at(-1).value;
        const setActiveTurn = vi.spyOn(view, 'setActiveTurn');
        expect(chat.send('event first')).toBe(true);
        const prompt = wire.sent.find((frame) => frame.op === 'prompt');
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'messageEnd',
            data: { message: { role: 'user', content: 'event first' } },
        });
        await Promise.resolve();
        expect(setActiveTurn).toHaveBeenLastCalledWith(
            expect.objectContaining({ stateLabel: 'Sending' }),
        );
        wire.emit({
            t: 'res',
            id: prompt.id,
            ok: true,
            data: { accepted: true },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(setActiveTurn).toHaveBeenLastCalledWith(
            expect.objectContaining({ stateLabel: 'Sent to Pi' }),
        );
    });

    it('keeps an accepted prompt sent when its response arrives before the user event', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        const chat = mountChatPi(root, '/work/response-first', wire.client);
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: {
                sid: 's1',
                snapshot: { lastSeq: 0, messages: [] },
                state: { busy: true },
            },
        });
        await Promise.resolve();
        await Promise.resolve();
        const view = createReviewTranscriptView.mock.results.at(-1).value;
        const setActiveTurn = vi.spyOn(view, 'setActiveTurn');
        expect(chat.send('response first')).toBe(true);
        const prompt = wire.sent.find((frame) => frame.op === 'prompt');
        wire.emit({
            t: 'res',
            id: prompt.id,
            ok: true,
            data: { accepted: true },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(setActiveTurn).toHaveBeenLastCalledWith(
            expect.objectContaining({ stateLabel: 'Sent to Pi' }),
        );
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'messageEnd',
            data: { message: { role: 'user', content: 'response first' } },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(setActiveTurn).toHaveBeenLastCalledWith(
            expect.objectContaining({ stateLabel: 'Sent to Pi' }),
        );
    });

    it('interrupts an active Pi session through the abort control call', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        const chat = mountChatPi(root, '/work/interrupt', wire.client);
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: {
                sid: 's1',
                snapshot: { lastSeq: 0, messages: [] },
                state: { busy: true },
            },
        });
        await Promise.resolve();
        const interrupted = chat.interrupt();
        const abort = wire.sent.find((frame) => frame.op === 'abort');
        expect(abort).toMatchObject({ op: 'abort', sid: 's1', args: {} });
        wire.emit({
            t: 'res',
            id: abort.id,
            ok: true,
            data: { aborted: true },
        });
        await expect(interrupted).resolves.toEqual({
            aborted: true,
            restored: [],
        });
    });

    it('restores turn prompts in send order through reconciliation and abort settlement', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        const chat = mountChatPi(root, '/work/restore-order', wire.client);
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: {
                sid: 's1',
                snapshot: { lastSeq: 0, messages: [] },
                state: { busy: true },
            },
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(chat.send('first')).toBe(true);
        const [first] = wire.sent.filter((frame) => frame.op === 'prompt');
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'messageEnd',
            data: { message: { role: 'user', content: 'first' } },
        });
        wire.emit({
            t: 'res',
            id: first.id,
            ok: true,
            data: { accepted: true },
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(chat.send('same')).toBe(true);
        expect(chat.send('same')).toBe(true);
        const interrupted = chat.interrupt();
        const abort = wire.sent.find((frame) => frame.op === 'abort');
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 2,
            evt: 'stateChanged',
            data: { busy: false },
        });
        wire.emit({
            t: 'res',
            id: abort.id,
            ok: true,
            data: { aborted: true },
        });

        await expect(interrupted).resolves.toEqual({
            aborted: true,
            restored: ['first', 'same', 'same'],
        });
    });

    it('publishes CWD synchronously and hydrates after spawn', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        const statuses = [];
        mountChatPi(root, '/work/sync', wire.client, undefined, (status) =>
            statuses.push(status),
        );

        expect(statuses).toEqual([{ cwd: '/work/sync' }]);
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: {
                sid: 's1',
                snapshot: { lastSeq: 0, messages: [] },
            },
        });
        await Promise.resolve();
        expect(wire.sent.at(-1)).toMatchObject({ op: 'hydrate', sid: 's1' });
    });

    it('merges hydrate state without replacing the transcript snapshot', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        let latestStatus;
        mountChatPi(root, '/work/demo', wire.client, undefined, (status) => {
            if (status) latestStatus = status;
        });
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: {
                sid: 's1',
                snapshot: {
                    lastSeq: 0,
                    messages: [{ role: 'user', content: 'spawned' }],
                },
            },
        });
        await Promise.resolve();
        await Promise.resolve(); // drain spawn paint()
        wire.emit({
            t: 'res',
            id: 'hyd',
            ok: true,
            data: {
                lastSeq: 1,
                messages: [{ role: 'assistant', content: 'hydrated' }],
                state: {
                    cwd: '/work/other',
                    model: 'pi-4',
                    thinking: 'high',
                    inputTokens: 0,
                    outputTokens: 1200,
                    contextUsedTokens: 42000,
                    contextWindowTokens: 200000,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                    skills: ['review'],
                },
            },
        });
        await Promise.resolve();
        await Promise.resolve(); // drain hydrate paint()

        expect(latestStatus).toEqual({
            cwd: '/work/other',
            model: 'pi-4',
            thinking: 'high',
            inputTokens: 0,
            outputTokens: 1200,
            contextUsedTokens: 42000,
            contextWindowTokens: 200000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            skills: ['review'],
        });
        expect(root.textContent).toContain('hydrated');
        expect(root.textContent).not.toContain('spawned');
    });

    it('keeps typed metadata across error-only and malformed state events', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        const statuses = [];
        mountChatPi(root, '/work/demo', wire.client, undefined, (status) => {
            if (status) statuses.push(status);
        });
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: { sid: 's1', snapshot: { lastSeq: 0, messages: [] } },
        });
        await Promise.resolve();
        wire.emit({
            t: 'res',
            id: 'hyd',
            ok: true,
            data: {
                lastSeq: 0,
                messages: [],
                state: {
                    model: 'pi-4',
                    thinking: 'high',
                    inputTokens: 10,
                    outputTokens: 20,
                    contextUsedTokens: 42000,
                    contextWindowTokens: 200000,
                    cacheReadTokens: 30,
                    cacheWriteTokens: 40,
                    skills: ['review'],
                },
            },
        });
        await Promise.resolve();
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'stateChanged',
            data: {
                contextUsedTokens: null,
                contextWindowTokens: 200000,
            },
        });
        expect(statuses.at(-1)).toMatchObject({
            contextUsedTokens: null,
            contextWindowTokens: 200000,
        });
        const valid = statuses.at(-1);
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 2,
            evt: 'stateChanged',
            data: { error: 'temporary failure' },
        });
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 3,
            evt: 'stateChanged',
            data: {
                model: 42,
                thinking: null,
                inputTokens: 'bad',
                outputTokens: Infinity,
                contextUsedTokens: {},
                contextWindowTokens: 'bad',
                cacheReadTokens: 'bad',
                cacheWriteTokens: Infinity,
                skills: ['ok', 7],
            },
        });

        expect(statuses.at(-1)).toEqual(valid);
        expect(statuses.at(-1)).toEqual({
            cwd: '/work/demo',
            model: 'pi-4',
            thinking: 'high',
            inputTokens: 10,
            outputTokens: 20,
            contextUsedTokens: null,
            contextWindowTokens: 200000,
            cacheReadTokens: 30,
            cacheWriteTokens: 40,
            skills: ['review'],
        });
    });

    it('resumes with a session path and hydrates after a sequence gap', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        const chat = mountChatPi(
            root,
            '/work/demo',
            wire.client,
            '/work/demo/.pi/resume.jsonl',
        );

        expect(wire.sent[0]).toMatchObject({
            op: 'spawn',
            args: {
                cwd: '/work/demo',
                sessionPath: '/work/demo/.pi/resume.jsonl',
            },
        });
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: { sid: 's1', snapshot: { lastSeq: 3, messages: [] } },
        });
        await Promise.resolve();
        await Promise.resolve(); // drain spawn paint()
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 5,
            evt: 'messageEnd',
            data: { message: { role: 'assistant', content: 'gap' } },
        });
        await Promise.resolve();
        await Promise.resolve(); // drain paint() + hydrate request
        expect(wire.sent.at(-1)).toMatchObject({ op: 'hydrate', sid: 's1' });

        const latestHydrate = wire.sent.at(-1);
        wire.emit({
            t: 'res',
            id: latestHydrate.id,
            ok: true,
            data: {
                lastSeq: 5,
                messages: [{ role: 'assistant', content: 'hydrated' }],
            },
        });
        await Promise.resolve();
        await Promise.resolve(); // drain hydrate paint()
        expect(root.querySelector('.assistant-message')?.textContent).toContain(
            'hydrated',
        );
        expect(chat.send('after hydrate')).toBe(true);
    });

    it('keeps input disabled and shows a bootstrap error without a snapshot', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        const chat = mountChatPi(root, '/work/demo', wire.client);
        wire.emit({ t: 'res', id: 'sp', ok: true, data: { sid: 's1' } });
        await Promise.resolve();
        await Promise.resolve();

        expect(chat.send('blocked')).toBe(false);
        expect(root.textContent).toContain(
            'bootstrap snapshot missing or malformed',
        );
    });

    it('stops accepting sends after rpcExited', () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        const chat = mountChatPi(root, '/work/demo', wire.client);
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: { sid: 's1', snapshot: { lastSeq: 0, messages: [] } },
        });
        wire.emit({ t: 'evt', sid: 's1', seq: 1, evt: 'rpcExited', data: {} });
        expect(chat.send('after exit')).toBe(false);
    });

    it('keeps a rejected setter/reset on the ready sid and still sends the next prompt', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        const chat = mountChatPi(root, '/work/demo', wire.client);
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: { sid: 's1', snapshot: { lastSeq: 0, messages: [] } },
        });
        await Promise.resolve();
        wire.emit({
            t: 'res',
            id: 'hyd',
            ok: true,
            data: { lastSeq: 0, messages: [] },
        });
        await Promise.resolve();

        const setter = chat.setModel('provider', 'model');
        wire.emit({
            t: 'res',
            id: 'set-model',
            ok: false,
            error: 'setter rejected',
        });
        await expect(setter).rejects.toThrow('setter rejected');
        const reset = chat.resetChat();
        wire.emit({
            t: 'res',
            id: 'reset',
            ok: false,
            error: 'reset rejected',
        });
        await expect(reset).rejects.toThrow('reset rejected');
        expect(chat.send('still ready')).toBe(true);
        expect(wire.sent.at(-1)).toMatchObject({
            op: 'prompt',
            sid: 's1',
            args: { message: 'still ready' },
        });
    });

    it('does not let an older overlapping hydrate overwrite the latest snapshot', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        mountChatPi(root, '/work/demo', wire.client);
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: { sid: 's1', snapshot: { lastSeq: 0, messages: [] } },
        });
        await Promise.resolve();
        wire.emit({
            t: 'res',
            id: 'hyd',
            ok: true,
            data: { lastSeq: 0, messages: [] },
        });
        await Promise.resolve();
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 2,
            evt: 'messageEnd',
            data: { message: { role: 'assistant', content: 'gap-one' } },
        });
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 4,
            evt: 'messageEnd',
            data: { message: { role: 'assistant', content: 'gap-two' } },
        });
        const hydrateCalls = wire.sent.filter(
            (frame) => frame.op === 'hydrate',
        );
        expect(hydrateCalls.map((frame) => frame.id)).toEqual([
            'hyd',
            'hyd-1',
            'hyd-2',
        ]);
        wire.emit({
            t: 'res',
            id: 'hyd-1',
            ok: true,
            data: {
                lastSeq: 2,
                messages: [{ role: 'assistant', content: 'old hydrate' }],
            },
        });
        await Promise.resolve();
        await Promise.resolve(); // drain hydrate paint()
        expect(root.textContent).not.toContain('old hydrate');
        wire.emit({
            t: 'res',
            id: 'hyd-2',
            ok: true,
            data: {
                lastSeq: 4,
                messages: [{ role: 'assistant', content: 'latest hydrate' }],
            },
        });
        await Promise.resolve();
        await Promise.resolve(); // drain hydrate paint()
        expect(root.textContent).toContain('latest hydrate');
        expect(root.textContent).not.toContain('old hydrate');
    });

    it('keeps independent pane status and removes it before destroy notification', async () => {
        const first = fakeClient();
        const second = fakeClient();
        connectControl
            .mockReturnValueOnce(first.client)
            .mockReturnValueOnce(second.client);
        const notifications = [];
        const unsubscribe = subscribePiRpcStatus((paneId, status) => {
            notifications.push({
                paneId,
                status,
                observed: getPiRpcStatus(paneId),
            });
        });

        mountRpcChat('pane-1', document.createElement('div'), '/work/one');
        mountRpcChat('pane-2', document.createElement('div'), '/work/two');
        expect(getPiRpcStatus('pane-1')).toEqual({ cwd: '/work/one' });
        expect(getPiRpcStatus('pane-2')).toEqual({ cwd: '/work/two' });

        first.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: { sid: 'one', snapshot: { lastSeq: 0, messages: [] } },
        });
        await Promise.resolve();
        first.emit({
            t: 'res',
            id: 'hyd',
            ok: true,
            data: {
                lastSeq: 0,
                messages: [],
                state: { model: 'model-one' },
            },
        });
        await Promise.resolve();
        expect(getPiRpcStatus('pane-1')).toMatchObject({
            cwd: '/work/one',
            model: 'model-one',
        });
        expect(getPiRpcStatus('pane-2')).toEqual({ cwd: '/work/two' });

        destroyRpcChat('pane-1');
        expect(getPiRpcStatus('pane-1')).toBeNull();
        expect(notifications.at(-1)).toEqual({
            paneId: 'pane-1',
            status: null,
            observed: null,
        });
        expect(getPiRpcStatus('pane-2')).toEqual({ cwd: '/work/two' });
        unsubscribe();
        destroyRpcChat('pane-2');
    });

    it('interrupt() rejects when sessionActive is false and sends no abort frame', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        const chat = mountChatPi(root, '/work/idle', wire.client);
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: {
                sid: 's1',
                snapshot: { lastSeq: 0, messages: [] },
                state: { busy: false },
            },
        });
        await Promise.resolve();
        await Promise.resolve();

        await expect(chat.interrupt()).rejects.toThrow('Pi RPC is not active');
        expect(wire.sent.some((frame) => frame.op === 'abort')).toBe(false);
    });

    it('interrupt() dedupes a concurrent second abort while the first is in flight and clears after completion', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        const chat = mountChatPi(root, '/work/dedupe', wire.client);
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: {
                sid: 's1',
                snapshot: { lastSeq: 0, messages: [] },
                state: { busy: true },
            },
        });
        await Promise.resolve();
        await Promise.resolve();

        const first = chat.interrupt();
        const aborts = wire.sent.filter((frame) => frame.op === 'abort');
        expect(aborts).toHaveLength(1);
        // Second concurrent call must be deduped — abortInFlight is true.
        await expect(chat.interrupt()).rejects.toThrow(
            'Pi interrupt is already pending',
        );
        expect(wire.sent.filter((frame) => frame.op === 'abort')).toHaveLength(
            1,
        );

        wire.emit({
            t: 'res',
            id: aborts[0].id,
            ok: true,
            data: { aborted: true },
        });
        await expect(first).resolves.toEqual({ aborted: true, restored: [] });

        // After the first abort completes, abortInFlight is cleared and a
        // fresh interrupt can send a new abort frame.
        const second = chat.interrupt();
        expect(wire.sent.filter((frame) => frame.op === 'abort')).toHaveLength(
            2,
        );
        const followUp = wire.sent.filter((frame) => frame.op === 'abort');
        wire.emit({
            t: 'res',
            id: followUp[1].id,
            ok: true,
            data: { aborted: true },
        });
        await expect(second).resolves.toEqual({ aborted: true, restored: [] });
    });

    it('interrupt() clears abortInFlight after the abort call fails', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        const chat = mountChatPi(root, '/work/fail', wire.client);
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: {
                sid: 's1',
                snapshot: { lastSeq: 0, messages: [] },
                state: { busy: true },
            },
        });
        await Promise.resolve();
        await Promise.resolve();

        const first = chat.interrupt();
        const [abort] = wire.sent.filter((frame) => frame.op === 'abort');
        wire.emit({
            t: 'res',
            id: abort.id,
            ok: false,
            error: 'Pi rejected abort',
        });
        await expect(first).rejects.toThrow('Pi rejected abort');

        // After failure, abortInFlight must be cleared so a retry can run.
        const second = chat.interrupt();
        expect(wire.sent.filter((frame) => frame.op === 'abort')).toHaveLength(
            2,
        );
        const [, followUp] = wire.sent.filter((frame) => frame.op === 'abort');
        wire.emit({
            t: 'res',
            id: followUp.id,
            ok: true,
            data: { aborted: true },
        });
        await expect(second).resolves.toEqual({ aborted: true, restored: [] });
    });

    it('rpcChatInterrupt forwards to mountChatPi.interrupt and rejects missing panes', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        connectControl.mockReturnValueOnce(wire.client);
        mountRpcChat('pane-1', root, '/work/forward');
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: {
                sid: 's1',
                snapshot: { lastSeq: 0, messages: [] },
                state: { busy: true },
            },
        });
        await Promise.resolve();
        await Promise.resolve();

        const promise = rpcChatInterrupt('pane-1');
        const [abort] = wire.sent.filter((frame) => frame.op === 'abort');
        expect(abort).toMatchObject({ op: 'abort', sid: 's1', args: {} });
        wire.emit({
            t: 'res',
            id: abort.id,
            ok: true,
            data: { aborted: true },
        });
        await expect(promise).resolves.toEqual({ aborted: true, restored: [] });

        await expect(rpcChatInterrupt('unknown-pane')).rejects.toThrow(
            'unknown or destroyed Pi RPC pane: unknown-pane',
        );
    });

    it('rpcChatSetName forwards to mountChatPi.setName and rejects missing panes and rejections', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        connectControl.mockReturnValueOnce(wire.client);
        mountRpcChat('pane-1', root, '/work/rename');
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: { sid: 's1', snapshot: { lastSeq: 0, messages: [] } },
        });
        await Promise.resolve();
        await Promise.resolve();

        const promise = rpcChatSetName('pane-1', '  Audit auth module  ');
        const [rename] = wire.sent.filter(
            (frame) => frame.op === 'setSessionName',
        );
        expect(rename).toMatchObject({
            op: 'setSessionName',
            sid: 's1',
            args: { name: 'Audit auth module' },
        });
        wire.emit({
            t: 'res',
            id: rename.id,
            ok: true,
            data: { state: { title: 'Audit auth module' } },
        });
        await expect(promise).resolves.toEqual({
            state: { title: 'Audit auth module' },
        });

        await expect(
            rpcChatSetName('unknown-pane', 'anything'),
        ).rejects.toThrow('unknown or destroyed Pi RPC pane: unknown-pane');

        // Rejection from the backend surfaces to the caller.
        const rejectWire = fakeClient();
        connectControl.mockReturnValueOnce(rejectWire.client);
        mountRpcChat('pane-2', root, '/work/rename-reject');
        rejectWire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: { sid: 's2', snapshot: { lastSeq: 0, messages: [] } },
        });
        await Promise.resolve();
        await Promise.resolve();
        const rejected = rpcChatSetName('pane-2', 'Forbidden');
        const [rejectCall] = rejectWire.sent.filter(
            (frame) => frame.op === 'setSessionName',
        );
        rejectWire.emit({
            t: 'res',
            id: rejectCall.id,
            ok: false,
            error: 'name not allowed',
        });
        await expect(rejected).rejects.toThrow('name not allowed');
    });

    it('non-accepted prompt response removes only the matching optimistic record, surfaces an error, and falls back to the next one', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        const chat = mountChatPi(root, '/work/reject', wire.client);
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: {
                sid: 's1',
                snapshot: { lastSeq: 0, messages: [] },
                state: { busy: true },
            },
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(chat.send('first')).toBe(true);
        expect(chat.send('second')).toBe(true);
        const prompts = wire.sent.filter((frame) => frame.op === 'prompt');
        expect(prompts).toHaveLength(2);
        const [firstPrompt, secondPrompt] = prompts;

        wire.emit({
            t: 'res',
            id: firstPrompt.id,
            ok: true,
            data: { accepted: false },
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(root.textContent).toContain('Error: prompt was not accepted');
        // The first prompt was rejected, the second is still in flight.
        // A second user event for the surviving prompt must still reconcile.
        wire.emit({
            t: 'res',
            id: secondPrompt.id,
            ok: true,
            data: { accepted: true },
        });
        await Promise.resolve();
        await Promise.resolve();
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'messageEnd',
            data: { message: { role: 'user', content: 'second' } },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(root.textContent).toContain('second');
        // And after the second prompt reconciles, no optimistic marker remains.
        expect(
            root.querySelector('[data-pi-optimistic-prompt="true"]'),
        ).toBeNull();
    });

    it('non-matching authoritative user text leaves the optimistic record; identical texts reconcile via renderedUserText', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        const chat = mountChatPi(root, '/work/reconcile', wire.client);
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: {
                sid: 's1',
                snapshot: { lastSeq: 0, messages: [] },
                state: { busy: true },
            },
        });
        await Promise.resolve();
        await Promise.resolve();

        // 1. Non-matching authoritative user text does NOT consume the
        //    optimistic record. Distinct prompt text makes the
        //    optimistic marker unique, so we can track it across events.
        expect(chat.send('alpha')).toBe(true);
        const [firstPrompt] = wire.sent.filter(
            (frame) => frame.op === 'prompt',
        );
        wire.emit({
            t: 'res',
            id: firstPrompt.id,
            ok: true,
            data: { accepted: true },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(
            root.querySelectorAll('[data-pi-optimistic-prompt="true"]'),
        ).toHaveLength(1);
        // A different authoritative user text must not reconcile.
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'messageEnd',
            data: { message: { role: 'user', content: 'beta' } },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(
            root.querySelectorAll('[data-pi-optimistic-prompt="true"]'),
        ).toHaveLength(1);

        // 2. Identical-text reconciliation: a matching authoritative
        //    user event consumes the optimistic record via the
        //    renderedUserText path.
        expect(chat.send('alpha')).toBe(true);
        const prompts = wire.sent.filter((frame) => frame.op === 'prompt');
        const [, secondPrompt] = prompts;
        wire.emit({
            t: 'res',
            id: secondPrompt.id,
            ok: true,
            data: { accepted: true },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(
            root.querySelectorAll('[data-pi-optimistic-prompt="true"]'),
        ).toHaveLength(2);
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 2,
            evt: 'messageEnd',
            data: { message: { role: 'user', content: 'alpha' } },
        });
        await Promise.resolve();
        await Promise.resolve();
        // Legacy OpPrompt reconciliation still consumes one matching
        // prompt by text. Queue-backed prompts use a separate identity path.
        expect(
            root.querySelectorAll('[data-pi-optimistic-prompt="true"]'),
        ).toHaveLength(1);
    });

    it('stranded optimistic records clear on agent_settled and on prompt control failure', async () => {
        // 1. agent_settled (busy: false) clears the entire outgoing queue.
        const settledRoot = document.createElement('div');
        const settledWire = fakeClient();
        const settledChat = mountChatPi(
            settledRoot,
            '/work/stranded-settled',
            settledWire.client,
        );
        settledWire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: {
                sid: 's1',
                snapshot: { lastSeq: 0, messages: [] },
                state: { busy: true },
            },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(settledChat.send('alpha')).toBe(true);
        expect(settledChat.send('beta')).toBe(true);
        await Promise.resolve();
        await Promise.resolve();
        // Two stranded optimistic records are in the DOM before the
        // settled boundary. They differ by text but share the optimistic
        // prefix; the LATEST is the only one with the active marker.
        // Query the transcript only — the active-prompt overlay lives
        // in a sibling of the transcript and would inflate the count.
        const transcriptEl = settledRoot.querySelector('.review-chat-wrapper');
        const transcript = transcriptEl;
        const transcriptOptimisticCount = () =>
            [...transcript.querySelectorAll('.user-message')].filter((node) =>
                /^(Sending|Sent to Pi): /u.test(node.textContent ?? ''),
            ).length;
        expect(transcriptOptimisticCount()).toBe(2);
        // Busy transitions to false (agent_settled). The chat must clear
        // ALL stranded optimistic records; both prefixes disappear.
        settledWire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'stateChanged',
            data: { busy: false },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(transcriptOptimisticCount()).toBe(0);
        // sessionActive is now false — interrupt() rejects.
        await expect(settledChat.interrupt()).rejects.toThrow(
            'Pi RPC is not active',
        );

        // 2. Prompt control failure (rejected prompt) clears only the
        //    matching optimistic record; surviving prompts are kept.
        const failRoot = document.createElement('div');
        const failWire = fakeClient();
        const failChat = mountChatPi(
            failRoot,
            '/work/stranded-fail',
            failWire.client,
        );
        failWire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: {
                sid: 's1',
                snapshot: { lastSeq: 0, messages: [] },
                state: { busy: true },
            },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(failChat.send('alpha')).toBe(true);
        expect(failChat.send('beta')).toBe(true);
        await Promise.resolve();
        await Promise.resolve();
        const prompts = failWire.sent.filter((frame) => frame.op === 'prompt');
        const [firstPrompt, secondPrompt] = prompts;
        // Reject the first prompt; the second must remain optimistic.
        failWire.emit({
            t: 'res',
            id: firstPrompt.id,
            ok: false,
            error: 'control connection closed',
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(failRoot.textContent).toContain(
            'Error: control connection closed',
        );
        // Exactly one optimistic record is left: the surviving "beta".
        const failTranscript = failRoot.querySelector('.review-chat-wrapper');
        const optimistics = failTranscript.querySelectorAll(
            '[data-pi-optimistic-prompt="true"]',
        );
        expect(optimistics).toHaveLength(1);
        expect(optimistics[0].textContent).toContain('beta');
        expect(optimistics[0].textContent).not.toContain('alpha');
        // And the second prompt can still reconcile via renderedUserText.
        failWire.emit({
            t: 'res',
            id: secondPrompt.id,
            ok: true,
            data: { accepted: true },
        });
        await Promise.resolve();
        await Promise.resolve();
        failWire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'messageEnd',
            data: { message: { role: 'user', content: 'beta' } },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(
            failTranscript.querySelector('[data-pi-optimistic-prompt="true"]'),
        ).toBeNull();
    });

    // Milestone 2: a long burst of streaming `text_delta` events must
    // NOT call setStructuredMessages at all. The live-text path uses
    // setStructuredPartial so each token avoids a full transcript
    // rebuild + savePersisted serialize+write. The settling messageEnd
    // runs the full structured repaint exactly once and clears the
    // .pi-streaming block.
    it('streams 100 text_delta events through setStructuredPartial without repainting', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        const chat = mountChatPi(root, '/work/stream', wire.client);
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: {
                sid: 's1',
                snapshot: { lastSeq: 0, messages: [] },
            },
        });
        await Promise.resolve();
        await Promise.resolve();
        const view = createReviewTranscriptView.mock.results.at(-1).value;
        const setStructuredMessages = vi.spyOn(view, 'setStructuredMessages');
        const setStructuredPartial = vi.spyOn(view, 'setStructuredPartial');

        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'messageStart',
            data: { message: { role: 'assistant' } },
        });
        await Promise.resolve();
        await Promise.resolve();
        // messageStart with no prior partial is a 'none' disposition.
        expect(setStructuredPartial).not.toHaveBeenCalled();

        for (let i = 0; i < 100; i++) {
            wire.emit({
                t: 'evt',
                sid: 's1',
                seq: 2 + i,
                evt: 'messageUpdate',
                data: {
                    assistantMessageEvent: {
                        type: 'text_delta',
                        contentIndex: 0,
                        delta: ` t${i}`,
                    },
                },
            });
            await Promise.resolve();
            await Promise.resolve();
        }
        // No full repaint happened during the burst.
        expect(setStructuredMessages).not.toHaveBeenCalled();
        expect(setStructuredPartial).toHaveBeenCalledTimes(100);
        const livePartial = root.querySelector('.pi-partial');
        expect(livePartial).not.toBeNull();
        const expected =
            ' t0 t1 t2 t3 t4 t5 t6 t7 t8 t9' +
            Array.from({ length: 90 }, (_, i) => ` t${i + 10}`).join('');
        expect(livePartial.textContent).toBe(expected);
        expect(root.querySelectorAll('.pi-streaming')).toHaveLength(1);

        // Settle: one messageEnd runs the full repaint and clears the
        // live block.
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 102,
            evt: 'messageEnd',
            data: {
                message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: expected }],
                },
            },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(setStructuredMessages).toHaveBeenCalledTimes(1);
        // setStructuredPartial is not called with '' on messageEnd; the
        // live block is cleared by the setStructuredMessages rebuild.
        // partial-clear only fires on a subsequent messageStart with a
        // still-open partial, which is not part of this burst.
        expect(
            setStructuredPartial.mock.calls.some(([text]) => text === ''),
        ).toBe(false);
        expect(root.querySelector('.pi-streaming')).toBeNull();

        // chat variable referenced to keep lint happy and to exercise
        // the early-return on destroyed state.
        void chat;
    });

    it('streams thinking and live tool updates through narrow setters before settlement', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        mountChatPi(root, '/work/live-thinking-tools', wire.client);
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: { sid: 's1', snapshot: { lastSeq: 0, messages: [] } },
        });
        await Promise.resolve();
        await Promise.resolve();
        const view = createReviewTranscriptView.mock.results.at(-1).value;
        const full = vi.spyOn(view, 'setStructuredMessages');
        const thinking = vi.spyOn(view, 'setStructuredThinking');
        const liveTool = vi.spyOn(view, 'setLiveToolOutput');

        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'messageStart',
            data: { message: { role: 'assistant' } },
        });
        for (let i = 0; i < 100; i++) {
            wire.emit({
                t: 'evt',
                sid: 's1',
                seq: i + 2,
                evt: 'messageUpdate',
                data: {
                    assistantMessageEvent: {
                        type: 'thinking_delta',
                        delta: `t${i}`,
                    },
                },
            });
        }
        await Promise.resolve();
        expect(full).not.toHaveBeenCalled();
        expect(thinking).toHaveBeenCalledTimes(100);
        expect(thinking).toHaveBeenLastCalledWith(
            't0t1t2t3t4t5t6t7t8t9' +
                Array.from({ length: 90 }, (_, i) => `t${i + 10}`).join(''),
        );

        for (let i = 0; i < 100; i++) {
            wire.emit({
                t: 'evt',
                sid: 's1',
                seq: 102 + i,
                evt: 'toolExecutionUpdate',
                data: {
                    toolCallId: 'live-1',
                    partialResult: {
                        content: [{ type: 'text', text: `tool-${i}` }],
                    },
                },
            });
        }
        expect(liveTool).toHaveBeenCalledTimes(100);
        expect(liveTool).toHaveBeenLastCalledWith('live-1', 'tool-99');
        expect(full).not.toHaveBeenCalled();

        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 202,
            evt: 'messageEnd',
            data: {
                message: {
                    role: 'toolResult',
                    toolCallId: 'live-1',
                    content: [{ type: 'text', text: 'final output' }],
                },
            },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(full).toHaveBeenCalledTimes(1);
        expect(liveTool).toHaveBeenCalledTimes(101);
        expect(liveTool).toHaveBeenLastCalledWith('live-1', '');
    });

    it('renders at most 100 settled messages and pages older history without duplicates', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        mountChatPi(root, '/work/window', wire.client);
        const messages = Array.from({ length: 101 }, (_, i) => ({
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: `m-${i}`,
        }));
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: { sid: 's1', snapshot: { lastSeq: 0, messages } },
        });
        await Promise.resolve();
        await Promise.resolve();

        const transcript = root.querySelector('.review-chat-wrapper');
        const blocks = () => [
            ...transcript.querySelectorAll(
                '.user-message, .assistant-message:not(.pi-streaming)',
            ),
        ];
        expect(blocks()).toHaveLength(100);
        expect(transcript.textContent).not.toContain('m-0');

        transcript.dispatchEvent(new Event('scroll'));
        const older = blocks();
        expect(older).toHaveLength(100);
        expect(older.map((node) => node.textContent)).toContain('m-0');
        expect(new Set(older.map((node) => node.textContent)).size).toBe(100);
    });

    it('batches settled persistence, skips streaming deltas, and flushes on teardown', async () => {
        vi.useFakeTimers();
        const root = document.createElement('div');
        const wire = fakeClient();
        const chat = mountChatPi(root, '/work/persist', wire.client);
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: { sid: 's1', snapshot: { lastSeq: 0, messages: [] } },
        });
        await Promise.resolve();
        await Promise.resolve();
        const hydrate = wire.sent.find((frame) => frame.op === 'hydrate');
        wire.emit({
            t: 'res',
            id: hydrate.id,
            ok: true,
            data: { lastSeq: 0, messages: [] },
        });
        await Promise.resolve();
        await Promise.resolve();
        await vi.runAllTimersAsync();
        savePersisted.mockClear();

        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'messageStart',
            data: { message: { role: 'assistant' } },
        });
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 2,
            evt: 'messageUpdate',
            data: {
                assistantMessageEvent: { type: 'text_delta', delta: 'a' },
            },
        });
        expect(savePersisted).not.toHaveBeenCalled();
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 3,
            evt: 'messageEnd',
            data: { message: { role: 'assistant', content: 'a' } },
        });
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 4,
            evt: 'messageEnd',
            data: { message: { role: 'user', content: 'next' } },
        });
        await vi.advanceTimersByTimeAsync(249);
        expect(savePersisted).not.toHaveBeenCalled();
        chat.destroy();
        expect(savePersisted).toHaveBeenCalledTimes(1);
        expect(savePersisted).toHaveBeenLastCalledWith(
            's1',
            expect.arrayContaining([
                expect.objectContaining({ content: 'a' }),
                expect.objectContaining({ content: 'next' }),
            ]),
        );
        await vi.advanceTimersByTimeAsync(1);
        expect(savePersisted).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
    });

    it('flushes a pending settled transcript once when Pi exits', async () => {
        vi.useFakeTimers();
        const root = document.createElement('div');
        const wire = fakeClient();
        mountChatPi(root, '/work/exit-persist', wire.client);
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: { sid: 's1', snapshot: { lastSeq: 0, messages: [] } },
        });
        await Promise.resolve();
        await Promise.resolve();
        const hydrate = wire.sent.find((frame) => frame.op === 'hydrate');
        wire.emit({
            t: 'res',
            id: hydrate.id,
            ok: true,
            data: { lastSeq: 0, messages: [] },
        });
        await Promise.resolve();
        await Promise.resolve();
        await vi.runAllTimersAsync();
        savePersisted.mockClear();

        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'messageEnd',
            data: { message: { role: 'assistant', content: 'saved on exit' } },
        });
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 2,
            evt: 'rpcExited',
            data: {},
        });
        expect(savePersisted).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(250);
        expect(savePersisted).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
    });

    it('persists reset hydrates once and cancels stale pending saves for gap hydrates', async () => {
        vi.useFakeTimers();
        const root = document.createElement('div');
        const wire = fakeClient();
        mountChatPi(root, '/work/reset-persist', wire.client);
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: { sid: 's1', snapshot: { lastSeq: 0, messages: [] } },
        });
        await Promise.resolve();
        await Promise.resolve();
        const initialHydrate = wire.sent.find(
            (frame) => frame.op === 'hydrate',
        );
        wire.emit({
            t: 'res',
            id: initialHydrate.id,
            ok: true,
            data: { lastSeq: 0, messages: [] },
        });
        await Promise.resolve();
        await Promise.resolve();
        await vi.runAllTimersAsync();
        savePersisted.mockClear();

        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'messageEnd',
            data: { message: { role: 'assistant', content: 'before-reset' } },
        });
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 2,
            evt: 'transcriptReset',
            data: {},
        });
        const resetHydrate = wire.sent.at(-1);
        expect(resetHydrate).toMatchObject({ op: 'hydrate', sid: 's1' });
        wire.emit({
            t: 'res',
            id: resetHydrate.id,
            ok: true,
            data: {
                lastSeq: 2,
                messages: [{ role: 'assistant', content: 'after-reset' }],
            },
        });
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(savePersisted).toHaveBeenCalledTimes(1);
        expect(savePersisted).toHaveBeenLastCalledWith('s1', [
            expect.objectContaining({ content: 'after-reset' }),
        ]);

        savePersisted.mockClear();
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 3,
            evt: 'messageEnd',
            data: { message: { role: 'assistant', content: 'pending' } },
        });
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 5,
            evt: 'stateChanged',
            data: {},
        });
        await vi.advanceTimersByTimeAsync(250);
        expect(savePersisted).not.toHaveBeenCalled();
        vi.useRealTimers();
    });

    it('ignores a stale stateChanged event before applying UI state', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        const controls = [];
        mountChatPi(
            root,
            '/work/stale-state',
            wire.client,
            undefined,
            undefined,
            (state) => controls.push(state),
        );
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: {
                sid: 's1',
                snapshot: { lastSeq: 0, messages: [] },
                state: { busy: false },
            },
        });
        await Promise.resolve();
        await Promise.resolve();
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'stateChanged',
            data: { busy: true },
        });
        expect(controls.at(-1)).toEqual(
            expect.objectContaining({ busy: true }),
        );
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'stateChanged',
            data: { busy: false },
        });
        expect(controls.at(-1)).toEqual(
            expect.objectContaining({ busy: true }),
        );
    });

    it('does not reconcile an optimistic prompt from a stale user messageEnd', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        const chat = mountChatPi(root, '/work/stale-user', wire.client);
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: {
                sid: 's1',
                snapshot: { lastSeq: 0, messages: [] },
                state: { busy: true },
            },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(chat.send('keep optimistic')).toBe(true);
        await Promise.resolve();
        await Promise.resolve();
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 0,
            evt: 'messageEnd',
            data: { message: { role: 'user', content: 'keep optimistic' } },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(
            root.querySelector('[data-pi-optimistic-prompt="true"]'),
        ).not.toBeNull();
    });

    it('does not request reset hydrate for a stale transcriptReset event', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        mountChatPi(root, '/work/stale-reset', wire.client);
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: { sid: 's1', snapshot: { lastSeq: 0, messages: [] } },
        });
        await Promise.resolve();
        await Promise.resolve();
        const hydratesBefore = wire.sent.filter(
            (frame) => frame.op === 'hydrate',
        ).length;
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 0,
            evt: 'transcriptReset',
            data: {},
        });
        expect(
            wire.sent.filter((frame) => frame.op === 'hydrate'),
        ).toHaveLength(hydratesBefore);
    });

    it('uses the active-turn update path when valid stateChanged becomes idle', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        mountChatPi(root, '/work/idle-state', wire.client);
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: {
                sid: 's1',
                snapshot: { lastSeq: 0, messages: [] },
                state: { busy: true },
            },
        });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        const view = createReviewTranscriptView.mock.results.at(-1).value;
        const setStructuredMessages = vi.spyOn(view, 'setStructuredMessages');
        const setActiveTurn = vi.spyOn(view, 'setActiveTurn');
        const replaceChildren = vi.spyOn(view.transcript, 'replaceChildren');
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'stateChanged',
            data: { busy: false },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(setStructuredMessages).not.toHaveBeenCalled();
        expect(replaceChildren).not.toHaveBeenCalled();
        expect(setActiveTurn).toHaveBeenLastCalledWith(null);
    });

    it('updates optimistic prompt send and response state without rebuilding the transcript', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        const chat = mountChatPi(root, '/work/narrow-prompt', wire.client);
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: {
                sid: 's1',
                snapshot: { lastSeq: 0, messages: [] },
                state: { busy: true },
            },
        });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        const view = createReviewTranscriptView.mock.results.at(-1).value;
        const setStructuredMessages = vi.spyOn(view, 'setStructuredMessages');
        const replaceChildren = vi.spyOn(view.transcript, 'replaceChildren');

        expect(chat.send('accepted prompt')).toBe(true);
        expect(root.textContent).toContain('Sending: accepted prompt');
        expect(setStructuredMessages).not.toHaveBeenCalled();
        expect(replaceChildren).not.toHaveBeenCalled();
        const accepted = wire.sent
            .filter((frame) => frame.op === 'prompt')
            .at(-1);
        wire.emit({
            t: 'res',
            id: accepted.id,
            ok: true,
            data: { accepted: true },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(root.textContent).toContain('Sent to Pi: accepted prompt');
        expect(setStructuredMessages).not.toHaveBeenCalled();
        expect(replaceChildren).not.toHaveBeenCalled();

        expect(chat.send('rejected prompt')).toBe(true);
        const rejected = wire.sent
            .filter((frame) => frame.op === 'prompt')
            .at(-1);
        wire.emit({
            t: 'res',
            id: rejected.id,
            ok: true,
            data: { accepted: false },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(root.textContent).toContain('Error: prompt was not accepted');
        expect(root.textContent).not.toContain('rejected prompt');
        expect(setStructuredMessages).not.toHaveBeenCalled();
        expect(replaceChildren).not.toHaveBeenCalled();
    });
});

describe('Pi RPC transcript controller (pi error surfaces — Milestone 4)', () => {
    async function bootReady(wire) {
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: {
                sid: 's1',
                snapshot: { lastSeq: 0, messages: [] },
            },
        });
        await Promise.resolve();
        await Promise.resolve();
        wire.emit({
            t: 'res',
            id: 'hyd',
            ok: true,
            data: { lastSeq: 0, messages: [] },
        });
        await Promise.resolve();
        await Promise.resolve();
    }

    it('autoRetryStart stashes retry state and updates the working label without an active prompt', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        mountChatPi(root, '/work/demo', wire.client);
        await bootReady(wire, root);
        const view = createReviewTranscriptView.mock.results.at(-1).value;
        const setActiveTurn = vi.spyOn(view, 'setActiveTurn');

        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'autoRetryStart',
            data: { attempt: 2, maxAttempts: 5 },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(setActiveTurn).toHaveBeenLastCalledWith(
            expect.objectContaining({
                active: false,
                retry: { attempt: 2, maxAttempts: 5 },
            }),
        );
        const working = root.querySelector('.pi-working-label');
        expect(working.textContent).toBe('Retrying · attempt 2 of 5');
        expect(
            root.querySelector('.pi-active-turn').classList.contains('hidden'),
        ).toBe(false);
    });

    it('autoRetryEnd clears retry state and hides the working row', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        mountChatPi(root, '/work/demo', wire.client);
        await bootReady(wire, root);
        const view = createReviewTranscriptView.mock.results.at(-1).value;
        const setActiveTurn = vi.spyOn(view, 'setActiveTurn');

        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'autoRetryStart',
            data: { attempt: 1, maxAttempts: 3 },
        });
        await Promise.resolve();
        await Promise.resolve();
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 2,
            evt: 'autoRetryEnd',
            data: { success: true },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(setActiveTurn).toHaveBeenLastCalledWith(null);
        expect(
            root.querySelector('.pi-active-turn').classList.contains('hidden'),
        ).toBe(true);
    });

    it('autoRetryEnd {success:false} sets the "Retry failed after N attempts: ..." status bar', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        mountChatPi(root, '/work/demo', wire.client);
        await bootReady(wire, root);
        const view = createReviewTranscriptView.mock.results.at(-1).value;
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'autoRetryStart',
            data: { attempt: 1, maxAttempts: 3 },
        });
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 2,
            evt: 'autoRetryEnd',
            data: { success: false, attempt: 3, finalError: 'rate limit' },
        });
        await Promise.resolve();
        expect(view.status.textContent).toBe(
            'Retry failed after 3 attempts: rate limit',
        );
    });

    it('autoRetryEnd {success:false} uses "attempt" singular when N=1', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        mountChatPi(root, '/work/demo', wire.client);
        await bootReady(wire, root);
        const view = createReviewTranscriptView.mock.results.at(-1).value;
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'autoRetryStart',
            data: { attempt: 1, maxAttempts: 1 },
        });
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 2,
            evt: 'autoRetryEnd',
            data: { success: false, attempt: 1, finalError: 'boom' },
        });
        await Promise.resolve();
        expect(view.status.textContent).toBe(
            'Retry failed after 1 attempt: boom',
        );
    });

    it('autoRetryEnd {success:false} with no finalError falls back to "Unknown error"', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        mountChatPi(root, '/work/demo', wire.client);
        await bootReady(wire, root);
        const view = createReviewTranscriptView.mock.results.at(-1).value;
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'autoRetryStart',
            data: { attempt: 1, maxAttempts: 3 },
        });
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 2,
            evt: 'autoRetryEnd',
            data: { success: false, attempt: 3 },
        });
        await Promise.resolve();
        expect(view.status.textContent).toBe(
            'Retry failed after 3 attempts: Unknown error',
        );
    });

    it('autoRetryStart with non-numeric attempt is ignored (no stray retry state)', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        mountChatPi(root, '/work/demo', wire.client);
        await bootReady(wire, root);
        const view = createReviewTranscriptView.mock.results.at(-1).value;
        const setActiveTurn = vi.spyOn(view, 'setActiveTurn');
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'autoRetryStart',
            data: { attempt: 'one', maxAttempts: 3 },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(setActiveTurn).not.toHaveBeenCalled();
    });

    it('summarizationRetryScheduled sets retry state AND status bar; summarizationRetryFinished clears', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        mountChatPi(root, '/work/demo', wire.client);
        await bootReady(wire, root);
        const view = createReviewTranscriptView.mock.results.at(-1).value;
        const setActiveTurn = vi.spyOn(view, 'setActiveTurn');

        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'summarizationRetryScheduled',
            data: { attempt: 1, maxAttempts: 4, errorMessage: 'transient' },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(setActiveTurn).toHaveBeenLastCalledWith(
            expect.objectContaining({
                active: false,
                retry: { attempt: 1, maxAttempts: 4 },
            }),
        );
        expect(view.status.textContent).toBe('pi: transient');

        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 2,
            evt: 'summarizationRetryFinished',
            data: {},
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(setActiveTurn).toHaveBeenLastCalledWith(null);
    });

    it('extensionError sets "pi extension error: ..." status bar', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        mountChatPi(root, '/work/demo', wire.client);
        await bootReady(wire, root);
        const view = createReviewTranscriptView.mock.results.at(-1).value;
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'extensionError',
            data: { error: 'extension exploded' },
        });
        await Promise.resolve();
        expect(view.status.textContent).toBe(
            'pi extension error: extension exploded',
        );
    });

    it('compactionEnd {aborted:true,reason:"manual"} shows "Compaction cancelled"', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        mountChatPi(root, '/work/demo', wire.client);
        await bootReady(wire, root);
        const view = createReviewTranscriptView.mock.results.at(-1).value;
        const setEphemeralError = vi.spyOn(view, 'setEphemeralError');
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'compactionEnd',
            data: { aborted: true, reason: 'manual' },
        });
        await Promise.resolve();
        expect(view.status.textContent).toBe('Compaction cancelled');
        // aborted branches never set an ephemeral row.
        expect(setEphemeralError).not.toHaveBeenCalledWith(expect.any(String));
    });

    it('compactionEnd {aborted:true,reason:"auto"} shows "Auto-compaction cancelled"', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        mountChatPi(root, '/work/demo', wire.client);
        await bootReady(wire, root);
        const view = createReviewTranscriptView.mock.results.at(-1).value;
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'compactionEnd',
            data: { aborted: true, reason: 'auto' },
        });
        await Promise.resolve();
        expect(view.status.textContent).toBe('Auto-compaction cancelled');
    });

    it('compactionEnd {reason:"manual",errorMessage:"..."} routes to status bar', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        mountChatPi(root, '/work/demo', wire.client);
        await bootReady(wire, root);
        const view = createReviewTranscriptView.mock.results.at(-1).value;
        const setEphemeralError = vi.spyOn(view, 'setEphemeralError');
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'compactionEnd',
            data: { reason: 'manual', errorMessage: 'compaction boom' },
        });
        await Promise.resolve();
        expect(view.status.textContent).toBe('pi: compaction boom');
        expect(setEphemeralError).not.toHaveBeenCalledWith(expect.any(String));
    });

    it('compactionEnd {reason:"auto",errorMessage:"..."} appends an ephemeral red row', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        mountChatPi(root, '/work/demo', wire.client);
        await bootReady(wire, root);
        const view = createReviewTranscriptView.mock.results.at(-1).value;
        const setEphemeralError = vi.spyOn(view, 'setEphemeralError');
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'compactionEnd',
            data: { reason: 'auto', errorMessage: 'provider 500' },
        });
        await Promise.resolve();
        expect(setEphemeralError).toHaveBeenLastCalledWith('provider 500');
    });

    it('compactionEnd {reason:"auto",errorMessage:null} clears any stale ephemeral row', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        mountChatPi(root, '/work/demo', wire.client);
        await bootReady(wire, root);
        const view = createReviewTranscriptView.mock.results.at(-1).value;
        const setEphemeralError = vi.spyOn(view, 'setEphemeralError');

        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'compactionEnd',
            data: { reason: 'auto', errorMessage: 'first failure' },
        });
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 2,
            evt: 'compactionEnd',
            data: { reason: 'auto' },
        });
        await Promise.resolve();
        expect(setEphemeralError).toHaveBeenLastCalledWith(null);
    });

    it('applyState busy→false clears any stranded retry state (gap-loss guard)', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        mountChatPi(root, '/work/demo', wire.client);
        await bootReady(wire, root);
        const view = createReviewTranscriptView.mock.results.at(-1).value;
        const setActiveTurn = vi.spyOn(view, 'setActiveTurn');

        // Enter busy=true via stateChanged so the next busy=false
        // actually crosses the busy→false edge (busy starts false;
        // a stateChanged {busy:false} alone is a no-op).
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'stateChanged',
            data: { busy: true },
        });
        await Promise.resolve();

        // Enter a retry state via autoRetryStart.
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 2,
            evt: 'autoRetryStart',
            data: { attempt: 1, maxAttempts: 3 },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(setActiveTurn).toHaveBeenLastCalledWith(
            expect.objectContaining({
                retry: { attempt: 1, maxAttempts: 3 },
            }),
        );

        // A later state event flips busy→false WITHOUT a matching
        // autoRetryEnd. The guard in applyState must clear the retry
        // state so the working row hides.
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 3,
            evt: 'stateChanged',
            data: { busy: false },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(setActiveTurn).toHaveBeenLastCalledWith(null);
        expect(
            root.querySelector('.pi-active-turn').classList.contains('hidden'),
        ).toBe(true);
    });
});

describe('Pi RPC transcript controller (compactionEnd regression pinning)', () => {
    async function bootReady(wire) {
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: { sid: 's1', snapshot: { lastSeq: 0, messages: [] } },
        });
        await Promise.resolve();
        await Promise.resolve();
        wire.emit({
            t: 'res',
            id: 'hyd',
            ok: true,
            data: { lastSeq: 0, messages: [] },
        });
        await Promise.resolve();
        await Promise.resolve();
    }

    // Regression pin for Finding 1 (review-correctness blocker 1):
    // rpc.md says compaction_end is emitted whether manual or
    // automatic, and on success carries `result` with no
    // errorMessage. The plan's contract row pins the manual
    // status-bar error on errorMessage being present. A successful
    // manual /compact therefore must NOT render "pi: compaction
    // error" in the status bar.
    it('successful manual compactionEnd (no errorMessage) leaves the status bar unchanged', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        mountChatPi(root, '/work/demo', wire.client);
        await bootReady(wire);
        const view = createReviewTranscriptView.mock.results.at(-1).value;
        const statusBefore = view.status.textContent;

        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'compactionEnd',
            data: { reason: 'manual' },
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(view.status.textContent).toBe(statusBefore);
        expect(view.status.textContent).not.toBe('pi: compaction error');
    });

    // Regression pin for Finding 2 (review-correctness blocker 2):
    // The handler must call setEphemeralError(nonManual && errorMessage
    // ? text : null) UNCONDITIONALLY, so aborted compactionEnds
    // (which carry no errorMessage per rpc.md) clear any stale row
    // left by a previous failed auto-compaction.
    it('aborted compactionEnd clears a stale ephemeral row from a prior failed auto-compaction', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        mountChatPi(root, '/work/demo', wire.client);
        await bootReady(wire);
        const view = createReviewTranscriptView.mock.results.at(-1).value;
        const setEphemeralError = vi.spyOn(view, 'setEphemeralError');

        // Failed auto-compaction sets the ephemeral row.
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'compactionEnd',
            data: { reason: 'auto', errorMessage: 'provider 500' },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(setEphemeralError).toHaveBeenLastCalledWith('provider 500');

        // Aborted compactionEnd (no errorMessage, manual reason)
        // must clear the stale row.
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 2,
            evt: 'compactionEnd',
            data: { aborted: true, reason: 'manual' },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(setEphemeralError).toHaveBeenLastCalledWith(null);
    });

    // Sibling pin for the manual branch (also clears the stale row,
    // since nonManual is false for reason='manual').
    it('successful manual compactionEnd (no errorMessage) also clears a stale ephemeral row', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        mountChatPi(root, '/work/demo', wire.client);
        await bootReady(wire);
        const view = createReviewTranscriptView.mock.results.at(-1).value;
        const setEphemeralError = vi.spyOn(view, 'setEphemeralError');

        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'compactionEnd',
            data: { reason: 'auto', errorMessage: 'first failure' },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(setEphemeralError).toHaveBeenLastCalledWith('first failure');

        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 2,
            evt: 'compactionEnd',
            data: { reason: 'manual' },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(setEphemeralError).toHaveBeenLastCalledWith(null);
    });
});

describe('Pi RPC queue-backed controller (M6)', () => {
    function queueItem(frame, state = 'local') {
        return {
            id: frame.args.itemId,
            sid: frame.sid,
            sessionEpoch: frame.args.sessionEpoch,
            message: frame.args.message,
            delivery: frame.args.delivery,
            state,
            attachments: [],
            createdAt: Date.now(),
        };
    }

    async function bootQueue(
        wire,
        root,
        state = { busy: false },
        onQueueRecovery = () => {},
    ) {
        const chat = mountChatPi(
            root,
            '/work/queue',
            wire.client,
            undefined,
            undefined,
            undefined,
            undefined,
            onQueueRecovery,
        );
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: {
                sid: 's1',
                snapshot: { lastSeq: 0, messages: [] },
                state,
            },
        });
        await Promise.resolve();
        await Promise.resolve();
        const hydrate = wire.sent.find((frame) => frame.op === 'hydrate');
        wire.emit({
            t: 'res',
            id: hydrate.id,
            ok: true,
            data: {
                lastSeq: 0,
                messages: [],
                state,
                queue: { sessionEpoch: 'epoch-1', items: [] },
                dialogs: [],
            },
        });
        await Promise.resolve();
        await Promise.resolve();
        return chat;
    }

    it('sends prompt, steer, and follow-up through queueSubmit with stable IDs', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        const chat = await bootQueue(wire, root, { busy: true });

        const prompt = chat?.send({ message: 'prompt', attachments: [] });
        const promptFrame = wire.sent.find(
            (frame) =>
                frame.op === 'queueSubmit' && frame.args.message === 'prompt',
        );
        expect(promptFrame).toMatchObject({
            sid: 's1',
            args: {
                sessionEpoch: 'epoch-1',
                delivery: 'steer',
                attachmentRefs: [],
            },
        });
        wire.emit({
            t: 'res',
            id: promptFrame.id,
            ok: true,
            data: queueItem(promptFrame),
        });
        await expect(prompt).resolves.toMatchObject({
            item: { id: promptFrame.args.itemId, delivery: 'steer' },
            uncertain: false,
        });

        const follow = chat.send({
            message: 'follow-up',
            attachments: [],
            deliveryOverride: 'followUp',
        });
        const followFrame = wire.sent.find(
            (frame) =>
                frame.op === 'queueSubmit' &&
                frame.args.message === 'follow-up',
        );
        expect(followFrame.args.delivery).toBe('followUp');
        expect(followFrame.args.itemId).not.toBe(promptFrame.args.itemId);
        wire.emit({
            t: 'res',
            id: followFrame.id,
            ok: true,
            data: queueItem(followFrame),
        });
        await expect(follow).resolves.toMatchObject({ uncertain: false });

        const rows = root.querySelectorAll('.pi-queue-item');
        expect(rows).toHaveLength(2);
        expect(
            root.querySelector('[data-queue-delivery="followUp"]'),
        ).not.toBeNull();
    });

    it('clears Pi-authoritative rows on idle settlement without a busy edge', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        // The backend still emits stateChanged for agent_settled when Busy
        // was already false; this must clear display-only Pi queue rows.
        await bootQueue(wire, root, { busy: false });

        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'queueUpdate',
            data: {
                steering: ['steer-target'],
                followUp: ['follow-target'],
            },
        });
        await Promise.resolve();
        expect(root.querySelectorAll('.pi-queue-authoritative')).toHaveLength(
            2,
        );
        expect(
            root.querySelector('.pi-queue-panel')?.classList.contains('hidden'),
        ).toBe(false);

        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 2,
            evt: 'stateChanged',
            data: { busy: false },
        });
        await Promise.resolve();
        expect(root.querySelectorAll('.pi-queue-authoritative')).toHaveLength(
            0,
        );
        expect(
            root.querySelector('.pi-queue-panel')?.classList.contains('hidden'),
        ).toBe(true);
    });

    it('restores a queue-panel item through the recovery callback', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        const onQueueRecovery = vi.fn();
        await bootQueue(wire, root, { busy: false }, onQueueRecovery);
        const local = {
            id: 'local-restore',
            sid: 's1',
            sessionEpoch: 'epoch-1',
            message: 'restore this draft',
            delivery: 'prompt',
            state: 'local',
            attachments: [
                {
                    ref: 'a'.repeat(64),
                    name: 'capture.png',
                    mimeType: 'image/png',
                    sizeBytes: 12,
                },
            ],
            createdAt: 1,
        };
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'queueChanged',
            data: { sessionEpoch: 'epoch-1', items: [local] },
        });
        await Promise.resolve();
        const restore = root.querySelector('.pi-queue-restore');
        expect(restore).not.toBeNull();
        restore.click();
        const restoreFrame = wire.sent.find(
            (frame) => frame.op === 'queueRestore',
        );
        expect(restoreFrame).toMatchObject({
            sid: 's1',
            args: { itemId: 'local-restore', sessionEpoch: 'epoch-1' },
        });
        const result = {
            restored: true,
            item: { ...local, state: 'cancelled' },
        };
        wire.emit({
            t: 'res',
            id: restoreFrame.id,
            ok: true,
            data: result,
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(onQueueRecovery).toHaveBeenCalledWith(result);
    });

    it('keeps queue restore no-op and errors out of recovery', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        const onQueueRecovery = vi.fn();
        await bootQueue(wire, root, { busy: false }, onQueueRecovery);
        const local = {
            id: 'local-noop',
            sid: 's1',
            sessionEpoch: 'epoch-1',
            message: 'leave this draft',
            delivery: 'prompt',
            state: 'local',
            attachments: [],
            createdAt: 1,
        };
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'queueChanged',
            data: { sessionEpoch: 'epoch-1', items: [local] },
        });
        await Promise.resolve();
        root.querySelector('.pi-queue-restore').click();
        let restoreFrame = wire.sent.find(
            (frame) => frame.op === 'queueRestore',
        );
        wire.emit({
            t: 'res',
            id: restoreFrame.id,
            ok: true,
            data: { restored: false, reason: 'not-local' },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(onQueueRecovery).not.toHaveBeenCalled();
        expect(root.querySelector('.pi-queue-restore')).not.toBeNull();

        root.querySelector('.pi-queue-restore').click();
        restoreFrame = wire.sent.filter(
            (frame) => frame.op === 'queueRestore',
        )[1];
        wire.emit({
            t: 'res',
            id: restoreFrame.id,
            ok: false,
            error: 'restore failed',
        });
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(onQueueRecovery).not.toHaveBeenCalled();
        expect(root.textContent).toContain(
            'Queue action failed: restore failed',
        );
    });

    it('clears an optimistic turn on idle settlement without a busy=true edge', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        const chat = await bootQueue(wire, root);
        const pending = chat.send({ message: 'history', attachments: [] });
        const frame = wire.sent.find(
            (candidate) => candidate.op === 'queueSubmit',
        );
        wire.emit({
            t: 'res',
            id: frame.id,
            ok: true,
            data: queueItem(frame, 'sending'),
        });
        await Promise.resolve();
        await Promise.resolve();

        // Queue consumption is published only after agent_settled as an
        // identity-bearing queueChanged transition; a bare idle state cannot
        // consume the item.
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'queueChanged',
            data: {
                sessionEpoch: 'epoch-1',
                items: [queueItem(frame, 'consumed')],
            },
        });
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 2,
            evt: 'stateChanged',
            data: { busy: false },
        });
        await Promise.resolve();
        await Promise.resolve();

        await expect(pending).resolves.toMatchObject({ uncertain: false });
        expect(
            root.querySelector('.pi-active-turn')?.classList.contains('hidden'),
        ).toBe(true);
        expect(
            root.querySelector('[data-pi-optimistic-prompt="true"]'),
        ).toBeNull();
    });

    it('keeps duplicate text on separate queue IDs and does not use text as identity', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        const chat = await bootQueue(wire, root);
        const first = chat.send({ message: 'same', attachments: [] });
        const firstFrame = wire.sent.find(
            (frame) => frame.op === 'queueSubmit',
        );
        wire.emit({
            t: 'res',
            id: firstFrame.id,
            ok: true,
            data: queueItem(firstFrame, 'accepted'),
        });
        await first;
        const second = chat.send({ message: 'same', attachments: [] });
        const secondFrame = wire.sent.filter(
            (frame) => frame.op === 'queueSubmit',
        )[1];
        wire.emit({
            t: 'res',
            id: secondFrame.id,
            ok: true,
            data: queueItem(secondFrame, 'accepted'),
        });
        await second;

        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'messageEnd',
            data: { message: { role: 'user', content: 'same' } },
        });
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 2,
            evt: 'messageEnd',
            data: { message: { role: 'user', content: 'same' } },
        });
        await Promise.resolve();
        await Promise.resolve();
        // User message text does not consume queue-backed optimistic records;
        // duplicate text has no stable identity at this lifecycle point.
        expect(
            root.querySelectorAll('[data-pi-optimistic-message="true"]'),
        ).toHaveLength(2);
        const ids = [...root.querySelectorAll('.pi-queue-item')].map(
            (row) => row.dataset.queueId,
        );
        expect(ids).toEqual([firstFrame.args.itemId, secondFrame.args.itemId]);
        expect(new Set(ids).size).toBe(2);

        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 3,
            evt: 'queueChanged',
            data: {
                sessionEpoch: 'epoch-1',
                items: [
                    queueItem(firstFrame, 'consumed'),
                    queueItem(secondFrame, 'consumed'),
                ],
            },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(
            root.querySelectorAll('[data-pi-optimistic-message="true"]'),
        ).toHaveLength(0);
    });

    it('keeps search state on the live chat handle and reveals a settled match', async () => {
        vi.useFakeTimers();
        try {
            const root = document.createElement('div');
            const wire = fakeClient();
            const chat = await bootQueue(wire, root);
            wire.emit({
                t: 'evt',
                sid: 's1',
                seq: 1,
                evt: 'messageEnd',
                data: {
                    message: {
                        role: 'user',
                        content: [{ type: 'text', text: 'search target' }],
                    },
                },
            });
            await Promise.resolve();
            await Promise.resolve();
            expect(chat.toggleSearch()).toBe(true);
            const input = root.querySelector('[data-pi-search-input]');
            input.value = 'target';
            input.dispatchEvent(new Event('input'));
            vi.advanceTimersByTime(120);
            expect(
                root.querySelector('[data-pi-search-count]').textContent,
            ).toBe('1 / 1');
            expect(
                root.querySelector('mark[data-pi-active-match]'),
            ).not.toBeNull();
            expect(chat.closeSearch()).toBe(true);
            expect(chat.toggleSearch()).toBe(true);
            expect(input.value).toBe('target');
            chat.destroy();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('Pi RPC dialog controller integration (M7)', () => {
    const dialog = {
        id: 'dialog-1',
        method: 'select',
        title: 'Choose fixture',
        options: ['Allow', 'Block'],
        timeout: 5000,
        createdAt: 1,
    };

    async function bootDialog(wire, root, dialogs = [dialog]) {
        const chat = mountChatPi(root, '/work/dialog', wire.client);
        wire.emit({
            t: 'res',
            id: 'sp',
            ok: true,
            data: {
                sid: 's1',
                snapshot: { lastSeq: 0, messages: [] },
                state: { busy: false },
            },
        });
        await Promise.resolve();
        await Promise.resolve();
        const hydrate = wire.sent.find((frame) => frame.op === 'hydrate');
        wire.emit({
            t: 'res',
            id: hydrate.id,
            ok: true,
            data: {
                lastSeq: 0,
                messages: [],
                state: { busy: false },
                queue: { sessionEpoch: 'epoch-1', items: [] },
                dialogs,
            },
        });
        await Promise.resolve();
        await Promise.resolve();
        return chat;
    }

    it('rehydrates one dialog, sends one exact response, and closes it', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        await bootDialog(wire, root);
        const overlay = root.querySelector('[data-dialog-id="dialog-1"]');
        expect(
            overlay?.querySelector('[data-dialog-value="Allow"]'),
        ).not.toBeNull();
        overlay.querySelector('[data-dialog-value="Allow"]').click();
        const response = wire.sent.find(
            (frame) => frame.op === 'extensionUiResponse',
        );
        expect(response).toMatchObject({
            sid: 's1',
            args: { requestId: 'dialog-1', value: 'Allow' },
        });
        wire.emit({
            t: 'res',
            id: response.id,
            ok: true,
            data: { resolved: true },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(root.querySelector('[data-dialog-id="dialog-1"]')).toBeNull();
        expect(
            wire.sent.filter((frame) => frame.op === 'extensionUiResponse'),
        ).toHaveLength(1);
    });

    it('keeps a retained dialog across a sequence-gap hydrate without duplication', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        await bootDialog(wire, root);
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 2,
            evt: 'stateChanged',
            data: { busy: false },
        });
        await Promise.resolve();
        const hydrate = wire.sent.at(-1);
        expect(hydrate.op).toBe('hydrate');
        wire.emit({
            t: 'res',
            id: hydrate.id,
            ok: true,
            data: {
                lastSeq: 2,
                messages: [],
                state: { busy: false },
                queue: { sessionEpoch: 'epoch-1', items: [] },
                dialogs: [dialog],
            },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(
            root.querySelectorAll('[data-dialog-id="dialog-1"]'),
        ).toHaveLength(1);
    });

    it('closes on child exit and explicit tab cancellation without a second response', async () => {
        const root = document.createElement('div');
        const wire = fakeClient();
        const chat = await bootDialog(wire, root);
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 1,
            evt: 'extensionUiClosed',
            data: { id: 'dialog-1', reason: 'childExit' },
        });
        await Promise.resolve();
        expect(root.querySelector('[data-dialog-id="dialog-1"]')).toBeNull();
        expect(root.textContent).toContain('Pi exited and closed the dialog');

        const second = { ...dialog, id: 'dialog-2' };
        wire.emit({
            t: 'evt',
            sid: 's1',
            seq: 2,
            evt: 'extensionUiRequest',
            data: second,
        });
        const cancel = chat.cancelDialogs('tabClosed');
        const cancelFrame = wire.sent.find(
            (frame) => frame.op === 'extensionUiCancel',
        );
        expect(cancelFrame).toMatchObject({
            sid: 's1',
            args: { reason: 'tabClosed' },
        });
        wire.emit({
            t: 'res',
            id: cancelFrame.id,
            ok: true,
            data: { cancelled: 1 },
        });
        await expect(cancel).resolves.toEqual({ cancelled: 1 });
        expect(root.querySelector('[data-dialog-id="dialog-2"]')).toBeNull();
        expect(
            wire.sent.filter((frame) => frame.op === 'extensionUiResponse'),
        ).toHaveLength(0);
    });
});
