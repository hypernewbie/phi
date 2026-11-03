// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://127.0.0.1:17170/"}
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { SyncManager } from '../web/sync.js';

setupDomHarness();

let manager;
afterEach(() => clearInterval(manager?.pollInterval));

function newManager(fetchHandler) {
    document.body.innerHTML = '<div id="sync-panel"></div>';
    const fetchMock = mockFetch(fetchHandler);
    manager = new SyncManager({
        sessionsManager: { config: {} },
        showToast: vi.fn(),
    });
    return fetchMock;
}

const push = (over = {}) => ({
    message_id: 'm-1',
    seq: 1,
    sender: 'laptop-a',
    recipient: 'pane-b',
    value: 'hello from another agent',
    updated_at_unix_ms: 1_700_000_000_000,
    ...over,
});

describe('Syncboard addressed messages', () => {
    it('stays hidden when nothing was addressed here', () => {
        newManager(() => []);
        manager.renderPushes([]);

        expect(manager.pushSection.classList.contains('hidden')).toBe(true);
        expect(manager.pushList.children).toHaveLength(0);
    });

    it('renders the direction, the body, and reuses the board card', () => {
        newManager(() => []);
        manager.renderPushes([push()]);

        expect(manager.pushSection.classList.contains('hidden')).toBe(false);
        const card = manager.pushList.querySelector('.sync-card');
        expect(card).not.toBeNull();
        expect(card.classList.contains('sync-card-push')).toBe(true);
        expect(card.querySelector('.sync-card-key').textContent).toContain(
            'laptop-a → pane-b',
        );
        expect(card.querySelector('.sync-card-value').textContent).toBe(
            'hello from another agent',
        );
    });

    it('orders newest first like the board', () => {
        newManager(() => []);
        manager.renderPushes([
            push({ message_id: 'old', updated_at_unix_ms: 1_000 }),
            push({ message_id: 'new', updated_at_unix_ms: 2_000 }),
        ]);

        const keys = [...manager.pushList.querySelectorAll('.sync-card-key')];
        expect(keys[0].textContent).toContain('laptop-a');
        expect(manager.pushList.querySelectorAll('.sync-card')).toHaveLength(2);
        // The newest message must be the first card.
        expect(manager.pushList.firstElementChild.textContent).toContain(
            'hello from another agent',
        );
    });

    it('says so when a value was truncated', () => {
        newManager(() => []);
        manager.renderPushes([push({ truncated: true })]);

        expect(
            manager.pushList.querySelector('.sync-card-footer').textContent,
        ).toContain('truncated');
    });

    it('keeps the last good list when the refresh fails', async () => {
        newManager(() => []);
        manager.renderPushes([push()]);

        mockFetch(() => {
            throw new TypeError('Failed to fetch');
        });
        await manager.refreshPushes();

        expect(manager.pushList.querySelectorAll('.sync-card')).toHaveLength(1);
    });

    it('renders from a successful refresh', async () => {
        newManager((url) =>
            decodeURIComponent(String(url)).includes('/api/sync/pushes')
                ? { messages: [push()] }
                : [],
        );
        await manager.refreshPushes();

        expect(manager.pushList.querySelectorAll('.sync-card')).toHaveLength(1);
    });
});
