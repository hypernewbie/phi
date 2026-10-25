export const MAX_BACKEND_STORES = 8;
export const SNAPSHOT_SCROLLBACK_ROWS = 256;
export class BackendStore {
    profileId;
    responses = new Map();
    screens = new Map();
    tabs = null;
    activeCwd = null;
    registry;
    constructor(profileId, registry) {
        this.profileId = profileId;
        this.registry = registry;
    }
    clear() {
        this.responses.clear();
        this.screens.clear();
        this.tabs = null;
        this.activeCwd = null;
    }
    async load(url, scope, render) {
        const hit = this.responses.get(url);
        if (hit !== undefined) {
            try {
                const cachedData = JSON.parse(hit);
                await render(cachedData, { stale: true });
            }
            catch {
                this.responses.delete(url);
            }
        }
        if (scope?.aborted) {
            return undefined;
        }
        let text;
        try {
            if (scope && typeof scope.fetchText === 'function') {
                text = await scope.fetchText(url);
            }
            else {
                const fetchFn = typeof fetch !== 'undefined'
                    ? fetch
                    : globalThis.fetch;
                const res = await fetchFn(url);
                if (!res.ok) {
                    const err = new Error(`HTTP ${res.status}`);
                    err.status = res.status;
                    throw err;
                }
                text = await res.text();
            }
        }
        catch (err) {
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
        const fresh = JSON.parse(text);
        this.responses.set(url, text);
        if (text !== hit) {
            await render(fresh, { stale: false });
        }
        return fresh;
    }
}
export class BackendStoreRegistry {
    maxEntries;
    stores = new Map();
    constructor(maxEntries = MAX_BACKEND_STORES) {
        this.maxEntries = maxEntries;
    }
    normalize(profileId) {
        return profileId || '__default__';
    }
    get(profileId) {
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
            }
            else {
                break;
            }
        }
        return store;
    }
    peek(profileId) {
        const key = this.normalize(profileId);
        const store = this.stores.get(key);
        if (store) {
            this.stores.delete(key);
            this.stores.set(key, store);
            return store;
        }
        return undefined;
    }
    has(profileId) {
        return this.stores.has(this.normalize(profileId));
    }
    delete(profileId) {
        const key = this.normalize(profileId);
        const store = this.stores.get(key);
        if (store) {
            store.clear();
            return this.stores.delete(key);
        }
        return false;
    }
    clear() {
        for (const store of this.stores.values()) {
            store.clear();
        }
        this.stores.clear();
    }
    get size() {
        return this.stores.size;
    }
}
export const backendStores = new BackendStoreRegistry();
