// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { BackendScope } from '../web/backend-scope.js';
import {
    EMPTY_MOBILE,
    MobileAppearanceStore,
    appearanceCacheKey,
    appearanceOwner,
    ownerFetch,
    readInheritanceCache,
    effectiveAppearance,
} from '../web/mobile-appearance.js';

setupDomHarness();
const clone = (value) => JSON.parse(JSON.stringify(value));
const stores = [];
beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    for (const store of stores.splice(0)) store.dispose();
    vi.useRealTimers();
});

// The injectable boundary models serial IDB transactions, not a network or UI replacement.
function storage() {
    return {
        owners: new Map(),
        drafts: new Map(),
        nextId: 1,
        fail: false,
        async change(owner, update) {
            if (this.fail) throw new Error('injected transaction failure');
            const record = clone(
                this.owners.get(owner) || {
                    owner,
                    confirmed: EMPTY_MOBILE,
                    counter: 0,
                    attempt: null,
                },
            );
            const drafts = clone([...this.drafts.values()]);
            const writes = [],
                deletes = [];
            const result = update(record, drafts, {
                put: (draft) => {
                    draft.id ??= this.nextId++;
                    writes.push(clone(draft));
                },
                delete: (id) => deletes.push(id),
            });
            this.owners.set(owner, clone(record));
            for (const draft of writes) this.drafts.set(draft.id, draft);
            for (const id of deletes) this.drafts.delete(id);
            return clone(result === undefined ? null : result);
        },
    };
}
function fixture(db = storage(), profile = 'a', origin = 'http://a.test') {
    const scope = new BackendScope(profile, origin);
    localStorage.setItem(
        appearanceCacheKey(scope),
        JSON.stringify({ schema: 1, mobile: EMPTY_MOBILE }),
    );
    const store = new MobileAppearanceStore(scope, db);
    stores.push(store);
    let server = clone(EMPTY_MOBILE);
    const fetch = vi.fn(async (url, init = {}) => {
        if (init.method === 'POST') {
            const body = JSON.parse(init.body);
            if (url.endsWith('/fence')) server.revision++;
            else {
                if (body.revision !== server.revision)
                    return Response.json(server, { status: 409 });
                server = {
                    ...server,
                    ...body.fields,
                    revision: server.revision + 1,
                };
            }
        }
        return Response.json(server);
    });
    const inheritanceFetch = vi.fn(async () =>
        Response.json({
            ui_font_family: 'serif',
            terminal_font_family: 'monospace',
        }),
    );
    vi.stubGlobal('fetch', (url, init) =>
        url === '/api/config' ? inheritanceFetch(url, init) : fetch(url, init),
    );
    return {
        inheritanceFetch,
        store,
        db,
        scope,
        fetch,
        get server() {
            return server;
        },
        set server(value) {
            server = value;
        },
    };
}
const settleEdit = () => vi.advanceTimersByTimeAsync(301);
const posts = (fetch) =>
    fetch.mock.calls.filter(([, init]) => init?.method === 'POST');

it('keeps durable edits usable when BroadcastChannel notifications fail', async () => {
    vi.stubGlobal(
        'BroadcastChannel',
        class {
            postMessage() {
                throw new DOMException(
                    'channel unavailable',
                    'InvalidStateError',
                );
            }
            close() {}
        },
    );
    const f = fixture();
    await f.store.start();
    await f.store.refresh();
    f.store.edit({ ui_font_size: 21 });
    await settleEdit();
    expect(f.store.storageWarning).toBe('');
    expect(f.server.ui_font_size).toBe(21);
    expect(f.store.pending).toBe(false);
});

it('finishes an aborted save without posting to its disposed channel', async () => {
    vi.stubGlobal(
        'BroadcastChannel',
        class {
            closed = false;
            postMessage() {
                if (this.closed)
                    throw new DOMException(
                        'channel closed',
                        'InvalidStateError',
                    );
            }
            close() {
                this.closed = true;
            }
        },
    );
    const f = fixture();
    await f.store.start();
    await f.store.refresh();
    f.fetch.mockImplementation(() => new Promise(() => {}));
    f.store.edit({ ui_font_size: 21 });
    await vi.advanceTimersByTimeAsync(0);
    const saving = f.store.flush();
    await vi.advanceTimersByTimeAsync(0);
    f.scope.abort();
    await expect(saving).resolves.toBeUndefined();
    expect(f.db.owners.get(f.store.owner).attempt).not.toBeNull();
    expect(f.db.drafts.get(f.store.draft.id).fields.ui_font_size).toBe(21);
});

