import type { BackendScope } from './backend-scope.js';

export const MAX_BACKEND_STORES = 8;
export const SNAPSHOT_SCROLLBACK_ROWS = 256;

export interface ScreenSnapshot {
    ansi: string;
    cols: number;
    rows: number;
}

export interface TabMeta {
    id: string;
    paneId?: string;
    session_id: string;
    title: string;
    coder: string;
    workspace: string;
    cwd: string;
    pinned: boolean;
    marked: boolean;
    opencode_mode?: string | null;
    pi_bridge?: any;
}

export interface LoadMeta {
    stale: boolean;
}

export class BackendStore {
    readonly profileId: string;
    responses: Map<string, string> = new Map();
    screens: Map<string, ScreenSnapshot> = new Map();
    tabs: TabMeta[] | null = null;
    activeCwd: string | null = null;
    registry?: BackendStoreRegistry;

    constructor(profileId: string, registry?: BackendStoreRegistry) {
        this.profileId = profileId;
        this.registry = registry;
    }

    clear(): void {
        this.responses.clear();
        this.screens.clear();
        this.tabs = null;
        this.activeCwd = null;
    }

    async load<T = any>(
        url: string,
        scope: BackendScope | null | undefined,
        render: (data: T, meta: LoadMeta) => void | Promise<void>,
    ): Promise<T | undefined> {
        const hit = this.responses.get(url);
        if (hit !== undefined) {
            try {
                const cachedData = JSON.parse(hit) as T;
                await render(cachedData, { stale: true });
            } catch {
                this.responses.delete(url);
            }
        }

        if (scope?.aborted) {
            return undefined;
        }

        let text: string;
        try {
            if (scope && typeof (scope as any).fetchText === 'function') {
                text = await (scope as any).fetchText(url);
            } else {
                const fetchFn =
                    typeof fetch !== 'undefined'
                        ? fetch
                        : (globalThis as any).fetch;
                const res = await fetchFn(url);
                if (!res.ok) {
                    const err: any = new Error(`HTTP ${res.status}`);
                    err.status = res.status;
                    throw err;
                }
                text = await res.text();
            }
        } catch (err: any) {
            if (err?.status === 401) {
                this.clear();
                this.registry?.delete(this.profileId);
                throw err;
            }
            if (scope?.aborted || err?.name === 'AbortError') {
                return undefined;
            }
            throw err;
        }

        if (scope?.aborted) {
            return undefined;
        }

        const fresh = JSON.parse(text) as T;
        this.responses.set(url, text);

        if (text !== hit) {
            await render(fresh, { stale: false });
        }

        return fresh;
    }
}

export class BackendStoreRegistry {
    private readonly maxEntries: number;
    private readonly stores = new Map<string, BackendStore>();

    constructor(maxEntries = MAX_BACKEND_STORES) {
        this.maxEntries = maxEntries;
    }

    private normalize(profileId: string): string {
        return profileId || '__default__';
    }

    get(profileId: string): BackendStore {
        const key = this.normalize(profileId);
        const existing = this.stores.get(key);
        if (existing) {
            this.stores.delete(key);
            this.stores.set(key, existing);
            return existing;
        }

        const store = new BackendStore(key, this);
        this.stores.set(key, store);

        while (this.stores.size > this.maxEntries) {
            const oldestKey = this.stores.keys().next().value;
            if (oldestKey !== undefined) {
                const oldest = this.stores.get(oldestKey);
                oldest?.clear();
                this.stores.delete(oldestKey);
            } else {
                break;
            }
        }

        return store;
    }

    peek(profileId: string): BackendStore | undefined {
        const key = this.normalize(profileId);
        const store = this.stores.get(key);
        if (store) {
            this.stores.delete(key);
            this.stores.set(key, store);
            return store;
        }
        return undefined;
    }

    has(profileId: string): boolean {
        return this.stores.has(this.normalize(profileId));
    }

    delete(profileId: string): boolean {
        const key = this.normalize(profileId);
        const store = this.stores.get(key);
        if (store) {
            store.clear();
            return this.stores.delete(key);
        }
        return false;
    }

    clear(): void {
        for (const store of this.stores.values()) {
            store.clear();
        }
        this.stores.clear();
    }

    get size(): number {
        return this.stores.size;
    }
}

export const backendStores = new BackendStoreRegistry();
