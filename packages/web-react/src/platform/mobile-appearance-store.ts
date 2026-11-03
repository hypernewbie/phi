// Mobile appearance fence store. TypeScript port of
// web/mobile-appearance.js MobileAppearanceStore + mobileStorage:
// optimistic drafts, durable attempts, deadline-gated fence
// generations, cross-tab hints. Method names mirror the legacy
// original; every side effect is injected for tests.
import {
    decodeInheritedFamilies,
    type ConnectionService,
    type InheritedFamilies,
    type MobileAppearance,
} from './http.ts';

export const MOBILE_ROUTE = '/api/config/mobile-appearance';
const MOBILE_CHANNEL = 'phi_mobile_appearance';
const MOBILE_DB = 'phi-mobile-appearance-v1';
const EDIT_DEBOUNCE_MS = 300;
const FENCE_TIMEOUT_MS = 15_000;

export const MOBILE_KEYS = [
    'ui_font_size',
    'terminal_font_size',
    'ui_font_family',
    'terminal_font_family',
] as const;

export type MobileFieldKey = (typeof MOBILE_KEYS)[number];

export type MobileFieldMap = {
    [key in MobileFieldKey]?: number | string | null;
};

export type MobileVersionMap = {
    [key in MobileFieldKey]?: number;
};

export const EMPTY_MOBILE: MobileAppearance = {
    revision: 0,
    ui_font_size: null,
    terminal_font_size: null,
    ui_font_family: null,
    terminal_font_family: null,
};

export interface MobileDraftSource {
    readonly id: number;
    readonly seq: number;
}

export interface MobileDraft {
    id?: number;
    owner: string;
    fields: MobileFieldMap;
    versions: MobileVersionMap;
    base: number | null;
    seq: number;
    explicit: boolean;
    cleared?: MobileVersionMap;
    source?: MobileDraftSource;
}

export interface MobileFence {
    generation: number;
    deadline: number;
    status: 'unknown' | 'rejected';
}

export interface MobileAttempt {
    id: number;
    revision: number;
    fields: MobileFieldMap;
    versions: MobileVersionMap;
    draftId: number;
    fences: MobileFence[];
}

export interface MobileOwnerRecord {
    owner: string;
    confirmed: MobileAppearance | null;
    counter: number;
    attempt: MobileAttempt | null;
}

export interface MobileDraftWriter {
    put(draft: MobileDraft): void;
    delete(id: number): void;
}

export interface MobileDraftStore {
    change<T>(
        owner: string,
        update: (
            record: MobileOwnerRecord,
            drafts: MobileDraft[],
            writer: MobileDraftWriter,
        ) => T,
    ): Promise<T>;
}

export interface MobileSyncChannel {
    postMessage(message: { owner: string }): void;
    close(): void;
    onmessage: ((event: MessageEvent) => void) | null;
}

export type MobileCache =
    | Pick<Storage, 'getItem' | 'setItem'>
    | null
    | undefined;

export interface MobileAppearanceDeps {
    http: Pick<
        ConnectionService,
        | 'getConfigDocument'
        | 'getMobileAppearance'
        | 'postMobileAppearance'
        | 'postMobileFence'
    >;
    bearer: () => string | null;
    owner: string;
    storage: MobileDraftStore;
    cache?: MobileCache;
    createChannel?: () => MobileSyncChannel | null;
    now?: () => number;
    isOnline?: () => boolean;
}

export function mobileCacheKey(owner: string): string {
    return `phi:mobile-appearance:v1:${owner}`;
}

interface MobileCacheBody {
    schema?: unknown;
    mobile?: unknown;
    inheritance?: unknown;
}

function readCacheBody(cache: MobileCache, owner: string): MobileCacheBody {
    if (cache === null || cache === undefined) return {};
    try {
        return (
            (JSON.parse(
                cache.getItem(mobileCacheKey(owner)) || 'null',
            ) as MobileCacheBody) || {}
        );
    } catch {
        return {};
    }
}

function copy<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

const hasFields = (draft: Pick<MobileDraft, 'fields'>): boolean =>
    Object.keys(draft.fields).length > 0;

let database: Promise<IDBDatabase> | null = null;

