// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://127.0.0.1:17170/"}
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { SyncManager } from '../web/sync.js';

setupDomHarness();
let manager;
afterEach(() => {
    clearInterval(manager?.pollInterval);
    vi.useRealTimers();
});

function newManager(handler = () => ({ messages: [] }), app = {}) {
    document.body.innerHTML = '<div id="sync-panel"></div>';
    const requests = mockFetch(handler);
    // Each test controls refresh timing. Startup itself is covered below.
    vi.spyOn(SyncManager.prototype, 'startPolling').mockImplementationOnce(
        () => {},
    );
    manager = new SyncManager({
        sessionsManager: { config: {} },
        showToast: vi.fn(),
        ...app,
    });
    return requests;
}

const push = (over = {}) => ({
    message_id: 'm-1',
    sender: 'laptop-a',
    recipient: 'pane-b',
    value: 'hello from another agent',
    updated_at_unix_ms: 1_700_000_000_000,
    ...over,
});

describe('Syncboard addressed messages', () => {
    it('renders literal content newest first, with readable direction and truncation', () => {
        newManager();
        manager.renderPushes([
            push({
                message_id: 'old',
                value: 'older',
                updated_at_unix_ms: 1_000,
            }),
            push({
                message_id: 'new',
                value: '<img src=x onerror=alert(1)>',
                updated_at_unix_ms: 2_000,
                truncated: true,
            }),
        ]);
        const cards = [...manager.pushList.children];
        expect(cards.map((card) => card.dataset.messageId)).toEqual([
            'new',
            'old',
        ]);
        expect(cards[0].querySelector('.sync-card-key').textContent).toBe(
            'laptop-a → pane-b',
        );
        expect(cards[0].querySelector('.sync-card-value').textContent).toBe(
            '<img src=x onerror=alert(1)>',
        );
        expect(cards[0].querySelector('img')).toBeNull();
        expect(
            cards[0].querySelector('.sync-card-footer').textContent,
        ).toContain('preview limited to 4 KiB');
        manager.renderPushes([]);
        expect(manager.pushSection.classList.contains('hidden')).toBe(true);
        expect(manager.pushList.children).toHaveLength(0);
    });

    it('keeps native disclosure state and keyboard focus across background refresh', () => {
        newManager();
        manager.renderPushes([push()]);
        const card = manager.pushList.firstElementChild;
        card.open = true;
        card.dispatchEvent(new Event('toggle'));
        card.querySelector('summary').focus();
        manager.renderPushes([push()]);
        expect(manager.pushList.firstElementChild.open).toBe(true);
        expect(document.activeElement).toBe(
            manager.pushList.querySelector('summary'),
        );
    });

    it('fetches this Phi even when the remote board hangs', async () => {
        const requests = newManager((url) =>
            url === '/api/sync/pushes'
                ? { messages: [push()] }
                : new Promise(() => {}),
        );
        manager.app.sessionsManager.config.sync_coordinator =
            'https://remote.example:7443';
        void manager.refreshMessages();
        await vi.waitFor(() =>
            expect(manager.pushList.children).toHaveLength(1),
        );
        expect(
            requests.mock.calls.some(([url]) => url === '/api/sync/pushes'),
        ).toBe(true);
        expect(
            requests.mock.calls
                .filter(([url]) => String(url).includes('proxy'))
                .every(
                    ([url]) =>
                        !decodeURIComponent(url).includes('/api/sync/pushes'),
                ),
        ).toBe(true);
    });

    it('paints the persisted last good answer before the startup request finishes', async () => {
        const store = { responses: new Map() };
        newManager(() => ({ messages: [push()] }), {
            getActiveStore: () => store,
        });
        await manager.refreshPushes();
        expect(store.responses.get('/api/sync/pushes')).toContain('m-1');
        // A fresh manager, with no memory cache and a stalled network.
        mockFetch(() => new Promise(() => {}));
        document.body.innerHTML = '<div id="sync-panel"></div>';
        manager = new SyncManager({
            sessionsManager: { config: {} },
            showToast: vi.fn(),
        });
        expect(manager.pushList.children).toHaveLength(1);
        expect(manager.pushList.textContent).toContain(
            'hello from another agent',
        );
        // Release the background read without waiting for its five-second deadline.
        manager._pushRefresh.abort();
    });

    it.each([
        () => {
            throw new TypeError('offline');
        },
        () => ({ ok: false, status: 502 }),
        () => ({ messages: [null] }),
        () => ({ messages: [push({ value: { invalid: true } })] }),
    ])(
        'preserves the last good list on transport or malformed-response failure',
        async (handler) => {
            newManager(handler);
            manager.renderPushes([push()]);
            await manager.refreshPushes();
            expect(manager.pushList.textContent).toContain(
                'hello from another agent',
            );
            expect(
                manager.pushSection.querySelector('[role=status]').textContent,
            ).toContain('Refresh unavailable');
            mockFetch(() => ({ messages: [] }));
            await manager.refreshPushes();
            expect(manager.pushSection.classList.contains('hidden')).toBe(true);
        },
    );

    it('bounds concurrent refreshes and recovers after a background timeout', async () => {
        vi.useFakeTimers();
        const requests = newManager(
            (_url, options) =>
                new Promise((_resolve, reject) => {
                    options.signal.addEventListener('abort', () =>
                        reject(new DOMException('aborted', 'AbortError')),
                    );
                }),
        );
        manager.renderPushes([push()]);
        const pending = manager.refreshPushes();
        await manager.refreshPushes();
        expect(requests).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(5000);
        await pending;
        expect(manager.pushList.children).toHaveLength(1);
        expect(
            manager.pushSection.querySelector('[role=status]').textContent,
        ).toContain('Refresh unavailable');
        mockFetch(() => ({ messages: [push({ value: 'back online' })] }));
        await manager.refreshPushes();
        expect(manager.pushList.textContent).toContain('back online');
    });

    it('does not paint an old backend reply into a newly selected server', async () => {
        let finish;
        let scope = { aborted: false };
        let store = { responses: new Map() };
        newManager(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
            { getActiveStore: () => store },
        );
        manager.app.scope = scope;
        const oldRead = manager.refreshPushes();
        scope = { aborted: false };
        store = { responses: new Map() };
        manager.app.scope = scope;
        manager.restorePushes(store);
        finish({ messages: [push()] });
        await oldRead;
        expect(manager.pushList.children).toHaveLength(0);
        expect(store.responses.size).toBe(0);
    });
});
