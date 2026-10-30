// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { setupDomHarness, mockFetch, stubWebSocket } from './_dom.js';
import { App } from '../web/app.js';
import {
    serverKey,
    setEmbeddedBackend,
    getEmbeddedProfileId,
    getEmbeddedBackendOrigin,
} from '../web/util.js';
import { runPrepaint } from '../web/theme.js';
import { backendStores } from '../web/backend-store.js';

setupDomHarness();

const indexHtml = fs.readFileSync('web/index.html', 'utf8');

function setupHtml() {
    document.body.innerHTML = indexHtml;
}

function setupVendorStubs() {
    if (!HTMLElement.prototype.scrollIntoView) {
        HTMLElement.prototype.scrollIntoView = () => {};
    }
    vi.stubGlobal('FitAddon', {
        FitAddon: class {
            fit() {}
        },
    });
    vi.stubGlobal('SearchAddon', {
        SearchAddon: class {},
    });
    vi.stubGlobal('Unicode11Addon', {
        Unicode11Addon: class {},
    });
    vi.stubGlobal('WebglAddon', {
        WebglAddon: class {},
    });
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
                    buffers: {
                        normal: { lines: { onTrim: vi.fn() } },
                    },
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

describe('Single-Tab Embedded Backend Switching', () => {
    let app;
    let fetchCalls = [];

    beforeEach(() => {
        setupVendorStubs();
        stubWebSocket();
        setupHtml();
        localStorage.clear();
        sessionStorage.clear();
        window.history.replaceState(null, '', '/');
        setEmbeddedBackend('', '');
        fetchCalls = [];
        const fetchStub = mockFetch((url, opts) => {
            fetchCalls.push({ url, opts });
            if (url === '/api/version') {
                return {
                    version: '0.12.0',
                    started_at: '2026-10-24T12:00:00Z',
                };
            }
            if (url === '/api/coders') {
                return [];
            }
            if (url === '/api/config') {
                return { workspaces: ['/tmp/ws1'] };
            }
            if (url === '/api/panes') {
                return [];
            }
            if (url === '/api/peers/status') {
                return [];
            }
            if (url === '/__phi/active') {
                return { ok: true };
            }
            if (url.includes('messages') || url.includes('sync')) {
                return [];
            }
            return [];
        });
        globalThis.fetch = fetchStub;
        if (typeof global !== 'undefined') global.fetch = fetchStub;
        if (typeof window !== 'undefined') window.fetch = fetchStub;
    });

    afterEach(() => {
        setEmbeddedBackend('', '');
        backendStores.clear();
    });

    it('Test 1: initOnce() is idempotent and does not register duplicate listeners', async () => {
        app = new App();
        expect(app._initializedOnce).toBe(false);

        // Spy on an element event listener to verify single registration
        const exportBtn = document.getElementById('header-export-btn');
        let exportClicks = 0;
        const origAddEventListener = exportBtn.addEventListener.bind(exportBtn);
        exportBtn.addEventListener = vi.fn((event, handler, opts) => {
            if (event === 'click') {
                exportClicks++;
            }
            return origAddEventListener(event, handler, opts);
        });

        app.initOnce();
        expect(app._initializedOnce).toBe(true);
        expect(exportClicks).toBe(1);

        // Call initOnce again
        app.initOnce();
        expect(app._initializedOnce).toBe(true);
        // Handler should not have been added a second time
        expect(exportClicks).toBe(1);
    });

    it('Test 2: window.__phiEmbed.switchTo(id, origin) performs full switch cycle', async () => {
        setEmbeddedBackend('profile-alpha', 'http://127.0.0.1:8080');
        app = new App();

        expect(window.__phiEmbed).toBeDefined();
        expect(typeof window.__phiEmbed.switchTo).toBe('function');
        expect(typeof window.__phiEmbed.forget).toBe('function');

        // Spy on detachAll
        const detachSpy = vi.spyOn(app.tabManager, 'detachAll');
        const revalidateSpy = vi.spyOn(app, 'revalidate');

        // Simulate an open settings modal and drawer
        const overlay = document.createElement('div');
        overlay.className = 'settings-overlay';
        document.body.appendChild(overlay);

        const sidebar = document.getElementById('sidebar-panel');
        if (sidebar) sidebar.classList.add('drawer-open');

        // Perform switch to profile-beta
        const switchPromise = window.__phiEmbed.switchTo(
            'profile-beta',
            'http://127.0.0.1:9090',
        );
        await switchPromise;

        // 1. detachAll called with prevProfileId to flush old tabs
        expect(detachSpy).toHaveBeenCalledWith({
            flushBackendId: 'profile-alpha',
        });

        // 2. Active profile & origin updated
        expect(getEmbeddedProfileId()).toBe('profile-beta');
        expect(getEmbeddedBackendOrigin()).toBe('http://127.0.0.1:9090');

        // 3. Transient UI dismissed
        expect(document.querySelector('.settings-overlay')).toBeNull();
        if (sidebar) {
            expect(sidebar.classList.contains('drawer-open')).toBe(false);
        }

        // 4. POST /__phi/active was called with profileId
        const activeCall = fetchCalls.find((c) => c.url === '/__phi/active');
        expect(activeCall).toBeDefined();
        expect(activeCall.opts.method).toBe('POST');
        expect(JSON.parse(activeCall.opts.body)).toEqual({
            profileId: 'profile-beta',
        });

        // 5. revalidate was called with the new scope
        expect(revalidateSpy).toHaveBeenCalled();
        const lastScope =
            revalidateSpy.mock.calls[revalidateSpy.mock.calls.length - 1][0];
        expect(lastScope.profileId).toBe('profile-beta');
        expect(lastScope.origin).toBe('http://127.0.0.1:9090');

        // 6. URL query params updated
        expect(window.location.search).toContain('profile=profile-beta');
        expect(window.location.search).toContain('embedded=1');
    });

    it('Test 3: Rapid switching A -> B -> C aborts B and coalesces to C', async () => {
        app = new App();
        const revalidatedProfiles = [];
        const origRevalidate = app.revalidate.bind(app);
        vi.spyOn(app, 'revalidate').mockImplementation(async (scope) => {
            if (scope?.aborted) return;
            // Delay revalidate slightly to allow overlap
            await new Promise((r) => setTimeout(r, 10));
            if (scope?.aborted) return;
            revalidatedProfiles.push(scope.profileId);
            return origRevalidate(scope);
        });

        // Trigger two switches back-to-back
        const pB = app.switchToBackend('profile-b');
        const pC = app.switchToBackend('profile-c');

        await Promise.all([pB, pC]);
        // The switch resolves on the cached paint; the refresh runs behind
        // it. Let the background refresh settle before asserting on it.
        await new Promise((r) => setTimeout(r, 40));

        // profile-b should have been superseded and aborted before revalidation finished
        expect(revalidatedProfiles).not.toContain('profile-b');
        expect(revalidatedProfiles).toContain('profile-c');
        expect(getEmbeddedProfileId()).toBe('profile-c');
    });

    it('Test 4: window.__phiEmbed.forget(id) removes scoped keys ending in :<id>', () => {
        app = new App();

        localStorage.setItem('phi_theme_color:srv-1', 'emerald');
        localStorage.setItem('phi_theme_color:srv-2', 'blue');
        localStorage.setItem('phi_tabs_state:srv-1', '{"tabs":[]}');
        localStorage.setItem('phi_server_started_at:srv-1', '123456');
        localStorage.setItem('phi_global_key', 'stay-alive');

        const result = window.__phiEmbed.forget('srv-1');
        expect(result).toBe(true);

        expect(localStorage.getItem('phi_theme_color:srv-1')).toBeNull();
        expect(localStorage.getItem('phi_tabs_state:srv-1')).toBeNull();
        expect(localStorage.getItem('phi_server_started_at:srv-1')).toBeNull();

        // Other servers and global keys preserved
        expect(localStorage.getItem('phi_theme_color:srv-2')).toBe('blue');
        expect(localStorage.getItem('phi_global_key')).toBe('stay-alive');
    });

    it('Test 5: runPrepaint() in web/theme.js reads phi_theme_color:<id>', () => {
        localStorage.clear();
        document.documentElement.removeAttribute('data-theme-color');
        document.documentElement.style.cssText = '';

        localStorage.setItem('phi_theme_color:srv-prod', 'coral');
        localStorage.setItem('phi_theme_color', 'blue');

        // When ?profile=srv-prod is in URL
        window.history.replaceState(
            null,
            '',
            '?desktop=1&embedded=1&profile=srv-prod',
        );
        runPrepaint();
        expect(document.documentElement.getAttribute('data-theme-color')).toBe(
            'coral',
        );

        // When URL has no profile, but embedded profile is set in runtime
        window.history.replaceState(null, '', '?desktop=1&embedded=1');
        setEmbeddedBackend('srv-prod', '');
        document.documentElement.removeAttribute('data-theme-color');
        runPrepaint();
        expect(document.documentElement.getAttribute('data-theme-color')).toBe(
            'coral',
        );

        // When no embedded profile, falls back to global phi_theme_color
        setEmbeddedBackend('', '');
        document.documentElement.removeAttribute('data-theme-color');
        runPrepaint();
        expect(document.documentElement.getAttribute('data-theme-color')).toBe(
            'blue',
        );
    });

    it('Test 6: App constructor ingests ?profile= and ?origin= from URL search', () => {
        window.history.replaceState(
            null,
            '',
            '?profile=srv-boot&origin=http%3A%2F%2Fboot-host%3A9999',
        );
        app = new App();

        expect(getEmbeddedProfileId()).toBe('srv-boot');
        expect(getEmbeddedBackendOrigin()).toBe('http://boot-host:9999');
        expect(app.scope.profileId).toBe('srv-boot');
        expect(app.scope.origin).toBe('http://boot-host:9999');
    });

    it('Test 7: switchToBackend with empty profileId returns false without switching', async () => {
        setEmbeddedBackend('current-srv', '');
        app = new App();

        const result = await app.switchToBackend('');
        expect(result).toBe(false);
        expect(getEmbeddedProfileId()).toBe('current-srv');
    });

    it('Test 8: applyAccentTheme and loadVersion store scoped keys', async () => {
        setEmbeddedBackend('scoped-srv', '');
        app = new App();

        app.applyAccentTheme('emerald');
        expect(localStorage.getItem('phi_theme_color:scoped-srv')).toBe(
            'emerald',
        );

        await app.loadVersion(app.scope);
        expect(localStorage.getItem('phi_server_started_at:scoped-srv')).toBe(
            '2026-10-24T12:00:00Z',
        );
    });

    it('Test 9: instant cache paint before /__phi/active and reconciliation after revalidate', async () => {
        const warmStore = backendStores.get('profile-warm');
        warmStore.responses.set(
            '/api/version',
            JSON.stringify({
                version: '0.12.0',
                started_at: '2026-10-24T12:00:00Z',
            }),
        );
        warmStore.responses.set(
            '/api/config',
            JSON.stringify({ hostname: 'warm-host', workspaces: ['/repo'] }),
        );
        warmStore.responses.set(
            '/api/git/worktrees?cwd=%2Frepo',
            JSON.stringify([{ path: '/repo', branch: 'main', active: true }]),
        );
        warmStore.tabs = [
            {
                id: 'p-warm',
                session_id: 's1',
                title: 'Warm Shell',
                coder: 'bash',
                workspace: '/repo',
                cwd: '/repo',
                pinned: false,
                marked: false,
            },
        ];
        warmStore.screens.set('p-warm', {
            ansi: 'cached prompt $ ',
            cols: 80,
            rows: 24,
        });

        app = new App();

        let activeCalled = false;
        let preActiveCalls = 0;
        let preActiveHostname = '';
        let preActiveHasWarmTab = false;
        let preActiveSyncState = '';

        const origFetch = globalThis.fetch;
        const customFetch = vi.fn((url, opts) => {
            const u = String(url);
            if (u === '/__phi/active') {
                activeCalled = true;
                preActiveCalls = fetchCalls.length;
                preActiveHostname =
                    document.getElementById('hostname-display')?.innerText ||
                    '';
                preActiveHasWarmTab = app.tabManager.tabs.has('p-warm');
                preActiveSyncState = document.documentElement.dataset.sync;
                fetchCalls.push({ url: u, opts });
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: { get: () => 'application/json' },
                    json: async () => ({ ok: true }),
                    text: async () => JSON.stringify({ ok: true }),
                });
            }
            if (u === '/api/config') {
                fetchCalls.push({ url: u, opts });
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: { get: () => 'application/json' },
                    json: async () => ({
                        hostname: 'warm-host-updated',
                        workspaces: ['/repo'],
                    }),
                    text: async () =>
                        JSON.stringify({
                            hostname: 'warm-host-updated',
                            workspaces: ['/repo'],
                        }),
                });
            }
            if (u === '/api/terminals') {
                fetchCalls.push({ url: u, opts });
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: { get: () => 'application/json' },
                    json: async () => [
                        {
                            id: 'p-warm',
                            session_id: 's1',
                            title: 'Warm Shell',
                            coder: 'bash',
                            workspace: '/repo',
                            cwd: '/repo',
                            pinned: false,
                            marked: false,
                        },
                        {
                            id: 'p-live',
                            session_id: 's2',
                            title: 'Live Shell',
                            coder: 'bash',
                            workspace: '/repo',
                            cwd: '/repo',
                            pinned: false,
                            marked: false,
                        },
                    ],
                    text: async () =>
                        JSON.stringify([
                            {
                                id: 'p-warm',
                                session_id: 's1',
                                title: 'Warm Shell',
                                coder: 'bash',
                                workspace: '/repo',
                                cwd: '/repo',
                                pinned: false,
                                marked: false,
                            },
                            {
                                id: 'p-live',
                                session_id: 's2',
                                title: 'Live Shell',
                                coder: 'bash',
                                workspace: '/repo',
                                cwd: '/repo',
                                pinned: false,
                                marked: false,
                            },
                        ]),
                });
            }
            return origFetch(url, opts);
        });

        globalThis.fetch = customFetch;
        if (typeof window !== 'undefined') window.fetch = customFetch;
        if (typeof global !== 'undefined') global.fetch = customFetch;

        await new Promise((r) => setTimeout(r, 20));
        fetchCalls = [];
        await app.switchToBackend('profile-warm');

        expect(activeCalled).toBe(true);
        expect(preActiveCalls).toBe(0);
        expect(preActiveHostname).toBe('warm-host');
        expect(preActiveHasWarmTab).toBe(true);
        expect(preActiveSyncState).toBe('stale');

        // The switch resolves on the CACHED paint: the cached hostname is
        // on screen and the page is marked stale (a refresh is running).
        expect(document.getElementById('hostname-display')?.innerText).toBe(
            'warm-host',
        );
        expect(app.tabManager.tabs.has('p-warm')).toBe(true);
        expect(document.documentElement.dataset.sync).toBe('stale');

        // The server is authoritative: when its answer lands it overrides
        // the cache and the stale marker clears.
        await new Promise((r) => setTimeout(r, 60));
        expect(document.getElementById('hostname-display')?.innerText).toBe(
            'warm-host-updated',
        );
        expect(app.tabManager.tabs.has('p-live')).toBe(true);
        expect(document.documentElement.dataset.sync).toBeUndefined();
    });

    it('keeps actions blocked after HTTP 503, restores inert state, and recovers only after explicit success', async () => {
        setEmbeddedBackend('profile-current', '');
        app = new App();
        const notifications = app.getNotifications();
        const mainLayout = document.querySelector('.main-layout');
        const toastContainer = document.getElementById('toast-container');
        const trigger = document.getElementById('header-notifications-btn');
        const overlay = document.getElementById('notifications-overlay');
        mainLayout.inert = false;
        toastContainer.inert = true;
        trigger.inert = false;
        overlay.inert = false;
        const originalFetch = globalThis.fetch;
        const gates = [];
        const startResolvers = [];
        const started = [0, 1].map(
            (index) =>
                new Promise((resolve) => {
                    startResolvers[index] = resolve;
                }),
        );
        const activeFetch = vi.fn((url, options) => {
            if (String(url) === '/__phi/active') {
                const index = gates.length;
                let resolve;
                const response = new Promise((done) => {
                    resolve = done;
                });
                gates.push({ resolve, options });
                startResolvers[index]?.();
                return response;
            }
            return originalFetch(url, options);
        });
        globalThis.fetch = activeFetch;
        window.fetch = activeFetch;

        const firstCallback = vi.fn();
        const failedSwitch = app.switchToBackend('profile-unconfirmed');
        expect(notifications['actionsBlocked']).toBe(true);
        await started[0];
        const firstPopup = notifications.show('While routing is pending', {
            duration: 50_000,
            action: { text: 'Open', callback: firstCallback },
        });
        notifications.open();
        const firstEntry = notifications['entries'][0];
        const firstDeadline = firstEntry.deadline;
        expect(firstPopup.querySelector('.toast-action-btn').disabled).toBe(
            true,
        );
        expect(
            document.querySelector('.notification-item-action').disabled,
        ).toBe(true);
        expect(
            document.querySelector('#notifications-routing-status').classList,
        ).not.toContain('hidden');
        notifications.activate(firstEntry.id);
        expect(firstCallback).not.toHaveBeenCalled();
        expect(firstEntry.callback).toBe(firstCallback);
        expect(firstEntry.deadline).toBe(firstDeadline);
        expect(mainLayout.inert).toBe(true);
        expect(toastContainer.inert).toBe(true);
        expect(trigger.inert).toBe(false);
        expect(overlay.inert).toBe(false);
        expect(document.getElementById('toast-container').inert).toBe(true);
        expect(
            document.getElementById('notifications-dismiss-all').disabled,
        ).toBe(false);
        expect(document.getElementById('notifications-close').disabled).toBe(
            false,
        );
        const localNotice = notifications.show('Dismiss while blocked', {
            duration: 0,
        });
        const localRow = [
            ...document.querySelectorAll('.notification-item'),
        ].find((row) => row.textContent.includes('Dismiss while blocked'));
        localRow.querySelector('.notification-item-dismiss').click();
        expect(localNotice.isConnected).toBe(false);
        notifications.closeButton.click();
        notifications.trigger.click();
        expect(overlay.classList).not.toContain('hidden');

        gates[0].resolve({ ok: false, status: 503 });
        await failedSwitch;
        expect(
            activeFetch.mock.calls.filter(
                ([url]) => String(url) === '/__phi/active',
            ),
        ).toHaveLength(1);
        expect(notifications['actionsBlocked']).toBe(true);
        expect(firstPopup.querySelector('.toast-action-btn').disabled).toBe(
            true,
        );
        expect(mainLayout.inert).toBe(false);
        expect(toastContainer.inert).toBe(true);
        expect(trigger.inert).toBe(false);
        expect(overlay.inert).toBe(false);

        const secondCallback = vi.fn();
        const recoveredSwitch = app.switchToBackend('profile-recovered');
        await started[1];
        const secondPopup = notifications.show('New target action', {
            duration: 50_000,
            action: { text: 'Open target', callback: secondCallback },
        });
        const secondEntry = notifications['entries'][0];
        expect(secondPopup.querySelector('.toast-action-btn').disabled).toBe(
            true,
        );
        expect(overlay.classList).not.toContain('hidden');
        gates[1].resolve({ ok: true, status: 200 });
        await recoveredSwitch;
        expect(notifications['actionsBlocked']).toBe(false);
        expect(
            document.querySelector('#notifications-routing-status').classList,
        ).toContain('hidden');
        expect(secondPopup.querySelector('.toast-action-btn').disabled).toBe(
            false,
        );
        notifications.activate(secondEntry.id);
        expect(secondCallback).toHaveBeenCalledOnce();
        expect(firstCallback).not.toHaveBeenCalled();
        expect(
            activeFetch.mock.calls.filter(
                ([url]) => String(url) === '/__phi/active',
            ),
        ).toHaveLength(2);
        notifications.destroy();
        globalThis.fetch = originalFetch;
        window.fetch = originalFetch;
    });

    it('does not unblock for a superseded response or an invalidated target store', async () => {
        app = new App();
        const notifications = app.getNotifications();
        const gates = [];
        const startResolvers = [];
        const started = [0, 1, 2].map(
            (index) =>
                new Promise((resolve) => {
                    startResolvers[index] = resolve;
                }),
        );
        const originalFetch = globalThis.fetch;
        const activeFetch = vi.fn((url, options) => {
            if (String(url) === '/__phi/active') {
                const index = gates.length;
                let resolve;
                const response = new Promise((done) => {
                    resolve = done;
                });
                gates.push({ resolve, options });
                startResolvers[index]?.();
                return response;
            }
            return originalFetch(url, options);
        });
        globalThis.fetch = activeFetch;
        window.fetch = activeFetch;

        const first = app.switchToBackend('profile-A');
        await started[0];
        const second = app.switchToBackend('profile-B');
        gates[0].resolve({ ok: true, status: 200 });
        await first;
        await started[1];
        expect(getEmbeddedProfileId()).toBe('profile-B');
        expect(notifications['actionsBlocked']).toBe(true);

        backendStores.delete('profile-B');
        gates[1].resolve({ ok: true, status: 200 });
        await second;
        expect(notifications['actionsBlocked']).toBe(true);
        expect(
            sessionStorage.getItem('phi_notification_actions_blocked_v1'),
        ).toBe('1');

        const third = app.switchToBackend('profile-B');
        await started[2];
        const callback = vi.fn();
        const popup = notifications.show('Confirmed target action', {
            duration: 50_000,
            action: { text: 'Open', callback },
        });
        gates[2].resolve({ ok: true, status: 200 });
        await third;
        expect(
            activeFetch.mock.calls.filter(
                ([url]) => String(url) === '/__phi/active',
            ),
        ).toHaveLength(3);
        expect(notifications['actionsBlocked']).toBe(false);
        expect(popup.querySelector('.toast-action-btn').disabled).toBe(false);
        notifications.activate(notifications['entries'][0].id);
        expect(callback).toHaveBeenCalledOnce();
        notifications.destroy();
        globalThis.fetch = originalFetch;
        window.fetch = originalFetch;
    });

    it('clears only the forgotten notification store before deleting its cache', () => {
        setEmbeddedBackend('forget-active', '');
        app = new App();
        const notifications = app.getNotifications();
        const activeStore = app.getActiveStore();
        const inactiveId = 'forget-inactive';
        const inactiveStore = backendStores.get(inactiveId);
        inactiveStore.notifications = [
            {
                id: 'inactive-1',
                type: 'info',
                title: 'Inactive',
                message: 'Keep for inactive before delete',
                timestamp: 1,
            },
        ];
        localStorage.setItem(
            `phi_notifications_v1:${inactiveId}`,
            JSON.stringify({
                version: 1,
                entries: inactiveStore.notifications,
            }),
        );
        notifications.show('Active history', { duration: 0 });
        localStorage.setItem(
            'phi_notifications_v1:forget-active',
            JSON.stringify({ version: 1, entries: activeStore.notifications }),
        );

        app.forgetBackend(inactiveId);
        expect(inactiveStore.notifications).toBeNull();
        expect(
            localStorage.getItem(`phi_notifications_v1:${inactiveId}`),
        ).toBeNull();
        expect(notifications['entries']).toHaveLength(1);

        app.forgetBackend('forget-active');
        expect(activeStore.notifications).toBeNull();
        expect(notifications['entries']).toHaveLength(0);
        expect(
            localStorage.getItem('phi_notifications_v1:forget-active'),
        ).toBeNull();
        notifications.destroy();
    });
});