it('debounces only valid edits and keeps blank/invalid input from sending the previous value', async () => {
    const { store, fetch } = fixture();
    await store.sync();
    store.edit({ ui_font_size: 21 });
    store.invalidateInput();
    await settleEdit();
    expect(posts(fetch)).toHaveLength(0);
    expect(store.values.ui_font_size).toBe(21);
    store.edit({ ui_font_size: 22 });
    await settleEdit();
    expect(posts(fetch)).toHaveLength(1);
    expect(JSON.parse(posts(fetch)[0][1].body)).toEqual({
        revision: 0,
        fields: { ui_font_size: 22 },
    });
    expect(store.pending).toBe(false);
    expect(store.attempt).toBeNull();
});

it('retains offline work, allocates distinct cloned-tab drafts, and requires a choice with competitors', async () => {
    const first = fixture();
    const second = fixture(first.db);
    await first.store.sync();
    await second.store.sync();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    first.store.edit({ ui_font_size: 20 });
    second.store.edit({ ui_font_size: 23 });
    await settleEdit();
    expect(first.store.draft.id).not.toBe(second.store.draft.id);
    expect(first.db.drafts.size).toBe(2);
    expect(posts(second.fetch)).toHaveLength(0);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    await first.store.refresh();
    await second.store.refresh();
    expect(posts(second.fetch)).toHaveLength(0);
    await first.store.saveMyChanges();
    expect(posts(second.fetch)).toHaveLength(1);
    expect(first.db.drafts.get(second.store.draft.id).fields).toEqual({
        ui_font_size: 23,
    });
});

it('restores a new document draft without adopting it automatically or deleting a changed source', async () => {
    const first = fixture();
    await first.store.sync();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    first.store.edit({ ui_font_size: 20 });
    await settleEdit();
    const recovery = fixture(first.db);
    await recovery.store.sync();
    expect(recovery.store.pending).toBe(false);
    await recovery.store.restore(first.store.draft.id);
    expect(recovery.store.draft.explicit).toBe(true);
    expect(recovery.store.draft.id).not.toBe(first.store.draft.id);
    first.store.edit({ ui_font_size: 23 });
    await settleEdit();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    await recovery.store.saveMyChanges();
    expect(first.db.drafts.get(first.store.draft.id).fields.ui_font_size).toBe(
        23,
    );
});

it('does not clear a newly restored draft when an older document draft acknowledges', async () => {
    const f = fixture();
    await f.store.sync();
    f.db.drafts.set(1, {
        id: 1,
        owner: f.store.owner,
        fields: { ui_font_size: 23 },
        versions: { ui_font_size: 1 },
        base: 0,
        seq: 1,
        explicit: true,
    });
    f.db.nextId = 2;
    let release;
    f.fetch.mockImplementation((_url, init = {}) =>
        init.method === 'POST'
            ? new Promise((resolve) => {
                  release = resolve;
              })
            : Promise.resolve(Response.json(EMPTY_MOBILE)),
    );
    f.store.edit({ ui_font_size: 21 });
    await vi.advanceTimersByTimeAsync(0);
    const saving = f.store.saveMyChanges();
    await vi.advanceTimersByTimeAsync(0);
    expect(posts(f.fetch)).toHaveLength(1);
    await f.store.restore(1);
    expect(f.store.values.ui_font_size).toBe(23);
    release(Response.json({ ...EMPTY_MOBILE, ui_font_size: 21, revision: 1 }));
    await saving;
    expect(f.store.values.ui_font_size).toBe(23);
    expect(f.store.pending).toBe(true);
});