function openMobileDB(): Promise<IDBDatabase> {
    if (!database)
        database = new Promise((resolve, reject) => {
            const request = indexedDB.open(MOBILE_DB, 1);
            request.onupgradeneeded = () => {
                request.result.createObjectStore('owners', {
                    keyPath: 'owner',
                });
                request.result.createObjectStore('drafts', {
                    keyPath: 'id',
                    autoIncrement: true,
                });
            };
            request.onerror = () => {
                database = null;
                reject(request.error);
            };
            request.onblocked = () => {
                database = null;
                reject(new Error('Browser storage is blocked'));
            };
            request.onsuccess = () => {
                request.result.onversionchange = () => {
                    request.result.close();
                    database = null;
                };
                resolve(request.result);
            };
        });
    return database;
}

export function createIndexedDBDraftStore(): MobileDraftStore {
    return {
        async change<T>(
            owner: string,
            update: (
                record: MobileOwnerRecord,
                drafts: MobileDraft[],
                writer: MobileDraftWriter,
            ) => T,
        ): Promise<T> {
            const db = await openMobileDB();
            return await new Promise<T>((resolve, reject) => {
                const tx = db.transaction(['owners', 'drafts'], 'readwrite');
                const owners = tx.objectStore('owners');
                const drafts = tx.objectStore('drafts');
                const ownerRequest = owners.get(owner);
                const draftRequest = drafts.getAll();
                let result: T;
                tx.onerror = () =>
                    reject(tx.error || new Error('Browser storage failed'));
                tx.onabort = () =>
                    reject(tx.error || new Error('Browser storage aborted'));
                tx.oncomplete = () => resolve(result);
                draftRequest.onsuccess = () => {
                    try {
                        const record: MobileOwnerRecord =
                            (ownerRequest.result as MobileOwnerRecord) || {
                                owner,
                                confirmed: null,
                                counter: 0,
                                attempt: null,
                            };
                        result = update(
                            record,
                            draftRequest.result as MobileDraft[],
                            {
                                put(draft: MobileDraft) {
                                    const value = { ...draft };
                                    if (value.id === undefined) delete value.id;
                                    const request = drafts.put(value);
                                    request.onsuccess = () => {
                                        draft.id = Number(request.result);
                                    };
                                },
                                delete(id: number) {
                                    drafts.delete(id);
                                },
                            },
                        );
                        owners.put(record);
                    } catch (error) {
                        tx.abort();
                        reject(error);
                    }
                };
            });
        },
    };
}

export function createBroadcastSyncChannel(): MobileSyncChannel | null {
    if (typeof BroadcastChannel === 'undefined') return null;
    try {
        return new BroadcastChannel(MOBILE_CHANNEL);
    } catch {
        return null;
    }
}

export function createLocalStorageCache(): Pick<
    Storage,
    'getItem' | 'setItem'
> | null {
    try {
        const probe = '__phi_mobile_probe__';
        localStorage.setItem(probe, probe);
        localStorage.removeItem(probe);
        return {
            getItem: (key) => localStorage.getItem(key),
            setItem: (key, value) => localStorage.setItem(key, value),
        };
    } catch {
        return null;
    }
}

export function createOnlineProbe(): () => boolean {
    return () => navigator.onLine;
}

function validCachedMobile(value: unknown): value is MobileAppearance {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 5) return false;
    if (
        !Number.isSafeInteger(record.revision) ||
        (record.revision as number) < 0
    )
        return false;
    return MOBILE_KEYS.every((key) => {
        const field = record[key];
        if (field === null) return true;
        if (key.endsWith('_size'))
            return (
                Number.isInteger(field) &&
                (field as number) >= (key === 'ui_font_size' ? 10 : 8) &&
                (field as number) <= (key === 'ui_font_size' ? 24 : 32)
            );
        return (
            typeof field === 'string' &&
            new TextEncoder().encode(field).length <= 512 &&
            !/\p{Cc}/u.test(field)
        );
    });
}

