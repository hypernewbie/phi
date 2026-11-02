// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../web/chat-pi/client.js', () => ({
    connectControl: vi.fn(),
}));
vi.mock('../web/chat-pi/persist.js', () => ({
    savePersisted: vi.fn(),
}));

import { connectControl } from '../web/chat-pi/client.js';
import { destroyRpcChat, mountRpcChat } from '../web/chat-pi/controller.js';
import { TabManager } from '../web/terminal.js';

afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
});

function fakeClient() {
    const sent = [];
    const pending = new Map();
    let listener = () => {};
    return {
        sent,
        client: {
            call(op, sid, args) {
                const id = `call-${sent.length + 1}`;
                sent.push({ id, op, sid, args });
                return new Promise((resolve, reject) => {
                    pending.set(id, { resolve, reject });
                });
            },
            onMessage(callback) {
                listener = callback;
                return () => {
                    listener = () => {};
                };
            },
            onState() {
                return () => {};
            },
            close() {},
        },
        emit(frame) {
            listener(frame);
        },
        respond(id, data) {
            const waiter = pending.get(id);
            pending.delete(id);
            waiter.resolve(data);
        },
        fail(id, error) {
            const waiter = pending.get(id);
            pending.delete(id);
            waiter.reject(error);
        },
    };
}

async function flush(count = 2) {
    for (let index = 0; index < count; index += 1) await Promise.resolve();
}