it.each(['saveMyChanges', 'useServerValues'])(
    '%s cannot affect a different draft restored during its read',
    async (action) => {
        const f = fixture();
        await f.store.sync();
        f.store.edit({ ui_font_size: 21 });
        await vi.advanceTimersByTimeAsync(0);
        const sourceId = f.db.nextId++;
        f.db.drafts.set(sourceId, {
            id: sourceId,
            owner: f.store.owner,
            fields: { ui_font_size: 23 },
            versions: { ui_font_size: 1 },
            base: 0,
            seq: 1,
            explicit: true,
        });
        let release;
        f.fetch.mockImplementation((_url, init = {}) =>
            init.method === 'POST'
                ? Promise.resolve(Response.json(EMPTY_MOBILE))
                : new Promise((resolve) => {
                      release = resolve;
                  }),
        );
        const choosing = f.store[action]();
        await vi.advanceTimersByTimeAsync(0);
        await f.store.restore(sourceId);
        release(Response.json(EMPTY_MOBILE));
        await choosing;
        expect(posts(f.fetch)).toHaveLength(0);
        expect(f.store.values.ui_font_size).toBe(23);
        expect(f.store.pending).toBe(true);
    },
);

it('does not replace input changed while Restore reads local storage', async () => {
    const f = fixture();
    await f.store.sync();
    f.store.edit({ ui_font_size: 21 });
    await vi.advanceTimersByTimeAsync(0);
    const originalId = f.store.draft.id;
    f.db.drafts.set(2, {
        id: 2,
        owner: f.store.owner,
        fields: { ui_font_size: 23 },
        versions: { ui_font_size: 1 },
        base: 0,
        seq: 1,
        explicit: true,
    });
    const change = f.db.change.bind(f.db);
    let release,
        hold = true;
    f.db.change = async (...args) => {
        if (hold) {
            hold = false;
            await new Promise((resolve) => {
                release = resolve;
            });
        }
        return change(...args);
    };
    const restoring = f.store.restore(2);
    f.store.edit({ ui_font_size: 22 });
    await vi.advanceTimersByTimeAsync(0);
    release();
    await restoring;
    expect(f.store.values.ui_font_size).toBe(22);
    expect(f.store.draft.id).toBe(originalId);
});

it('keeps memory-only input when Restore cannot preserve the current draft', async () => {
    const f = fixture();
    await f.store.sync();
    f.store.edit({ ui_font_size: 21 });
    await vi.advanceTimersByTimeAsync(0);
    f.db.drafts.set(2, {
        id: 2,
        owner: f.store.owner,
        fields: { ui_font_size: 23 },
        versions: { ui_font_size: 1 },
        base: 0,
        seq: 1,
        explicit: true,
    });
    await f.store.sync();
    f.db.fail = true;
    f.store.edit({ ui_font_size: 22 });
    await vi.advanceTimersByTimeAsync(0);
    await f.store.restore(2);
    expect(f.store.values.ui_font_size).toBe(22);
    expect(f.store.storageWarning).toContain('memory');
});

