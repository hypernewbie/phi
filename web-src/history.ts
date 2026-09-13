/* Φ phi — Terminal recording archive (see temp/TERMPERF.md) */

// Caching layer for bounded terminal recordings. The live terminal
// never touches this module — recordings live in IndexedDB, are fetched
// on demand by the archive UI / gap repainter, and are evicted under a
// modest per-origin byte budget. The module degrades gracefully when
// indexedDB is unavailable (server fetch only, no caching).

export interface RecordingChunk {
    paneId: string;
    epoch: number;
    start: number;
    end: number;
    bytes: Uint8Array; // length may exceed network chunk cap — see store layout below
    touched: number;
}

export interface HistoryFetchResult {
    start: number;
    end: number;
    bytes: Uint8Array;
    cachedStart?: number; // first contiguous cached byte (may be > requested from)
    cachedEnd?: number; // one past the last cached byte (clamp for missing tail)
    missing: boolean;
}

export interface HistoryStoreOptions {
    idbFactory?: IDBFactory | null;
    fetchImpl?: typeof fetch;
    origin?: string;
    chunkBytes?: number; // store fetch granularity; default 256KiB
    cacheBudgetBytes?: number; // per-origin eviction budget; default 32 MiB
}

const DB_NAME = 'phi-history';
const DB_VERSION = 2;
const STORE = 'chunks';
const MARKER_STORE = 'markers';
const DEFAULT_CHUNK = 256 * 1024;
const DEFAULT_BUDGET = 32 * 1024 * 1024;

function originOf(opts: HistoryStoreOptions): string {
    if (opts.origin) return opts.origin;
    if (typeof location !== 'undefined') return location.origin || 'null';
    return 'null';
}

function keyOf(
    origin: string,
    paneId: string,
    epoch: number,
    start: number,
): string {
    return `${origin}|${paneId}|${epoch}|${start}`;
}

function prefixOf(origin: string, paneId: string, epoch: number): string {
    return `${origin}|${paneId}|${epoch}|`;
}

