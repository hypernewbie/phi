// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://127.0.0.1:17170/"}
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { SyncManager } from '../web/sync.js';

setupDomHarness();

let manager;
afterEach(() => clearInterval(manager?.pollInterval));

async function startSync(config) {
    document.body.innerHTML = '<div id="sync-panel"></div>';
    const fetchMock = mockFetch(() => []);
    manager = new SyncManager({
        sessionsManager: { config },
        showToast: vi.fn(),
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const target = new URL(
        fetchMock.mock.calls[0][0],
        window.location.origin,
    ).searchParams.get('url');
    return target;
}

describe('SyncManager coordinator', () => {
    it('does not pin the automatic coordinator when focus leaves an unchanged input', async () => {
        await startSync({ sync_coordinator: 'http://localhost:17170' });
        const save = vi.spyOn(manager, 'saveCoordinator');
        manager.coordinatorInput.focus();
        manager.coordinatorInput.blur();
        await Promise.resolve();
        expect(save).not.toHaveBeenCalled();
    });

    it.each(['', 'https://coordinator.example:7443'])(
        'saves an edited coordinator %j once and does not resave it on blur',
        async (value) => {
            await startSync({ sync_coordinator: 'http://localhost:17171' });
            manager.app.sessionsManager.loadConfig = vi.fn(async () => {
                manager.app.sessionsManager.config = {
                    sync_coordinator: value || 'http://localhost:17170',
                };
            });
            manager.coordinatorInput.focus();
            manager.coordinatorInput.value = value;
            manager.coordinatorInput.dispatchEvent(new Event('change'));
            manager.coordinatorInput.blur();
            await vi.waitFor(() =>
                expect(manager.coordinatorInput.value).toBe(
                    value || 'http://localhost:17170',
                ),
            );
            const saves = vi
                .mocked(fetch)
                .mock.calls.filter(
                    ([url]) => url === '/api/config/sync-coordinator',
                );
            expect(saves).toHaveLength(1);
            expect(JSON.parse(saves[0][1].body)).toEqual({
                sync_coordinator: value,
            });
            manager.coordinatorInput.focus();
            manager.coordinatorInput.blur();
            expect(
                vi
                    .mocked(fetch)
                    .mock.calls.filter(
                        ([url]) => url === '/api/config/sync-coordinator',
                    ),
            ).toHaveLength(1);
        },
    );

    it('waits for server config before polling from the embedded shell', async () => {
        const originalLocation = window.location;
        Object.defineProperty(window, 'location', {
            configurable: true,
            value: {
                protocol: 'phi-app:',
                origin: 'phi-app://app',
                href: 'phi-app://app/',
            },
        });
        try {
            document.body.innerHTML = '<div id="sync-panel"></div>';
            const fetchMock = mockFetch(() => []);
            manager = new SyncManager({
                sessionsManager: { config: undefined },
                showToast: vi.fn(),
            });
            expect(fetchMock).not.toHaveBeenCalled();

            manager.app.sessionsManager.config = {
                sync_coordinator: 'http://127.0.0.1:17170',
            };
            await manager.refreshMessages();
            expect(fetchMock).toHaveBeenCalledOnce();
            expect(
                new URL(
                    fetchMock.mock.calls[0][0],
                    'http://127.0.0.1:17170',
                ).searchParams.get('url'),
            ).toBe('http://127.0.0.1:17170/api/sync/messages');
        } finally {
            Object.defineProperty(window, 'location', {
                configurable: true,
                value: originalLocation,
            });
        }
    });

    it.each([undefined, {}, { sync_coordinator: '' }])(
        'uses the page origin, including its port, with config %j',
        async (config) => {
            const target = await startSync(config);
            expect(target).toBe('http://127.0.0.1:17170/api/sync/messages');
            expect(
                document.getElementById('sync-coordinator-input').value,
            ).toBe(window.location.origin);
        },
    );

    it.each(['https://coordinator.example:7443', 'http://localhost:7070'])(
        'preserves an explicitly configured coordinator %s',
        async (url) => {
            expect(await startSync({ sync_coordinator: url })).toBe(
                `${url}/api/sync/messages`,
            );
        },
    );
});
