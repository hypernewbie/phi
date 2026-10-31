// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { TabManager } from '../web/terminal.js';
import { AttachmentStore } from '../web/attachment-store.js';

setupDomHarness();

function makeManager() {
    const tm = Object.create(TabManager.prototype);
    tm.tabs = new Map();
    tm.activePaneId = 'pane-a';
    tm.inputBarContainer = document.createElement('div');
    tm.inputTextArea = document.createElement('textarea');
    tm.attachmentStrip = document.createElement('div');
    tm.attachmentStatus = document.createElement('div');
    tm.attachInputBtn = document.createElement('button');
    tm.attachmentFileInput = document.createElement('input');
    tm.attachmentFileInput.type = 'file';
    tm.attachmentPhotoInput = document.createElement('input');
    tm.attachmentPhotoInput.type = 'file';
    tm.attachmentCameraInput = document.createElement('input');
    tm.attachmentCameraInput.type = 'file';
    tm.attachmentSourceDropup = document.createElement('div');
    tm.attachmentSourceDropup.id = 'attachment-source-dropup';
    tm.attachmentSourceDropup.className = 'model-presets-dropup hidden';
    document.body.appendChild(tm.attachmentSourceDropup);
    tm.attachmentServerModal = document.createElement('div');
    tm.attachmentServerModal.className = 'modal-overlay hidden';
    tm.attachmentServerTree = document.createElement('div');
    tm.attachmentServerModal.appendChild(tm.attachmentServerTree);
    tm.attachmentServerStatus = document.createElement('div');
    tm.attachmentServerModal.appendChild(tm.attachmentServerStatus);
    document.body.appendChild(tm.attachmentServerModal);
    tm.stagedAttachments = [];
    tm._attachmentRequestScopes = new Map();
    tm.sendInput = vi.fn(() => true);
    tm.updateDirectModeUI = vi.fn();
    tm.adjustInputHeight = vi.fn();
    tm._resetPiRecall = vi.fn();
    tm._resumeFollowOnSubmit = vi.fn();
    tm.app = {
        scope: {
            profileId: 'profile-a',
            origin: 'https://phi-a.example',
            signal: new AbortController().signal,
            headers: () => ({ 'X-Phi-Backend': 'profile-a' }),
        },
        sessionsManager: { activeCWD: '/project-a' },
        showToast: vi.fn(),
    };
    tm.attachmentStore = new AttachmentStore({ indexedDB: null });
    tm.attachmentStore.bind(tm.app.scope);
    tm._attachmentStorageWarning = '';
    const tabA = {
        paneId: 'pane-a',
        coder: 'pi',
        cwd: '/project-a',
        directMode: true,
        isDead: false,
        draft: '',
        draftAttachments: [],
        ws: { readyState: 1 },
    };
    const tabB = {
        paneId: 'pane-b',
        coder: 'pi',
        cwd: '/project-b',
        directMode: false,
        isDead: false,
        draft: '',
        draftAttachments: [],
        ws: { readyState: 1 },
    };
    tm.tabs.set(tabA.paneId, tabA);
    tm.tabs.set(tabB.paneId, tabB);
    tm.getActiveTab = () => tm.tabs.get(tm.activePaneId);
    tm.saveTabDraft = TabManager.prototype.saveTabDraft.bind(tm);
    tm.saveActiveDraft = function () {
        const tab = this.getActiveTab();
        if (!tab) return;
        tab.draft = this.inputTextArea.value;
        tab.draftAttachments = this.stagedAttachments;
        this.saveTabDraft(tab);
    };
    tm._attachmentToast = vi.fn();
    tm._initAttachmentControl();
    return { tm, tabA, tabB };
}

function png(name = 'public.png') {
    return new File(
        [
            new Uint8Array([
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2,
            ]),
        ],
        name,
        { type: 'image/png' },
    );
}

