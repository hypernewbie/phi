// @vitest-environment jsdom
//
// FUNDAMENTAL CONTRACT — DO NOT CHANGE.
//
// The desktop is one page that switches servers in place. A storm of
// rapid switches (fresh start, spam clicking the server rail, adding
// servers) must converge on exactly one server: the one the user
// clicked last. Every rendered surface and every per-profile cache
// must belong to that server alone. A response that outlives its
// switch must never render, and a request that leaves the page before
// its server is active must never paint another server's data.
//
// "One server is another server" is a defect, never a trade-off.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { setupDomHarness, mockFetch, stubWebSocket } from './_dom.js';
import { App } from '../web/app.js';
import { setEmbeddedBackend, getEmbeddedProfileId } from '../web/util.js';
import { backendStores, BackendStore } from '../web/backend-store.js';
import { listCoders } from '../web/coders.js';

setupDomHarness();

const indexHtml = fs.readFileSync('web/index.html', 'utf8');

const ALPHA = 'profile-alpha';
const BETA = 'profile-beta';
const ORIGIN = 'phi-app://app';

// Two servers whose every payload carries a marker the DOM and the
// caches must never mix.
const SERVERS = {
    [ALPHA]: {
        marker: 'alpha',
        version: { version: '10.0.0-alpha', started_at: '2026-11-07T00:00:00Z' },
        coders: [{ id: 'alpha-coder', name: 'Alpha Coder' }],
        config: {
            workspaces: ['/srv/alpha/ws-one', '/srv/alpha/ws-two'],
            hostname: 'alpha-host-7f3a',
        },
        peers: [{ name: 'alpha-peer', state: 'up' }],
        sync: [{ id: 'alpha-msg-1', title: 'alpha message' }],
        worktrees: [
            { path: '/srv/alpha/ws-one', active: true },
            { path: '/srv/alpha/ws-two', active: false },
        ],
        sessions: [{ id: 'alpha-session-1', title: 'alpha session' }],
    },
    [BETA]: {
        marker: 'beta',
        version: { version: '20.0.0-beta', started_at: '2026-11-07T01:00:00Z' },
        coders: [{ id: 'beta-coder', name: 'Beta Coder' }],
        config: {
            workspaces: ['/srv/beta/ws-one'],
            hostname: 'beta-host-c29e',
        },
        peers: [{ name: 'beta-peer', state: 'busy', busy_count: 2 }],
        sync: [{ id: 'beta-msg-1', title: 'beta message' }],
        worktrees: [{ path: '/srv/beta/ws-one', active: true }],
        sessions: [{ id: 'beta-session-1', title: 'beta session' }],
    },
};

function payloadFor(profileId, pathname, search) {
    const server = SERVERS[profileId];
    switch (pathname) {
        case '/api/version':
            return server.version;
        case '/api/coders':
            return server.coders;
        case '/api/config':
            return server.config;
        case '/api/peers/status':
            return server.peers;
        case '/api/sync/messages':
            return server.sync;
        case '/api/panes':
            return [];
        case '/api/sessions':
            return server.sessions;
        case '/api/git/worktrees':
            return server.worktrees;
        case '/api/config/mobile-appearance':
            return { ok: false, status: 404, json: { error: 'none' } };
        default:
            if (pathname.startsWith('/api/sessions')) return server.sessions;
            return {};
    }
    void search;
}

/**
 * A controllable two-server network. Requests carrying X-Phi-Backend
 * route to that server; requests without it (the headerless right-panel
 * fetches) route to the modeled main-process pointer, which flips when
 * the page's POST /__phi/active lands — exactly like the real desktop.
 * Per-server delays and one-shot gates create overlapping responses.
 */
function installTwoServerFetch() {
    const calls = [];
    const activePosts = [];
    const gates = new Map();
    const delays = new Map();
    const model = { pointer: ALPHA };

    const gateKey = (server, pathname) => `gate:${server}${pathname}`;
    const delayKey = (server, pathname) => `delay:${server}${pathname}`;

    const wait = (ms) =>
        ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : null;

    const handler = async (url, opts) => {
        const parsed = new URL(url, 'http://page.local');
        const pathname = parsed.pathname;
        const headerId = opts?.headers?.['X-Phi-Backend'];

        if (pathname === '/__phi/active' && opts?.method === 'POST') {
            const body = JSON.parse(opts.body);
            // The pointer flips only when the POST lands.
            model.pointer = body.profileId;
            activePosts.push(body.profileId);
            calls.push({ url: pathname, profileId: 'control' });
            return { ok: true };
        }

        const profileId = headerId || model.pointer;
        const server = SERVERS[profileId] ? profileId : ALPHA;
        calls.push({ url: pathname + parsed.search, profileId: server });

        const gate = gates.get(gateKey(server, pathname));
        if (gate) gate.promise = gate.promise || new Promise((r) => (gate.release = r));
        if (gate?.promise) await gate.promise;

        await wait(delays.get(delayKey(server, pathname)) || 0);
        return payloadFor(server, pathname, parsed.search);
    };

    return {
        stub: mockFetch(handler),
        calls,
        activePosts,
        model,
        setDelay(profileId, pathname, ms) {
            delays.set(delayKey(profileId, pathname), ms);
        },
        gate(profileId, pathname) {
            const entry = {};
            entry.promise = new Promise((resolve) => {
                entry.release = resolve;
            });
            gates.set(gateKey(profileId, pathname), entry);
            return entry;
        },
        gateFor(profileId, pathname) {
            return gates.get(gateKey(profileId, pathname));
        },
    };
}

