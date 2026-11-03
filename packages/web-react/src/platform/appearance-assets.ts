// Custom font/background assets. IndexedDB (not localStorage) because
// file bytes can exceed localStorage's ~5MB synchronous string quota;
// Blobs store natively with no base64 inflation. Local-only: never
// sent to the server. Port of web/app.js _db/_putCustomFont/... with
// the same database, stores, and fixed keys so both surfaces share
// uploads made in either.
export function readCustomFontName(appearance: {
    custom_font_name?: unknown;
}): string {
    return typeof appearance.custom_font_name === 'string'
        ? appearance.custom_font_name
        : '';
}

export function hasCustomFont(appearance: {
    custom_font_name?: unknown;
}): boolean {
    return readCustomFontName(appearance).length > 0;
}

export function readCustomBackgroundName(appearance: {
    terminal_bg_name?: unknown;
}): string {
    return typeof appearance.terminal_bg_name === 'string'
        ? appearance.terminal_bg_name
        : '';
}

export const FONT_MAX_BYTES = 8 * 1024 * 1024;
export const BG_MAX_BYTES = 16 * 1024 * 1024;
export const CUSTOM_FONT_FAMILY = 'Phi Custom Font';
const FONT_STYLE_ID = 'phi-custom-fonts';

export interface AssetRecord {
    displayName: string;
    blob: Blob;
}

export interface AssetDatabase {
    put(
        store: 'fonts' | 'backgrounds',
        key: string,
        record: AssetRecord,
    ): Promise<void>;
    get(
        store: 'fonts' | 'backgrounds',
        key: string,
    ): Promise<AssetRecord | null>;
    remove(store: 'fonts' | 'backgrounds', key: string): Promise<void>;
}

let database: Promise<IDBDatabase> | null = null;

function openAssetDB(): Promise<IDBDatabase> {
    if (!database)
        database = new Promise((resolve, reject) => {
            const request = indexedDB.open('phi', 2);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains('fonts'))
                    db.createObjectStore('fonts');
                if (!db.objectStoreNames.contains('backgrounds'))
                    db.createObjectStore('backgrounds');
            };
            request.onsuccess = () => {
                request.result.onversionchange = () => {
                    request.result.close();
                    database = null;
                };
                resolve(request.result);
            };
            request.onblocked = () => {
                console.warn(
                    '[db] IndexedDB upgrade blocked by another open connection',
                );
            };
            request.onerror = () => {
                database = null;
                reject(request.error);
            };
        });
    return database;
}

function transact<T>(
    ready: () => Promise<IDBDatabase>,
    store: 'fonts' | 'backgrounds',
    mode: IDBTransactionMode,
    run: (objectStore: IDBObjectStore) => IDBRequest,
): Promise<T> {
    return ready().then(
        (database) =>
            new Promise<T>((resolve, reject) => {
                const tx = database.transaction(store, mode);
                const request = run(tx.objectStore(store));
                tx.oncomplete = () => resolve(request.result as T);
                tx.onerror = () => reject(tx.error);
            }),
    );
}

export function createIndexedDBAssetDatabase(): AssetDatabase {
    // Opened on first use: unit runtimes without IndexedDB can still
    // construct stores that never touch assets.
    let db: Promise<IDBDatabase> | null = null;
    const ready = (): Promise<IDBDatabase> => (db ??= openAssetDB());
    return {
        put: (store, key, record) =>
            transact<void>(ready, store, 'readwrite', (objectStore) =>
                objectStore.put(record, key),
            ),
        get: (store, key) =>
            transact<AssetRecord | null>(
                ready,
                store,
                'readonly',
                (objectStore) => objectStore.get(key),
            ).then((result) => result ?? null),
        remove: (store, key) =>
            transact<void>(ready, store, 'readwrite', (objectStore) =>
                objectStore.delete(key),
            ),
    };
}

export function memoryAssetDatabase(): AssetDatabase & {
    records: Map<string, AssetRecord>;
} {
    const records = new Map<string, AssetRecord>();
    return {
        records,
        put: (store, key, record) => {
            records.set(`${store}:${key}`, record);
            return Promise.resolve();
        },
        get: (store, key) =>
            Promise.resolve(records.get(`${store}:${key}`) ?? null),
        remove: (store, key) => {
            records.delete(`${store}:${key}`);
            return Promise.resolve();
        },
    };
}

// Size is checked before IndexedDB is even opened: an oversize file
// never causes a write (or an upgrade).
export async function putFont(
    db: AssetDatabase,
    name: string,
    blob: Blob,
): Promise<void> {
    if (blob.size > FONT_MAX_BYTES)
        throw new Error('Font too large (max 8MB)');
    await db.put('fonts', 'custom', { displayName: name, blob });
}

export async function putBackground(
    db: AssetDatabase,
    name: string,
    blob: Blob,
): Promise<void> {
    if (blob.size > BG_MAX_BYTES)
        throw new Error('Background image too large (max 16MB)');
    await db.put('backgrounds', 'custom_bg', { displayName: name, blob });
}

export async function getFont(
    db: AssetDatabase,
): Promise<AssetRecord | null> {
    return db.get('fonts', 'custom');
}

export async function getBackground(
    db: AssetDatabase,
): Promise<AssetRecord | null> {
    return db.get('backgrounds', 'custom_bg');
}

export async function clearFont(db: AssetDatabase): Promise<void> {
    try {
        await db.remove('fonts', 'custom');
    } finally {
        removeFontFace();
    }
}

export async function clearBackground(db: AssetDatabase): Promise<void> {
    await db.remove('backgrounds', 'custom_bg');
}

// Registers the uploaded font as the constant family 'Phi Custom
// Font' via an object URL (avoids base64 inflation). The previous
// URL is revoked; legacy leaks it.
let fontFaceUrl: string | null = null;

export function injectFontFace(blob: Blob): void {
    const url = URL.createObjectURL(blob);
    let style = document.getElementById(FONT_STYLE_ID);
    if (!style) {
        style = document.createElement('style');
        style.id = FONT_STYLE_ID;
        document.head.appendChild(style);
    }
    style.textContent = `@font-face{font-family:'${CUSTOM_FONT_FAMILY}';src:url(${url});font-display:swap;}`;
    if (fontFaceUrl !== null) URL.revokeObjectURL(fontFaceUrl);
    fontFaceUrl = url;
}

export function removeFontFace(): void {
    document.getElementById(FONT_STYLE_ID)?.remove();
    if (fontFaceUrl !== null) {
        URL.revokeObjectURL(fontFaceUrl);
        fontFaceUrl = null;
    }
}

export function fontFaceInstalled(): boolean {
    return document.getElementById(FONT_STYLE_ID) !== null;
}
