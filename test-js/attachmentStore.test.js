// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { setupDomHarness } from './_dom.js';
import {
    AttachmentStore,
    attachmentOwnerKey,
} from '../web/attachment-store.js';

setupDomHarness();

const owner = {
    profileId: 'profile-a',
    origin: 'http://phi.local:17170',
    paneId: 'pane-a',
    cwd: '/workspace/a',
};

const item = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'photo.png',
    type: 'image/png',
    sizeBytes: 4,
    kind: 'image',
    sha256: 'a'.repeat(64),
    path: '',
    uploadState: 'waiting',
    errorReason: '',
};

describe('AttachmentStore', () => {
    it('keys records by the full profile, origin, pane, and cwd tuple', () => {
        const key = attachmentOwnerKey(owner);
        expect(key).toBe(attachmentOwnerKey({ ...owner }));
        expect(key).not.toBe(
            attachmentOwnerKey({ ...owner, origin: 'http://other.local' }),
        );
        expect(key).not.toBe(
            attachmentOwnerKey({ ...owner, paneId: 'pane-b' }),
        );
        expect(key).not.toBe(
            attachmentOwnerKey({ ...owner, cwd: '/workspace/b' }),
        );
    });

    it('parks automatic mutations when a different backend becomes active', async () => {
        const store = new AttachmentStore({ indexedDB: null });
        store.bind({ profileId: owner.profileId, origin: owner.origin });
        await store.saveDraft(
            owner,
            0,
            'parked',
            [item],
            [
                {
                    id: item.id,
                    name: item.name,
                    type: item.type,
                    sizeBytes: item.sizeBytes,
                    blob: new Blob(['png!']),
                },
            ],
        );
        store.bind({ profileId: 'profile-b', origin: 'http://other.local' });
        expect(store.isActive(owner)).toBe(false);
        expect((await store.claimUpload(owner, item.id)).claimed).toBe(false);
        expect((await store.loadDraft(owner)).draft?.text).toBe('parked');
        store.bind({ profileId: owner.profileId, origin: owner.origin });
        expect(store.isActive(owner)).toBe(true);
        store.dispose();
    });

    it('binds an unscoped browser backend to the page origin', () => {
        const store = new AttachmentStore({ indexedDB: null });
        store.bind({ profileId: '', origin: '' });
        expect(
            store.isActive({
                ...owner,
                profileId: '',
                origin: window.location.origin,
            }),
        ).toBe(true);
        expect(
            store.isActive({
                ...owner,
                profileId: '',
                origin: 'http://other.local',
            }),
        ).toBe(false);
        store.dispose();
    });

    it('keeps drafts in memory when IndexedDB is unavailable and never replays an attempted send', async () => {
        const store = new AttachmentStore({ indexedDB: null });
        store.bind({ profileId: owner.profileId, origin: owner.origin });
        const saved = await store.saveDraft(
            owner,
            0,
            'inspect this',
            [item],
            [
                {
                    id: item.id,
                    name: item.name,
                    type: item.type,
                    sizeBytes: item.sizeBytes,
                    blob: new Blob(['png!'], { type: 'image/png' }),
                },
            ],
        );
        expect(saved.durable).toBe(false);
        expect(saved.draft.revision).toBe(1);
        expect(saved.warning).toContain('Not saved on this device');

        const uploadClaim = await store.claimUpload(owner, item.id, true);
        expect(uploadClaim.claimed).toBe(true);
        expect((await store.claimUpload(owner, item.id)).claimed).toBe(false);
        await store.updateUpload(owner, item.id, 'ready', {
            path: '/private/item.png',
        });

        const frozen = await store.freezeDraft(owner, 1, {
            text: 'inspect this',
            context: {
                process_id: 'process-a',
                generation: '1',
                session_id: 'session-a',
                leaf_id: 'leaf-a',
                model: null,
            },
            items: [
                { ...item, uploadState: 'ready', path: '/private/item.png' },
            ],
        });
        expect(frozen.outbox.state).toBe('waiting');
        expect(frozen.durable).toBe(false);
        const frozenDraft = await store.loadDraft(owner);
        expect(frozenDraft.draft?.text).toBe('');
        expect(frozenDraft.draft?.items).toHaveLength(0);
        expect((await store.claimSend(frozen.outbox.id)).claimed).toBe(false);
        const firstClaim = await store.claimSend(frozen.outbox.id, true);
        expect(firstClaim.claimed).toBe(true);
        expect(firstClaim.outbox?.state).toBe('attempted');
        expect((await store.claimSend(frozen.outbox.id, true)).claimed).toBe(
            false,
        );

        await store.updateOutbox(frozen.outbox.id, 'unknown', 'uncertain');
        expect((await store.getOutbox(frozen.outbox.id))?.state).toBe(
            'unknown',
        );
        store.dispose();
    });

    it('releases removed draft blobs so repeated selections do not exhaust the local quota', async () => {
        const store = new AttachmentStore({ indexedDB: null });
        store.bind({ profileId: owner.profileId, origin: owner.origin });
        const blob = new Blob([new Uint8Array(25 * 1024 * 1024)]);
        let revision = 0;
        for (let index = 0; index < 5; index++) {
            const selected = {
                ...item,
                id: `selection-${index}`,
                sizeBytes: blob.size,
            };
            const saved = await store.saveDraft(
                owner,
                revision++,
                'keep typing',
                [selected],
                [{ ...selected, blob }],
            );
            expect(saved.warning).not.toContain('100 MiB limit');
            await store.saveDraft(owner, revision++, 'keep typing', [], []);
            expect((await store.loadBlobs(owner, [selected.id])).size).toBe(0);
        }
        expect((await store.loadDraft(owner)).draft?.text).toBe('keep typing');
        store.dispose();
    });

    it('rejects a stale draft revision without overwriting the current copy', async () => {
        const store = new AttachmentStore({ indexedDB: null });
        store.bind({ profileId: owner.profileId, origin: owner.origin });
        await store.saveDraft(owner, 0, 'current', [], []);
        const stale = await store.saveDraft(owner, 0, 'stale copy', [], []);
        expect(stale.conflict).toBe(true);
        expect((await store.loadDraft(owner)).draft?.text).toBe('current');
        store.dispose();
    });

    it('cancels waiting sends and retains shared blobs until the last local reference is forgotten', async () => {
        const store = new AttachmentStore({ indexedDB: null });
        store.bind({ profileId: owner.profileId, origin: owner.origin });
        const ready = {
            ...item,
            uploadState: 'ready',
            path: '/private/photo.png',
        };
        const blob = new Blob(['png!'], { type: 'image/png' });
        const blobRef = {
            id: item.id,
            name: item.name,
            type: item.type,
            sizeBytes: item.sizeBytes,
            blob,
        };
        const context = {
            process_id: 'process-a',
            generation: '1',
            session_id: 'session-a',
            leaf_id: 'leaf-a',
            model: null,
        };

        await store.saveDraft(owner, 0, 'first', [ready], [blobRef]);
        const first = await store.freezeDraft(owner, 1, {
            text: 'first',
            context,
            items: [ready],
        });
        await store.saveDraft(owner, 2, 'second', [ready], [blobRef]);
        const second = await store.freezeDraft(owner, 3, {
            text: 'second',
            context,
            items: [ready],
        });

        expect(second.outbox.id).not.toBe(first.outbox.id);
        expect(await store.cancelWaitingSend(second.outbox.id)).toBe(true);
        expect((await store.claimSend(second.outbox.id, true)).claimed).toBe(
            false,
        );
        expect(await store.loadBlobs(owner, [item.id])).toHaveProperty(
            'size',
            1,
        );
        expect(await store.forgetOutbox(first.outbox.id)).toBe(true);
        expect(await store.loadBlobs(owner, [item.id])).toHaveProperty(
            'size',
            1,
        );
        expect(await store.forgetOutbox(second.outbox.id)).toBe(true);
        expect(await store.loadBlobs(owner, [item.id])).toHaveProperty(
            'size',
            0,
        );

        await store.saveDraft(owner, 4, 'attempted', [ready], [blobRef]);
        const attempted = await store.freezeDraft(owner, 5, {
            text: 'attempted',
            context,
            items: [ready],
        });
        expect((await store.claimSend(attempted.outbox.id, true)).claimed).toBe(
            true,
        );
        expect(await store.cancelWaitingSend(attempted.outbox.id)).toBe(false);
        expect((await store.getOutbox(attempted.outbox.id))?.state).toBe(
            'attempted',
        );
        store.dispose();
    });
});