export class MobileAppearanceStore {
    private readonly http: MobileAppearanceDeps['http'];
    private readonly bearer: () => string | null;
    private readonly storage: MobileDraftStore;
    private readonly cacheStorage: MobileCache;
    private readonly createChannel: () => MobileSyncChannel | null;
    private readonly now: () => number;
    private readonly isOnline: () => boolean;
    readonly owner: string;
    confirmed: MobileAppearance | null;
    inheritance: InheritedFamilies | null;
    inheritanceWarning = '';
    private inheritanceRead: Promise<boolean> | null = null;
    private inheritanceGeneration = 0;
    draft: MobileDraft;
    records: { record: MobileOwnerRecord; drafts: MobileDraft[] };
    error = '';
    storageWarning = '';
    invalid = false;
    resetDetected = false;
    unavailable = false;
    disposed = false;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private fenceTimer: ReturnType<typeof setTimeout> | null = null;
    private read: Promise<boolean> | null = null;
    private lane: Promise<unknown> = Promise.resolve();
    private choiceGeneration = 0;
    private readonly listeners = new Set<() => void>();
    private channel: MobileSyncChannel | null = null;
    private stop = new AbortController();
    private started = false;

    constructor(deps: MobileAppearanceDeps) {
        this.http = deps.http;
        this.bearer = deps.bearer;
        this.owner = deps.owner;
        this.storage = deps.storage;
        this.cacheStorage = deps.cache;
        this.createChannel = deps.createChannel ?? createBroadcastSyncChannel;
        this.now = deps.now ?? Date.now;
        this.isOnline =
            deps.isOnline ?? (() => globalThis.navigator?.onLine !== false);
        const cached = readCacheBody(this.cacheStorage, this.owner);
        this.confirmed =
            cached.schema === 1 && validCachedMobile(cached.mobile)
                ? (cached.mobile as MobileAppearance)
                : null;
        this.inheritance =
            cached.schema === 1
                ? (decodeInheritedFamilies(cached.inheritance) ?? null)
                : null;
        this.draft = {
            owner: this.owner,
            fields: {},
            versions: {},
            base: this.confirmed?.revision ?? null,
            seq: 0,
            explicit: false,
        };
        this.records = {
            record: {
                owner: this.owner,
                confirmed: this.confirmed,
                counter: 0,
                attempt: null,
            },
            drafts: [],
        };
    }

    get values(): MobileAppearance {
        // Draft fields carry the UI-typed value per key; the spread keeps
        // confirmed fields the draft does not override.
        return {
            ...(this.confirmed || EMPTY_MOBILE),
            ...this.draft.fields,
        } as MobileAppearance;
    }

    get pending(): boolean {
        return hasFields(this.draft);
    }

    get attempt(): MobileAttempt | null {
        return this.records.record.attempt;
    }

    get conflict(): boolean {
        return (
            this.pending &&
            this.draft.base !== null &&
            this.confirmed !== null &&
            this.draft.base !== this.confirmed.revision
        );
    }