// Opens (and lazily upgrades) the cache DB. Returns null when the host
// has no IndexedDB (so the caller falls back to fetch-only).
function openDB(
    idbFactory: IDBFactory | null | undefined,
): Promise<IDBDatabase | null> {
    if (!idbFactory) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
        const req = idbFactory.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: 'key' });
            }
            if (!db.objectStoreNames.contains(MARKER_STORE)) {
                db.createObjectStore(MARKER_STORE, { keyPath: 'key' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

// IndexedDB cursor helpers (they have to be Promise-wrapped by hand).
function pDone<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function pTransaction(
    db: IDBDatabase,
    mode: IDBTransactionMode,
): IDBObjectStore {
    return db.transaction(STORE, mode).objectStore(STORE);
}

function pMarkerTransaction(
    db: IDBDatabase,
    mode: IDBTransactionMode,
): IDBObjectStore {
    return db.transaction(MARKER_STORE, mode).objectStore(MARKER_STORE);
}

function markerKeyOf(origin: string, paneId: string, epoch: number): string {
    return `${origin}|${paneId}|${epoch}|markers`;
}

export interface ResizeMarker {
    AtSeq: number;
    Cols: number;
    Rows: number;
}

export interface MarkerSet {
    paneId: string;
    epoch: number;
    markers: ResizeMarker[];
}

// pGetAll wraps a getAll() request (IDB records in keyPath order).
function pGetAll(store: IDBObjectStore): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

export class HistoryStore {
    readonly origin: string;
    private readonly idbFactory: IDBFactory | null;
    private readonly fetchImpl: typeof fetch;
    private readonly chunkBytes: number;
    private readonly cacheBudget: number;
    private dbPromise: Promise<IDBDatabase | null> | null = null;

    constructor(opts: HistoryStoreOptions = {}) {
        this.origin = originOf(opts);
        this.idbFactory =
            opts.idbFactory ??
            (typeof indexedDB !== 'undefined' ? indexedDB : null);
        this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
        this.chunkBytes = opts.chunkBytes ?? DEFAULT_CHUNK;
        this.cacheBudget = opts.cacheBudgetBytes ?? DEFAULT_BUDGET;
    }

    private getDB(): Promise<IDBDatabase | null> {
        if (!this.dbPromise) this.dbPromise = openDB(this.idbFactory);
        return this.dbPromise;
    }

    // Returns every cached chunk for a pane/epoch (across all starts),
    // sorted by start. getAll walks the keyPath-ordered store; we filter
    // client-side by key prefix since the key already encodes
    // origin|paneId|epoch|start.
    private async chunksFor(
        paneId: string,
        epoch: number,
    ): Promise<RecordingChunk[]> {
        const db = await this.getDB();
        if (!db) return [];
        const prefix = prefixOf(this.origin, paneId, epoch);
        const store = pTransaction(db, 'readonly');
        const all = (await pGetAll(store)) as Array<
            RecordingChunk & { key?: string }
        >;
        return all
            .filter((r) => !!r.key && r.key.startsWith(prefix))
            .map((r) => ({
                paneId: r.paneId,
                epoch: r.epoch,
                start: r.start,
                end: r.end,
                bytes: r.bytes,
                touched: r.touched || 0,
            }))
            .sort((a, b) => a.start - b.start);
    }

    private async putChunk(chunk: RecordingChunk): Promise<void> {
        const db = await this.getDB();
        if (!db) return;
        const key = keyOf(this.origin, chunk.paneId, chunk.epoch, chunk.start);
        const rec = { key, ...chunk, touched: Date.now() };
        const store = pTransaction(db, 'readwrite');
        await pDone(store.put(rec));
    }

    private async touchMany(chunkKeys: string[]): Promise<void> {
        if (!chunkKeys.length) return;
        const db = await this.getDB();
        if (!db) return;
        const store = pTransaction(db, 'readwrite');
        for (const key of chunkKeys) {
            const cur = await pDone(store.get(key));
            if (!cur) continue;
            cur.touched = Date.now();
            await pDone(store.put(cur));
        }
    }

    // Exposed for tests; production callers await enforceBudget via fetchRange.
    async pruneCache(): Promise<void> {
        await this.enforceBudget();
    }

    // Trims oldest-touched chunks until total cache bytes fit the budget.
    private async enforceBudget(): Promise<void> {
        const db = await this.getDB();
        if (!db) return;
        const store = pTransaction(db, 'readwrite');
        const all = (await pGetAll(store)) as Array<
            RecordingChunk & { key: string }
        >;
        let total = 0;
        for (const r of all) total += r.bytes?.byteLength ?? 0;
        if (total <= this.cacheBudget) return;
        all.sort((a, b) => (a.touched || 0) - (b.touched || 0));
        for (const victim of all) {
            if (total <= this.cacheBudget) break;
            await pDone(store.delete(victim.key));
            total -= victim.bytes.byteLength;
        }
    }

    // Fetches a recording range [from, through) for the given pane/epoch,
    // serving from the cache when contiguous and fetching only the
    // missing gaps from the server. Cache resumption after a fetch is
    // explicit (we re-plan from the new cursor), so cached spans
    // beyond an earlier gap are not lost.
    async fetchRange(
        paneId: string,
        epoch: number,
        from: number,
        through: number,
    ): Promise<HistoryFetchResult | null> {
        if (from < 0 || through <= from) return null;
        const cached = await this.chunksFor(paneId, epoch);
        const sorted = cached.sort((a, b) => a.start - b.start);

        // Plan the request as a sequence of contiguous runs whose union
        // covers [from, through) without overlap. Each run is either
        // fully covered by the cache (cached:true) or is a gap we fetch
        // (cached:false). Subsequent gaps pick up where the previous
        // server response left off, so we resume from cache correctly.
        const runs: Array<{
            start: number;
            end: number;
            cached: boolean;
        }> = [];
        let cursor = from;
        let ci = 0;
        while (cursor < through) {
            while (ci < sorted.length && sorted[ci].end <= cursor) ci++;
            const next = ci < sorted.length ? sorted[ci] : undefined;
            // Cached run requires the chunk to own cursor (next.start <=
            // cursor). When next.start > cursor we are in a gap.
            if (next && next.start <= cursor && next.end > cursor) {
                const runEnd = Math.min(next.end, through);
                if (runEnd > cursor) {
                    runs.push({
                        start: cursor,
                        end: runEnd,
                        cached: true,
                    });
                }
                cursor = runEnd;
            } else {
                const gapEnd = next ? Math.min(next.start, through) : through;
                if (gapEnd <= cursor) break;
                runs.push({
                    start: cursor,
                    end: gapEnd,
                    cached: false,
                });
                cursor = gapEnd;
            }
        }

        const assembled: Uint8Array[] = [];
        let actualStart = from;
        let actualEnd = from;
        let missing = false;
        const touchedKeys: string[] = [];
        for (const run of runs) {
            if (run.cached) {
                for (const c of sorted) {
                    if (c.end <= run.start) continue;
                    if (c.start >= run.end) break;
                    const cs = Math.max(c.start, run.start);
                    const ce = Math.min(c.end, run.end);
                    const off = cs - c.start;
                    assembled.push(c.bytes.subarray(off, off + (ce - cs)));
                    touchedKeys.push(
                        keyOf(this.origin, c.paneId, c.epoch, c.start),
                    );
                }
                actualEnd = Math.max(actualEnd, run.end);
                continue;
            }
            const fetched = await this.fetchFromServer(
                paneId,
                epoch,
                run.start,
                run.end,
            );
            if (!fetched) {
                missing = true;
                continue;
            }
            if (fetched.start > run.start) {
                missing = true;
                if (actualStart === from) actualStart = fetched.start;
            }
            const end = Math.min(fetched.end, run.end);
            let pos = fetched.start;
            let remaining = fetched.bytes;
            while (pos < end && remaining.byteLength > 0) {
                const segEnd = Math.min(pos + this.chunkBytes, end);
                const segLen = Math.min(segEnd - pos, remaining.byteLength);
                if (segLen <= 0) break;
                const seg = remaining.subarray(0, segLen);
                await this.putChunk({
                    paneId,
                    epoch,
                    start: pos,
                    end: pos + segLen,
                    bytes: seg,
                    touched: 0,
                });
                assembled.push(seg);
                pos += segLen;
                remaining = remaining.subarray(segLen);
            }
            // The server's `end` is the authoritative farthest contiguous
            // byte it can serve — not the byte count we actually stored.
            if (end > actualEnd) actualEnd = end;
            // Persist resize markers from the server response so the
            // archive worker (commit 6) can re-apply them while walking
            // cached history off the main thread.
            if (fetched.markers.length > 0) {
                await this.putMarkers(paneId, epoch, fetched.markers);
            }
        }
        await this.touchMany(touchedKeys);
        await this.enforceBudget();
        return {
            start: from,
            end: actualEnd,
            bytes: concatBytes(assembled),
            cachedStart: missing ? actualStart : from,
            cachedEnd: actualEnd,
            missing,
        };
    }

    private async fetchFromServer(
        paneId: string,
        epoch: number,
        from: number,
        through: number,
    ): Promise<{
        start: number;
        end: number;
        epoch: number;
        markers: ResizeMarker[];
        bytes: Uint8Array;
    } | null> {
        try {
            const res = await this.fetchImpl(
                `/api/terminals/${encodeURIComponent(paneId)}/recording?from=${from}&through=${through}&epoch=${epoch}`,
                { cache: 'no-store' },
            );
            if (!res.ok) return null;
            const buf = new Uint8Array(await res.arrayBuffer());
            if (buf.byteLength < 4) return null;
            const view = new DataView(buf.buffer);
            const jsonLen = view.getUint32(0, false);
            if (4 + jsonLen > buf.byteLength) return null;
            let hdr: {
                start: number;
                end: number;
                epoch?: number;
                resizes?: Array<[number, number, number]>;
            };
            try {
                hdr = JSON.parse(
                    new TextDecoder().decode(buf.subarray(4, 4 + jsonLen)),
                );
            } catch (_e) {
                return null;
            }
            // Cross-epoch response is poison; drop it.
            if (typeof hdr.epoch === 'number' && hdr.epoch !== epoch)
                return null;
            const markers: ResizeMarker[] = [];
            for (const r of hdr.resizes || []) {
                if (Array.isArray(r) && r.length === 3) {
                    markers.push({
                        AtSeq: r[0],
                        Cols: r[1],
                        Rows: r[2],
                    });
                }
            }
            return {
                start: hdr.start,
                end: hdr.end,
                epoch: typeof hdr.epoch === 'number' ? hdr.epoch : epoch,
                markers,
                bytes: buf.subarray(4 + jsonLen),
            };
        } catch (_e) {
            return null;
        }
    }

    // Persists resize markers from a server response keyed by pane+epoch.
    // Marker sets are append-only by AtSeq; we dedupe and merge.
    private async putMarkers(
        paneId: string,
        epoch: number,
        incoming: ResizeMarker[],
    ): Promise<void> {
        if (incoming.length === 0) return;
        const db = await this.getDB();
        if (!db) return;
        const store = pMarkerTransaction(db, 'readwrite');
        const key = markerKeyOf(this.origin, paneId, epoch);
        const existing = (await pDone(store.get(key))) as
            | { markers: ResizeMarker[] }
            | undefined;
        const seen = new Set<number>();
        const merged: ResizeMarker[] = [];
        for (const src of [...(existing?.markers || []), ...incoming]) {
            if (seen.has(src.AtSeq)) continue;
            seen.add(src.AtSeq);
            merged.push(src);
        }
        merged.sort((a, b) => a.AtSeq - b.AtSeq);
        await pDone(store.put({ key, paneId, epoch, markers: merged }));
    }

    // Returns the cached marker set for a pane+epoch, useful to the
    // archive worker when it walks archive history.
    async getMarkers(paneId: string, epoch: number): Promise<ResizeMarker[]> {
        const db = await this.getDB();
        if (!db) return [];
        const store = pMarkerTransaction(db, 'readonly');
        const rec = (await pDone(
            store.get(markerKeyOf(this.origin, paneId, epoch)),
        )) as { markers?: ResizeMarker[] } | undefined;
        return rec?.markers || [];
    }

    // Drops every cached chunk for a pane (epoch change, tab removal).
    async dropPane(paneId: string, epoch?: number): Promise<void> {
        const db = await this.getDB();
        if (!db) return;
        const store = pTransaction(db, 'readwrite');
        const prefix =
            epoch === undefined
                ? `${this.origin}|${paneId}|`
                : prefixOf(this.origin, paneId, epoch);
        const toDelete: string[] = [];
        const all = (await pGetAll(store)) as Array<{ key: string }>;
        for (const r of all) {
            if (r.key && r.key.startsWith(prefix)) toDelete.push(r.key);
        }
        for (const k of toDelete) await pDone(store.delete(k));
    }
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const p of parts) total += p.byteLength;
    if (total === 0) return new Uint8Array(0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.byteLength;
    }
    return out;
}
