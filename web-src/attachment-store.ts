import { newAttachmentID, type AttachmentOwner } from './attachments.js';

export const ATTACHMENT_DATABASE = 'phi-attachments-v1';
const DATABASE_VERSION = 1;
const DRAFTS = 'drafts';
const BLOBS = 'blobs';
const OUTBOX = 'outbox';
const STORAGE_WARNING = 'Not saved on this device; keep this tab open.';
const MAX_LOCAL_BYTES = 100 * 1024 * 1024;

export type AttachmentUploadState = 'waiting' | 'attempted' | 'ready' | 'unknown' | 'error';
export type AttachmentSendState = 'waiting' | 'attempted' | 'unknown' | 'dispatched' | 'refused' | 'cancelled';

export interface AttachmentOwnerRecord {
    readonly profileId: string;
    readonly origin: string;
    readonly paneId: string;
    readonly cwd: string;
}

export interface StoredAttachmentItem {
    readonly id: string;
    readonly name: string;
    readonly type: string;
    readonly sizeBytes: number;
    readonly kind: 'image' | 'file';
    readonly sha256: string;
    readonly path: string;
    readonly uploadState: AttachmentUploadState;
    readonly errorReason: string;
    readonly source?: 'device' | 'server';
    readonly serverPath?: string;
    readonly serverFingerprint?: string;
}

export interface StoredAttachmentDraft {
    readonly key: string;
    readonly ownerKey: string;
    readonly owner: AttachmentOwnerRecord;
    readonly revision: number;
    readonly text: string;
    readonly items: readonly StoredAttachmentItem[];
    readonly updatedAt: number;
}

export interface StoredAttachmentOutbox {
    readonly id: string;
    readonly ownerKey: string;
    readonly owner: AttachmentOwnerRecord;
    readonly paneId: string;
    readonly revision: number;
    readonly ownerRevisionKey: string;
    readonly state: AttachmentSendState;
    readonly reason: string;
    readonly text: string;
    readonly context: unknown;
    readonly items: readonly StoredAttachmentItem[];
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly durable: boolean;
}

export interface DraftSaveResult {
    readonly draft: StoredAttachmentDraft;
    readonly durable: boolean;
    readonly conflict: boolean;
    readonly warning: string;
}

export interface OutboxResult {
    readonly outbox: StoredAttachmentOutbox;
    readonly durable: boolean;
    readonly conflict: boolean;
    readonly warning: string;
}

export interface AttachmentBlobInput {
    readonly id: string;
    readonly name: string;
    readonly type: string;
    readonly sizeBytes: number;
    readonly blob: Blob;
}

export interface AttachmentSnapshotInput {
    readonly text: string;
    readonly context: unknown;
    readonly items: readonly StoredAttachmentItem[];
}

function ownerRecord(owner: AttachmentOwner): AttachmentOwnerRecord {
    return {
        profileId: owner.profileId,
        origin: owner.origin,
        paneId: owner.paneId,
        cwd: owner.cwd,
    };
}

export function attachmentOwnerKey(owner: AttachmentOwnerRecord | AttachmentOwner): string {
    return JSON.stringify([owner.profileId, owner.origin, owner.paneId, owner.cwd]);
}

function ownerRevisionKey(ownerKey: string, revision: number): string {
    return JSON.stringify([ownerKey, revision]);
}

function blobKey(ownerKey: string, itemId: string): string {
    return JSON.stringify([ownerKey, itemId]);
}