    get status(): string {
        if (this.storageWarning) return this.storageWarning;
        if (this.attempt)
            return this.attempt.fences.at(-1)?.status === 'rejected'
                ? 'Resolve failed; save outcome still unknown'
                : 'Save outcome unknown';
        if (this.error) return this.error;
        if (this.invalid) return 'Enter a whole number in the allowed range.';
        if (this.conflict)
            return 'Server settings changed. Choose which values to save.';
        if (this.pending) return 'Pending changes';
        return this.confirmed ? 'Saved' : 'Using mobile defaults';
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    notify(): void {
        if (this.disposed) return;
        this.armFenceTimer();
        for (const listener of this.listeners) listener();
    }

    // The Resolve button enables when the latest fence deadline passes;
    // the store re-renders then because screens cannot own timers.
    private armFenceTimer(): void {
        if (this.fenceTimer !== null) {
            clearTimeout(this.fenceTimer);
            this.fenceTimer = null;
        }
        const remaining =
            (this.attempt?.fences.at(-1)?.deadline || 0) - this.now();
        if (!this.disposed && this.attempt !== null && remaining > 0) {
            this.fenceTimer = setTimeout(() => {
                this.fenceTimer = null;
                this.notify();
            }, remaining + 1);
        }
    }

    broadcast(): void {
        if (this.disposed) return;
        try {
            this.channel?.postMessage({ owner: this.owner });
        } catch {
            // Notifications are hints; persisted drafts remain usable.
        }
    }

    async start(): Promise<void> {
        // Idempotent and reviving: StrictMode mounts effects twice, and
        // the settings panel mounts on every modal open.
        if (this.started) return;
        this.started = true;
        this.disposed = false;
        this.stop = new AbortController();
        const channel = this.createChannel();
        if (channel !== null) {
            this.channel = channel;
            channel.onmessage = (event) => {
                const data = event.data as { owner?: unknown } | null;
                if (data?.owner === this.owner) void this.wake();
            };
        }
        window.addEventListener('online', this.wake);
        window.addEventListener('focus', this.wake);
        window.addEventListener('beforeunload', this.beforeUnload);
        await this.sync();
        if (!this.disposed) void this.refresh();
    }

    beforeUnload = (event: BeforeUnloadEvent): void => {
        if (this.storageWarning && this.pending) {
            event.preventDefault();
            event.returnValue = '';
        }
    };

    // Reload local records and offer never-dispatched drafts. Idle hints
    // never fetch; a draft with no revision can read once to enable its save.
    wake = (): void => {
        void this.sync().then(() => {
            if (!this.disposed) void this.flush();
        });
    };

    dispose(): void {
        this.disposed = true;
        this.started = false;
        this.stop.abort();
        this.channel?.close();
        this.channel = null;
        if (this.timer !== null) clearTimeout(this.timer);
        if (this.fenceTimer !== null) clearTimeout(this.fenceTimer);
        window.removeEventListener('online', this.wake);
        window.removeEventListener('focus', this.wake);
        window.removeEventListener('beforeunload', this.beforeUnload);
        this.listeners.clear();
    }

    storageError(): void {
        this.storageWarning =
            'Browser storage is unavailable. Changes remain in memory and cannot survive reload; saves are paused.';
        this.notify();
    }

    cache(): void {
        const storage = this.cacheStorage;
        if (storage === null || storage === undefined) return;
        try {
            storage.setItem(
                mobileCacheKey(this.owner),
                JSON.stringify({
                    schema: 1,
                    mobile: this.confirmed,
                    inheritance: this.inheritance,
                }),
            );
        } catch {
            /* IndexedDB remains authoritative for mobile saves. */
        }
    }

    adopt(state: MobileAppearance): void {
        if (this.confirmed && state.revision < this.confirmed.revision) return;
        this.confirmed = copy(state);
        this.cache();
    }

    ingestInheritance(data: unknown): void {
        if (this.disposed) return;
        const families = decodeInheritedFamilies(data);
        if (families === null) return;
        this.inheritanceGeneration++;
        this.inheritance = {
            ui_font_family: families.ui_font_family,
            terminal_font_family: families.terminal_font_family,
        };
        this.inheritanceWarning = '';
        this.cache();
        this.notify();
    }

    refreshInheritance(): Promise<boolean> {
        if (this.inheritanceRead) return this.inheritanceRead;
        if (this.disposed) return Promise.resolve(false);
        const generation = this.inheritanceGeneration;
        this.inheritanceRead = (async () => {
            try {
                const token = this.bearer();
                const outcome = await this.http.getConfigDocument(
                    this.stop.signal,
                    token === null ? undefined : token,
                );
                if (outcome.kind !== 'ok')
                    throw new Error('Unable to refresh inherited fonts.');
                const families = decodeInheritedFamilies({
                    ui_font_family: outcome.document.uiFontFamily,
                    terminal_font_family: outcome.document.terminalFontFamily,
                });
                if (families === null)
                    throw new Error('Invalid inherited fonts response.');
                if (this.disposed || generation !== this.inheritanceGeneration)
                    return false;
                this.ingestInheritance(families);
                return true;
            } catch {
                if (!this.disposed) {
                    this.inheritanceWarning =
                        'Inherited fonts could not refresh; using the last saved families or built-in defaults.';
                    this.notify();
                }
                return false;
            } finally {
                this.inheritanceRead = null;
            }
        })();
        return this.inheritanceRead;
    }

    async sync(): Promise<void> {
        try {
            this.records = await this.storage.change(
                this.owner,
                (record, drafts) => ({ record, drafts }),
            );
            if (
                this.records.record.confirmed &&
                validCachedMobile(this.records.record.confirmed)
            )
                this.adopt(this.records.record.confirmed);
            this.storageWarning = '';
        } catch {
            this.storageError();
        }
        this.notify();
    }

    edit(fields: MobileFieldMap): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.invalid = false;
        this.error = '';
        if (!this.pending) {
            this.draft.explicit = false;
            this.draft.base = this.confirmed?.revision ?? null;
        }
        for (const key of MOBILE_KEYS)
            if (key in fields) {
                this.draft.fields[key] = fields[key];
                this.draft.versions[key] = ++this.draft.seq;
            }
        if (!this.pending) return;
        this.notify();
        const active = this.draft;
        const seq = active.seq;
        void this.persistDraft().then((saved) => {
            if (
                saved &&
                active === this.draft &&
                seq === active.seq &&
                !this.disposed &&
                !this.invalid
            ) {
                if (this.timer !== null) clearTimeout(this.timer);
                this.timer = setTimeout(() => {
                    void this.flush();
                }, EDIT_DEBOUNCE_MS);
            }
        });
    }

