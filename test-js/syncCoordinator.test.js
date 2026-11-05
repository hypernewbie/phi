// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://127.0.0.1:17170/"}
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { SyncManager } from '../web/sync.js';

setupDomHarness();

let manager;
afterEach(() => clearInterval(manager?.pollInterval));

/** Requests that hit the board; the panel now also fetches addressed messages. */
const boardCalls = (mock) =>
    mock.mock.calls.filter((call) =>
        // The proxy embeds the target in a query parameter, so compare the
        // decoded URL rather than the encoded request.
        decodeURIComponent(String(call[0])).includes('/api/sync/messages'),
    );

async function startSync(config) {
    document.body.innerHTML = '<div id="sync-panel"></div>';
    const fetchMock = mockFetch(() => []);
    manager = new SyncManager({
        sessionsManager: { config },
        showToast: vi.fn(),
    });
    await vi.waitFor(() => expect(boardCalls(fetchMock).length).toBe(1));
    const target = new URL(
        boardCalls(fetchMock)[0][0],
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
            expect(boardCalls(fetchMock)).toHaveLength(1);
            expect(
                new URL(
                    boardCalls(fetchMock)[0][0],
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

describe('SyncManager refresh resilience', () => {
    // Constructing a manager starts a poll. Let that first poll land before
    // the test installs its own fetch, or its late render races the test.
    async function ready() {
        document.body.innerHTML = '<div id="sync-panel"></div>';
        const initial = mockFetch(() => []);
        manager = new SyncManager({
            sessionsManager: { config: {} },
            showToast: vi.fn(),
        });
        const render = vi.spyOn(manager, 'renderMessages');
        await vi.waitFor(() => expect(initial).toHaveBeenCalled());
        // The initial markup is already empty; only the render call proves
        // the startup request settled before the test changes its mock.
        await vi.waitFor(() => expect(render).toHaveBeenCalledWith([]));
    }

    it('keeps the rendered board when a refresh fails', async () => {
        await ready();
        manager.renderMessages([
            {
                key: 'keep',
                value: 'still here',
                updated_at: new Date().toISOString(),
            },
        ]);
        expect(
            manager.messagesList.querySelectorAll('.sync-card'),
        ).toHaveLength(1);

        mockFetch(() => {
            throw new TypeError('Failed to fetch');
        });
        await manager.refreshMessages();

        expect(
            manager.messagesList.querySelectorAll('.sync-card'),
        ).toHaveLength(1);
        const note = manager.messagesList.querySelector('.sync-error-state');
        expect(note.textContent).toContain('Showing the last board');
    });

    it('reports a failed or unexpected response as offline instead of throwing', async () => {
        await ready();
        mockFetch(() => ({ ok: false, status: 502, json: async () => ({}) }));
        await manager.refreshMessages();
        expect(
            manager.messagesList.querySelector('.sync-error-state').textContent,
        ).toContain('HTTP 502');

        mockFetch(() => ({ ok: true, json: async () => ({ not: 'a list' }) }));
        await manager.refreshMessages();
        expect(
            manager.messagesList.querySelector('.sync-error-state').textContent,
        ).toContain('Unexpected board response');
    });

    it('clears the note once a refresh succeeds', async () => {
        await ready();
        mockFetch(() => {
            throw new TypeError('Failed to fetch');
        });
        await manager.refreshMessages();
        expect(
            manager.messagesList.querySelector('.sync-error-state'),
        ).not.toBeNull();

        mockFetch(() => []);
        await manager.refreshMessages();
        expect(
            manager.messagesList.querySelector('.sync-error-state'),
        ).toBeNull();
    });
});
