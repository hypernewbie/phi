// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { BackendStore } from '../web/backend-store.js';
import { NotificationManager } from '../web/notifications.js';
import { queueDesktopNotification } from '../web/desktop-notifications.js';

setupDomHarness();

const SLOT = '__phiDesktopNotificationsV1';
const page = () => window;

let manager;
let savedDescriptor;

function useDesktopPage() {
    window.history.replaceState({}, '', '/?desktop=1');
}

function restoreSlot() {
    if (savedDescriptor) {
        Object.defineProperty(window, SLOT, savedDescriptor);
    } else {
        Reflect.deleteProperty(window, SLOT);
    }
    savedDescriptor = undefined;
}

beforeEach(() => {
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('data-phi-desktop-root');
    window.history.replaceState({}, '', '/');
    localStorage.clear();
    sessionStorage.clear();
    savedDescriptor = Object.getOwnPropertyDescriptor(window, SLOT);
    Reflect.deleteProperty(window, SLOT);
});

afterEach(() => {
    manager?.destroy();
    manager = undefined;
    restoreSlot();
});

describe('desktop notification transport', () => {
    it('does not create a queue in an ordinary browser page', () => {
        queueDesktopNotification({
            id: 'n1',
            profileId: 'profile-a',
            title: 'Notice',
            message: 'Message',
            type: 'info',
            timestamp: Date.now(),
        });

        expect(page()[SLOT]).toBeUndefined();
    });

    it('copies bounded previews and keeps only the newest 100', () => {
        useDesktopPage();
        for (let index = 0; index < 101; index++) {
            queueDesktopNotification({
                id: `n${index}`,
                profileId: 'profile-a',
                title: 't'.repeat(201),
                message: 'm'.repeat(2_001),
                type: 'success',
                timestamp: 10_000 + index,
            });
        }

        const pending = page()[SLOT];
        expect(pending).toHaveLength(100);
        expect(pending[0].id).toBe('n1');
        expect(pending.at(-1)).toMatchObject({
            id: 'n100',
            profileId: 'profile-a',
            title: 't'.repeat(200),
            message: 'm'.repeat(2_000),
            type: 'success',
            timestamp: 10_100,
        });
    });

    it('rejects invalid identity fields without truncating them', () => {
        useDesktopPage();
        const base = {
            id: 'n1',
            profileId: 'profile-a',
            title: 'Notice',
            message: 'Message',
            type: 'info',
            timestamp: Date.now(),
        };
        queueDesktopNotification({ ...base, id: 'x'.repeat(65) });
        queueDesktopNotification({ ...base, profileId: 'x'.repeat(513) });
        queueDesktopNotification({ ...base, profileId: '' });
        queueDesktopNotification({ ...base, timestamp: Number.NaN });

        expect(page()[SLOT]).toBeUndefined();
    });

    it('forwards a new manager entry with its captured profile after local work', () => {
        useDesktopPage();
        const store = new BackendStore('profile-a');
        manager = new NotificationManager({
            storageKey: 'desktop-history',
            store,
        });

        const toast = manager.show('Local message', {
            type: 'error',
            title: 'Local title',
            duration: 0,
        });

        expect(toast.isConnected).toBe(true);
        expect(store.notifications?.[0]).toMatchObject({
            title: 'Local title',
            message: 'Local message',
            type: 'error',
        });
        expect(page()[SLOT]).toHaveLength(1);
        expect(page()[SLOT][0]).toMatchObject({
            profileId: 'profile-a',
            title: 'Local title',
            message: 'Local message',
            type: 'error',
        });
    });

    it('normalizes the default profile to an unscoped native target', () => {
        useDesktopPage();
        manager = new NotificationManager({
            storageKey: 'default-history',
            store: new BackendStore('__default__'),
        });

        manager.show('Default scope', { duration: 0 });

        expect(page()[SLOT]).toHaveLength(1);
        expect(page()[SLOT][0].profileId).toBeNull();
    });

    it('forwards a captured notification with its original profile after a switch', () => {
        useDesktopPage();
        const storeA = new BackendStore('profile-a');
        manager = new NotificationManager({
            storageKey: 'profile-a-history',
            store: storeA,
        });
        const captured = manager.captureNotifier();
        manager.setContext('profile-b-history', new BackendStore('profile-b'));

        captured('Late result', { type: 'success', title: 'Profile A' });

        expect(storeA.notifications?.[0]).toMatchObject({
            title: 'Profile A',
            message: 'Late result',
        });
        expect(page()[SLOT]).toMatchObject([
            {
                profileId: 'profile-a',
                title: 'Profile A',
                message: 'Late result',
            },
        ]);
    });

    it('does not forward history restored into a new manager', () => {
        useDesktopPage();
        const store = new BackendStore('profile-a');
        store.notifications = [
            {
                id: 'restored',
                type: 'info',
                title: 'Old entry',
                message: 'History only',
                timestamp: Date.now(),
            },
        ];
        manager = new NotificationManager({
            storageKey: 'restored-history',
            store,
        });

        expect(page()[SLOT]).toBeUndefined();
    });

    it('forwards live legacy toasts but not constructor-time DOM restoration', async () => {
        useDesktopPage();
        const container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        const restored = document.createElement('div');
        restored.className = 'toast toast-info';
        restored.innerHTML =
            '<strong class="toast-title">Restored</strong><span class="toast-message">History only</span>';
        container.appendChild(restored);
        document.body.appendChild(container);
        manager = new NotificationManager({
            storageKey: 'legacy-history',
            store: new BackendStore('profile-a'),
        });
        expect(page()[SLOT]).toBeUndefined();

        const live = document.createElement('div');
        live.className = 'toast toast-success';
        live.innerHTML =
            '<strong class="toast-title">Legacy</strong><span class="toast-message">Live</span>';
        manager['toastContainer'].appendChild(live);
        await Promise.resolve();
        await Promise.resolve();

        expect(page()[SLOT]).toMatchObject([
            { profileId: 'profile-a', title: 'Legacy', message: 'Live' },
        ]);
    });

    it('keeps local toast and history when the queue slot cannot be replaced', () => {
        useDesktopPage();
        Object.defineProperty(window, SLOT, {
            configurable: true,
            writable: false,
            value: Object.freeze([]),
        });
        manager = new NotificationManager({
            storageKey: 'blocked-desktop-history',
            store: new BackendStore('__default__'),
        });

        expect(() =>
            manager.show('Still local', { duration: 0 }),
        ).not.toThrow();
        expect(document.querySelector('.toast-message')?.textContent).toBe(
            'Still local',
        );
        manager.open();
        expect(
            document.querySelector('.notification-item-message')?.textContent,
        ).toBe('Still local');
        expect(page()[SLOT]).toEqual([]);
    });
});
