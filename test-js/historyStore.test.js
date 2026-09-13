// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HistoryStore } from '../web/history.js';

// Hot-v1 protocol invariants: the recording archive cache is a strict
// offline of the server, never drops cached history silently when storage
// gets tight, and the per-origin budget is enforced by
// least-recently-touched eviction. Tests use a minimal in-memory
// IndexedDB stub so jsdom (which has no indexedDB) can drive the same
// code paths production uses.

class FakeReq {
    constructor(result = undefined) {
        this.result = result;
    }
    ok() {
        queueMicrotask(() => this.onsuccess?.({}));
    }
}
FakeReq.prototype.onsuccess = null;

class FakeCursor {
    constructor(value, store) {
        this.value = value;
        this._store = store;
    }
    continue() {
        this.value = this._store.cursorNextAfter(
            this.value ? this.value.key : undefined,
        );
    }
}

class FakeStore {
    constructor(name, keyPath) {
        this.name = name;
        this.keyPath = keyPath;
        this.data = new Map();
    }
    put(value) {
        const v = value;
        this.data.set(v.key, v);
        const r = new FakeReq(v.key);
        r.ok();
        return r;
    }
    get(key) {
        const r = new FakeReq(this.data.get(key));
        r.ok();
        return r;
    }
    delete(key) {
        const had = this.data.delete(key);
        const r = new FakeReq(had ? key : undefined);
        r.ok();
        return r;
    }
    getAll() {
        const r = new FakeReq([...this.data.values()]);
        r.ok();
        return r;
    }
    openCursor() {
        const cur = this.cursorNextAfter(undefined);
        const r = new FakeReq(cur);
        r.ok();
        return r;
    }
    cursorNextAfter(afterKey) {
        const keys = [...this.data.keys()].sort();
        const next = afterKey ? keys.find((k) => k > afterKey) : keys[0];
        if (!next) return null;
        return new FakeCursor(this.data.get(next), this);
    }
}

class FakeDB {
    constructor() {
        this.version = 1;
        this._stores = {};
        this._stores.chunks = new FakeStore('chunks', 'key');
        this._stores.markers = new FakeStore('markers', 'key');
    }
    objectStoreNames() {
        return Object.keys(this._stores);
    }
    createObjectStore(name, opts) {
        this._stores[name] = new FakeStore(name, opts.keyPath);
        return this._stores[name];
    }
    transaction(name) {
        const tx = { _stores: this._stores };
        tx.objectStore = (n) => {
            const s = this._stores[n];
            if (!s) throw new Error(`no store ${n}`);
            return s;
        };
        return tx;
    }
    onupgradeneeded() {}
}

function buildFactoryAndDB() {
    const db = new FakeDB();
    // Capture the onupgradeneeded target by wrapping open: HistoryStore's
    // openDB calls request.onupgradeneeded = () => db.createObjectStore,
    // which runs against the FakeDB. We replicate the WebIDB order:
    // upgrade (if any) runs, then onsuccess fires with `result = db`.
    function makeReq(result) {
        const r = { result, _ok: false };
        Object.defineProperty(r, 'onsuccess', {
            get() {
                return this._onsuccess;
            },
            set(fn) {
                this._onsuccess = fn;
                queueMicrotask(() => {
                    // No real upgrade needed (objectStore already exists in ctor).
                    fn?.({});
                });
            },
        });
        return r;
    }
    const factory = {
        open: (_name, _ver) => makeReq(db),
    };
    return { factory, db, stores: db._stores };
}

function buildStore(budgetBytes = 1024 * 1024) {
    const { factory, stores } = buildFactoryAndDB();
    const fetchImpl = vi.fn();
    const store = new HistoryStore({
        idbFactory: factory,
        fetchImpl,
        origin: 'O',
        cacheBudgetBytes: budgetBytes,
    });
    return { store, fetchImpl, stores };
}

function recordingResponse(text, start, end) {
    return recordingResponseWithResizes(text, 1, start, end, []);
}

function recordingResponseWithResizes(text, epoch, start, end, resizes) {
    const bytes = new TextEncoder().encode(text);
    const json = new TextEncoder().encode(
        JSON.stringify({ epoch, start, end, resizes }),
    );
    const buf = new Uint8Array(4 + json.byteLength + bytes.byteLength);
    new DataView(buf.buffer).setUint32(0, json.byteLength, false);
    buf.set(json, 4);
    buf.set(bytes, 4 + json.byteLength);
    return {
        ok: true,
        arrayBuffer: async () => buf.buffer.slice(0),
    };
}

