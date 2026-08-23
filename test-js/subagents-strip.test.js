// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createSubagentStrip,
    createSubagentViewer,
    hideSubagentStrip,
} from '../web/chat-pi/subagents.js';
import { mountChatPi } from '../web/chat-pi/index.js';

const snapshot = {
    runs: [
        {
            id: 'run-1',
            kind: 'agent',
            label: 'worker-bee-with-a-very-long-label',
            state: 'running',
            activity: { currentTool: 'read' },
        },
        { id: 'run-2', kind: 'agent', label: 'reviewer', state: 'complete' },
    ],
};

function mountStrip(isActive = () => true) {
    const onClick = vi.fn();
    const strip = createSubagentStrip(isActive, onClick);
    return { strip, onClick };
}

function fakeClient(transcript = { runId: 'run-1', steps: [] }) {
    let listener = () => {};
    const client = {
        call: vi.fn((op) => {
            if (op === 'subagentTranscript') return Promise.resolve(transcript);
            if (op === 'spawn')
                return Promise.resolve({
                    sid: 'sid-1',
                    snapshot: { lastSeq: 0, messages: [] },
                    state: { busy: false },
                });
            if (op === 'hydrate')
                return Promise.resolve({
                    lastSeq: 0,
                    messages: [],
                    state: { busy: false },
                });
            if (op === 'prompt') return Promise.resolve({ accepted: true });
            return Promise.resolve({});
        }),
        send: vi.fn(),
        onMessage: vi.fn((callback) => {
            listener = callback;
            return () => {};
        }),
        close: vi.fn(),
        emit: (env) => listener(env),
    };
    return client;
}

async function settlePromises() {
    await Promise.resolve();
    await Promise.resolve();
}

beforeEach(() => {
    document.body.innerHTML = '';
    const el = document.createElement('div');
    el.id = 'subagent-strip';
    el.className = 'subagent-strip hidden';
    document.body.append(el);
});

describe('subagent strip', () => {
    it('renders one chip per top-level run with dot classes', () => {
        const { strip } = mountStrip();
        strip.update(snapshot);
        const chips = document.querySelectorAll('.subagent-chip');
        expect(chips.length).toBe(2);
        expect(chips[0].querySelector('.dot-running')).not.toBeNull();
        expect(chips[1].querySelector('.dot-complete')).not.toBeNull();
        expect(strip.root.classList.contains('hidden')).toBe(false);
    });

    it('truncates labels longer than 24 characters', () => {
        const { strip } = mountStrip();
        strip.update(snapshot);
        const label = document.querySelector('.subagent-chip-label');
        expect(label?.textContent?.length).toBe(24);
        expect(label?.textContent?.endsWith('…')).toBe(true);
    });

    it('hides and clears on empty runs, null, and undefined data', () => {
        const { strip } = mountStrip();
        for (const data of [{ runs: [] }, null, undefined]) {
            strip.update(data);
            expect(strip.root.classList.contains('hidden')).toBe(true);
            expect(strip.root.children.length).toBe(0);
        }
    });

    it('maps unknown states to the gray dot', () => {
        const { strip } = mountStrip();
        strip.update({ runs: [{ id: 'x', label: 'x', state: 'paused' }] });
        const dot = strip.root.querySelector('.dot');
        expect(dot?.className).toContain('dot-queued');
    });

    it('dispatches onClick with runId and label on chip click', () => {
        const { strip, onClick } = mountStrip();
        strip.update(snapshot);
        const chip = strip.root.querySelector('.subagent-chip');
        chip.click();
        expect(onClick).toHaveBeenCalledWith(
            'run-1',
            'worker-bee-with-a-very-long-label',
        );
    });

    it('no-ops update when the pane is not the active tab', () => {
        const { strip } = mountStrip(() => false);
        strip.update(snapshot);
        expect(strip.root.children.length).toBe(0);
        expect(strip.root.classList.contains('hidden')).toBe(true);
    });

    it('ignores nested children — only top-level runs become chips', () => {
        const { strip } = mountStrip();
        strip.update({
            runs: [
                {
                    id: 'parent',
                    label: 'fleet',
                    state: 'running',
                    children: [{ id: 'child', label: 'kid', state: 'failed' }],
                },
            ],
        });
        const chips = strip.root.querySelectorAll('.subagent-chip');
        expect(chips.length).toBe(1);
    });

    it('destroy removes children and hides; second destroy does not throw', () => {
        const { strip } = mountStrip();
        strip.update(snapshot);
        strip.destroy();
        expect(strip.root.children.length).toBe(0);
        expect(strip.root.classList.contains('hidden')).toBe(true);
        expect(() => strip.destroy()).not.toThrow();
    });

    it('falls back to a detached root when the element is absent', () => {
        document.body.innerHTML = '';
        const strip = createSubagentStrip(
            () => true,
            () => {},
        );
        expect(() => strip.update(snapshot)).not.toThrow();
        expect(strip.root.isConnected).toBe(false);
    });

    it('hideSubagentStrip hides the shared element', () => {
        const { strip } = mountStrip();
        strip.update(snapshot);
        hideSubagentStrip();
        expect(
            document
                .getElementById('subagent-strip')
                ?.classList.contains('hidden'),
        ).toBe(true);
    });
});