function clone<T>(value: T): T {
    return structuredClone(value);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('indexeddb-request-failed'));
    });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error || new Error('indexeddb-transaction-aborted'));
        transaction.onerror = () => reject(transaction.error || new Error('indexeddb-transaction-failed'));
    });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const request = factory.open(ATTACHMENT_DATABASE, DATABASE_VERSION);
        const fail = (error: unknown) => {
            if (settled) return;
            settled = true;
            reject(error instanceof Error ? error : new Error('indexeddb-unavailable'));
        };
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(DRAFTS)) {
                const drafts = db.createObjectStore(DRAFTS, { keyPath: 'key' });
                drafts.createIndex('byOwner', 'ownerKey', { unique: false });
                drafts.createIndex('byPane', 'owner.paneId', { unique: false });
                drafts.createIndex('byItem', 'itemKeys', { unique: false, multiEntry: true });
            }
            if (!db.objectStoreNames.contains(BLOBS)) {
                db.createObjectStore(BLOBS, { keyPath: 'key' });
            }
            if (!db.objectStoreNames.contains(OUTBOX)) {
                const outbox = db.createObjectStore(OUTBOX, { keyPath: 'id' });
                outbox.createIndex('byOwner', 'ownerKey', { unique: false });
                outbox.createIndex('byOwnerRevision', 'ownerRevisionKey', { unique: true });
                outbox.createIndex('byItem', 'itemKeys', { unique: false, multiEntry: true });
            }
        };
        request.onblocked = () => fail(new Error('indexeddb-upgrade-blocked'));
        request.onerror = () => fail(request.error || new Error('indexeddb-open-failed'));
        request.onsuccess = () => {
            const db = request.result;
            if (settled) {
                db.close();
                return;
            }
            settled = true;
            db.onversionchange = () => db.close();
            resolve(db);
        };
    });
}

function cleanItems(items: readonly StoredAttachmentItem[]): StoredAttachmentItem[] {
    return items.map((item) => ({
        id: item.id,
        name: item.name,
        type: item.type,
        sizeBytes: item.sizeBytes,
        kind: item.kind,
        sha256: item.sha256,
        path: item.path,
        uploadState: item.uploadState,
        errorReason: item.errorReason,
        source: item.source,
        serverPath: item.serverPath,
        serverFingerprint: item.serverFingerprint,
    }));
}

function isBlob(value: unknown): value is Blob {
    return Boolean(value && typeof value === 'object' && typeof (value as Blob).size === 'number' && typeof (value as Blob).slice === 'function');
}

function itemKeys(items: readonly StoredAttachmentItem[]): string[] {
    return items.map((item) => item.id);
}

export class AttachmentStore {
    private readonly factory: IDBFactory | null;
    private database: Promise<IDBDatabase> | null = null;
    private readonly drafts = new Map<string, StoredAttachmentDraft>();
    private readonly blobs = new Map<string, Blob>();
    private readonly outbox = new Map<string, StoredAttachmentOutbox>();
    private readonly attemptedUploads = new Set<string>();
    private readonly attemptedSends = new Set<string>();
    private readonly listeners = new Set<(warning: string) => void>();
    private warning = '';
    private activeOwner = '';
    private disposed = false;
    private generation = 0;

    constructor(options: { indexedDB?: IDBFactory | null } = {}) {
        this.factory = options.indexedDB === undefined
            ? typeof indexedDB === 'undefined' ? null : indexedDB
            : options.indexedDB;
    }

    get storageWarning(): string {
        return this.warning;
    }