function recordingResponseForEpoch(text, epoch, start, end) {
    const bytes = new TextEncoder().encode(text);
    const json = new TextEncoder().encode(
        JSON.stringify({ epoch, start, end, resizes: [] }),
    );
    const buf = new Uint8Array(4 + json.byteLength + bytes.byteLength);
    new DataView(buf.buffer).setUint32(0, json.byteLength, false);
    buf.set(json, 4);
    buf.set(bytes, 4 + json.byteLength);
    return {
        ok: true,
        arrayBuffer: async () => buf.buffer.slice(0),
    };
}

beforeEach(() => {
    vi.stubGlobal('indexedDB', undefined);
});

describe('HistoryStore', () => {
    it('fetchRange pulls gaps from the server and serves contiguous cache', async () => {
        const { store, fetchImpl, stores } = buildStore();
        stores.chunks.put({
            key: 'O|p|1|0',
            paneId: 'p',
            epoch: 1,
            start: 0,
            end: 50,
            bytes: new Uint8Array(50).fill(0x41),
            touched: 0,
        });
        fetchImpl.mockImplementation(() =>
            Promise.resolve(recordingResponse('BBBBBBBBBB', 50, 60)),
        );

        const r = await store.fetchRange('p', 1, 0, 60);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(r.start).toBe(0);
        expect(r.end).toBe(60);
        expect(r.bytes.byteLength).toBe(60);
        expect(r.bytes[0]).toBe(0x41);
        expect(r.bytes[49]).toBe(0x41);
        expect(String.fromCharCode(r.bytes[50])).toBe('B');
    });

    it('fetchRange reports ring truncation honestly (missing flag)', async () => {
        const { store, fetchImpl } = buildStore();
        fetchImpl.mockImplementation(() =>
            Promise.resolve(recordingResponse('xxxxx', 70, 75)),
        );
        const r = await store.fetchRange('p', 1, 0, 100);
        expect(r.end).toBe(75);
        expect(r.missing).toBe(true);
    });

    it('budget eviction drops least-recently-touched first', async () => {
        const { store, stores } = buildStore(100);
        stores.chunks.put({
            key: 'O|p|1|0',
            paneId: 'p',
            epoch: 1,
            start: 0,
            end: 40,
            bytes: new Uint8Array(40),
            touched: 1,
        });
        stores.chunks.put({
            key: 'O|p|1|40',
            paneId: 'p',
            epoch: 1,
            start: 40,
            end: 80,
            bytes: new Uint8Array(40),
            touched: 10,
        });
        stores.chunks.put({
            key: 'O|p|1|80',
            paneId: 'p',
            epoch: 1,
            start: 80,
            end: 120,
            bytes: new Uint8Array(40),
            touched: 5,
        });
        await store.pruneCache();
        const keys = [...stores.chunks.data.keys()].sort();
        expect(keys).not.toContain('O|p|1|0');
        expect(keys).toContain('O|p|1|40');
        expect(keys).toContain('O|p|1|80');
    });

    it('dropPane removes every cached chunk for the pane', async () => {
        const { store, stores } = buildStore();
        stores.chunks.put({
            key: 'O|p|1|0',
            paneId: 'p',
            epoch: 1,
            start: 0,
            end: 10,
            bytes: new Uint8Array(10),
            touched: 0,
        });
        stores.chunks.put({
            key: 'O|p|1|10',
            paneId: 'p',
            epoch: 1,
            start: 10,
            end: 20,
            bytes: new Uint8Array(10),
            touched: 0,
        });
        await store.dropPane('p');
        expect([...stores.chunks.data.keys()]).toEqual([]);
    });

    it('works without indexedDB (no caching, server fetch only)', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValue(recordingResponse('PAYLOAD', 0, 7));
        const store = new HistoryStore({
            idbFactory: null,
            fetchImpl,
            origin: 'O',
        });
        const r = await store.fetchRange('p', 1, 0, 7);
        expect(r.bytes.byteLength).toBe(7);
    });

    it('cache resume after a gap: cached chunks beyond the gap are reused', async () => {
        const { store, fetchImpl, stores } = buildStore();
        stores.chunks.put({
            key: 'O|p|1|80',
            paneId: 'p',
            epoch: 1,
            start: 80,
            end: 120,
            bytes: new Uint8Array(40).fill(0x43),
            touched: 0,
        });
        stores.chunks.put({
            key: 'O|p|1|200',
            paneId: 'p',
            epoch: 1,
            start: 200,
            end: 240,
            bytes: new Uint8Array(40).fill(0x44),
            touched: 0,
        });
        fetchImpl.mockImplementation(() => {
            // Server returns exactly the bytes for [120, 200).
            const text = 'E'.repeat(80);
            return Promise.resolve(recordingResponse(text, 120, 200));
        });
        const r = await store.fetchRange('p', 1, 80, 240);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(r.bytes.byteLength).toBe(160);
        expect(r.bytes[0]).toBe(0x43);
        expect(r.bytes[39]).toBe(0x43);
        expect(r.bytes[40]).toBe(0x45);
        expect(r.bytes[119]).toBe(0x45);
        expect(r.bytes[120]).toBe(0x44);
        expect(r.bytes[159]).toBe(0x44);
    });

    it('server-clamped start: missing=true, cachedStart reflects the real span', async () => {
        const { store, fetchImpl } = buildStore();
        fetchImpl.mockImplementation(() =>
            Promise.resolve(recordingResponse('xxx', 70, 75)),
        );
        const r = await store.fetchRange('p', 1, 0, 100);
        expect(r.missing).toBe(true);
        // The bytes payload is whatever the server returned for the
        // clamped [70, 75) window — here "xxx" (3 chars), not 5. The
        // cached span marker is the structural truth; bytes is just
        // the payload it covers.
        expect(r.bytes.byteLength).toBe(3);
        expect(r.cachedStart).toBe(70);
        expect(r.cachedEnd).toBe(75);
    });

    it('mixed-epoch cache key keeps prior PTY lifetimes separate', async () => {
        const { store, fetchImpl, stores } = buildStore();
        stores.chunks.put({
            key: 'O|p|1|0',
            paneId: 'p',
            epoch: 1,
            start: 0,
            end: 30,
            bytes: new Uint8Array(30).fill(0x41),
            touched: 0,
        });
        stores.chunks.put({
            key: 'O|p|2|0',
            paneId: 'p',
            epoch: 2,
            start: 0,
            end: 30,
            bytes: new Uint8Array(30).fill(0x42),
            touched: 0,
        });
        const r = await store.fetchRange('p', 2, 0, 30);
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(r.bytes.byteLength).toBe(30);
        for (let i = 0; i < 30; i++) expect(r.bytes[i]).toBe(0x42);
    });

    it('persists resize markers from the server by (pane, epoch)', async () => {
        const { store, fetchImpl } = buildStore();
        fetchImpl.mockImplementation(() =>
            Promise.resolve(
                recordingResponseWithResizes('PAYLOAD', 7, 0, 8, [
                    [2, 80, 24],
                    [5, 100, 30],
                ]),
            ),
        );
        await store.fetchRange('p', 7, 0, 8);
        const markers = await store.getMarkers('p', 7);
        expect(markers).toEqual([
            { AtSeq: 2, Cols: 80, Rows: 24 },
            { AtSeq: 5, Cols: 100, Rows: 30 },
        ]);
    });

    it('merges and dedupes markers across multiple fetches', async () => {
        const { store, fetchImpl } = buildStore();
        fetchImpl.mockImplementationOnce(() =>
            Promise.resolve(
                recordingResponseWithResizes('AAAA', 9, 0, 4, [[2, 80, 24]]),
            ),
        );
        await store.fetchRange('p', 9, 0, 4);
        fetchImpl.mockImplementationOnce(() =>
            Promise.resolve(
                recordingResponseWithResizes('BBBB', 9, 4, 8, [
                    [2, 80, 24], // duplicate of prior
                    [5, 100, 30], // new
                ]),
            ),
        );
        await store.fetchRange('p', 9, 4, 8);
        const markers = await store.getMarkers('p', 9);
        expect(markers).toEqual([
            { AtSeq: 2, Cols: 80, Rows: 24 },
            { AtSeq: 5, Cols: 100, Rows: 30 },
        ]);
    });

    it('rejects a server response whose epoch does not match the request', async () => {
        const { store, fetchImpl } = buildStore();
        fetchImpl.mockImplementation(() =>
            Promise.resolve(recordingResponseForEpoch('PAYLOAD', 99, 0, 4)),
        );
        const r = await store.fetchRange('p', 7, 0, 4);
        // Cross-epoch response is dropped: nothing cached, bytes empty,
        // missing flag set so the caller can fall back.
        expect(r.missing).toBe(true);
        expect(r.bytes.byteLength).toBe(0);
    });
});