it('preserves later edits when an earlier save acknowledges', async () => {
    const f = fixture();
    await f.store.sync();
    let release;
    f.fetch.mockImplementation((url, init = {}) =>
        init.method === 'POST'
            ? new Promise((resolve) => {
                  release = resolve;
              })
            : Promise.resolve(Response.json(f.server)),
    );
    f.store.edit({ ui_font_size: 21 });
    await settleEdit();
    f.store.edit({ ui_font_size: 22 });
    await settleEdit();
    expect(posts(f.fetch)).toHaveLength(1);
    release(Response.json({ ...EMPTY_MOBILE, revision: 1, ui_font_size: 21 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.values.ui_font_size).toBe(22);
    expect(f.store.pending).toBe(true);
    expect(f.store.draft.base).toBe(1);
    expect(f.db.drafts.get(f.store.draft.id).fields).toEqual({
        ui_font_size: 22,
    });
});

it.each([400, 401, 403, 404, 405, 413, 415])(
    'definitive save %i releases only its slot and retains the draft without automatic retry',
    async (status) => {
        const f = fixture();
        await f.store.sync();
        f.fetch.mockResolvedValue(new Response('rejected', { status }));
        f.store.edit({ ui_font_size: 21 });
        await settleEdit();
        expect(f.store.attempt).toBeNull();
        expect(f.store.pending).toBe(true);
        expect(f.store.draft.explicit).toBe(true);
        await f.store.flush();
        expect(posts(f.fetch)).toHaveLength(1);
    },
);

it('409 requires an explicit choice, including disjoint-field revision changes', async () => {
    const f = fixture();
    await f.store.sync();
    f.server = { ...EMPTY_MOBILE, revision: 1, terminal_font_size: 18 };
    f.store.edit({ ui_font_size: 21 });
    await settleEdit();
    expect(f.store.conflict).toBe(true);
    expect(f.store.attempt).toBeNull();
    await f.store.refresh();
    expect(posts(f.fetch)).toHaveLength(1);
    await f.store.saveMyChanges();
    expect(posts(f.fetch)).toHaveLength(2);
    expect(f.server).toMatchObject({
        ui_font_size: 21,
        terminal_font_size: 18,
        revision: 2,
    });
});

it.each([500, 'malformed', 'unexpected', 'transport'])(
    '%s is unconfirmed and a matching GET never releases it',
    async (outcome) => {
        const f = fixture();
        await f.store.sync();
        f.fetch.mockImplementation(async (_url, init = {}) => {
            if (init.method !== 'POST')
                return Response.json({
                    ...EMPTY_MOBILE,
                    ui_font_size: 21,
                    revision: 1,
                });
            if (outcome === 'transport') throw new TypeError('offline');
            if (outcome === 'malformed') return new Response('{');
            if (outcome === 'unexpected')
                return Response.json({
                    ...EMPTY_MOBILE,
                    ui_font_size: 21,
                    revision: 2,
                });
            return new Response('failure', { status: 500 });
        });
        f.store.edit({ ui_font_size: 21 });
        await settleEdit();
        const id = f.store.attempt.id;
        await f.store.refresh();
        await f.store.flush();
        expect(f.store.attempt.id).toBe(id);
        expect(f.store.pending).toBe(true);
        expect(posts(f.fetch)).toHaveLength(1);
    },
);

it.each([400, 401, 403, 404, 405, 413, 415])(
    'fence %i does not resolve the original save, including a late original acknowledgment',
    async (status) => {
        const f = fixture();
        await f.store.sync();
        let release;
        f.fetch.mockImplementation((url, init = {}) => {
            if (url.endsWith('/fence'))
                return Promise.resolve(new Response('rejected', { status }));
            if (init.method === 'POST')
                return new Promise((resolve) => {
                    release = resolve;
                });
            return Promise.resolve(Response.json(f.server));
        });
        f.store.edit({ ui_font_size: 21 });
        await settleEdit();
        const id = f.store.attempt.id;
        await f.store.resolve();
        expect(f.store.attempt.id).toBe(id);
        expect(f.store.attempt.fences[0].status).toBe('rejected');
        expect(f.store.status).toBe(
            'Resolve failed; save outcome still unknown',
        );
        f.store.edit({ ui_font_size: 22 });
        await settleEdit();
        release(
            Response.json({ ...EMPTY_MOBILE, ui_font_size: 21, revision: 1 }),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(f.store.attempt.id).toBe(id);
        expect(posts(f.fetch)).toHaveLength(2);
        f.fetch.mockResolvedValue(
            Response.json({ ...EMPTY_MOBILE, ui_font_size: 21, revision: 2 }),
        );
        await f.store.resolve();
        expect(f.store.attempt).toBeNull();
        expect(f.store.pending).toBe(true);
        expect(f.store.draft.explicit).toBe(true);
    },
);

it('serializes simultaneous resolution clicks and retains a lost fence for Resolve again', async () => {
    const f = fixture();
    await f.store.sync();
    f.fetch.mockRejectedValue(new TypeError('lost reply'));
    f.store.edit({ ui_font_size: 21 });
    await settleEdit();
    const other = fixture(f.db);
    await other.store.sync();
    other.fetch.mockRejectedValue(new TypeError('lost fence'));
    await Promise.all([f.store.resolve(), other.store.resolve()]);
    expect(posts(other.fetch)).toHaveLength(1);
    expect(f.db.owners.get(f.store.owner).attempt.fences).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_001);
    other.fetch.mockResolvedValue(
        Response.json({ ...EMPTY_MOBILE, revision: 2 }),
    );
    await other.store.resolve();
    expect(other.store.attempt).toBeNull();
});

it('keeps memory-only edits and prevents dispatch when storage fails', async () => {
    const f = fixture();
    await f.store.sync();
    f.db.fail = true;
    f.store.edit({ ui_font_size: 23 });
    await settleEdit();
    expect(f.store.values.ui_font_size).toBe(23);
    expect(f.store.storageWarning).toMatch(/memory.*reload/);
    expect(posts(f.fetch)).toHaveLength(0);
});

it('isolates owners with reused IDs and keeps removed-owner drafts read-only', async () => {
    const first = fixture();
    await first.store.sync();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    first.store.edit({ ui_font_size: 23 });
    await settleEdit();
    first.scope.abort();
    const second = fixture(first.db, 'a', 'http://b.test');
    await second.store.sync();
    expect(first.store.owner).not.toBe(second.store.owner);
    expect(second.store.records.drafts).toHaveLength(1);
    await second.store.restore(first.store.draft.id);
    expect(second.store.pending).toBe(false);
    await second.store.discard(first.store.draft.id);
    expect(first.db.drafts.size).toBe(1);
});

it('ignores reordered GET data but detects a server reset relative to probe start', async () => {
    const f = fixture();
    await f.store.sync();
    let release;
    f.fetch.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                release = resolve;
            }),
    );
    const read = f.store.refresh();
    f.store.confirmed = { ...EMPTY_MOBILE, revision: 2 };
    release(Response.json({ ...EMPTY_MOBILE, revision: 1 }));
    await read;
    expect(f.store.confirmed.revision).toBe(2);
    expect(f.store.resetDetected).toBe(false);
    f.fetch.mockResolvedValue(Response.json(EMPTY_MOBILE));
    await f.store.refresh();
    expect(f.store.resetDetected).toBe(true);
});