    invalidateInput(): void {
        this.invalid = true;
        if (this.timer !== null) clearTimeout(this.timer);
        this.notify();
    }

    persistDraft(): Promise<boolean> {
        const active = this.draft;
        const snapshot = copy(active);
        const operation = this.lane.then(async () => {
            snapshot.id = active.id;
            try {
                await this.storage.change(
                    this.owner,
                    (_record, drafts, writer) => {
                        snapshot.cleared = drafts.find(
                            (draft) => draft.id === snapshot.id,
                        )?.cleared;
                        for (const key of MOBILE_KEYS)
                            if (
                                (snapshot.versions[key] || 0) <=
                                (snapshot.cleared?.[key] || 0)
                            ) {
                                delete snapshot.fields[key];
                                delete snapshot.versions[key];
                            }
                        writer.put(snapshot);
                    },
                );
                active.id = snapshot.id;
                this.storageWarning = '';
                this.broadcast();
                return true;
            } catch {
                this.storageError();
                return false;
            }
        });
        this.lane = operation;
        return operation;
    }

    refresh(force = false): Promise<boolean> {
        if (this.read) return this.read;
        if (this.disposed || (this.unavailable && !force))
            return Promise.resolve(false);
        void this.refreshInheritance();
        const startRevision = this.confirmed?.revision ?? null;
        this.read = (async () => {
            try {
                const token = this.bearer();
                const outcome = await this.http.getMobileAppearance(
                    this.stop.signal,
                    token === null ? undefined : token,
                );
                if (outcome.kind === 'cancelled' || this.disposed) return false;
                if (outcome.kind === 'unsupported') {
                    this.unavailable = true;
                    throw new Error(
                        'Mobile persistence is unavailable on this server.',
                    );
                }
                if (outcome.kind === 'unavailable')
                    throw new Error('Unable to refresh mobile settings.');
                if (outcome.kind === 'rejected')
                    throw new Error(
                        outcome.status === 401
                            ? 'Sign in again to save mobile settings.'
                            : 'Unable to refresh mobile settings.',
                    );
                const state = outcome.state;
                if (startRevision !== null && state.revision < startRevision) {
                    this.resetDetected = true;
                    this.error =
                        'Server state was reset. Saves are paused; pending changes are retained.';
                    return false;
                }
                this.adopt(state);
                await this.storage.change(this.owner, (record) => {
                    if (
                        !record.confirmed ||
                        state.revision >= record.confirmed.revision
                    )
                        record.confirmed = state;
                });
                if (!this.pending)
                    this.draft.base = this.confirmed?.revision ?? null;
                this.error = '';
                this.unavailable = false;
                await this.sync();
                void this.flush();
                return true;
            } catch (error) {
                if (!this.disposed)
                    this.error =
                        error instanceof Error
                            ? error.message
                            : 'Unable to refresh mobile settings.';
                return false;
            } finally {
                this.read = null;
                this.notify();
            }
        })();
        return this.read;
    }

