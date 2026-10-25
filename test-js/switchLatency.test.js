// @vitest-environment jsdom
// The switch must be as fast as the cache paint: the server refresh runs
// BEHIND the switch, never in front of it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { setupDomHarness, mockFetch, stubWebSocket } from './_dom.js';
import { App } from '../web/app.js';
import { setEmbeddedBackend } from '../web/util.js';
import { backendStores } from '../web/backend-store.js';
import { loadCoderRegistry } from '../web/coders.js';

setupDomHarness();
const indexHtml = fs.readFileSync('web/index.html', 'utf8');

function setupVendorStubs() {
    if (!HTMLElement.prototype.scrollIntoView) {
        HTMLElement.prototype.scrollIntoView = () => {};
    }
    vi.stubGlobal('FitAddon', {
        FitAddon: class {
            fit() {}
        },
    });
    vi.stubGlobal('SearchAddon', { SearchAddon: class {} });
    vi.stubGlobal('Unicode11Addon', { Unicode11Addon: class {} });
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

/** A remote link: every server round trip costs `latency` ms. */
function slowFetch(latency, log = []) {
    return vi.fn((url) => {
        const u = String(url);
        log.push(u);
        return new Promise((resolve) => {
            const delay = u === '/__phi/active' ? 0 : latency;
            setTimeout(() => {
                const json = (data) => ({
                    ok: true,
                    status: 200,
                    headers: { get: () => 'application/json' },
                    json: async () => data,
                    text: async () => JSON.stringify(data),
                });
                if (u === '/api/version') {
                    resolve(
                        json({
                            version: '0.12.0',
                            started_at: '2026-10-24T12:00:00Z',
                        }),
                    );
                } else if (u === '/api/config') {
                    resolve(json({ hostname: 'remote-host', workspaces: [] }));
                } else if (u === '/api/terminals') {
                    resolve(json([]));
                } else if (u === '/api/coders') {
                    resolve(json([]));
                } else if (u === '/api/peers/status') {
                    resolve(json([]));
                } else if (u === '/__phi/active') {
                    // Answered by the main process: a local round trip, not a
                    // network one.
                    resolve(json({ ok: true }));
                } else {
                    resolve(json([]));
                }
            }, delay);
        });
    });
}

describe('Switch latency: the cache is the switch', () => {
    let app;

    beforeEach(async () => {
        setupVendorStubs();
        // The coder registry is a module-level singleton whose promise is
        // shared by every test in this file: settle it (forced) so one
        // test's pending fetch cannot stall the next test's config load.
        await loadCoderRegistry(true);
        stubWebSocket();
        document.body.innerHTML = indexHtml;
        window.history.replaceState(null, '', '/');
        setEmbeddedBackend('', '');
    });

    afterEach(() => {
        setEmbeddedBackend('', '');
        backendStores.clear();
    });

    it('resolves the switch without waiting for the remote server', async () => {
        const log = [];
        const fetchStub = slowFetch(300, log);
        globalThis.fetch = fetchStub;
        global.fetch = fetchStub;
        window.fetch = fetchStub;

        const warm = backendStores.get('profile-remote');
        warm.responses.set(
            '/api/version',
            JSON.stringify({ version: '0.12.0' }),
        );
        warm.tabs = [
            {
                id: 'p-1',
                session_id: 's1',
                title: 'Remote Shell',
                coder: 'bash',
                workspace: '/w',
                cwd: '/w',
                pinned: false,
                marked: false,
            },
        ];
        warm.screens.set('p-1', { ansi: 'cached $ ', cols: 80, rows: 24 });

        app = new App();
        const t0 = Date.now();
        await app.switchToBackend('profile-remote', 'http://remote:7070');
        const elapsed = Date.now() - t0;

        // The remote server takes 300ms per call; a switch that waited for
        // the server would cost several of those.
        expect(elapsed).toBeLessThan(150);
        // The cached tab is already on screen.
        expect(app.tabManager.tabs.has('p-1')).toBe(true);
        // The refresh is still running behind the switch.
        expect(document.documentElement.dataset.sync).toBe('stale');
    });

    it('lets the server override the cache when it answers', async () => {
        const log = [];
        const fetchStub = slowFetch(20, log);
        globalThis.fetch = fetchStub;
        global.fetch = fetchStub;
        window.fetch = fetchStub;

        const warm = backendStores.get('profile-remote');
        warm.responses.set(
            '/api/config',
            JSON.stringify({ hostname: 'cached-host', workspaces: [] }),
        );

        app = new App();
        await app.switchToBackend('profile-remote', 'http://remote:7070');
        await new Promise((r) => setTimeout(r, 200));

        expect(document.getElementById('hostname-display')?.innerText).toBe(
            'remote-host',
        );
        expect(document.documentElement.dataset.sync).toBeUndefined();
    });

    it('runs the refresh probes concurrently, not one after another', async () => {
        // Track how many server requests are in flight at once. Sequential
        // probes never overlap; concurrent ones do.
        let inFlight = 0;
        let peak = 0;
        const base = slowFetch(60);
        const fetchStub = vi.fn((url, opts) => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            const p = base(url, opts);
            return p.finally(() => {
                inFlight--;
            });
        });
        globalThis.fetch = fetchStub;
        global.fetch = fetchStub;
        window.fetch = fetchStub;

        app = new App();
        await app.switchToBackend('profile-remote', 'http://remote:7070');
        await new Promise((r) => setTimeout(r, 400));

        // The version, coders, config and terminals probes overlap.
        expect(peak).toBeGreaterThanOrEqual(3);
    });
});
