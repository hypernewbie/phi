// @vitest-environment node
// The cache must survive a fleet of servers: the registry is LRU, so a
// limit below the number of servers a user flips between silently threw
// away every server's cache.
import { describe, expect, it } from 'vitest';
import {
    BackendStore,
    BackendStoreRegistry,
    MAX_BACKEND_STORES,
} from '../web/backend-store.js';

describe('backend store registry capacity', () => {
    it('keeps a cache for every server in a large fleet', () => {
        const registry = new BackendStoreRegistry();
        const fleet = 10;
        // The limit must cover a real fleet: eight was arbitrary and threw
        // away the cache of every server past the eighth.
        expect(MAX_BACKEND_STORES).toBeGreaterThanOrEqual(fleet);

        for (let i = 0; i < fleet; i++) {
            const store = registry.get(`server-${i}`);
            store.responses.set('/api/config', JSON.stringify({ i }));
        }
        // Every server still has its cached response.
        for (let i = 0; i < fleet; i++) {
            expect(registry.peek(`server-${i}`)?.responses.size).toBe(1);
        }
        expect(registry.size).toBe(fleet);
    });

    it('evicts the least recently used store beyond the limit', () => {
        const registry = new BackendStoreRegistry(2);
        registry.get('a').responses.set('/x', '1');
        registry.get('b').responses.set('/x', '1');
        // Touch 'a' so 'b' becomes the oldest.
        registry.get('a');
        registry.get('c');
        expect(registry.has('b')).toBe(false);
        expect(registry.has('a')).toBe(true);
        expect(registry.has('c')).toBe(true);
    });

    it('holds more than a dozen servers without eviction', () => {
        const registry = new BackendStoreRegistry();
        for (let i = 0; i < 20; i++) registry.get(`s${i}`);
        expect(registry.size).toBe(20);
        expect(registry.peek('s0')).toBeDefined();
    });

    it('a store keeps its terminal snapshots across a switch', () => {
        const registry = new BackendStoreRegistry();
        const store = registry.get('server-a');
        store.screens.set('pane-1', { ansi: 'hello', cols: 80, rows: 24 });
        store.tabs = [{ id: 'pane-1', title: 'Shell', coder: 'bash' }];

        // Another server takes over, then the first comes back.
        registry.get('server-b');
        const back = registry.get('server-a');
        expect(back.screens.get('pane-1')?.ansi).toBe('hello');
        expect(back.tabs).toHaveLength(1);
    });

    it('a fresh store starts empty', () => {
        const store = new BackendStore('x');
        expect(store.responses.size).toBe(0);
        expect(store.screens.size).toBe(0);
        expect(store.tabs).toBeNull();
    });
});