    async restore(id: number): Promise<void> {
        const active = this.draft;
        const seq = active.seq;
        await this.sync();
        const source = this.records.drafts.find(
            (draft) => draft.id === id && draft.owner === this.owner,
        );
        if (
            !source ||
            active !== this.draft ||
            active.seq !== seq ||
            this.disposed
        )
            return;
        if (this.pending && !(await this.persistDraft())) return;
        if (active !== this.draft || active.seq !== seq || this.disposed)
            return;
        this.draft = {
            owner: this.owner,
            fields: copy(source.fields),
            versions: {},
            base: source.base,
            seq: 0,
            explicit: true,
        };
        for (const key of MOBILE_KEYS)
            if (key in source.fields)
                this.draft.versions[key] = ++this.draft.seq;
        this.draft.base = source.base;
        this.draft.explicit = true;
        this.draft.source = { id, seq: source.seq };
        this.notify();
        await this.persistDraft();
        await this.sync();
    }

    async discard(id: number): Promise<void> {
        await this.storage
            .change(this.owner, (record, drafts, writer) => {
                if (record.attempt?.draftId === id) return;
                const source = drafts.find(
                    (draft) => draft.id === id && draft.owner === this.owner,
                );
                if (source) writer.delete(id);
            })
            .catch(() => this.storageError());
        await this.sync();
    }

    async useServerValues(): Promise<void> {
        if (this.attempt) return;
        const choice = ++this.choiceGeneration;
        const active = this.draft;
        const selected = copy(active);
        this.draft.explicit = true;
        if (this.timer !== null) clearTimeout(this.timer);
        if (
            !(await this.refresh()) ||
            this.attempt ||
            active !== this.draft ||
            choice !== this.choiceGeneration
        )
            return;
        for (const key of MOBILE_KEYS)
            if (this.draft.versions[key] === selected.versions[key]) {
                delete this.draft.fields[key];
                delete this.draft.versions[key];
            }
        this.draft.base = (this.confirmed as MobileAppearance).revision;
        this.draft.explicit = this.pending;
        await this.persistDraft();
        this.notify();
    }

    async saveMyChanges(): Promise<void> {
        if (this.attempt || this.invalid) return;
        const choice = ++this.choiceGeneration;
        const active = this.draft;
        const selected = copy(active);
        this.draft.explicit = true;
        if (this.timer !== null) clearTimeout(this.timer);
        if (
            !hasFields(selected) ||
            !(await this.refresh()) ||
            this.attempt ||
            active !== this.draft ||
            choice !== this.choiceGeneration
        )
            return;
        selected.base = (this.confirmed as MobileAppearance).revision;
        selected.explicit = false;
        // Persist the explicit rebase, but do not send any edits made during the read.
        this.draft.base = selected.base;
        await this.persistDraft();
        if (active === this.draft && choice === this.choiceGeneration)
            await this.flush(true, selected);
    }

    async flush(
        explicit = false,
        selected: MobileDraft = copy(this.draft),
    ): Promise<void> {
        if (
            this.disposed ||
            this.invalid ||
            this.unavailable ||
            this.resetDetected ||
            this.storageWarning ||
            this.isOnline() === false ||
            !hasFields(selected) ||
            (!explicit && selected.explicit)
        )
            return;
        if (selected.base === null) {
            if (this.attempt) return;
            if (!this.confirmed) {
                await this.refresh();
                return;
            }
            // Only a never-dispatched draft has no base. Claim against the
            // first known revision; the durable transaction rechecks safety.
            selected.base = this.confirmed.revision;
        }
        const active = this.draft;
        const choice = this.choiceGeneration;
        await this.lane;
        if (active !== this.draft) return;
        selected.id = active.id;
        if (selected.id === undefined) return;
        let attempt: MobileAttempt | null = null;
        try {
            attempt = await this.storage.change(
                this.owner,
                (record, drafts) => {
                    // Storage may have waited behind another transaction since flush began.
                    // Recheck local intent before claiming a durable, possibly unconfirmed write.
                    if (
                        this.disposed ||
                        this.invalid ||
                        this.unavailable ||
                        this.resetDetected ||
                        this.storageWarning ||
                        this.isOnline() === false ||
                        active !== this.draft ||
                        choice !== this.choiceGeneration ||
                        (!explicit && active.explicit) ||
                        record.attempt ||
                        !record.confirmed ||
                        record.confirmed.revision !== selected.base
                    )
                        return null;
                    if (
                        !explicit &&
                        drafts.some(
                            (draft) =>
                                draft.owner === this.owner &&
                                draft.id !== selected.id &&
                                hasFields(draft),
                        )
                    )
                        return null;
                    const saved = drafts.find(
                        (draft) => draft.id === selected.id,
                    );
                    if (!saved || saved.seq < selected.seq) return null;
                    const claimed: MobileAttempt = {
                        id: ++record.counter,
                        revision: selected.base as number,
                        fields: selected.fields,
                        versions: selected.versions,
                        draftId: selected.id as number,
                        fences: [],
                    };
                    record.attempt = copy(claimed);
                    return claimed;
                },
            );
        } catch {
            this.storageError();
            return;
        }
        if (!attempt) {
            await this.sync();
            return;
        }
        await this.sync();
        this.broadcast();
        await this.sendSave(attempt);
    }