describe('subagent transcript viewer', () => {
    const transcript = {
        runId: 'run-1',
        steps: [
            {
                label: 'Implement worker',
                sessionFile: '/tmp/session.jsonl',
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Please inspect this file.' },
                        ],
                    },
                    {
                        role: 'assistant',
                        content: [{ type: 'text', text: 'I inspected it.' }],
                    },
                ],
            },
        ],
    };

    it('opens an inline viewer with a primary rail entry, run entry, step header, and messages', async () => {
        const root = document.createElement('div');
        document.body.append(root);
        const client = fakeClient(transcript);
        const viewer = createSubagentViewer(root, client, '/work/demo');

        viewer.open('run-1', 'worker');
        await settlePromises();

        expect(viewer.isOpen()).toBe(true);
        expect(root.querySelector('.subagent-viewer')).not.toBeNull();
        expect(root.querySelectorAll('.subagent-rail button')).toHaveLength(2);
        expect(root.querySelector('.subagent-rail-primary')?.textContent).toBe(
            'Primary',
        );
        expect(root.querySelector('.subagent-step-header')?.textContent).toBe(
            'Implement worker',
        );
        expect(
            root.querySelectorAll('.user-message, .assistant-message').length,
        ).toBeGreaterThanOrEqual(1);

        viewer.close();
        expect(viewer.isOpen()).toBe(false);
        expect(root.querySelector('.subagent-viewer')).toBeNull();
        expect(() => viewer.close()).not.toThrow();
    });

    it('renders paired tool output through the structured renderer', async () => {
        const root = document.createElement('div');
        document.body.append(root);
        const client = fakeClient({
            runId: 'run-tool',
            steps: [
                {
                    label: 'Read source',
                    sessionFile: '/tmp/tool-session.jsonl',
                    messages: [
                        {
                            role: 'assistant',
                            content: [
                                {
                                    type: 'toolCall',
                                    id: 'call-1',
                                    name: 'read',
                                    arguments: { path: '/work/demo/file.ts' },
                                },
                            ],
                        },
                        {
                            role: 'toolResult',
                            toolCallId: 'call-1',
                            content: [{ type: 'text', text: 'source text' }],
                        },
                    ],
                },
            ],
        });
        const viewer = createSubagentViewer(root, client, '/work/demo');

        viewer.open('run-tool', 'tool worker');
        await settlePromises();

        expect(root.querySelector('.tool-execution')).not.toBeNull();
        viewer.destroy();
    });

    it('shows the existing empty state when no transcript messages are readable', async () => {
        const root = document.createElement('div');
        document.body.append(root);
        const viewer = createSubagentViewer(
            root,
            fakeClient({ runId: 'empty', steps: [] }),
            '/work/demo',
        );

        viewer.open('empty', 'empty worker');
        await settlePromises();

        expect(root.querySelector('.review-empty')?.textContent).toContain(
            'No messages found',
        );
        viewer.destroy();
    });

    it('keeps the viewer open and reports transcript call errors', async () => {
        const root = document.createElement('div');
        document.body.append(root);
        const client = fakeClient();
        client.call.mockImplementation(() =>
            Promise.reject(new Error('disk unavailable')),
        );
        const viewer = createSubagentViewer(root, client, '/work/demo');

        viewer.open('run-error', 'failed worker');
        await settlePromises();

        expect(viewer.isOpen()).toBe(true);
        expect(root.querySelector('.subagent-viewer-error')?.textContent).toBe(
            'disk unavailable',
        );
        viewer.destroy();
    });

    it('closes from the Primary rail button and clears the overlay on destroy', async () => {
        const root = document.createElement('div');
        document.body.append(root);
        const viewer = createSubagentViewer(
            root,
            fakeClient(transcript),
            '/work/demo',
        );

        viewer.open('run-1', 'worker');
        await settlePromises();
        root.querySelector('.subagent-rail-primary').click();
        expect(viewer.isOpen()).toBe(false);
        viewer.destroy();
        expect(root.querySelector('.subagent-viewer')).toBeNull();
    });

    it('blocks chat sends while the mounted viewer is open and destroys it with the chat', async () => {
        const root = document.createElement('div');
        root.className = 'active';
        document.body.append(root);
        const client = fakeClient(transcript);
        const chat = mountChatPi(root, '/work/demo', client);
        await settlePromises();
        client.emit({
            t: 'evt',
            sid: 'sid-1',
            seq: 1,
            evt: 'subagentFleet',
            data: {
                runs: [{ id: 'run-1', label: 'worker', state: 'running' }],
            },
        });
        document.querySelector('#subagent-strip .subagent-chip').click();
        await settlePromises();

        expect(chat.send('blocked while reading')).toBe(false);
        expect(client.call).not.toHaveBeenCalledWith(
            'prompt',
            expect.anything(),
            expect.anything(),
        );
        chat.destroy();
        expect(root.querySelector('.subagent-viewer')).toBeNull();
        expect(document.getElementById('subagent-strip').children).toHaveLength(
            0,
        );
    });
});
