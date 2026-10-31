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
import { readSwitchPhases, reportSwitchPhases } from './_perf.js';
import { termPerfMeasureBetween } from '../web/terminal.js';

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
    // biome-ignore lint/complexity/useArrowFunction: arrows cannot be constructed; createTab calls new window.Terminal(...)
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
        performance.clearMarks();
        performance.clearMeasures();
        setupVendorStubs();
        // The coder registry is a module-level singleton whose promise is
        // shared by every test in this file: settle it (forced) so one
        // test's pending fetch cannot stall the next test's config load.
        mockFetch(() => []);
        await loadCoderRegistry(true);
        stubWebSocket();
        document.body.innerHTML = indexHtml;
        window.history.replaceState(null, '', '/');
        setEmbeddedBackend('', '');
    });

    afterEach(() => {
        try {
            reportSwitchPhases(
                expect.getState().currentTestName || 'switch latency',
            );
        } finally {
            app?.scope?.abort?.();
            setEmbeddedBackend('', '');
            backendStores.clear();
            app = undefined;
        }
    });

    it('records readable User Timing entries for a switch', async () => {
        const fetchStub = slowFetch(0);
        globalThis.fetch = fetchStub;
        global.fetch = fetchStub;
        window.fetch = fetchStub;

        backendStores.get('profile-markers').tabs = [];
        app = new App();
        await app.switchToBackend('profile-markers');

        expect(
            performance.getEntriesByName('phi:switch-start', 'mark'),
        ).toHaveLength(1);
        const totals = performance.getEntriesByName(
            'phi:switch-total',
            'measure',
        );
        expect(totals).toHaveLength(1);
        expect(Number.isFinite(totals[0].duration)).toBe(true);
        expect(totals[0].duration).toBeGreaterThanOrEqual(0);
        app.scope.abort();
    });

    it('reports fast switch phases and excludes unrelated measures', () => {
        performance.measure('unrelated-probe', {
            start: 0,
            duration: 2,
        });
        performance.measure('phi:switch-init', {
            start: 0,
            duration: 1,
        });

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect(readSwitchPhases()).toEqual([
                { name: 'phi:switch-init', ms: 1 },
            ]);
            expect(reportSwitchPhases('FAIL probe')).toBe(
                '[phi-perf] FAIL probe phi:switch-init=1.0ms',
            );
            expect(warn).toHaveBeenCalledWith(
                '[phi-perf] FAIL probe phi:switch-init=1.0ms',
            );
        } finally {
            warn.mockRestore();
        }
    });

    it('records the total when the switch rejects', async () => {
        app = new App();
        vi.spyOn(app, '_performSwitch').mockRejectedValue(
            new Error('switch probe failure'),
        );

        await expect(app.switchToBackend('profile-rejection')).rejects.toThrow(
            'switch probe failure',
        );

        expect(
            performance.getEntriesByName('phi:switch-total', 'measure'),
        ).toHaveLength(1);
    });

    it('keeps one entry per owned name across queued switches', async () => {
        const fetchStub = slowFetch(0);
        globalThis.fetch = fetchStub;
        global.fetch = fetchStub;
        window.fetch = fetchStub;
        backendStores.get('profile-markers').tabs = [];

        app = new App();
        await Promise.all([
            app.switchToBackend('profile-markers'),
            app.switchToBackend('profile-markers'),
            app.switchToBackend('profile-markers'),
        ]);

        const names = performance
            .getEntries()
            .filter((entry) => entry.name.startsWith('phi:switch-'))
            .map((entry) => entry.name);
        expect(new Set(names).size).toBe(names.length);
        expect(
            performance.getEntriesByName('phi:switch-start', 'mark'),
        ).toHaveLength(1);
        expect(
            performance.getEntriesByName('phi:switch-total', 'measure'),
        ).toHaveLength(1);
        expect(names.length).toBeLessThanOrEqual(7);
        app.scope.abort();
    });

    it('keeps one entry when the same name is measured twice', () => {
        expect(termPerfMeasureBetween('switch-init', 0, 5)).toBe(5);
        expect(termPerfMeasureBetween('switch-init', 0, 7)).toBe(7);

        const entries = performance.getEntriesByName(
            'phi:switch-init',
            'measure',
        );
        expect(entries).toHaveLength(1);
        expect(entries[0].duration).toBe(7);
    });

    it('resolves the switch without waiting for the remote server', async () => {
        const log = [];
        const remoteDelayMs = 5000;
        const fetchStub = slowFetch(remoteDelayMs, log);
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
        try {
            const t0 = performance.now();
            await app.switchToBackend('profile-remote', 'http://remote:7070');
            const elapsed = performance.now() - t0;

            // The limit follows the remote delay, not a 150ms CPU budget.
            // The delay stays far above local switch work so a loaded
            // worker cannot fail a switch that never waited.
            expect(
                elapsed,
                'switch must resolve before a remote response',
            ).toBeLessThan(remoteDelayMs);

            expect(app.tabManager.tabs.has('p-1')).toBe(true);
            expect(document.documentElement.dataset.sync).toBe('stale');

            const phases = readSwitchPhases();
            const names = phases.map(({ name }) => name);
            for (const name of [
                'phi:switch-total',
                'phi:switch-init',
                'phi:switch-prep',
                'phi:switch-paint',
                'phi:switch-sync-project',
                'phi:switch-active-post',
            ]) {
                expect(names, `missing switch phase: ${name}`).toContain(name);
            }
            for (const { name, ms } of phases) {
                expect(
                    Number.isFinite(ms),
                    `non-finite duration: ${name}`,
                ).toBe(true);
                expect(ms, `negative duration: ${name}`).toBeGreaterThanOrEqual(
                    0,
                );
            }
        } catch (error) {
            reportSwitchPhases('FAIL switch-before-remote');
            throw error;
        }
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
        await vi.waitFor(() => {
            expect(document.getElementById('hostname-display')?.innerText).toBe(
                'remote-host',
            );
            expect(document.documentElement.dataset.sync).toBeUndefined();
        });
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