    async resolve(): Promise<void> {
        if (this.disposed || this.storageWarning || this.isOnline() === false)
            return;
        let claim: {
            attempt: MobileAttempt;
            generation: number;
        } | null = null;
        try {
            claim = await this.storage.change(this.owner, (record) => {
                const pending = record.attempt;
                if (
                    !pending ||
                    (pending.fences.at(-1)?.deadline || 0) > this.now()
                )
                    return null;
                const generation = (pending.fences.at(-1)?.generation || 0) + 1;
                pending.fences.push({
                    generation,
                    deadline: this.now() + FENCE_TIMEOUT_MS,
                    status: 'unknown',
                });
                return { attempt: copy(pending), generation };
            });
        } catch {
            this.storageError();
            return;
        }
        if (!claim) return;
        await this.sync();
        this.broadcast();
        await this.sendFence(claim.attempt, claim.generation);
    }

    private async sendSave(attempt: MobileAttempt): Promise<void> {
        let released = false;
        try {
            const token = this.bearer();
            const outcome = await this.http.postMobileAppearance(
                JSON.stringify({
                    revision: attempt.revision,
                    fields: attempt.fields,
                }),
                this.stop.signal,
                token === null ? undefined : token,
            );
            if (outcome.kind === 'cancelled') return;
            if (outcome.kind === 'unknown')
                throw new Error('Save outcome unknown');
            const status = outcome.kind === 'rejected' ? outcome.status : 200;
            const state =
                outcome.kind === 'saved' || outcome.kind === 'conflict'
                    ? outcome.state
                    : null;
            if (outcome.kind === 'saved') {
                const saved = outcome.state;
                if (
                    saved.revision !== attempt.revision + 1 ||
                    MOBILE_KEYS.some(
                        (key) =>
                            key in attempt.fields &&
                            saved[key] !== attempt.fields[key],
                    )
                )
                    throw new Error('Unexpected save acknowledgment');
            }
            released = await this.storage.change(
                this.owner,
                (record, drafts, writer) => {
                    const slot = record.attempt;
                    if (
                        !slot ||
                        slot.id !== attempt.id ||
                        slot.fences.length !== 0
                    )
                        return false;
                    if (
                        state &&
                        (!record.confirmed ||
                            state.revision >= record.confirmed.revision)
                    )
                        record.confirmed = state;
                    const draft = drafts.find(
                        (candidate) =>
                            candidate.id === attempt.draftId &&
                            candidate.owner === this.owner,
                    );
                    if (draft) {
                        if (outcome.kind === 'saved' && state) {
                            for (const key of MOBILE_KEYS)
                                if (
                                    draft.versions[key] ===
                                    attempt.versions[key]
                                ) {
                                    draft.cleared ||= {};
                                    draft.cleared[key] = attempt.versions[key];
                                    delete draft.fields[key];
                                    delete draft.versions[key];
                                }
                            if (
                                !record.confirmed ||
                                record.confirmed.revision <= state.revision
                            )
                                draft.base = state.revision;
                            if (draft.source) {
                                const sourceRef = draft.source;
                                const source = drafts.find(
                                    (other) =>
                                        other.id === sourceRef.id &&
                                        other.seq === sourceRef.seq,
                                );
                                if (source && source.id !== undefined)
                                    writer.delete(source.id);
                            }
                        } else draft.explicit = true;
                        writer.put(draft);
                    }
                    record.attempt = null;
                    return true;
                },
            );
            if (
                outcome.kind === 'saved' &&
                state &&
                released &&
                this.draft.id === attempt.draftId
            ) {
                // A new edit can start while the following IndexedDB sync waits.
                this.adopt(state);
                for (const key of MOBILE_KEYS)
                    if (this.draft.versions[key] === attempt.versions[key]) {
                        delete this.draft.fields[key];
                        delete this.draft.versions[key];
                    }
                if (
                    !this.confirmed ||
                    this.confirmed.revision <= state.revision
                )
                    this.draft.base = state.revision;
            } else if (released) this.draft.explicit = true;
            if (status === 404 || status === 405) this.unavailable = true;
            else if (status === 200) this.unavailable = false;
            this.error =
                outcome.kind === 'saved'
                    ? ''
                    : status === 401
                      ? 'Sign in again, then explicitly resolve or save.'
                      : 'Save rejected. Pending changes are retained.';
        } catch (error) {
            this.error = 'Save outcome unknown. Resolve before saving again.';
            if (error instanceof Error && !this.disposed)
                console.warn('[mobile appearance]', error.message);
        } finally {
            await this.sync();
            this.broadcast();
            // An acknowledged save can unblock edits queued behind it; the
            // flush guards recheck intent, so a settled attempt retries nothing.
            if (!this.disposed) void this.flush();
            this.notify();
        }
    }