it('backs off failed reads at 5, 10, 20 and 30 seconds, then resets on success', async () => {
    const f = fixture();
    await f.store.sync();
    f.fetch.mockRejectedValue(new TypeError('offline'));
    await f.store.refresh();
    let calls = 1;
    for (const delay of [5000, 10000, 20000, 30000]) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(f.fetch).toHaveBeenCalledTimes(calls);
        await vi.advanceTimersByTimeAsync(1);
        expect(f.fetch).toHaveBeenCalledTimes(++calls);
    }
    f.fetch.mockResolvedValue(Response.json(EMPTY_MOBILE));
    await f.store.refresh();
    calls++;
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.fetch).toHaveBeenCalledTimes(calls + 1);
});

describe('server-owned mobile font inheritance', () => {
    it('caches only checked server families and keeps overrides/drafts through failed reads', async () => {
        const f = fixture();
        await f.store.sync();
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        f.store.edit({ terminal_font_family: '', ui_font_size: 23 });
        await settleEdit();
        await f.store.refresh();
        expect(f.store.inheritance).toEqual({
            ui_font_family: 'serif',
            terminal_font_family: 'monospace',
        });
        expect(readInheritanceCache(f.scope)).toEqual(f.store.inheritance);
        expect(f.inheritanceFetch.mock.calls[0][1]).toMatchObject({
            cache: 'no-store',
            headers: { 'X-Phi-Backend': 'a' },
        });
        expect(
            effectiveAppearance(
                'mobile',
                { ui_font_family: 'stale local' },
                f.store.values,
                f.store.inheritance,
            ),
        ).toMatchObject({
            ui_font_family: 'serif',
            terminal_font_family: '',
            ui_font_size: 23,
        });
        f.inheritanceFetch.mockRejectedValue(new TypeError('offline'));
        await f.store.refreshInheritance();
        expect(f.store.inheritance.ui_font_family).toBe('serif');
        expect(f.store.inheritanceWarning).toMatch(/last saved/);
        expect(f.store.draft.fields).toEqual({
            terminal_font_family: '',
            ui_font_size: 23,
        });
        expect(posts(f.fetch)).toHaveLength(0);
        f.store.ingestInheritance({
            ui_font_family: 'invalid missing terminal',
        });
        expect(f.store.inheritance.ui_font_family).toBe('serif');
    });
    it('ignores a late inheritance read after newer authorized config ingestion or owner disposal', async () => {
        const f = fixture();
        let finish;
        f.inheritanceFetch.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const first = f.store.refreshInheritance();
        expect(f.store.refreshInheritance()).toBe(first);
        f.store.ingestInheritance({
            ui_font_family: 'newer',
            terminal_font_family: 'monospace',
        });
        finish(
            Response.json({
                ui_font_family: 'older',
                terminal_font_family: 'monospace',
            }),
        );
        await first;
        expect(f.store.inheritance.ui_font_family).toBe('newer');
        f.store.dispose();
        f.store.ingestInheritance({
            ui_font_family: 'wrong owner',
            terminal_font_family: '',
        });
        expect(f.store.inheritance.ui_font_family).toBe('newer');
    });
    it('keeps an atomic offline reset explicit when the original save outcome is unknown', async () => {
        const f = fixture();
        await f.store.sync();
        f.fetch.mockRejectedValueOnce(new TypeError('lost reply'));
        f.store.edit({ ui_font_size: 21 });
        await settleEdit();
        const attempt = clone(f.store.attempt);
        const reset = {
            ui_font_size: null,
            terminal_font_size: null,
            ui_font_family: null,
            terminal_font_family: null,
        };
        f.store.edit(reset);
        await settleEdit();
        expect(f.store.values).toMatchObject(reset);
        expect(f.store.attempt).toEqual(attempt);
        expect(posts(f.fetch)).toHaveLength(1);
        await f.store.resolve();
        expect(f.store.pending).toBe(true);
        expect(f.store.draft.explicit).toBe(true);
        await f.store.saveMyChanges();
        expect(f.server).toMatchObject(reset);
        expect(f.store.pending).toBe(false);
    });
});

