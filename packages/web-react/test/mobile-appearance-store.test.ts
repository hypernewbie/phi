// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type {
    MobileDraft,
    MobileDraftStore,
    MobileOwnerRecord,
    MobileSyncChannel,
} from '../src/platform/mobile-appearance-store.ts';
import {
    EMPTY_MOBILE,
    MobileAppearanceStore,
    mobileCacheKey,
} from '../src/platform/mobile-appearance-store.ts';
import type {
    ConfigDocumentOutcome,
    ConnectionService,
    MobileAppearance,
    MobileFenceOutcome,
    MobileReadOutcome,
    MobileSaveOutcome,
} from '../src/platform/http.ts';

const OWNER = '["http://page.invalid","","http://phi.invalid"]';
const flush = () => new Promise<void>((done) => setTimeout(done, 0));

const live: Array<MobileAppearanceStore> = [];
const freeze = (store: MobileAppearanceStore): void => {
    store.dispose();
    live.splice(live.indexOf(store), 1);
};
afterEach(() => {
    for (const store of live.splice(0)) store.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

const state = (
    revision: number,
    fields: Partial<MobileAppearance> = {},
): MobileAppearance => ({
    ...EMPTY_MOBILE,
    revision,
    ...fields,
});

function memoryDraftStore(
    behavior: { fail?: boolean } = {},
): MobileDraftStore & {
    owners: Map<string, MobileOwnerRecord>;
    drafts: Map<number, MobileDraft>;
} {
    const owners = new Map<string, MobileOwnerRecord>();
    const drafts = new Map<number, MobileDraft>();
    let nextId = 1;
    return {
        owners,
        drafts,
        async change(owner, update) {
            if (behavior.fail) throw new Error('storage is broken');
            let record = owners.get(owner);
            if (!record) {
                record = { owner, confirmed: null, counter: 0, attempt: null };
                owners.set(owner, record);
            }
            const result = update(record, [...drafts.values()], {
                put(draft) {
                    if (draft.id === undefined) draft.id = nextId++;
                    drafts.set(draft.id, draft);
                },
                delete(id) {
                    drafts.delete(id);
                },
            });
            owners.set(owner, record);
            return result;
        },
    };
}

function memoryChannelHub() {
    const members = new Set<MobileSyncChannel>();
    const create = (): MobileSyncChannel => {
        const channel: MobileSyncChannel = {
            onmessage: null,
            postMessage: (message) => {
                for (const other of members)
                    if (other !== channel)
                        other.onmessage?.({ data: message } as MessageEvent);
            },
            close: () => {
                members.delete(channel);
            },
        };
        members.add(channel);
        return channel;
    };
    return { create };
}

function memoryCache(backing = new Map<string, string>()) {
    return {
        backing,
        getItem: (key: string) => backing.get(key) ?? null,
        setItem: (key: string, value: string) => {
            backing.set(key, value);
        },
    };
}

type Script<T> = T | Array<T>;

function scripted<T>(script: Script<T> | undefined, fallback: T) {
    const queue = Array.isArray(script) ? [...script] : [];
    const single = Array.isArray(script) ? undefined : script;
    return () => {
        if (queue.length > 0) return Promise.resolve(queue.shift() as T);
        return Promise.resolve(single ?? fallback);
    };
}

const CONFIG_OK: ConfigDocumentOutcome = {
    kind: 'ok',
    document: {
        hostname: 'H',
        workspaces: [],
        hiddenTerminal: false,
        reuseTab: false,
        autoReconnect: 'visible',
        fastMode: false,
        piOffline: false,
        piBridgeNoInject: false,
        claudeSkipPermissions: false,
        agyThemeAnsi: false,
        opencodeIdleMinutes: 0,
        themeColor: '',
        uiFontFamily: 'Inter',
        uiFontSize: 0,
        terminalFontFamily: 'Fira Code',
        terminalFontSize: 0,
        mobileScrollbackRows: 0,
        hostnameOverride: '',
    },
};

function harness(
    options: {
        read?: Script<MobileReadOutcome>;
        save?: Script<MobileSaveOutcome>;
        fence?: Script<MobileFenceOutcome>;
        config?: Script<ConfigDocumentOutcome>;
        storage?: MobileDraftStore & {
            owners: Map<string, MobileOwnerRecord>;
            drafts: Map<number, MobileDraft>;
        };
        cache?: ReturnType<typeof memoryCache>;
        hub?: ReturnType<typeof memoryChannelHub>;
        now?: () => number;
        online?: boolean;
        failStorage?: boolean;
        bearer?: string | null;
    } = {},
) {
    const reads: Array<string | undefined> = [];
    const saves: Array<string> = [];
    let fences = 0;
    const storage =
        options.storage ?? memoryDraftStore({ fail: options.failStorage });
    const cache = options.cache ?? memoryCache();
    const hub = options.hub ?? memoryChannelHub();
    const online = options.online ?? true;
    const token = options.bearer === undefined ? 'live-token' : options.bearer;
    const nextRead = scripted<MobileReadOutcome>(options.read, {
        kind: 'ok',
        state: state(3),
    });
    const nextSave = scripted<MobileSaveOutcome>(options.save, {
        kind: 'unknown',
    });
    const nextFence = scripted<MobileFenceOutcome>(options.fence, {
        kind: 'unknown',
    });
    const nextConfig = scripted<ConfigDocumentOutcome>(
        options.config,
        CONFIG_OK,
    );
    const http: MobileAppearanceStore['http'] = {
        getConfigDocument: (_signal, bearer) => {
            reads.push(bearer);
            return nextConfig();
        },
        getMobileAppearance: (_signal, bearer) => {
            reads.push(bearer);
            return nextRead();
        },
        postMobileAppearance: (body, _signal, bearer) => {
            reads.push(bearer);
            saves.push(body);
            return nextSave();
        },
        postMobileFence: (_signal, bearer) => {
            reads.push(bearer);
            fences += 1;
            return nextFence();
        },
    };
    const store = new MobileAppearanceStore({
        http,
        bearer: () => token,
        owner: OWNER,
        storage,
        cache,
        createChannel: () => hub.create(),
        now: options.now,
        isOnline: () => online,
    });
    live.push(store);
    return {
        store,
        storage,
        cache,
        hub,
        http,
        reads,
        saves,
        fences: () => fences,
    };
}

async function started(
    options: Parameters<typeof harness>[0] = {},
): Promise<ReturnType<typeof harness>> {
    const h = harness(options);
    await h.store.start();
    await flush();
    return h;
}

it('starts from the cached confirmed state and refreshes', async () => {
    const cache = memoryCache();
    cache.setItem(
        mobileCacheKey(OWNER),
        JSON.stringify({
            schema: 1,
            mobile: state(2, { ui_font_size: 17 }),
            inheritance: {
                ui_font_family: 'Cached UI',
                terminal_font_family: 'Cached Term',
            },
        }),
    );
    const { store } = await started({
        cache,
        read: { kind: 'ok', state: state(3, { ui_font_size: 18 }) },
    });
    expect(store.confirmed).toMatchObject({ revision: 3, ui_font_size: 18 });
    expect(store.inheritance).toMatchObject({
        ui_font_family: 'Inter',
        terminal_font_family: 'Fira Code',
    });
    expect(store.status).toBe('Saved');
    expect(store.draft.base).toBe(3);
});

it('ignores duplicate starts and restarts after dispose', async () => {
    const { store, reads } = await started({
        read: { kind: 'ok', state: state(1) },
    });
    await store.start();
    await flush();
    const settled = reads.length;
    expect(settled).toBeGreaterThan(0);
    store.dispose();
    await store.start();
    await flush();
    expect(reads.length).toBeGreaterThan(settled);
    let notifies = 0;
    store.subscribe(() => {
        notifies += 1;
    });
    store.edit({ ui_font_size: 19 });
    expect(notifies).toBe(1);
    expect(store.pending).toBe(true);
});

it('sends the live bearer on every request', async () => {
    const { store, reads } = await started({
        read: { kind: 'ok', state: state(1) },
    });
    store.edit({ ui_font_size: 17 });
    await store.persistDraft();
    await store.flush(true);
    expect(reads.length).toBeGreaterThanOrEqual(3);
    for (const bearer of reads) expect(bearer).toBe('live-token');
});

it('auto-saves an edit after the 300 ms debounce', async () => {
    const { store, saves } = await started({
        read: { kind: 'ok', state: state(1) },
        save: {
            kind: 'saved',
            state: state(2, { ui_font_size: 17 }),
        },
    });
    vi.useFakeTimers();
    try {
        store.edit({ ui_font_size: 17 });
        expect(store.status).toBe('Pending changes');
        expect(saves).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(300);
        await vi.advanceTimersByTimeAsync(10);
        expect(saves).toHaveLength(1);
        expect(JSON.parse(saves[0] as string)).toEqual({
            revision: 1,
            fields: { ui_font_size: 17 },
        });
        expect(store.status).toBe('Saved');
        expect(store.pending).toBe(false);
    } finally {
        vi.useRealTimers();
    }
});

it('cancels the debounced save when input is invalidated', async () => {
    const { store, saves } = await started({
        read: { kind: 'ok', state: state(1) },
        save: { kind: 'saved', state: state(2) },
    });
    vi.useFakeTimers();
    try {
        store.edit({ ui_font_size: 17 });
        store.invalidateInput();
        await vi.advanceTimersByTimeAsync(1000);
        expect(saves).toHaveLength(0);
        expect(store.status).toBe('Enter a whole number in the allowed range.');
    } finally {
        vi.useRealTimers();
    }
});

it('adopts current state on 409 and retains pending fields', async () => {
    const { store } = await started({
        read: { kind: 'ok', state: state(5) },
        save: {
            kind: 'conflict',
            state: state(6, { terminal_font_size: 15 }),
        },
    });
    store.edit({ ui_font_size: 20 });
    await store.persistDraft();
    await store.flush(true);
    await flush();
    expect(store.confirmed).toMatchObject({
        revision: 6,
        terminal_font_size: 15,
    });
    expect(store.values.ui_font_size).toBe(20);
    expect(store.pending).toBe(true);
    expect(store.attempt).toBeNull();
    expect(store.conflict).toBe(true);
    expect(store.error).toBe('Save rejected. Pending changes are retained.');
});

it('blocks saves after an unknown outcome until Resolve', async () => {
    const { store, saves, fences } = await started({
        read: { kind: 'ok', state: state(5) },
        save: { kind: 'unknown' },
        fence: { kind: 'saved', state: state(6, { ui_font_size: 20 }) },
    });
    store.edit({ ui_font_size: 20 });
    await store.persistDraft();
    await store.flush(true);
    await flush();
    expect(store.attempt).not.toBeNull();
    expect(store.status).toBe('Save outcome unknown');
    // Further edits queue locally but never dispatch another write.
    store.edit({ terminal_font_size: 15 });
    await store.persistDraft();
    await store.flush(true);
    await flush();
    expect(saves).toHaveLength(1);
    expect(fences()).toBe(0);
    await store.resolve();
    await flush();
    expect(fences()).toBe(1);
    expect(saves).toHaveLength(1);
    expect(store.attempt).toBeNull();
    expect(store.confirmed).toMatchObject({ revision: 6 });
    expect(store.conflict).toBe(true);
    expect(store.status).toBe(
        'Server settings changed. Choose which values to save.',
    );
});

it('gates Resolve behind the fence deadline', async () => {
    let now = 1_000_000;
    const { store, fences } = await started({
        now: () => now,
        read: { kind: 'ok', state: state(5) },
        save: { kind: 'unknown' },
        fence: [
            { kind: 'rejected', status: 500 },
            { kind: 'saved', state: state(6) },
        ],
    });
    store.edit({ ui_font_size: 20 });
    await store.persistDraft();
    await store.flush(true);
    await flush();
    await store.resolve();
    await flush();
    expect(fences()).toBe(1);
    expect(store.status).toBe('Resolve failed; save outcome still unknown');
    // The rejected fence clears its deadline: Resolve again proceeds.
    await store.resolve();
    await flush();
    expect(fences()).toBe(2);
    expect(store.attempt).toBeNull();
    expect(now).toBe(1_000_000);
});

it('holds Resolve while a fence generation is in flight', async () => {
    let now = 1_000_000;
    const { store, storage, fences } = await started({
        now: () => now,
        read: { kind: 'ok', state: state(5) },
        save: { kind: 'unknown' },
    });
    store.edit({ ui_font_size: 20 });
    await store.persistDraft();
    await store.flush(true);
    await flush();
    // Simulate a fence claimed elsewhere that has not expired.
    const record = storage.owners.get(OWNER);
    if (!record?.attempt) throw new Error('attempt was not claimed');
    record.attempt.fences.push({
        generation: 1,
        deadline: now + 10_000,
        status: 'unknown',
    });
    await store.resolve();
    expect(fences()).toBe(0);
    now += 10_001;
    await store.resolve();
    await flush();
    expect(fences()).toBe(1);
});

it('rejects an acknowledgment that skips a revision', async () => {
    const { store, saves } = await started({
        read: { kind: 'ok', state: state(5) },
        save: { kind: 'saved', state: state(7, { ui_font_size: 20 }) },
    });
    store.edit({ ui_font_size: 20 });
    await store.persistDraft();
    await store.flush(true);
    await flush();
    expect(saves).toHaveLength(1);
    expect(store.attempt).not.toBeNull();
    expect(store.status).toBe('Save outcome unknown');
    expect(store.error).toBe(
        'Save outcome unknown. Resolve before saving again.',
    );
});

it('persists drafts across store instances on shared storage', async () => {
    const storage = memoryDraftStore();
    const first = harness({
        storage,
        read: { kind: 'ok', state: state(1) },
    });
    await first.store.start();
    first.store.edit({ ui_font_size: 19 });
    await first.store.persistDraft();
    freeze(first.store);
    const second = harness({
        storage,
        read: { kind: 'ok', state: state(1) },
    });
    await second.store.sync();
    const retained = second.store.records.drafts.filter(
        (draft) => Object.keys(draft.fields).length > 0,
    );
    expect(retained).toHaveLength(1);
    expect(retained[0]?.fields).toEqual({ ui_font_size: 19 });
    await second.store.restore(retained[0]?.id as number);
    expect(second.store.values.ui_font_size).toBe(19);
    expect(second.store.pending).toBe(true);
});

it('restores and discards retained drafts', async () => {
    const storage = memoryDraftStore();
    const first = harness({
        storage,
        read: { kind: 'ok', state: state(1) },
    });
    await first.store.start();
    first.store.edit({ ui_font_size: 19 });
    await first.store.persistDraft();
    const draftId = first.store.draft.id as number;
    freeze(first.store);
    const second = harness({
        storage,
        read: { kind: 'ok', state: state(1) },
    });
    await second.store.sync();
    await second.store.restore(draftId);
    await flush();
    expect(second.store.values.ui_font_size).toBe(19);
    await second.store.discard(draftId);
    await flush();
    expect(
        second.store.records.drafts.some((draft) => draft.id === draftId),
    ).toBe(false);
});

it('refuses to discard the draft behind an unknown save', async () => {
    const { store } = await started({
        read: { kind: 'ok', state: state(1) },
        save: { kind: 'unknown' },
    });
    store.edit({ ui_font_size: 19 });
    await store.persistDraft();
    const draftId = store.draft.id as number;
    await store.flush(true);
    await flush();
    expect(store.attempt?.draftId).toBe(draftId);
    await store.discard(draftId);
    await flush();
    expect(store.records.drafts.some((draft) => draft.id === draftId)).toBe(
        true,
    );
});

it('syncs on a cross-tab hint for the same owner', async () => {
    const hub = memoryChannelHub();
    const storage = memoryDraftStore();
    const left = harness({
        hub,
        storage,
        read: { kind: 'ok', state: state(1) },
    });
    const right = harness({
        hub,
        storage,
        read: { kind: 'ok', state: state(1) },
    });
    await left.store.start();
    await right.store.start();
    left.store.edit({ ui_font_size: 21 });
    await left.store.persistDraft();
    freeze(left.store);
    await flush();
    await flush();
    const seen = right.store.records.drafts.filter(
        (draft) => Object.keys(draft.fields).length > 0,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.fields).toEqual({ ui_font_size: 21 });
});

it('pauses saves while storage is broken but keeps edits in memory', async () => {
    const { store, saves } = await started({
        failStorage: true,
        read: { kind: 'ok', state: state(1) },
    });
    store.edit({ ui_font_size: 19 });
    await store.persistDraft();
    await flush();
    expect(store.pending).toBe(true);
    expect(store.status).toContain('Browser storage is unavailable');
    await store.flush(true);
    expect(saves).toHaveLength(0);
});

it('asks before unload only when storage-broken and pending', async () => {
    const broken = await started({
        failStorage: true,
        read: { kind: 'ok', state: state(1) },
    });
    broken.store.edit({ ui_font_size: 19 });
    await broken.store.persistDraft();
    const blocked = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(true);
    expect((blocked as BeforeUnloadEvent).returnValue !== undefined).toBe(true);
    broken.store.dispose();
    live.splice(live.indexOf(broken.store), 1);
    const clean = await started({ read: { kind: 'ok', state: state(1) } });
    clean.store.edit({ ui_font_size: 19 });
    await clean.store.persistDraft();
    const allowed = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(allowed);
    expect(allowed.defaultPrevented).toBe(false);
});

it('surfaces a 401 refresh as sign-in-again without retrying', async () => {
    let calls = 0;
    const { store } = await started({
        read: { kind: 'rejected', status: 401 },
        config: { kind: 'ok', document: CONFIG_OK.document },
    });
    calls += 1;
    expect(store.error).toBe('Sign in again to save mobile settings.');
    expect(store.status).toBe('Sign in again to save mobile settings.');
    await flush();
    await flush();
    expect(calls).toBe(1);
});

it('marks the server unavailable on 404 and recovers on force', async () => {
    const { store } = await started({
        read: [{ kind: 'unsupported' }, { kind: 'ok', state: state(4) }],
    });
    expect(store.unavailable).toBe(true);
    expect(store.error).toBe(
        'Mobile persistence is unavailable on this server.',
    );
    expect(await store.refresh(true)).toBe(true);
    expect(store.unavailable).toBe(false);
    expect(store.error).toBe('');
});

it('pauses saves after a server reset is detected', async () => {
    const { store, saves } = await started({
        read: [
            { kind: 'ok', state: state(9) },
            { kind: 'ok', state: state(2) },
        ],
    });
    store.edit({ ui_font_size: 19 });
    await store.persistDraft();
    expect(await store.refresh(true)).toBe(false);
    expect(store.resetDetected).toBe(true);
    expect(store.error).toContain('Server state was reset');
    expect(store.pending).toBe(true);
    await store.flush(true);
    expect(saves).toHaveLength(0);
});

it('save-my-changes rebases onto the server revision', async () => {
    const { store, saves } = await started({
        read: [
            { kind: 'ok', state: state(5) },
            { kind: 'ok', state: state(6, { terminal_font_size: 15 }) },
        ],
        save: {
            kind: 'saved',
            state: state(7, { ui_font_size: 20, terminal_font_size: 15 }),
        },
    });
    store.edit({ ui_font_size: 20 });
    await store.persistDraft();
    await store.saveMyChanges();
    await flush();
    expect(saves).toHaveLength(1);
    expect(JSON.parse(saves[0] as string).revision).toBe(6);
    expect(store.confirmed).toMatchObject({ revision: 7 });
    expect(store.pending).toBe(false);
});

it('use-server-values drops fields the server already moved past', async () => {
    const { store } = await started({
        read: [
            { kind: 'ok', state: state(5) },
            { kind: 'ok', state: state(6, { ui_font_size: 22 }) },
        ],
    });
    store.edit({ ui_font_size: 20 });
    await store.persistDraft();
    await store.useServerValues();
    await flush();
    expect(store.pending).toBe(false);
    expect(store.values.ui_font_size).toBe(22);
});

it('waits offline instead of claiming an attempt', async () => {
    const { store, saves } = await started({
        online: false,
        read: { kind: 'ok', state: state(1) },
    });
    store.edit({ ui_font_size: 19 });
    await store.persistDraft();
    await store.flush(true);
    expect(saves).toHaveLength(0);
    expect(store.attempt).toBeNull();
    expect(store.pending).toBe(true);
});

it('writes the confirmed state back to the local cache', async () => {
    const cache = memoryCache();
    const { store } = await started({
        cache,
        read: { kind: 'ok', state: state(8, { ui_font_size: 19 }) },
    });
    expect(store.confirmed?.revision).toBe(8);
    const cached = JSON.parse(
        cache.backing.get(mobileCacheKey(OWNER)) as string,
    );
    expect(cached.schema).toBe(1);
    expect(cached.mobile).toMatchObject({
        revision: 8,
        ui_font_size: 19,
    });
});