    private async sendFence(
        attempt: MobileAttempt,
        generation: number,
    ): Promise<void> {
        try {
            const token = this.bearer();
            const outcome = await this.http.postMobileFence(
                this.stop.signal,
                token === null ? undefined : token,
            );
            if (outcome.kind === 'cancelled') return;
            if (outcome.kind === 'unknown')
                throw new Error('Save outcome unknown');
            const status = outcome.kind === 'rejected' ? outcome.status : 200;
            const state = outcome.kind === 'saved' ? outcome.state : null;
            if (state !== null && state.revision <= attempt.revision)
                throw new Error('Unexpected save acknowledgment');
            const released = await this.storage.change(
                this.owner,
                (record, drafts, writer) => {
                    const slot = record.attempt;
                    if (
                        !slot ||
                        slot.id !== attempt.id ||
                        slot.fences.at(-1)?.generation !== generation
                    )
                        return false;
                    if (outcome.kind !== 'saved') {
                        const fence = slot.fences.at(-1);
                        if (fence) {
                            fence.status = 'rejected';
                            fence.deadline = 0;
                        }
                        return false;
                    }
                    if (
                        state &&
                        (!record.confirmed ||
                            state.revision >= record.confirmed.revision)
                    )
                        record.confirmed = state;
                    const draft = drafts.find(
                        (candidate) =>
                            candidate.id === attempt.draftId &&
                            candidate.owner === this.owner,
                    );
                    if (draft) {
                        draft.explicit = true;
                        writer.put(draft);
                    }
                    record.attempt = null;
                    return true;
                },
            );
            // A fenced save may or may not have applied; the draft goes
            // explicit so only an explicit choice continues it.
            if (released) this.draft.explicit = true;
            if (status === 404 || status === 405) this.unavailable = true;
            else if (status === 200) this.unavailable = false;
            this.error =
                outcome.kind === 'saved'
                    ? ''
                    : status === 401
                      ? 'Sign in again, then explicitly resolve or save.'
                      : 'Save rejected. Pending changes are retained.';
        } catch (error) {
            this.error = 'Save outcome unknown. Resolve before saving again.';
            if (error instanceof Error && !this.disposed)
                console.warn('[mobile appearance]', error.message);
        } finally {
            await this.sync();
            this.broadcast();
            if (!this.disposed) void this.flush();
            this.notify();
        }
    }
}