describe('Pi RPC queue recovery bridge', () => {
    it('dispatches controller recovery on document and restores the terminal draft and chip', async () => {
        const setup = vi
            .spyOn(TabManager.prototype, 'setupEventListeners')
            .mockImplementation(() => {});
        const interval = vi
            .spyOn(globalThis, 'setInterval')
            .mockImplementation(() => 0);
        const paneId = 'pi-rpc:/work/queue-bridge';
        const root = document.createElement('div');
        const wire = fakeClient();
        const recoveryEvents = [];
        const onRecovery = (event) => recoveryEvents.push(event);
        const terminal = new TabManager({});
        terminal._listenQueueRecovery();
        terminal.tabs.set(paneId, {
            paneId,
            coder: 'pi-rpc',
            termContainer: document.createElement('div'),
        });
        terminal.activePaneId = paneId;
        terminal.inputTextArea = document.createElement('textarea');
        terminal.attachmentStrip = document.createElement('div');
        terminal.stagedAttachments = [];
        terminal.adjustInputHeight = vi.fn();
        terminal.piRpcStatusBar = document.createElement('div');
        terminal.presetsContainer = document.createElement('div');
        document.body.append(terminal.inputTextArea, terminal.attachmentStrip);
        document.addEventListener('phi:pi-queue-recovery', onRecovery);

        try {
            connectControl.mockReturnValueOnce(wire.client);
            mountRpcChat(paneId, root, '/work/queue-bridge');
            const spawnFrame = wire.sent.find((frame) => frame.op === 'spawn');
            expect(spawnFrame).toBeDefined();
            wire.respond(spawnFrame.id, {
                sid: 's1',
                title: 'Pi RPC',
                cwd: '/work/queue-bridge',
                snapshot: { lastSeq: 0, messages: [] },
                state: {},
            });
            await flush();
            const hydrate = wire.sent.find((frame) => frame.op === 'hydrate');
            expect(hydrate).toBeDefined();
            wire.respond(hydrate.id, {
                lastSeq: 0,
                messages: [],
                state: {},
                queue: { sessionEpoch: 'epoch-1', items: [] },
                dialogs: [],
            });
            await flush();

            const local = {
                id: 'local-bridge',
                sid: 's1',
                sessionEpoch: 'epoch-1',
                message: 'restore through controller',
                delivery: 'prompt',
                state: 'local',
                attachments: [
                    {
                        ref: 'b'.repeat(64),
                        name: 'bridge.png',
                        mimeType: 'image/png',
                        sizeBytes: 24,
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
            await flush();

            // Item identity, never message text, decides what the server
            // already has: a different item carrying the same words must not
            // retire the unsent row.
            wire.emit({
                t: 'evt',
                sid: 's1',
                seq: 2,
                evt: 'queueChanged',
                data: {
                    sessionEpoch: 'epoch-1',
                    items: [
                        {
                            id: 'server-same-text',
                            sid: 's1',
                            sessionEpoch: 'epoch-1',
                            message: 'restore through controller',
                            delivery: 'steer',
                            state: 'sending',
                            attachments: [],
                            createdAt: 2,
                        },
                    ],
                },
            });
            await flush();
            expect(
                [...root.querySelectorAll('.pi-queue-item')].map(
                    (row) => row.dataset.queueId,
                ),
            ).toEqual(['server-same-text', 'local-bridge']);

            const restore = root.querySelector('.pi-queue-restore');
            expect(restore).not.toBeNull();
            restore.click();
            const restoreFrame = wire.sent.find(
                (frame) => frame.op === 'queueRestore',
            );
            expect(restoreFrame).toMatchObject({
                sid: 's1',
                args: { itemId: 'local-bridge', sessionEpoch: 'epoch-1' },
            });
            const result = {
                restored: true,
                item: { ...local, state: 'cancelled' },
            };
            wire.respond(restoreFrame.id, result);
            await flush(3);

            expect(recoveryEvents).toHaveLength(1);
            expect(recoveryEvents[0].target).toBe(document);
            expect(recoveryEvents[0].detail).toEqual({
                paneId,
                recovery: result,
            });
            expect(terminal.tabs.get(paneId).draft).toBe(
                'restore through controller',
            );
            expect(terminal.inputTextArea.value).toBe(
                'restore through controller',
            );
            // The browser never holds the bytes behind a queued attachment,
            // so recovery restores the text and stages no chip that would
            // resolve to a path that does not exist.
            expect(terminal.stagedAttachments).toEqual([]);
            expect(terminal.attachmentStrip.children).toHaveLength(0);
        } finally {
            document.removeEventListener('phi:pi-queue-recovery', onRecovery);
            terminal._piRpcStatusUnsubscribe?.();
            destroyRpcChat(paneId);
            setup.mockRestore();
            interval.mockRestore();
        }
    });

    it('parks inactive-pane recovery without disturbing the active Pi composer', async () => {
        const setup = vi
            .spyOn(TabManager.prototype, 'setupEventListeners')
            .mockImplementation(() => {});
        const interval = vi
            .spyOn(globalThis, 'setInterval')
            .mockImplementation(() => 0);
        const activePaneId = 'pi-rpc:/work/queue-active';
        const targetPaneId = 'pi-rpc:/work/queue-target';
        const activeRoot = document.createElement('div');
        const targetRoot = document.createElement('div');
        const activeWire = fakeClient();
        const targetWire = fakeClient();
        const terminal = new TabManager({});
        terminal._listenQueueRecovery();
        const activeTabEl = document.createElement('div');
        const targetTabEl = document.createElement('div');
        activeTabEl.scrollIntoView = vi.fn();
        targetTabEl.scrollIntoView = vi.fn();
        const activeTermContainer = document.createElement('div');
        const targetTermContainer = document.createElement('div');
        const activeTab = {
            paneId: activePaneId,
            coder: 'pi-rpc',
            tabEl: activeTabEl,
            termContainer: activeTermContainer,
            workspace: '/work',
            cwd: '/work',
            sessionId: activePaneId,
            draft: '',
            draftAttachments: [],
            directMode: false,
            isDead: false,
        };
        const targetTab = {
            paneId: targetPaneId,
            coder: 'pi-rpc',
            tabEl: targetTabEl,
            termContainer: targetTermContainer,
            workspace: '/work',
            cwd: '/work',
            sessionId: targetPaneId,
            draft: '',
            draftAttachments: [],
            directMode: false,
            isDead: false,
        };
        terminal.tabs.set(activePaneId, activeTab);
        terminal.tabs.set(targetPaneId, targetTab);
        terminal.activePaneId = activePaneId;
        terminal.inputTextArea = document.createElement('textarea');
        terminal.attachmentStrip = document.createElement('div');
        terminal.stagedAttachments = [];
        terminal.adjustInputHeight = vi.fn();
        terminal.piRpcStatusBar = document.createElement('div');
        terminal.presetsContainer = document.createElement('div');
        terminal.inputBarContainer = document.createElement('div');
        terminal.updateDirectModeUI = vi.fn();
        terminal.activateTabViewport = vi.fn();
        terminal.saveTabsState = vi.fn();
        terminal.updateDocumentTitle = vi.fn();
        terminal.app = {
            config: {},
            terminalFontSize: 14,
            sessionsManager: {
                activeCoder: 'pi-rpc',
                activeWorkspace: '/work',
                activeCWD: '/work',
                switchCoder: vi.fn(),
                highlightActiveSession: vi.fn(),
                highlightActiveWorktree: vi.fn(),
                workspaceSelect: { value: '/work' },
                updateWorkspaceSelectWidth: vi.fn(),
                loadWorktrees: vi.fn(() => Promise.resolve()),
            },
            diffController: { refreshDiff: vi.fn() },
            markdownManager: { refreshFiles: vi.fn() },
        };
        const activeAttachment = {
            id: 'active-attachment',
            ref: 'a'.repeat(64),
            name: 'active.png',
            type: 'image/png',
            sizeBytes: 12,
            source: 'paste',
        };
        const targetRef = 'b'.repeat(64);
        terminal.inputTextArea.value = 'active pane draft';
        terminal.stagedAttachments = [activeAttachment];
        terminal._renderAttachmentStrip();
        const activeChipMarkup = terminal.attachmentStrip.innerHTML;
        const focusSentinel = document.createElement('button');
        document.body.append(
            focusSentinel,
            terminal.inputTextArea,
            terminal.attachmentStrip,
        );
        focusSentinel.focus();
        const activeElementBeforeRecovery = document.activeElement;

        const bootstrap = async (wire, sid, sessionEpoch) => {
            const spawnFrame = wire.sent.find((frame) => frame.op === 'spawn');
            expect(spawnFrame).toBeDefined();
            wire.respond(spawnFrame.id, {
                sid,
                title: 'Pi RPC',
                cwd: '/work',
                snapshot: { lastSeq: 0, messages: [] },
                state: {},
            });
            await flush();
            const hydrate = wire.sent.find((frame) => frame.op === 'hydrate');
            expect(hydrate).toBeDefined();
            wire.respond(hydrate.id, {
                lastSeq: 0,
                messages: [],
                state: {},
                queue: { sessionEpoch, items: [] },
                dialogs: [],
            });
            await flush();
        };

        try {
            connectControl
                .mockReturnValueOnce(activeWire.client)
                .mockReturnValueOnce(targetWire.client);
            mountRpcChat(activePaneId, activeRoot, '/work/queue-active');
            mountRpcChat(targetPaneId, targetRoot, '/work/queue-target');
            await bootstrap(activeWire, 'active-sid', 'active-epoch');
            await bootstrap(targetWire, 'target-sid', 'target-epoch');

            const local = {
                id: 'local-inactive-bridge',
                sid: 'target-sid',
                sessionEpoch: 'target-epoch',
                message: 'restore target pane',
                delivery: 'prompt',
                state: 'local',
                attachments: [
                    {
                        ref: targetRef,
                        name: 'target.png',
                        mimeType: 'image/png',
                        sizeBytes: 24,
                    },
                ],
                createdAt: 1,
            };
            targetWire.emit({
                t: 'evt',
                sid: 'target-sid',
                seq: 1,
                evt: 'queueChanged',
                data: { sessionEpoch: 'target-epoch', items: [local] },
            });
            await flush();

            const restore = targetRoot.querySelector('.pi-queue-restore');
            expect(restore).not.toBeNull();
            restore.click();
            const restoreFrame = targetWire.sent.find(
                (frame) => frame.op === 'queueRestore',
            );
            expect(restoreFrame).toMatchObject({
                sid: 'target-sid',
                args: {
                    itemId: 'local-inactive-bridge',
                    sessionEpoch: 'target-epoch',
                },
            });
            const result = {
                restored: true,
                item: { ...local, state: 'cancelled' },
            };
            targetWire.respond(restoreFrame.id, result);
            await flush(3);

            expect(terminal.activePaneId).toBe(activePaneId);
            expect(terminal.inputTextArea.value).toBe('active pane draft');
            expect(terminal.stagedAttachments).toEqual([activeAttachment]);
            expect(terminal.attachmentStrip.innerHTML).toBe(activeChipMarkup);
            expect(document.activeElement).toBe(activeElementBeforeRecovery);
            expect(targetTab.draft).toBe('restore target pane');
            expect(targetTab.draftAttachments).toEqual([]);

            terminal.switchTab(targetPaneId);
            expect(terminal.activePaneId).toBe(targetPaneId);
            expect(terminal.inputTextArea.value).toBe('restore target pane');
            expect(terminal.stagedAttachments).toEqual([]);

            const activeLocal = {
                id: 'local-active-bridge',
                sid: 'target-sid',
                sessionEpoch: 'target-epoch',
                message: 'restore active target',
                delivery: 'prompt',
                state: 'local',
                attachments: [
                    {
                        ref: 'd'.repeat(64),
                        name: 'active-target.png',
                        mimeType: 'image/png',
                        sizeBytes: 48,
                    },
                ],
                createdAt: 2,
            };
            focusSentinel.focus();
            targetWire.emit({
                t: 'evt',
                sid: 'target-sid',
                seq: 2,
                evt: 'queueChanged',
                data: { sessionEpoch: 'target-epoch', items: [activeLocal] },
            });
            await flush();
            const activeRestore = targetRoot.querySelector('.pi-queue-restore');
            expect(activeRestore).not.toBeNull();
            activeRestore.click();
            const activeRestoreFrame = targetWire.sent
                .filter((frame) => frame.op === 'queueRestore')
                .at(-1);
            expect(activeRestoreFrame).toMatchObject({
                sid: 'target-sid',
                args: {
                    itemId: 'local-active-bridge',
                    sessionEpoch: 'target-epoch',
                },
            });
            const activeResult = {
                restored: true,
                item: { ...activeLocal, state: 'cancelled' },
            };
            targetWire.respond(activeRestoreFrame.id, activeResult);
            await flush(3);
            // Pi prepends restored text before whatever the user has typed, so
            // recovery can never overwrite an existing draft.
            expect(targetTab.draft).toBe(
                'restore active target\n\nrestore target pane',
            );
            expect(terminal.inputTextArea.value).toBe(
                'restore active target\n\nrestore target pane',
            );
            expect(terminal.stagedAttachments).toEqual([]);
            expect(document.activeElement).toBe(terminal.inputTextArea);
        } finally {
            terminal._piRpcStatusUnsubscribe?.();
            destroyRpcChat(activePaneId);
            destroyRpcChat(targetPaneId);
            setup.mockRestore();
            interval.mockRestore();
        }
    });
});