describe('attachment control', () => {
    it('keeps submitted recovery in the paperclip menu, not beside the next draft', () => {
        const { tm, tabA } = makeManager();
        const snapshot = {
            items: [],
            text: 'submitted prompt',
            state: 'sending',
            outboxState: 'attempted',
        };
        tabA._attachmentPendingSnapshot = snapshot;
        tm._finishAttachmentSnapshot(tabA, snapshot, 'dispatched', '');
        expect(tm.attachmentStatus.textContent).toBe('Submitted to Pi.');
        expect(tm.attachmentStatus.querySelectorAll('button')).toHaveLength(0);
        expect(tabA._attachmentLastSubmitted).toBe(snapshot);

        tm.inputTextArea.value = 'next draft';
        tm.inputTextArea.dispatchEvent(new Event('input'));
        expect(tm.attachmentStatus.classList.contains('hidden')).toBe(true);
        tm.attachInputBtn.click();
        const restore = [
            ...tm.attachmentSourceDropup.querySelectorAll('[role="menuitem"]'),
        ].find((button) => button.textContent === 'Restore last attachment');
        expect(restore).toBeDefined();
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
        restore.click();
        expect(confirm).toHaveBeenCalledWith(
            expect.stringContaining('can create a duplicate'),
        );
        expect(tm.inputTextArea.value).toBe('next draft');
        expect(tabA._attachmentLastSubmitted).toBe(snapshot);
        expect(tm.sendInput).not.toHaveBeenCalled();
        confirm.mockRestore();
    });

    it.each(['unknown', 'refused'])(
        'keeps %s sends visible and recoverable while typing',
        (state) => {
            const { tm, tabA } = makeManager();
            const snapshot = {
                items: [],
                state: 'sending',
                outboxState: 'attempted',
            };
            tabA._attachmentPendingSnapshot = snapshot;
            tm._finishAttachmentSnapshot(
                tabA,
                snapshot,
                state,
                state === 'refused' ? 'stale' : 'uncertain',
            );
            tm.inputTextArea.value = 'next draft';
            tm.inputTextArea.dispatchEvent(new Event('input'));
            expect(tm.attachmentStatus.classList.contains('hidden')).toBe(
                false,
            );
            expect(tm.attachmentStatus.textContent).toContain(
                state === 'unknown'
                    ? 'Submission not confirmed'
                    : 'Attachment not sent',
            );
            expect(
                [...tm.attachmentStatus.querySelectorAll('button')].map(
                    (button) => button.textContent,
                ),
            ).toContain('Restore to draft');
            expect(tabA._attachmentPendingSnapshot).toBe(snapshot);
        },
    );

    it.each(['dispatched', 'refused', 'cancelled'])(
        'observes an already-%s snapshot without dispatching it again',
        async (state) => {
            const { tm, tabA } = makeManager();
            const snapshot = {
                items: [],
                state: 'sending',
                outboxState: 'waiting',
            };
            tabA._attachmentPendingSnapshot = snapshot;
            vi.spyOn(tm, '_freezeAttachmentSnapshot').mockResolvedValue({
                outbox: { state, reason: '' },
            });
            const dispatch = vi.spyOn(tm, '_dispatchAttachmentSnapshot');
            await tm._freezeAndDispatchAttachmentSnapshot(tabA, snapshot);
            expect(dispatch).not.toHaveBeenCalled();
            expect(snapshot.state).toBe(state);
            expect(tabA._attachmentPendingSnapshot).toBe(
                state === 'dispatched' ? null : snapshot,
            );
        },
    );

    it.each(['dispatched', 'refused', 'cancelled'])(
        'observes a %s result when another tab wins the claim',
        async (state) => {
            const { tm, tabA } = makeManager();
            const snapshot = {
                id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                items: [],
                state: 'sending',
                outboxState: 'waiting',
                owner: tm._captureAttachmentOwner(tabA),
                scope: tm.app.scope,
            };
            tabA._attachmentPendingSnapshot = snapshot;
            vi.spyOn(tm.attachmentStore, 'claimSend').mockResolvedValue({
                claimed: false,
                outbox: { state, reason: '' },
            });
            const fetch = vi.fn();
            mockFetch(fetch);
            await tm._dispatchAttachmentSnapshot(tabA, snapshot);
            expect(fetch).not.toHaveBeenCalled();
            expect(snapshot.state).toBe(state);
            expect(tabA._attachmentPendingSnapshot).toBe(
                state === 'dispatched' ? null : snapshot,
            );
        },
    );

    it('opens the picker synchronously and stages in the pane that opened it', async () => {
        const { tm, tabA, tabB } = makeManager();
        const click = vi
            .spyOn(tm.attachmentFileInput, 'click')
            .mockImplementation(() => {});
        let finishUpload;
        mockFetch((url) => {
            if (url.includes('/context')) return { available: false };
            return new Promise((resolve) => {
                finishUpload = () =>
                    resolve({
                        id:
                            tabA.draftAttachments[0]?.id ||
                            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                        name: 'public.png',
                        path: '/private/items/public.png',
                        sizeBytes: 10,
                        mimeType: 'image/png',
                        kind: 'image',
                        sha256: 'a'.repeat(64),
                    });
            });
        });

        tm.attachInputBtn.click();
        expect(tabA.directMode).toBe(false);
        expect(tm.updateDirectModeUI).toHaveBeenCalledWith(tabA);
        expect(tm.attachmentSourceDropup.classList.contains('hidden')).toBe(
            false,
        );
        const deviceBtn = [
            ...tm.attachmentSourceDropup.querySelectorAll('button'),
        ].find((btn) => btn.textContent === 'Device Files');
        expect(deviceBtn).toBeDefined();
        deviceBtn.click();
        expect(click).toHaveBeenCalledTimes(1);

        Object.defineProperty(tm.attachmentFileInput, 'files', {
            configurable: true,
            value: [png()],
        });
        tm.attachmentFileInput.dispatchEvent(new Event('change'));
        expect(tabA.draftAttachments).toHaveLength(1);
        expect(['waiting', 'uploading']).toContain(
            tabA.draftAttachments[0].uploadState,
        );
        expect(
            tm.attachmentStrip.querySelectorAll('.attachment-chip'),
        ).toHaveLength(1);
        await vi.waitFor(() => expect(finishUpload).toBeTypeOf('function'));

        tm.activePaneId = tabB.paneId;
        tm.stagedAttachments = tabB.draftAttachments;
        finishUpload();
        await vi.waitFor(() =>
            expect(tabA.draftAttachments[0].uploadState).toBe('ready'),
        );
        expect(tabB.draftAttachments).toHaveLength(0);
        expect(tm.stagedAttachments).toHaveLength(0);
    });

    it('does not restore a stale snapshot while the owner draft save is pending', async () => {
        const { tm, tabA } = makeManager();
        const owner = tm._captureAttachmentOwner(tabA);
        tabA._attachmentDraftOwner = owner;
        let finishSave;
        const loadDraft = vi.spyOn(tm.attachmentStore, 'loadDraft');
        vi.spyOn(tm.attachmentStore, 'saveDraft').mockImplementation(
            () =>
                new Promise((resolve) => {
                    finishSave = () =>
                        resolve({
                            draft: {},
                            durable: true,
                            conflict: false,
                            warning: '',
                        });
                }),
        );

        const save = tm.saveTabDraft(tabA);
        await vi.waitFor(() => expect(finishSave).toBeTypeOf('function'));
        const revision = tabA._attachmentRevision;
        await tm._restoreAttachmentDraft(tabA, tm.app.scope);

        expect(loadDraft).not.toHaveBeenCalled();
        expect(tabA._attachmentRevision).toBe(revision);
        finishSave();
        await save;
        expect(tabA._attachmentPendingPersists.size).toBe(0);
    });

    it('does not claim an upload while offline and resumes the same item when online', async () => {
        const { tm, tabA } = makeManager();
        const descriptor = Object.getOwnPropertyDescriptor(navigator, 'onLine');
        Object.defineProperty(navigator, 'onLine', {
            configurable: true,
            value: false,
        });
        const owner = tm._captureAttachmentOwner(tabA);
        const file = png();
        const attachment = {
            id: '550e8400-e29b-41d4-a716-446655440000',
            name: file.name,
            path: '',
            type: file.type,
            sizeBytes: file.size,
            kind: 'image',
            sha256: '',
            source: 'device',
            phiAttachment: true,
            uploadState: 'waiting',
            errorReason: '',
            file,
            owner,
        };
        tabA._attachmentDraftOwner = owner;
        tabA.draftAttachments = [attachment];
        tm.stagedAttachments = [attachment];
        await tm.saveTabDraft(tabA);
        const fetch = mockFetch((url) => {
            if (url.includes('/items/'))
                return {
                    id: attachment.id,
                    name: file.name,
                    path: '/private/item.png',
                    sizeBytes: file.size,
                    mimeType: 'image/png',
                    kind: 'image',
                    sha256: 'a'.repeat(64),
                };
            throw new Error(`unexpected request: ${url}`);
        });
        try {
            await tm._startAttachmentUpload(
                tabA,
                attachment,
                tm.app.scope,
                false,
            );
            expect(attachment.uploadState).toBe('waiting');
            expect(fetch).not.toHaveBeenCalled();

            Object.defineProperty(navigator, 'onLine', {
                configurable: true,
                value: true,
            });
            await tm._startAttachmentUpload(
                tabA,
                attachment,
                tm.app.scope,
                true,
            );
            await vi.waitFor(() =>
                expect(attachment.uploadState).toBe('ready'),
            );
            expect(fetch).toHaveBeenCalledTimes(1);
        } finally {
            if (descriptor)
                Object.defineProperty(navigator, 'onLine', descriptor);
            else delete navigator.onLine;
        }
    });

    it('submits native attachments through the bridge and preserves newer typing', async () => {
        const { tm, tabA } = makeManager();
        let finishUpload;
        let finishSend;
        let liveContext;
        mockFetch((url) => {
            if (url.includes('/context'))
                return liveContext || { available: true };
            if (url.includes('/items/')) {
                return new Promise((resolve) => {
                    finishUpload = () =>
                        resolve({
                            id:
                                tabA.draftAttachments[0]?.id ||
                                'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                            name: 'public.png',
                            path: '/private/items/public.png',
                            sizeBytes: 10,
                            mimeType: 'image/png',
                            kind: 'image',
                            sha256: 'a'.repeat(64),
                        });
                });
            }
            return new Promise((resolve) => {
                finishSend = () =>
                    resolve({
                        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                        state: 'dispatched',
                        reason: '',
                    });
            });
        });
        tm.attachInputBtn.click();
        const deviceBtn = [
            ...tm.attachmentSourceDropup.querySelectorAll('button'),
        ].find((btn) => btn.textContent === 'Device Files');
        deviceBtn.click();
        Object.defineProperty(tm.attachmentFileInput, 'files', {
            configurable: true,
            value: [png()],
        });
        tm.attachmentFileInput.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(finishUpload).toBeTypeOf('function'));
        finishUpload();
        await vi.waitFor(() =>
            expect(tabA.draftAttachments[0].uploadState).toBe('ready'),
        );

        const owner = tabA.draftAttachments[0].owner;
        tabA.piBridge = {
            connected: true,
            capabilities: ['pi.attachments.v1'],
        };
        tabA._attachmentContextOwnerKey = tm._attachmentOwnerKey(owner);
        tabA._attachmentContext = {
            process_id: 'process-a',
            generation: '1',
            session_id: 'session-a',
            leaf_id: 'leaf-a',
            model: { provider: 'provider', id: 'vision' },
            idle: true,
            queued: false,
            image_available: true,
            available: true,
        };
        liveContext = { ...tabA._attachmentContext, leaf_id: 'metadata-leaf' };
        tm.inputTextArea.value = 'inspect this';
        tm.inputTextArea.dispatchEvent(new Event('input'));
        tm.sendStagedInput();
        expect(tm.sendInput).not.toHaveBeenCalled();
        expect(tm.inputTextArea.value).toBe('');
        expect(tabA._attachmentPendingSnapshot.state).toBe('sending');
        tm.inputTextArea.value = 'new draft while Pi handles the snapshot';
        tm.saveActiveDraft();
        await vi.waitFor(() => expect(finishSend).toBeTypeOf('function'));
        // The next draft must persist before the dispatch response arrives.
        await vi.waitFor(async () => {
            expect(
                (await tm.attachmentStore.loadDraft(owner)).draft?.text,
            ).toBe('new draft while Pi handles the snapshot');
        });
        expect(tabA._attachmentConflict).toBe(false);
        finishSend();
        await vi.waitFor(() =>
            expect(tabA._attachmentPendingSnapshot).toBeNull(),
        );
        expect(tm.inputTextArea.value).toBe(
            'new draft while Pi handles the snapshot',
        );
        expect(tabA._attachmentNotice).toContain('Submitted to Pi');
        expect(tabA._attachmentLastSubmitted.context.leaf_id).toBe(
            'metadata-leaf',
        );
    });

    it('stages and sends multiple files as one batch', async () => {
        const { tm, tabA } = makeManager();
        let sentIDs = null;
        let finishSend;
        mockFetch((url, options) => {
            if (url.includes('/context'))
                return tabA._attachmentContext || { available: true };
            if (url.includes('/items/')) {
                const id = String(url).split('/items/')[1].split('?')[0];
                return {
                    id,
                    name: 'f.png',
                    path: `/private/items/${id}.png`,
                    sizeBytes: 10,
                    mimeType: 'image/png',
                    kind: 'image',
                    sha256: 'a'.repeat(64),
                };
            }
            return new Promise((resolve) => {
                finishSend = () =>
                    resolve({
                        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                        state: 'dispatched',
                        reason: '',
                    });
            });
        });
        tm.attachInputBtn.click();
        const deviceBtn = [
            ...tm.attachmentSourceDropup.querySelectorAll('button'),
        ].find((btn) => btn.textContent === 'Device Files');
        deviceBtn.click();
        Object.defineProperty(tm.attachmentFileInput, 'files', {
            configurable: true,
            value: [png('a.png'), png('b.png')],
        });
        tm.attachmentFileInput.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(tabA.draftAttachments).toHaveLength(2));
        await vi.waitFor(() =>
            expect(
                tabA.draftAttachments.every(
                    (item) => item.uploadState === 'ready',
                ),
            ).toBe(true),
        );

        const owner = tabA.draftAttachments[0].owner;
        tabA.piBridge = {
            connected: true,
            capabilities: ['pi.attachments.v1'],
        };
        tabA._attachmentContextOwnerKey = tm._attachmentOwnerKey(owner);
        tabA._attachmentContext = {
            process_id: 'process-a',
            generation: '1',
            session_id: 'session-a',
            leaf_id: 'leaf-a',
            model: { provider: 'provider', id: 'vision' },
            idle: true,
            queued: false,
            image_available: true,
            available: true,
        };
        const realSend = tm._dispatchAttachmentSnapshot.bind(tm);
        vi.spyOn(tm, '_dispatchAttachmentSnapshot').mockImplementation(
            async (tab, snapshot, explicit) => {
                sentIDs = snapshot.items.map((item) => item.id);
                return realSend(tab, snapshot, explicit);
            },
        );
        tm.inputTextArea.value = 'inspect both';
        tm.inputTextArea.dispatchEvent(new Event('input'));
        tm.sendStagedInput();
        await vi.waitFor(() => expect(finishSend).toBeTypeOf('function'));
        finishSend();
        await vi.waitFor(() =>
            expect(tabA._attachmentPendingSnapshot).toBeNull(),
        );
        expect(sentIDs).toHaveLength(2);
        expect(tabA._attachmentNotice).toContain('Submitted to Pi');
    });

    it('cancels locally while the live Pi context read is pending', async () => {
        const { tm, tabA } = makeManager();
        const context = {
            process_id: 'process-a',
            generation: '1',
            session_id: 'session-a',
            leaf_id: 'leaf-a',
            model: null,
            available: true,
        };
        const snapshot = {
            id: '',
            owner: tm._captureAttachmentOwner(tabA),
            scope: tm.app.scope,
            context,
            items: [],
            text: 'keep this prompt',
            draftRevision: 0,
            state: 'sending',
            outboxState: 'waiting',
        };
        tabA._attachmentPendingSnapshot = snapshot;
        let finishRead;
        mockFetch(
            () =>
                new Promise((resolve) => {
                    finishRead = resolve;
                }),
        );
        const freeze = vi.spyOn(tm.attachmentStore, 'freezeDraft');
        const sending = tm._freezeAndDispatchAttachmentSnapshot(tabA, snapshot);
        await vi.waitFor(() => expect(finishRead).toBeTypeOf('function'));
        await tm._cancelWaitingAttachmentSnapshot(tabA, snapshot);
        expect(snapshot.state).toBe('cancelled');
        finishRead(context);
        await sending;
        expect(freeze).not.toHaveBeenCalled();
        expect(snapshot.state).toBe('cancelled');
        expect(snapshot.text).toBe('keep this prompt');
        expect(tm.sendInput).not.toHaveBeenCalled();
    });

    it.each([
        { process_id: 'replacement' },
        { generation: '2' },
        { session_id: 'other-session' },
        { model: { provider: 'provider', id: 'other-model' } },
    ])(
        'does not rebind a new send to a changed Pi origin: %j',
        async (change) => {
            const { tm, tabA } = makeManager();
            const context = {
                process_id: 'process-a',
                generation: '1',
                session_id: 'session-a',
                leaf_id: 'leaf-a',
                model: { provider: 'provider', id: 'vision' },
                available: true,
            };
            const snapshot = {
                id: '',
                owner: tm._captureAttachmentOwner(tabA),
                scope: tm.app.scope,
                context,
                items: [],
                text: 'keep this prompt',
                draftRevision: 0,
                state: 'sending',
                outboxState: 'waiting',
            };
            tabA._attachmentPendingSnapshot = snapshot;
            mockFetch(() => ({ ...context, ...change }));
            const freeze = vi.spyOn(tm.attachmentStore, 'freezeDraft');
            await tm._freezeAndDispatchAttachmentSnapshot(tabA, snapshot);
            expect(freeze).not.toHaveBeenCalled();
            expect(snapshot.state).toBe('refused');
            expect(snapshot.reason).toBe('stale');
            expect(snapshot.text).toBe('keep this prompt');
            expect(tm.sendInput).not.toHaveBeenCalled();
            expect(tabA._attachmentNotice).toContain(
                'Attachment not sent. Pi state changed',
            );
        },
    );

    it('refuses a ninth staged file without losing the batch', async () => {
        const { tm, tabA } = makeManager();
        mockFetch((url) => {
            if (url.includes('/context')) return { available: false };
            const id = String(url).split('/items/')[1].split('?')[0];
            return {
                id,
                name: 'f.png',
                path: `/private/items/${id}.png`,
                sizeBytes: 10,
                mimeType: 'image/png',
                kind: 'image',
                sha256: 'a'.repeat(64),
            };
        });
        tm.attachInputBtn.click();
        const deviceBtn = [
            ...tm.attachmentSourceDropup.querySelectorAll('button'),
        ].find((btn) => btn.textContent === 'Device Files');
        deviceBtn.click();
        Object.defineProperty(tm.attachmentFileInput, 'files', {
            configurable: true,
            value: Array.from({ length: 9 }, (_, index) =>
                png(`f${index}.png`),
            ),
        });
        tm.attachmentFileInput.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(tabA.draftAttachments).toHaveLength(9));
        const ok = tabA.draftAttachments.filter(
            (item) => item.uploadState !== 'error',
        );
        const limited = tabA.draftAttachments.filter(
            (item) => item.uploadState === 'error',
        );
        expect(ok).toHaveLength(8);
        expect(limited).toHaveLength(1);
        expect(limited[0].errorReason).toBe('limit');
        await vi.waitFor(() =>
            expect(ok.every((item) => item.uploadState === 'ready')).toBe(true),
        );
        expect(tm._attachmentToast).toHaveBeenCalled();
    });

    it('snapshots a server file without a browser upload and retains change errors', async () => {
        const { tm, tabA } = makeManager();
        let snapshotCalls = 0;
        let failChanged = false;
        mockFetch((url, options) => {
            if (url.includes('/context')) return { available: false };
            if (url.includes('/api/attachments/v2/server-items')) {
                snapshotCalls++;
                const body = JSON.parse(options.body);
                if (failChanged)
                    return {
                        ok: false,
                        status: 409,
                        json: { reason: 'changed-source' },
                    };
                return {
                    id: body.id,
                    name: 'report.txt',
                    path: '/private/items/report.txt',
                    sizeBytes: 5,
                    mimeType: 'text/plain',
                    kind: 'file',
                    sha256: 'b'.repeat(64),
                };
            }
            throw new Error(`unexpected request: ${url}`);
        });
        const owner = tm._captureAttachmentOwner(tabA);
        tm._stageServerAttachment(tabA, owner, tm.app.scope, {
            name: 'report.txt',
            path: '/srv/report.txt',
            kind: 'file',
            sizeBytes: 5,
            fingerprint: 'fp-1',
        });
        await vi.waitFor(() =>
            expect(tabA.draftAttachments[0]?.uploadState).toBe('ready'),
        );
        expect(tabA.draftAttachments[0].source).toBe('server');
        expect(tabA.draftAttachments[0].path).toBe('/private/items/report.txt');
        expect(snapshotCalls).toBe(1);

        failChanged = true;
        tm._stageServerAttachment(tabA, owner, tm.app.scope, {
            name: 'moved.txt',
            path: '/srv/moved.txt',
            kind: 'file',
            sizeBytes: 5,
            fingerprint: 'fp-stale',
        });
        await vi.waitFor(() => expect(tabA.draftAttachments).toHaveLength(2));
        await vi.waitFor(() =>
            expect(tabA.draftAttachments[1].uploadState).toBe('error'),
        );
        expect(tabA.draftAttachments[1].errorReason).toBe('changed-source');
        expect(
            tm.attachmentStrip.querySelectorAll('.attachment-chip'),
        ).toHaveLength(2);

        await tm.saveTabDraft(tabA);
        tabA._attachmentRestoredOwnerKey = '';
        await tm._restoreAttachmentDraft(tabA, tm.app.scope);
        expect(tabA.draftAttachments[0]).toMatchObject({
            source: 'server',
            uploadState: 'ready',
            path: '/private/items/report.txt',
        });
        expect(tabA.draftAttachments[1]).toMatchObject({
            source: 'server',
            serverPath: '/srv/moved.txt',
            serverFingerprint: 'fp-stale',
            uploadState: 'error',
            errorReason: 'changed-source',
        });
        failChanged = false;
        await tm._retryDeviceAttachment(tabA, tabA.draftAttachments[1]);
        await vi.waitFor(() =>
            expect(tabA.draftAttachments[1].uploadState).toBe('ready'),
        );
        expect(snapshotCalls).toBe(3);
    });

    it('refuses mixed legacy/new attachment batches before network dispatch', () => {
        const { tm, tabA } = makeManager();
        tabA.piBridge = {
            connected: true,
            capabilities: ['pi.attachments.v1'],
        };
        tm.stagedAttachments = [
            {
                phiAttachment: true,
                id: 'a',
                uploadState: 'ready',
                owner: { paneId: 'pane-a' },
            },
            { id: 'legacy', path: '/tmp/legacy.png', source: 'paste' },
        ];
        tm.inputTextArea.value = 'keep me';
        tm.sendStagedInput();
        expect(tm.inputTextArea.value).toBe('keep me');
        expect(tm.sendInput).not.toHaveBeenCalled();
        expect(tabA._attachmentNotice).toContain('separately');
    });
});