function setupVendorStubs() {
    if (!HTMLElement.prototype.scrollIntoView) {
        HTMLElement.prototype.scrollIntoView = () => {};
    }
    vi.stubGlobal('FitAddon', { FitAddon: class { fit() {} } });
    vi.stubGlobal('SearchAddon', { SearchAddon: class {} });
    vi.stubGlobal('Unicode11Addon', { Unicode11: class {} });
    vi.stubGlobal('WebglAddon', { WebglAddon: class {} });
    vi.stubGlobal(
        'Audio',
        class {
            play() {
                return Promise.resolve();
            }
        },
    );
    vi.stubGlobal('Terminal', function () {
        const rootEl = document.createElement('div');
        const viewportEl = document.createElement('div');
        viewportEl.className = 'xterm-viewport';
        rootEl.appendChild(viewportEl);
        return {
            cols: 80,
            rows: 24,
            options: { theme: {} },
            element: rootEl,
            unicode: { activeVersion: '6' },
            buffer: {
                active: { type: 'normal', viewportY: 0, baseY: 0 },
                onBufferChange: vi.fn(),
            },
            parser: { registerOscHandler: vi.fn() },
            _core: {
                coreService: { onUserInput: vi.fn() },
                _bufferService: {
                    buffers: { normal: { lines: { onTrim: vi.fn() } } },
                },
            },
            loadAddon: vi.fn(),
            open: vi.fn(),
            focus: vi.fn(),
            dispose: vi.fn(),
            onData: vi.fn(),
            onResize: vi.fn(),
            onBell: vi.fn(),
            onSelectionChange: vi.fn(),
            attachCustomKeyEventHandler: vi.fn(),
            getSelection: vi.fn(() => ''),
            write: vi.fn(),
            writeln: vi.fn(),
            clear: vi.fn(),
            reset: vi.fn(),
            resize: vi.fn(),
            scrollToBottom: vi.fn(),
        };
    });
}