describe('bounded owner requests', () => {
    it.each(['headers', 'body'])(
        'times out a never-resolving %s operation at 15 seconds',
        async (phase) => {
            const scope = new BackendScope('a', 'http://a.test');
            const hang = new Promise(() => {});
            vi.stubGlobal(
                'fetch',
                vi.fn(() =>
                    phase === 'headers'
                        ? hang
                        : Promise.resolve({ arrayBuffer: () => hang }),
                ),
            );
            const request = ownerFetch(scope, '/api/config');
            const assertion = expect(request).rejects.toMatchObject({
                name: 'AbortError',
            });
            await vi.advanceTimersByTimeAsync(15_000);
            await assertion;
            expect(vi.getTimerCount()).toBe(0);
        },
    );
    it.each(['scope', 'caller'])(
        'preserves %s abort and suppresses late body completion',
        async (who) => {
            const scope = new BackendScope('a', 'http://a.test'),
                caller = new AbortController();
            let finish;
            vi.stubGlobal(
                'fetch',
                vi.fn(async () => ({
                    arrayBuffer: () =>
                        new Promise((resolve) => {
                            finish = resolve;
                        }),
                })),
            );
            const request = ownerFetch(scope, '/api/config', {
                signal: caller.signal,
            });
            const assertion = expect(request).rejects.toMatchObject({
                name: 'AbortError',
            });
            await Promise.resolve();
            if (who === 'scope') scope.abort();
            else caller.abort();
            await assertion;
            finish(new ArrayBuffer(0));
            await Promise.resolve();
            expect(vi.getTimerCount()).toBe(0);
        },
    );
    it('sends the captured backend header without replacing the caller abort signal', async () => {
        const f = fixture();
        await ownerFetch(f.scope, '/api/config', {
            signal: new AbortController().signal,
        });
        expect(
            f.inheritanceFetch.mock.calls[0][1].headers['X-Phi-Backend'],
        ).toBe('a');
        expect(appearanceOwner(f.scope)).toContain('http://a.test');
    });
});