    subscribe(listener: (warning: string) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    bind(scope?: { readonly profileId?: string; readonly origin?: string } | null): void {
        const origin = scope?.origin || (typeof window !== 'undefined' ? window.location.origin : '');
        const next = JSON.stringify([scope?.profileId || '', origin]);
        if (this.activeOwner === next) return;
        this.activeOwner = next;
        this.generation++;
        this.notify();
    }

    isActive(owner: AttachmentOwnerRecord | AttachmentOwner): boolean {
        return !this.disposed && this.activeOwner === JSON.stringify([owner.profileId, owner.origin]);
    }

    dispose(): void {
        this.disposed = true;
        this.generation++;
        this.listeners.clear();
        void this.database?.then((db) => db.close()).catch(() => {});
    }

    async loadDraft(owner: AttachmentOwner): Promise<{ draft: StoredAttachmentDraft | null; blobs: ReadonlyMap<string, Blob>; durable: boolean }> {
        const key = attachmentOwnerKey(owner);
        const memoryDraft = this.drafts.get(key) || null;
        const memoryBlobs = new Map<string, Blob>();
        for (const item of memoryDraft?.items || []) {
            const blob = this.blobs.get(blobKey(key, item.id));
            if (blob) memoryBlobs.set(item.id, blob);
        }
        const db = await this.getDatabase();
        if (!db) return { draft: memoryDraft ? clone(memoryDraft) : null, blobs: memoryBlobs, durable: false };
        try {
            const tx = db.transaction([DRAFTS, BLOBS], 'readonly');
            const done = transactionDone(tx);
            const draft = await requestResult(tx.objectStore(DRAFTS).get(key)) as StoredAttachmentDraft | undefined;
            const loadedBlobs = new Map<string, Blob>();
            if (draft) {
                const requests = draft.items.map((item) => requestResult(tx.objectStore(BLOBS).get(blobKey(key, item.id))));
                const records = await Promise.all(requests) as Array<{ blob?: Blob } | undefined>;
                draft.items.forEach((item, index) => {
                    const blob = records[index]?.blob;
                    if (isBlob(blob)) loadedBlobs.set(item.id, blob);
                });
            }
            await done;
            if (draft) {
                this.drafts.set(key, clone(draft));
                for (const [id, blob] of loadedBlobs) this.blobs.set(blobKey(key, id), blob);
            }
            this.setWarning('');
            return { draft: draft ? clone(draft) : null, blobs: loadedBlobs, durable: true };
        } catch {
            this.setWarning(STORAGE_WARNING);
            return { draft: memoryDraft ? clone(memoryDraft) : null, blobs: memoryBlobs, durable: false };
        }
    }

    async loadBlobs(owner: AttachmentOwner, itemIds: readonly string[]): Promise<ReadonlyMap<string, Blob>> {
        const key = attachmentOwnerKey(owner);
        const result = new Map<string, Blob>();
        for (const id of itemIds) {
            const blob = this.blobs.get(blobKey(key, id));
            if (blob) result.set(id, blob);
        }
        const db = await this.getDatabase();
        if (!db) return result;
        try {
            const tx = db.transaction(BLOBS, 'readonly');
            const done = transactionDone(tx);
            const rows = await Promise.all(itemIds.map((id) => requestResult(tx.objectStore(BLOBS).get(blobKey(key, id))))) as Array<{ blob?: Blob } | undefined>;
            await done;
            rows.forEach((row, index) => {
                if (isBlob(row?.blob)) result.set(itemIds[index]!, row.blob);
            });
            return result;
        } catch {
            this.setWarning(STORAGE_WARNING);
            return result;
        }
    }

    async draftsForPane(paneId: string): Promise<readonly StoredAttachmentDraft[]> {
        const memory = [...this.drafts.values()].filter((draft) => draft.owner.paneId === paneId);
        const db = await this.getDatabase();
        if (!db) return memory.map(clone);
        try {
            const tx = db.transaction(DRAFTS, 'readonly');
            const done = transactionDone(tx);
            const rows = await requestResult(tx.objectStore(DRAFTS).index('byPane').getAll(IDBKeyRange.only(paneId))) as StoredAttachmentDraft[];
            await done;
            for (const row of rows) this.drafts.set(row.key, clone(row));
            this.setWarning('');
            return rows.map(clone);
        } catch {
            this.setWarning(STORAGE_WARNING);
            return memory.map(clone);
        }
    }

    async saveDraft(
        owner: AttachmentOwner,
        expectedRevision: number,
        text: string,
        items: readonly StoredAttachmentItem[],
        blobs: readonly AttachmentBlobInput[],
    ): Promise<DraftSaveResult> {
        const capturedGeneration = this.generation;
        const key = attachmentOwnerKey(owner);
        const previous = this.drafts.get(key);
        if (previous && previous.revision !== expectedRevision) {
            return { draft: clone(previous), durable: false, conflict: true, warning: 'Draft changed in another tab.' };
        }
        const draft: StoredAttachmentDraft = {
            key,
            ownerKey: key,
            owner: ownerRecord(owner),
            revision: expectedRevision + 1,
            text,
            items: cleanItems(items),
            updatedAt: Date.now(),
        };
        this.drafts.set(key, clone(draft));
        const projectedBlobs = new Map(this.blobs);
        for (const item of blobs) projectedBlobs.set(blobKey(key, item.id), item.blob);
        const memoryNext = [...projectedBlobs.values()].reduce((total, blob) => total + blob.size, 0);
        if (memoryNext > MAX_LOCAL_BYTES) {
            this.setWarning('Local attachment storage reached its 100 MiB limit. Forget a local copy before adding more.');
            return { draft: clone(draft), durable: false, conflict: false, warning: this.warning };
        }
        for (const item of blobs) this.blobs.set(blobKey(key, item.id), item.blob);
        const db = await this.getDatabase();
        if (!db) {
            this.setWarning(STORAGE_WARNING);
            return { draft: clone(draft), durable: false, conflict: false, warning: this.warning };
        }
        try {
            const tx = db.transaction([DRAFTS, BLOBS, OUTBOX], 'readwrite');
            const done = transactionDone(tx);
            const draftStore = tx.objectStore(DRAFTS);
            const saved = await requestResult(draftStore.get(key)) as StoredAttachmentDraft | undefined;
            if ((saved?.revision || 0) !== expectedRevision) {
                tx.abort();
                await done.catch(() => {});
                const conflict = saved || draft;
                this.setWarning('Draft changed in another tab. Keep this copy open; it was not overwritten.');
                return { draft: clone(conflict), durable: false, conflict: true, warning: this.warning };
            }
            const existingItems = new Map((saved?.items || []).map((item) => [item.id, item]));
            const mergedDraft = {
                ...draft,
                items: draft.items.map((item) => {
                    const prior = existingItems.get(item.id);
                    return prior && item.uploadState === 'waiting' && prior.uploadState !== 'waiting'
                        ? { ...item, ...prior }
                        : item;
                }),
            };
            const blobStore = tx.objectStore(BLOBS);
            const existingBlobs = await requestResult(blobStore.getAll()) as Array<{ key: string; sizeBytes: number }>;
            let totalBytes = existingBlobs.reduce((total, row) => total + (Number.isFinite(row.sizeBytes) ? row.sizeBytes : 0), 0);
            for (const item of blobs) {
                const itemKey = blobKey(key, item.id);
                const previousBlob = existingBlobs.find((row) => row.key === itemKey);
                totalBytes -= previousBlob?.sizeBytes || 0;
                totalBytes += item.sizeBytes;
            }
            if (totalBytes > MAX_LOCAL_BYTES) {
                tx.abort();
                await done.catch(() => {});
                this.setWarning('Local attachment storage reached its 100 MiB limit. Forget a local copy before adding more.');
                return { draft: clone(draft), durable: false, conflict: false, warning: this.warning };
            }
            const oldIDs = (saved?.items || []).map((item) => item.id).filter((id) => !mergedDraft.items.some((item) => item.id === id));
            draftStore.put({ ...mergedDraft, itemKeys: itemKeys(mergedDraft.items) });
            for (const item of blobs) {
                if (isBlob(item.blob)) blobStore.put({ key: blobKey(key, item.id), ownerKey: key, itemId: item.id, blob: item.blob, name: item.name, type: item.type, sizeBytes: item.sizeBytes });
            }
            for (const oldID of oldIDs) {
                const draftUses = await requestResult(draftStore.index('byItem').count(oldID));
                const outboxUses = await requestResult(tx.objectStore(OUTBOX).index('byItem').count(oldID));
                if (draftUses === 0 && outboxUses === 0) blobStore.delete(blobKey(key, oldID));
            }
            await done;
            this.drafts.set(key, clone(mergedDraft));
            if (this.generation !== capturedGeneration || !this.isActive(owner)) {
                this.setWarning('Attachment draft parked for its original Phi backend.');
                return { draft: clone(draft), durable: true, conflict: false, warning: this.warning };
            }
            this.setWarning('');
            return { draft: clone(mergedDraft), durable: true, conflict: false, warning: '' };
        } catch {
            this.setWarning(STORAGE_WARNING);
            return { draft: clone(draft), durable: false, conflict: false, warning: this.warning };
        }
    }

    async freezeDraft(
        owner: AttachmentOwner,
        expectedRevision: number,
        snapshot: AttachmentSnapshotInput,
    ): Promise<OutboxResult> {
        const key = attachmentOwnerKey(owner);
        const revisionKey = ownerRevisionKey(key, expectedRevision);
        const existing = [...this.outbox.values()].find((record) => record.ownerRevisionKey === revisionKey);
        if (existing) return { outbox: clone(existing), durable: existing.durable, conflict: false, warning: this.warning };
        const db = await this.getDatabase();
        const fallback = this.makeOutbox(owner, expectedRevision, snapshot);
        if (!db) {
            this.outbox.set(fallback.id, fallback);
            const draft = this.drafts.get(key);
            if (draft?.revision === expectedRevision) {
                this.drafts.set(key, { ...draft, revision: expectedRevision + 1, text: '', items: [], updatedAt: Date.now() });
            }
            this.setWarning(STORAGE_WARNING);
            return { outbox: clone(fallback), durable: false, conflict: false, warning: this.warning };
        }
        try {
            const tx = db.transaction([DRAFTS, OUTBOX], 'readwrite');
            const done = transactionDone(tx);
            const outboxStore = tx.objectStore(OUTBOX);
            const prior = await requestResult(outboxStore.index('byOwnerRevision').get(revisionKey)) as StoredAttachmentOutbox | undefined;
            if (prior) {
                await done;
                this.outbox.set(prior.id, clone(prior));
                return { outbox: clone(prior), durable: true, conflict: false, warning: '' };
            }
            const draftStore = tx.objectStore(DRAFTS);
            const draft = await requestResult(draftStore.get(key)) as StoredAttachmentDraft | undefined;
            if (!draft || draft.revision !== expectedRevision || draft.text !== snapshot.text || !sameItemIDs(draft.items, snapshot.items)) {
                tx.abort();
                await done.catch(() => {});
                this.setWarning('Draft changed in another tab. Reload or keep the current copy open.');
                return { outbox: fallback, durable: false, conflict: true, warning: this.warning };
            }
            const outbox: StoredAttachmentOutbox = { ...fallback, durable: true };
            outboxStore.add({ ...outbox, itemKeys: itemKeys(outbox.items) });
            draftStore.put({ ...draft, revision: expectedRevision + 1, text: '', items: [], itemKeys: [], updatedAt: Date.now() });
            await done;
            this.outbox.set(outbox.id, clone(outbox));
            this.drafts.set(key, { ...draft, revision: expectedRevision + 1, text: '', items: [], updatedAt: Date.now() });
            this.setWarning('');
            return { outbox: clone(outbox), durable: true, conflict: false, warning: '' };
        } catch {
            this.outbox.set(fallback.id, clone(fallback));
            this.setWarning(STORAGE_WARNING);
            return { outbox: clone(fallback), durable: false, conflict: false, warning: this.warning };
        }
    }

    async getOutbox(id: string): Promise<StoredAttachmentOutbox | null> {
        const memory = this.outbox.get(id);
        const db = await this.getDatabase();
        if (!db) return memory ? clone(memory) : null;
        try {
            const tx = db.transaction(OUTBOX, 'readonly');
            const done = transactionDone(tx);
            const record = await requestResult(tx.objectStore(OUTBOX).get(id)) as StoredAttachmentOutbox | undefined;
            await done;
            if (record) this.outbox.set(id, clone(record));
            return record ? clone(record) : memory ? clone(memory) : null;
        } catch {
            this.setWarning(STORAGE_WARNING);
            return memory ? clone(memory) : null;
        }
    }

    async outboxForOwner(owner: AttachmentOwner): Promise<readonly StoredAttachmentOutbox[]> {
        const key = attachmentOwnerKey(owner);
        const db = await this.getDatabase();
        if (!db) return [...this.outbox.values()].filter((record) => record.ownerKey === key).map(clone);
        try {
            const tx = db.transaction(OUTBOX, 'readonly');
            const done = transactionDone(tx);
            const rows = await requestResult(tx.objectStore(OUTBOX).index('byOwner').getAll(IDBKeyRange.only(key))) as StoredAttachmentOutbox[];
            await done;
            for (const row of rows) this.outbox.set(row.id, clone(row));
            return rows.map(clone);
        } catch {
            this.setWarning(STORAGE_WARNING);
            return [...this.outbox.values()].filter((record) => record.ownerKey === key).map(clone);
        }
    }

    async claimUpload(owner: AttachmentOwner, itemId: string, explicit = false): Promise<{ claimed: boolean; durable: boolean }> {
        const key = attachmentOwnerKey(owner);
        const itemKey = blobKey(key, itemId);
        if (this.attemptedUploads.has(itemKey) && !explicit) return { claimed: false, durable: false };
        const db = await this.getDatabase();
        if (!db) {
            if (!explicit) return { claimed: false, durable: false };
            this.attemptedUploads.add(itemKey);
            const draft = this.drafts.get(key);
            if (draft) this.setMemoryDraftItem(draft, itemId, 'attempted', {});
            this.setWarning(STORAGE_WARNING);
            return { claimed: true, durable: false };
        }
        try {
            const tx = db.transaction([DRAFTS, BLOBS], 'readwrite');
            const done = transactionDone(tx);
            const draftStore = tx.objectStore(DRAFTS);
            const draft = await requestResult(draftStore.get(key)) as (StoredAttachmentDraft & { itemKeys?: string[] }) | undefined;
            if (!draft || !draft.itemKeys?.includes(itemId)) {
                tx.abort();
                await done.catch(() => {});
                return { claimed: false, durable: true };
            }
            const index = draft.items.findIndex((item) => item.id === itemId);
            const currentState = index >= 0 ? draft.items[index]!.uploadState : null;
            const retryable = explicit && currentState === 'unknown';
            if (index < 0 || currentState !== 'waiting' && !retryable) {
                tx.abort();
                await done.catch(() => {});
                return { claimed: false, durable: true };
            }
            const items = draft.items.slice();
            items[index] = { ...items[index]!, uploadState: 'attempted' };
            draftStore.put({ ...draft, items, updatedAt: Date.now() });
            await done;
            this.attemptedUploads.add(itemKey);
            this.drafts.set(key, { ...draft, items, updatedAt: Date.now() });
            this.setWarning('');
            return { claimed: true, durable: true };
        } catch {
            if (!explicit) {
                this.setWarning(STORAGE_WARNING);
                return { claimed: false, durable: false };
            }
            this.attemptedUploads.add(itemKey);
            const draft = this.drafts.get(key);
            if (draft) this.setMemoryDraftItem(draft, itemId, 'attempted', {});
            this.setWarning(STORAGE_WARNING);
            return { claimed: true, durable: false };
        }
    }

    async updateUpload(owner: AttachmentOwner, itemId: string, state: AttachmentUploadState, patch: Partial<StoredAttachmentItem> = {}): Promise<void> {
        const key = attachmentOwnerKey(owner);
        const db = await this.getDatabase();
        const current = this.drafts.get(key);
        if (!db) {
            if (current) this.setMemoryDraftItem(current, itemId, state, patch);
            this.setWarning(STORAGE_WARNING);
            return;
        }
        try {
            const tx = db.transaction(DRAFTS, 'readwrite');
            const done = transactionDone(tx);
            const store = tx.objectStore(DRAFTS);
            const draft = await requestResult(store.get(key)) as StoredAttachmentDraft | undefined;
            if (!draft) {
                tx.abort();
                await done.catch(() => {});
                return;
            }
            const items = draft.items.map((item) => item.id === itemId ? { ...item, ...patch, uploadState: state } : item);
            store.put({ ...draft, items, updatedAt: Date.now() });
            await done;
            this.drafts.set(key, { ...draft, items, updatedAt: Date.now() });
            this.setWarning('');
        } catch {
            if (current) this.setMemoryDraftItem(current, itemId, state, patch);
            this.setWarning(STORAGE_WARNING);
        }
    }

    async claimSend(id: string, explicit = false): Promise<{ claimed: boolean; durable: boolean; outbox: StoredAttachmentOutbox | null }> {
        if (this.attemptedSends.has(id)) return { claimed: false, durable: false, outbox: await this.getOutbox(id) };
        const db = await this.getDatabase();
        if (!db) {
            if (!explicit) return { claimed: false, durable: false, outbox: await this.getOutbox(id) };
            const record = this.outbox.get(id);
            if (!record || record.state !== 'waiting') return { claimed: false, durable: false, outbox: record ? clone(record) : null };
            const updated = { ...record, state: 'attempted' as const, updatedAt: Date.now() };
            this.outbox.set(id, updated);
            this.attemptedSends.add(id);
            this.setWarning(STORAGE_WARNING);
            return { claimed: true, durable: false, outbox: clone(updated) };
        }
        try {
            const tx = db.transaction(OUTBOX, 'readwrite');
            const done = transactionDone(tx);
            const store = tx.objectStore(OUTBOX);
            const record = await requestResult(store.get(id)) as StoredAttachmentOutbox | undefined;
            if (!record || record.state !== 'waiting') {
                await done;
                return { claimed: false, durable: true, outbox: record ? clone(record) : null };
            }
            const updated: StoredAttachmentOutbox = { ...record, state: 'attempted', updatedAt: Date.now() };
            store.put(updated);
            await done;
            this.outbox.set(id, clone(updated));
            this.attemptedSends.add(id);
            this.setWarning('');
            return { claimed: true, durable: true, outbox: clone(updated) };
        } catch {
            if (!explicit) {
                this.setWarning(STORAGE_WARNING);
                return { claimed: false, durable: false, outbox: await this.getOutbox(id) };
            }
            const record = this.outbox.get(id);
            if (!record || record.state !== 'waiting') return { claimed: false, durable: false, outbox: record ? clone(record) : null };
            const updated = { ...record, state: 'attempted' as const, updatedAt: Date.now() };
            this.outbox.set(id, updated);
            this.attemptedSends.add(id);
            this.setWarning(STORAGE_WARNING);
            return { claimed: true, durable: false, outbox: clone(updated) };
        }
    }

    async cancelWaitingSend(id: string): Promise<boolean> {
        const memory = this.outbox.get(id);
        const db = await this.getDatabase();
        if (!db) {
            if (!memory || memory.state !== 'waiting') return false;
            this.outbox.set(id, { ...memory, state: 'cancelled', reason: 'cancelled', updatedAt: Date.now() });
            this.setWarning(STORAGE_WARNING);
            return true;
        }
        try {
            const tx = db.transaction(OUTBOX, 'readwrite');
            const done = transactionDone(tx);
            const store = tx.objectStore(OUTBOX);
            const record = await requestResult(store.get(id)) as StoredAttachmentOutbox | undefined;
            if (!record || record.state !== 'waiting') {
                await done;
                return false;
            }
            const cancelled = { ...record, state: 'cancelled' as const, reason: 'cancelled', updatedAt: Date.now() };
            store.put(cancelled);
            await done;
            this.outbox.set(id, clone(cancelled));
            return true;
        } catch {
            this.setWarning(STORAGE_WARNING);
            return false;
        }
    }

    async forgetOutbox(id: string): Promise<boolean> {
        const memory = this.outbox.get(id);
        const db = await this.getDatabase();
        if (!db) {
            if (!memory) return false;
            this.outbox.delete(id);
            for (const item of memory.items) {
                const stillUsed = [...this.drafts.values()].some((draft) => draft.ownerKey === memory.ownerKey && draft.items.some((candidate) => candidate.id === item.id)) ||
                    [...this.outbox.values()].some((record) => record.ownerKey === memory.ownerKey && record.items.some((candidate) => candidate.id === item.id));
                if (!stillUsed) this.blobs.delete(blobKey(memory.ownerKey, item.id));
            }
            this.setWarning(STORAGE_WARNING);
            return true;
        }
        try {
            const tx = db.transaction([OUTBOX, DRAFTS, BLOBS], 'readwrite');
            const done = transactionDone(tx);
            const outboxStore = tx.objectStore(OUTBOX);
            const record = await requestResult(outboxStore.get(id)) as StoredAttachmentOutbox | undefined;
            if (!record) {
                await done;
                return false;
            }
            outboxStore.delete(id);
            const draftStore = tx.objectStore(DRAFTS);
            const blobStore = tx.objectStore(BLOBS);
            const forgotten: string[] = [];
            for (const item of record.items) {
                const draftUses = await requestResult(draftStore.index('byItem').count(item.id));
                const outboxUses = await requestResult(outboxStore.index('byItem').count(item.id));
                if (draftUses === 0 && outboxUses === 0) {
                    blobStore.delete(blobKey(record.ownerKey, item.id));
                    forgotten.push(item.id);
                }
            }
            await done;
            this.outbox.delete(id);
            for (const itemId of forgotten) this.blobs.delete(blobKey(record.ownerKey, itemId));
            return true;
        } catch {
            this.setWarning(STORAGE_WARNING);
            return false;
        }
    }

    async updateOutbox(id: string, state: AttachmentSendState, reason = ''): Promise<void> {
        const db = await this.getDatabase();
        const current = this.outbox.get(id);
        if (!db) {
            if (current) this.outbox.set(id, { ...current, state, reason, updatedAt: Date.now() });
            this.setWarning(STORAGE_WARNING);
            return;
        }
        try {
            const tx = db.transaction(OUTBOX, 'readwrite');
            const done = transactionDone(tx);
            const store = tx.objectStore(OUTBOX);
            const record = await requestResult(store.get(id)) as StoredAttachmentOutbox | undefined;
            if (!record) {
                tx.abort();
                await done.catch(() => {});
                return;
            }
            const updated = { ...record, state, reason, updatedAt: Date.now() };
            store.put(updated);
            await done;
            this.outbox.set(id, clone(updated));
            this.setWarning('');
        } catch {
            if (current) this.outbox.set(id, { ...current, state, reason, updatedAt: Date.now() });
            this.setWarning(STORAGE_WARNING);
        }
    }

    private makeOutbox(owner: AttachmentOwner, revision: number, snapshot: AttachmentSnapshotInput): StoredAttachmentOutbox {
        const key = attachmentOwnerKey(owner);
        const id = newAttachmentID();
        const now = Date.now();
        return {
            id,
            ownerKey: key,
            owner: ownerRecord(owner),
            paneId: owner.paneId,
            revision,
            ownerRevisionKey: ownerRevisionKey(key, revision),
            state: 'waiting',
            reason: '',
            text: snapshot.text,
            context: clone(snapshot.context),
            items: cleanItems(snapshot.items),
            createdAt: now,
            updatedAt: now,
            durable: false,
        };
    }

    private setMemoryDraftItem(draft: StoredAttachmentDraft, itemId: string, state: AttachmentUploadState, patch: Partial<StoredAttachmentItem>): void {
        const items = draft.items.map((item) => item.id === itemId ? { ...item, ...patch, uploadState: state } : item);
        this.drafts.set(draft.key, { ...draft, items, updatedAt: Date.now() });
    }

    private async getDatabase(): Promise<IDBDatabase | null> {
        if (this.disposed || !this.factory) return null;
        if (!this.database) this.database = openDatabase(this.factory).catch((error) => {
            this.setWarning(error instanceof Error && error.message === 'indexeddb-upgrade-blocked'
                ? 'Storage is busy in another tab; this draft is not saved yet.'
                : STORAGE_WARNING);
            throw error;
        });
        try {
            return await this.database;
        } catch {
            return null;
        }
    }

    private setWarning(value: string): void {
        if (this.warning === value) return;
        this.warning = value;
        this.notify();
    }

    private notify(): void {
        for (const listener of this.listeners) listener(this.warning);
    }
}

function sameItemIDs(a: readonly StoredAttachmentItem[], b: readonly StoredAttachmentItem[]): boolean {
    return a.length === b.length && a.every((item, index) => item.id === b[index]?.id);
}