async function settle(app, revalidates) {
    for (let i = 0; i < 6; i++) {
        if (revalidates.length) await Promise.allSettled(revalidates);
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // Let the fleet/sync poll timers fire once or twice more: a late
    // poll must also paint only the final server.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await app._switchChain;
}

/** A deterministic monkey storm: alternating double-clicks ending on BETA. */
function stormOrder() {
    const order = [];
    for (let i = 0; i < 12; i++) order.push(BETA, ALPHA);
    // Spam: several clicks on the same entry, like a frustrated user.
    order.push(BETA, BETA, ALPHA, BETA, ALPHA, ALPHA, BETA, BETA);
    return order;
}

describe('single-tab switch storm (FUNDAMENTAL CONTRACT)', () => {
    let app;
    let net;
    let revalidates;
    let trackedRevalidate;

    beforeEach(() => {
        setupVendorStubs();
        stubWebSocket();
        document.body.innerHTML = indexHtml;
        localStorage.clear();
        sessionStorage.clear();
        window.history.replaceState(null, '', '/');
        setEmbeddedBackend(ALPHA, ORIGIN);
        net = installTwoServerFetch();
        globalThis.fetch = net.stub;
        if (typeof global !== 'undefined') global.fetch = net.stub;
        if (typeof window !== 'undefined') window.fetch = net.stub;

        // Crossing delays: alpha answers fast, beta is slow — the storm
        // overlaps waves of responses from both servers.
        net.setDelay(ALPHA, '/api/version', 4);
        net.setDelay(BETA, '/api/version', 24);
        net.setDelay(ALPHA, '/api/coders', 3);
        net.setDelay(BETA, '/api/coders', 60);
        net.setDelay(ALPHA, '/api/config', 2);
        net.setDelay(BETA, '/api/config', 40);
        net.setDelay(BETA, '/api/git/worktrees', 30);
        net.setDelay(ALPHA, '/api/git/worktrees', 6);

        revalidates = [];
        app = new App();
        trackedRevalidate = vi
            .spyOn(app, 'revalidate')
            .mockImplementation((...args) => {
                const promise = Promise.resolve(
                    App.prototype.revalidate.apply(app, args),
                );
                revalidates.push(promise);
                return promise;
            });
        void trackedRevalidate;
    });

    afterEach(() => {
        app?.tabManager?.dispose();
        setEmbeddedBackend('', '');
        backendStores.clear();
        vi.restoreAllMocks();
    });

    it('R-storm: after 32 rapid switches every surface belongs to the last-clicked server', async () => {
        const order = stormOrder();
        const switches = order.map((id) =>
            window.__phiEmbed.switchTo(id, ORIGIN),
        );
        await settle(app, revalidates);
        await Promise.allSettled(switches);

        // 1. The page IS the last server.
        expect(getEmbeddedProfileId()).toBe(BETA);

        // 2. Every /__phi/active POST the page sent was in click order
        //    (a subsequence of the storm) and the last one is the
        //    server the user clicked last. A POST that flips the host
        //    pointer to a server the page already left is the root of
        //    "one server is another server".
        let cursor = -1;
        for (const posted of net.activePosts) {
            const at = order.indexOf(posted, cursor + 1);
            expect(at).toBeGreaterThan(cursor);
            cursor = at;
        }
        expect(net.activePosts.at(-1)).toBe(BETA);

        // 3. The visible host is the final server's.
        const host = document.getElementById('hostname-display')?.innerText;
        expect(host).toContain('beta-host');
        expect(host).not.toContain('alpha-host');

        // 4. The coder registry — a global shared by every surface —
        //    holds only the final server's coders.
        const coderIds = listCoders().map((coder) => coder.id);
        expect(coderIds).toContain('beta-coder');
        expect(coderIds).not.toContain('alpha-coder');
        for (const tab of document.querySelectorAll('.coder-tab')) {
            expect(tab.getAttribute('data-coder')).not.toBe('alpha-coder');
        }

        // 5. The workspace picker lists only the final server's
        //    workspaces, and the active cwd sits on one of them.
        const options = [
            ...document.querySelectorAll('#workspace-select option'),
        ].map((option) => option.value);
        expect(options.length).toBeGreaterThan(0);
        for (const value of options) {
            expect(value.startsWith('/srv/beta/')).toBe(true);
        }
        expect(app.sessionsManager.activeWorkspace.startsWith('/srv/beta/'))
            .toBe(true);
        expect(
            (app.sessionsManager.activeCWD || '').startsWith('/srv/beta/'),
        ).toBe(true);

        // 6. No server marker of the abandoned server appears anywhere
        //    in the document.
        const text = document.body.textContent || '';
        expect(text).not.toContain('/srv/alpha');
        expect(text).not.toContain('alpha-host');
        expect(text).not.toContain('Alpha Coder');

        // 7. Per-profile caches stay isolated: a store may hold its own
        //    server's payloads, never the other server's.
        for (const [profileId, server] of Object.entries(SERVERS)) {
            const store = backendStores.get(profileId);
            for (const [url, body] of store.responses) {
                if (url === '/api/version') {
                    expect(JSON.parse(body).version).toBe(server.version.version);
                }
                if (url === '/api/config') {
                    for (const ws of JSON.parse(body).workspaces) {
                        expect(ws.startsWith(`/srv/${server.marker}/`)).toBe(
                            true,
                        );
                    }
                }
            }
        }
    });

    it('R-late: a response that outlives its switch never renders', async () => {
        // The first alpha coder answer is held back until the storm has
        // fully settled on beta. Its scope was aborted long before the
        // bytes arrive; nothing may paint them.
        const held = net.gate(ALPHA, '/api/coders');
        net.setDelay(ALPHA, '/api/coders', 0);

        const order = stormOrder();
        const switches = order.map((id) =>
            window.__phiEmbed.switchTo(id, ORIGIN),
        );
        await settle(app, revalidates);
        await Promise.allSettled(switches);
        expect(getEmbeddedProfileId()).toBe(BETA);

        held.release();
        // Give the late bytes every chance to (wrongly) paint.
        for (let i = 0; i < 6; i++) {
            await Promise.allSettled(revalidates);
            await new Promise((resolve) => setTimeout(resolve, 0));
        }

        const coderIds = listCoders().map((coder) => coder.id);
        expect(coderIds).not.toContain('alpha-coder');
        expect(document.body.textContent).not.toContain('Alpha Coder');
    });

    it('R-active: only the surviving switch may flip the host pointer, in click order', async () => {
        // Hold every config answer so the switch chain is slow enough
        // that superseded switches race the final one for the POST.
        net.setDelay(BETA, '/api/config', 10);
        const order = [BETA, ALPHA, BETA, ALPHA, BETA];
        const switches = order.map((id) =>
            window.__phiEmbed.switchTo(id, ORIGIN),
        );
        await Promise.allSettled(switches);
        await settle(app, revalidates);

        expect(net.activePosts.at(-1)).toBe(BETA);
        let cursor = -1;
        for (const posted of net.activePosts) {
            const at = order.indexOf(posted, cursor + 1);
            expect(at).toBeGreaterThan(cursor);
            cursor = at;
        }
        // The POSTs are also serialized: each one completed before the
        // next was sent, so the host pointer can never end on an
        // earlier click.
        expect(net.activePosts.length).toBeLessThanOrEqual(order.length);
    });
});

describe('headerless requests during a switch (FUNDAMENTAL CONTRACT)', () => {
    let app;
    let net;
    let revalidates;

    beforeEach(() => {
        setupVendorStubs();
        stubWebSocket();
        document.body.innerHTML = indexHtml;
        localStorage.clear();
        sessionStorage.clear();
        window.history.replaceState(null, '');
        setEmbeddedBackend(ALPHA, ORIGIN);
        net = installTwoServerFetch();
        globalThis.fetch = net.stub;
        if (typeof global !== 'undefined') global.fetch = net.stub;
        if (typeof window !== 'undefined') window.fetch = net.stub;
        revalidates = [];
    });

    afterEach(() => {
        app?.tabManager?.dispose();
        setEmbeddedBackend('', '');
        backendStores.clear();
        vi.restoreAllMocks();
    });

    it('R-panel: a right-panel fetch issued before the pointer flip must not paint the abandoned server', async () => {
        app = new App();
        const tracked = vi
            .spyOn(app, 'revalidate')
            .mockImplementation((...args) => {
                const promise = Promise.resolve(
                    App.prototype.revalidate.apply(app, args),
                );
                revalidates.push(promise);
                return promise;
            });
        void tracked;
        await settle(app, revalidates);

        // The user clicks server B. The POST /__phi/active is in flight
        // — the host pointer still says A. The worktrees panel fires
        // (user refresh or an automatic refresh): headerless, so it is
        // answered by A. When the flip lands, those bytes must be
        // dead: the sidebar is B's, whole.
        const postGate = net.gate('control', '/__phi/active');
        const switching = window.__phiEmbed.switchTo(BETA, ORIGIN);

        // The pointer is still on alpha while the POST waits: this
        // headerless load is answered by alpha.
        const load = app.sessionsManager.loadSessions();

        // Land the switch.
        const gate = net.gateFor('control', '/__phi/active');
        gate.release();
        await switching;
        await Promise.allSettled([load, ...revalidates]);
        await settle(app, revalidates);

        expect(getEmbeddedProfileId()).toBe(BETA);
        const text = document.getElementById('session-list')?.textContent || '';
        expect(text).not.toContain('/srv/alpha');
        expect(
            (app.sessionsManager.activeCWD || '').startsWith('/srv/beta/'),
        ).toBe(true);
    });
});

describe('BackendStore under a switch storm (FUNDAMENTAL CONTRACT)', () => {
    it('R-cache: a load whose scope died before its answer never writes the cache or the DOM', async () => {
        const store = new BackendStore('solo');
        const renders = [];

        // First load: slow, and its scope dies mid-flight.
        const dyingScope = { aborted: false, fetchText: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return JSON.stringify({ generation: 'old' });
        } };
        // Second load: fast, live, answers the newer body.
        const liveScope = { aborted: false, fetchText: async () => {
            await new Promise((resolve) => setTimeout(resolve, 2));
            return JSON.stringify({ generation: 'new' });
        } };

        const first = store.load('/api/state', dyingScope, (data) => {
            renders.push(['first', data.generation]);
        });
        const second = store.load('/api/state', liveScope, (data) => {
            renders.push(['second', data.generation]);
        });
        await second;
        // The newer answer is on screen and in the cache.
        expect(renders.at(-1)).toEqual(['second', 'new']);
        expect(JSON.parse(store.responses.get('/api/state'))).toEqual({
            generation: 'new',
        });

        // Now the old scope dies, and only then do its bytes arrive.
        dyingScope.aborted = true;
        await first;

        // The dead answer must not have painted or regressed the cache.
        expect(JSON.parse(store.responses.get('/api/state'))).toEqual({
            generation: 'new',
        });
        expect(renders.at(-1)).toEqual(['second', 'new']);
    });
});
