// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { NotificationManager } from '../web/notifications.js';
import {
    BackendStore,
    backendStores,
    MAX_BACKEND_STORES,
} from '../web/backend-store.js';
import { TabManager } from '../web/terminal.js';

setupDomHarness();

let managers = [];
let savedWindowDescriptors = new Map();

function makeManager(options = {}) {
    const manager = new NotificationManager(options);
    managers.push(manager);
    return manager;
}

function replaceWindowProperty(name, value) {
    if (!savedWindowDescriptors.has(name)) {
        savedWindowDescriptors.set(
            name,
            Object.getOwnPropertyDescriptor(window, name),
        );
    }
    Object.defineProperty(window, name, {
        configurable: true,
        writable: true,
        value,
    });
}

async function flushMutations() {
    await Promise.resolve();
    await Promise.resolve();
}

function legacyToast({
    title = 'External',
    message = 'External message',
} = {}) {
    const toast = document.createElement('div');
    toast.className = 'toast toast-error';
    const titleNode = document.createElement('div');
    titleNode.className = 'toast-title';
    titleNode.textContent = title;
    const messageNode = document.createElement('div');
    messageNode.className = 'toast-message';
    messageNode.textContent = message;
    toast.append(titleNode, messageNode);
    return toast;
}

beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(10_000));
});

afterEach(() => {
    for (const manager of managers) manager.destroy();
    managers = [];
    for (const [name, descriptor] of savedWindowDescriptors) {
        if (descriptor) Object.defineProperty(window, name, descriptor);
        else Reflect.deleteProperty(window, name);
    }
    savedWindowDescriptors.clear();
    vi.useRealTimers();
});

describe('NotificationManager', () => {
    it('keeps App.showToast defaults, glyphs, returned popups, and safe text', async () => {
        const { App } = await import('../web/app.js');
        const app = Object.create(App.prototype);
        const info = app.showToast('plain <img src=x onerror=alert(1)>');
        const error = app.showToast('failed', { type: 'error' });
        const success = app.showToast('done', { type: 'success' });

        expect(info).toBeInstanceOf(HTMLElement);
        expect(info.querySelector('.toast-title').textContent).toBe('Notice');
        expect(info.querySelector('.toast-icon').textContent).toBe('ℹ');
        expect(error.querySelector('.toast-title').textContent).toBe('Error');
        expect(error.querySelector('.toast-icon').textContent).toBe('⚠');
        expect(success.querySelector('.toast-title').textContent).toBe('Done');
        expect(success.querySelector('.toast-icon').textContent).toBe('𓆣');
        expect(info.querySelector('.toast-message').textContent).toBe(
            'plain <img src=x onerror=alert(1)>',
        );
        expect(info.querySelector('img')).toBeNull();
        expect(app._defaultStore).toBeTruthy();
        expect(window.__phiShowToast).toBeTypeOf('function');

        app.getNotifications().open();
        expect(
            [...document.querySelectorAll('.notification-item-message')].map(
                (node) => node.textContent,
            ),
        ).toEqual(['done', 'failed', 'plain <img src=x onerror=alert(1)>']);
        app.getNotifications().destroy();
        expect(window.__phiShowToast).toBeUndefined();
    });

    it('keeps expired text in history and expires actions at their original deadline', () => {
        const manager = makeManager();
        const callback = vi.fn();
        const timed = manager.show('Timed message', {
            duration: 50,
            action: { text: 'Undo', callback },
        });
        const persistent = manager.show('Persistent message', {
            duration: 0,
            action: { text: 'Keep', callback },
        });
        manager.open();

        vi.advanceTimersByTime(50);
        expect(timed.classList.contains('show')).toBe(false);
        expect(timed.isConnected).toBe(true);
        expect(
            document.querySelector('.notification-item-message')?.textContent,
        ).toBe('Persistent message');
        const timedRow = [
            ...document.querySelectorAll('.notification-item'),
        ].find((row) => row.textContent.includes('Timed message'));
        expect(timedRow?.querySelector('.notification-item-action')).toBeNull();
        expect(
            [...document.querySelectorAll('.notification-item-action')].map(
                (button) => button.textContent,
            ),
        ).toEqual(['Keep']);

        vi.advanceTimersByTime(200);
        expect(timed.isConnected).toBe(false);
        expect(
            [...document.querySelectorAll('.notification-item-message')].map(
                (node) => node.textContent,
            ),
        ).toEqual(['Persistent message', 'Timed message']);
        expect(callback).not.toHaveBeenCalled();
        expect(persistent.isConnected).toBe(true);
    });

    it('makes programmatic popup dismissal idempotent and retains information-only history', () => {
        const manager = makeManager();
        const callback = vi.fn();
        const toast = manager.show('Undo remains described', {
            duration: 5000,
            action: { text: 'Undo', callback },
        });
        manager.open();

        manager.dismissToast(toast);
        manager.dismissToast(toast);
        expect(toast.classList.contains('show')).toBe(false);
        const row = document.querySelector('.notification-item');
        expect(row?.textContent).toContain('Undo remains described');
        expect(row?.querySelector('.notification-item-action')).toBeNull();
        expect(callback).not.toHaveBeenCalled();

        vi.advanceTimersByTime(200);
        expect(toast.isConnected).toBe(false);
        expect(document.querySelector('.notification-item')).not.toBeNull();
    });

    it('runs an action synchronously once and removes only its own record', () => {
        const manager = makeManager();
        const callback = vi.fn(() => Promise.resolve('done'));
        manager.show('Action notice', {
            duration: 0,
            action: { text: 'Run', callback },
        });
        manager.open();
        const action = document.querySelector('.toast-action-btn');

        action.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        action.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(callback).toHaveBeenCalledTimes(1);
        expect(document.querySelector('.notification-item')).toBeNull();
        expect(document.querySelector('.notifications-empty').textContent).toBe(
            'No notifications yet.',
        );
    });

    it('cleans up a throwing action before allowing its exception to escape', () => {
        const manager = makeManager();
        manager.show('Throwing action', {
            duration: 0,
            action: {
                text: 'Run',
                callback: () => {
                    throw new Error('action failed');
                },
            },
        });
        manager.open();
        const row = document.querySelector('.notification-item');

        expect(() => manager.activate(row.dataset.notificationId)).toThrow(
            'action failed',
        );
        expect(document.querySelector('.notification-item')).toBeNull();
    });

    it('keeps a reentrant notification when the original action completes', () => {
        const manager = makeManager();
        manager.show('Original', {
            duration: 0,
            action: {
                text: 'Create another',
                callback: () => manager.show('Reentrant', { duration: 0 }),
            },
        });
        manager.open();
        const original = document.querySelector('.notification-item');

        manager.activate(original.dataset.notificationId);

        expect(
            [...document.querySelectorAll('.notification-item-message')].map(
                (node) => node.textContent,
            ),
        ).toEqual(['Reentrant']);
    });

    it('does not let a pending animation frame revive a cleared popup', () => {
        const frames = [];
        let nextFrame = 0;
        replaceWindowProperty('requestAnimationFrame', (callback) => {
            frames.push(callback);
            nextFrame += 1;
            return nextFrame;
        });
        replaceWindowProperty('cancelAnimationFrame', vi.fn());
        const manager = makeManager();
        const toast = manager.show('Clear before frame', { duration: 0 });

        manager.dismissAll();
        for (const callback of frames) callback(0);

        expect(toast.isConnected).toBe(false);
        expect(toast.classList.contains('show')).toBe(false);
    });

    it('expires a removed popup before a stale drawer action can run', async () => {
        const manager = makeManager();
        const callback = vi.fn();
        const toast = manager.show('Removed popup', {
            duration: 5000,
            action: { text: 'Go', callback },
        });
        manager.open();
        const row = document.querySelector('.notification-item');
        toast.remove();

        manager.activate(row.dataset.notificationId);
        await flushMutations();

        expect(callback).not.toHaveBeenCalled();
        expect(
            document.querySelector('.notification-item-message').textContent,
        ).toBe('Removed popup');
        expect(row.querySelector('.notification-item-action')).toBeNull();
        expect(document.querySelectorAll('.notification-item')).toHaveLength(1);
    });

    it('imports legacy toast text once and retains the row after external removal', async () => {
        const manager = makeManager();
        manager.open();
        const toast = legacyToast({
            title: 'External error',
            message: 'literal <script>text</script>',
        });
        let legacyAction = 0;
        const action = document.createElement('button');
        action.type = 'button';
        action.textContent = 'External action';
        action.addEventListener('click', () => legacyAction++);
        toast.appendChild(action);
        manager['toastContainer'].appendChild(toast);
        await flushMutations();

        expect(document.querySelectorAll('.notification-item')).toHaveLength(1);
        expect(
            document.querySelector('.notification-item-title').textContent,
        ).toBe('External error');
        expect(
            document.querySelector('.notification-item-message').textContent,
        ).toBe('literal <script>text</script>');
        expect(
            document.querySelector('.notification-item-message script'),
        ).toBeNull();
        expect(document.querySelector('.notification-item-action')).toBeNull();

        manager['toastContainer'].appendChild(toast);
        await flushMutations();
        expect(document.querySelectorAll('.notification-item')).toHaveLength(1);
        toast.remove();
        await flushMutations();
        expect(document.querySelectorAll('.notification-item')).toHaveLength(1);
        expect(document.querySelector('.notification-item-action')).toBeNull();
        expect(legacyAction).toBe(0);
    });

    it('drains and marks legacy nodes before dismiss-all, including reinsertion', async () => {
        const manager = makeManager();
        const toast = legacyToast({ message: 'Legacy only' });
        manager['toastContainer'].appendChild(toast);

        manager.dismissAll();
        await flushMutations();
        expect(toast.isConnected).toBe(false);
        expect(document.querySelectorAll('.notification-item')).toHaveLength(0);
        expect(
            document.querySelector('.notifications-dismiss-all').disabled,
        ).toBe(true);

        manager['toastContainer'].appendChild(toast);
        await flushMutations();
        expect(toast.isConnected).toBe(false);
        expect(document.querySelectorAll('.notification-item')).toHaveLength(0);
    });

    it('rejects an action after its deadline even when its timer has not fired', () => {
        const manager = makeManager();
        const callback = vi.fn();
        const toast = manager.show('Throttled timer', {
            duration: 50,
            action: { text: 'Run', callback },
        });
        manager.open();
        const row = document.querySelector('.notification-item');
        vi.setSystemTime(new Date(Date.now() + 51));

        manager.activate(row.dataset.notificationId);

        expect(callback).not.toHaveBeenCalled();
        expect(row.querySelector('.notification-item-action')).toBeNull();
        expect(toast.classList.contains('show')).toBe(false);
    });

    it('groups a, b, a, c into one promoted N tabs ready record', () => {
        const viewTabs = vi.fn();
        const callbacks = [vi.fn(), vi.fn(), vi.fn()];
        const manager = makeManager({ onReadyTabs: viewTabs });
        const ready = (paneId, message, callback) =>
            manager.show(message, {
                title: 'Task Done',
                type: 'info',
                duration: 6000,
                readyPaneId: paneId,
                action: { text: 'Go to tab', callback },
            });
        const first = ready(
            'a',
            'Session "A" is waiting at a prompt.',
            callbacks[0],
        );
        expect(
            ready('b', 'Session "B" completed execution.', callbacks[1]),
        ).toBe(first);
        expect(
            ready('a', 'Session "A" completed execution.', callbacks[2]),
        ).toBe(first);
        expect(ready('c', 'Session "C" is waiting at a prompt.', vi.fn())).toBe(
            first,
        );

        expect(
            document.querySelectorAll('#toast-container > .toast'),
        ).toHaveLength(1);
        expect(first.querySelector('.toast-message').textContent).toBe(
            '3 tabs ready',
        );
        expect(first.querySelector('.toast-action-btn').textContent).toBe(
            'View tabs',
        );
        manager.open();
        expect(document.querySelectorAll('.notification-item')).toHaveLength(1);
        expect(
            document.querySelector('.notification-item-message').textContent,
        ).toBe('3 tabs ready');
        expect(
            document.querySelector('.notification-item-action').textContent,
        ).toBe('View tabs');
        manager.activate(
            document.querySelector('.notification-item').dataset.notificationId,
        );
        expect(viewTabs).toHaveBeenCalledOnce();
        for (const callback of callbacks)
            expect(callback).not.toHaveBeenCalled();
    });

    it('restarts the ready deadline, ignores the old timer, then starts a fresh group', () => {
        const manager = makeManager({ onReadyTabs: vi.fn() });
        const ready = (paneId, message) =>
            manager.show(message, {
                readyPaneId: paneId,
                duration: 6000,
                action: { text: 'Go to tab', callback: vi.fn() },
            });
        manager.open();
        const first = ready('a', 'Session A ready');
        vi.advanceTimersByTime(5000);
        expect(ready('b', 'Session B ready')).toBe(first);
        vi.advanceTimersByTime(5999);
        expect(first.classList.contains('show')).toBe(true);
        expect(
            document.querySelector('.notification-item-action').textContent,
        ).toBe('View tabs');

        vi.advanceTimersByTime(1);
        expect(first.classList.contains('show')).toBe(false);
        expect(
            document.querySelector('.notification-item-message').textContent,
        ).toBe('2 tabs ready');
        expect(document.querySelector('.notification-item-action')).toBeNull();
        vi.advanceTimersByTime(200);
        expect(first.isConnected).toBe(false);

        const fresh = ready('a', 'Fresh session A ready');
        expect(fresh).not.toBe(first);
        expect(
            [...document.querySelectorAll('.notification-item-message')].map(
                (node) => node.textContent,
            ),
        ).toEqual(['Fresh session A ready', '2 tabs ready']);
    });

    it('removes members without extending the deadline and seals an empty group', () => {
        const callbackA = vi.fn();
        const callbackB = vi.fn();
        const manager = makeManager({ onReadyTabs: vi.fn() });
        const ready = (paneId, message, callback) =>
            manager.show(message, {
                readyPaneId: paneId,
                duration: 6000,
                action: { text: 'Go to tab', callback },
            });
        manager.open();
        const first = ready(
            'a',
            'Session A is waiting at a prompt.',
            callbackA,
        );
        ready('b', 'Session B is waiting at a prompt.', callbackB);
        vi.advanceTimersByTime(4000);
        manager.removeReadyPane('b');
        expect(first.querySelector('.toast-message').textContent).toBe(
            'Session A is waiting at a prompt.',
        );
        expect(first.querySelector('.toast-action-btn').textContent).toBe(
            'Go to tab',
        );
        vi.advanceTimersByTime(2000);
        expect(first.classList.contains('show')).toBe(false);
        expect(document.querySelector('.notification-item-action')).toBeNull();
        expect(
            document.querySelector('.notification-item-message').textContent,
        ).toBe('Session A is waiting at a prompt.');

        ready('a', 'Session A is waiting at a prompt.', callbackA);
        ready('b', 'Session B is waiting at a prompt.', callbackB);
        manager.removeReadyPane('a');
        manager.removeReadyPane('b');
        const rows = [
            ...document.querySelectorAll('.notification-item-message'),
        ];
        expect(rows[0].textContent).toBe('Session B is waiting at a prompt.');
        expect(document.querySelector('.notification-item-action')).toBeNull();
        expect(callbackA).not.toHaveBeenCalled();
        expect(callbackB).not.toHaveBeenCalled();
    });

    it('keeps an active bridge announcement after its attention marker clears', () => {
        vi.stubGlobal(
            'Audio',
            class {
                play() {
                    return Promise.resolve();
                }
            },
        );
        const notifications = makeManager();
        const tab = {
            paneId: 'active-pi',
            title: 'Active Pi',
            coder: 'pi',
            isAttention: false,
            tabEl: document.createElement('div'),
        };
        const tabManager = Object.assign(Object.create(TabManager.prototype), {
            app: {
                showToast: (message, options) =>
                    notifications.show(message, options),
            },
            switchTab: vi.fn(),
            updateDocumentTitle: vi.fn(),
            _refreshOverflowDropdown: vi.fn(),
            _refreshHostnameTabsDropdown: vi.fn(),
            getActiveTab: () => tab,
        });

        tabManager._ringPiBridgeBell(tab);
        tabManager._setTabAttention(tab, false);
        notifications.open();

        expect(tab.isAttention).toBe(false);
        expect(
            document.querySelector('.notification-item-message').textContent,
        ).toBe('Session "Active Pi" is waiting at a prompt.');
        expect(
            document.querySelector('.notification-item-action').textContent,
        ).toBe('Go to tab');
    });

    it('traps focus, stops underlying shortcuts, and restores the opener', () => {
        const manager = makeManager();
        const globalKeydown = vi.fn();
        document.addEventListener('keydown', globalKeydown);
        manager.show('Focus row', { duration: 0 });
        manager.trigger.click();
        expect(document.activeElement).toBe(manager.closeButton);

        const close = manager.closeButton;
        const tab = new KeyboardEvent('keydown', {
            key: 'Tab',
            bubbles: true,
            cancelable: true,
        });
        close.dispatchEvent(tab);
        expect(globalKeydown).not.toHaveBeenCalled();

        const shortcut = new KeyboardEvent('keydown', {
            key: 'x',
            ctrlKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true,
        });
        close.dispatchEvent(shortcut);
        expect(globalKeydown).not.toHaveBeenCalled();
        expect(shortcut.defaultPrevented).toBe(false);

        manager.close();
        expect(document.activeElement).toBe(manager.trigger);
        document.removeEventListener('keydown', globalKeydown);
    });

    it('removes its listeners, timers, and created DOM on destroy', () => {
        const manager = makeManager();
        const trigger = manager.trigger;
        const toast = manager.show('Cleanup', { duration: 5000 });
        manager.open();
        const entry = manager['entries'][0];

        manager.destroy();

        expect(entry.timer).toBeNull();
        expect(entry.fadeTimer).toBeNull();
        expect(entry.animation).toBeNull();
        expect(entry.callback).toBeNull();
        expect(toast.isConnected).toBe(false);
        expect(trigger.isConnected).toBe(false);
        expect(document.getElementById('notifications-overlay')).toBeNull();
        expect(document.getElementById('toast-container')).toBeNull();
        const outside = document.createElement('button');
        document.body.appendChild(outside);
        outside.focus();
        expect(document.activeElement).toBe(outside);
    });
});

describe('NotificationManager history cache', () => {
    it('restores text-only history and treats an empty memory snapshot as authoritative', () => {
        localStorage.setItem(
            'saved-history',
            JSON.stringify({
                version: 1,
                entries: [
                    {
                        id: 'cached-1',
                        type: 'success',
                        title: 'Cached',
                        message: 'Information only',
                        timestamp: 123,
                    },
                ],
            }),
        );
        const manager = makeManager();
        const savedStore = new BackendStore('saved');
        manager.setContext('saved-history', savedStore);
        manager.open();

        expect(savedStore.notifications).toEqual([
            {
                id: 'cached-1',
                type: 'success',
                title: 'Cached',
                message: 'Information only',
                timestamp: 123,
            },
        ]);
        expect(
            document.querySelector('.notification-item-message').textContent,
        ).toBe('Information only');
        expect(document.querySelector('.notification-item-action')).toBeNull();
        expect(document.querySelector('#toast-container > .toast')).toBeNull();

        localStorage.setItem(
            'empty-history',
            JSON.stringify({
                version: 1,
                entries: [
                    {
                        id: 'stale-local',
                        type: 'info',
                        title: 'Stale',
                        message: 'Must not replace memory',
                        timestamp: 456,
                    },
                ],
            }),
        );
        const emptyStore = new BackendStore('empty');
        emptyStore.notifications = [];
        manager.setContext('empty-history', emptyStore);
        manager.open();
        expect(emptyStore.notifications).toEqual([]);
        expect(document.querySelector('.notification-item')).toBeNull();
        expect(document.querySelector('.notifications-empty').textContent).toBe(
            'No notifications yet.',
        );
    });

    it('rejects invalid cache records, duplicates, versions, JSON, and oversized input', () => {
        const good = {
            id: 'good',
            type: 'info',
            title: 'Good',
            message: 'Keep only metadata',
            timestamp: 1,
        };
        const invalid = [
            null,
            { ...good, id: '' },
            { ...good, id: 'x'.repeat(65) },
            { ...good, id: 'bad-type', type: 'warning' },
            { ...good, id: 'long-title', title: 't'.repeat(201) },
            { ...good, id: 'long-message', message: 'm'.repeat(2001) },
            { ...good, id: 'bad-time', timestamp: 8_640_000_000_000_001 },
            good,
            { ...good, message: 'Duplicate must be skipped' },
            { ...good, id: 'extra', action: 'discard', paneId: 'discard' },
        ];
        localStorage.setItem(
            'valid-cache',
            JSON.stringify({ version: 1, entries: invalid }),
        );
        const manager = makeManager();
        const validStore = new BackendStore('valid');
        manager.setContext('valid-cache', validStore);
        expect(validStore.notifications.map((entry) => entry.id)).toEqual([
            'good',
            'extra',
        ]);
        expect(Object.keys(validStore.notifications[1]).sort()).toEqual([
            'id',
            'message',
            'timestamp',
            'title',
            'type',
        ]);

        const invalidInputs = [
            ['unsupported', JSON.stringify({ version: 2, entries: [good] })],
            ['malformed', '{ not json'],
            ['oversized', 'x'.repeat(1_500_001)],
        ];
        for (const [key, raw] of invalidInputs) {
            localStorage.setItem(key, raw);
            const store = new BackendStore(key);
            manager.setContext(key, store);
            expect(store.notifications).toEqual([]);
        }
    });

    it('limits restored and live history to the first 100 records', () => {
        const restored = Array.from({ length: 101 }, (_, index) => ({
            id: `loaded-${index}`,
            type: 'info',
            title: 'Loaded',
            message: `Loaded ${index}`,
            timestamp: index,
        }));
        localStorage.setItem(
            'history-limit',
            JSON.stringify({ version: 1, entries: restored }),
        );
        const manager = makeManager();
        const loadedStore = new BackendStore('loaded');
        manager.setContext('history-limit', loadedStore);
        expect(loadedStore.notifications).toHaveLength(100);
        expect(loadedStore.notifications[0].message).toBe('Loaded 0');
        expect(loadedStore.notifications.at(-1).message).toBe('Loaded 99');

        const liveStore = new BackendStore('live');
        manager.setContext('live-history', liveStore);
        const snapshot = liveStore.notifications;
        for (let index = 0; index <= 100; index += 1) {
            manager.show(`Arrival ${index}`, { duration: 0 });
        }
        expect(liveStore.notifications).toBe(snapshot);
        expect(snapshot).toHaveLength(100);
        expect(snapshot[0].message).toBe('Arrival 100');
        expect(snapshot.at(-1).message).toBe('Arrival 1');
    });

    it('keeps live text full while persisting bounded previews and only flat metadata', async () => {
        const manager = makeManager();
        const store = new BackendStore('previews');
        manager.setContext('preview-history', store);
        const title = 'T'.repeat(250);
        const message = 'M'.repeat(2_100);
        const callback = vi.fn();
        const popup = manager.show(message, {
            title,
            duration: 0,
            action: { text: 'Open', callback },
        });
        expect(popup.querySelector('.toast-title').textContent).toHaveLength(
            250,
        );
        expect(popup.querySelector('.toast-message').textContent).toHaveLength(
            2_100,
        );
        expect(store.notifications).toHaveLength(1);
        expect(store.notifications[0].title).toHaveLength(200);
        expect(store.notifications[0].message).toHaveLength(2_000);

        await vi.advanceTimersByTimeAsync(0);
        const saved = JSON.parse(localStorage.getItem('preview-history'));
        expect(saved.version).toBe(1);
        expect(saved.entries[0].title).toHaveLength(200);
        expect(saved.entries[0].message).toHaveLength(2_000);
        expect(Object.keys(saved.entries[0]).sort()).toEqual([
            'id',
            'message',
            'timestamp',
            'title',
            'type',
        ]);
        expect(JSON.stringify(saved)).not.toContain('callback');
        expect(JSON.stringify(saved)).not.toContain('paneId');
    });

    it('increments generated IDs past collisions in loaded history', () => {
        const store = new BackendStore('id-collision');
        store.notifications = [
            {
                id: 'notification-10000-1',
                type: 'info',
                title: 'Cached',
                message: 'Existing',
                timestamp: 10_000,
            },
        ];
        const manager = makeManager();
        manager.setContext('id-collision-history', store);
        vi.setSystemTime(10_000);

        manager.show('New', { duration: 0 });

        expect(store.notifications.map((entry) => entry.id)).toEqual([
            'notification-10000-2',
            'notification-10000-1',
        ]);
    });

    it('preserves array arrival order through equal timestamps and clock rollback', () => {
        const manager = makeManager();
        const store = new BackendStore('clock');
        manager.setContext('clock-history', store);
        const snapshot = store.notifications;
        vi.setSystemTime(10_000);
        manager.show('first', { duration: 0 });
        manager.show('same timestamp', { duration: 0 });
        vi.setSystemTime(9_000);
        manager.show('clock rollback', { duration: 0 });

        expect(store.notifications).toBe(snapshot);
        expect(snapshot.map((entry) => entry.message)).toEqual([
            'clock rollback',
            'same timestamp',
            'first',
        ]);
        expect(snapshot.map((entry) => entry.timestamp)).toEqual([
            9_000, 10_000, 10_000,
        ]);
    });

    it('coalesces writes by captured store/key and flushes pending writes on pagehide', () => {
        const manager = makeManager();
        const writes = vi.spyOn(Storage.prototype, 'setItem');
        const storeA = new BackendStore('A');
        const storeB = new BackendStore('B');
        manager.setContext('history:A', storeA);
        manager.show('A1', { duration: 0 });
        manager.show('A2', { duration: 0 });
        manager.setContext('history:B', storeB);
        manager.show('B1', { duration: 0 });
        expect(localStorage.getItem('history:A')).toBeNull();
        expect(localStorage.getItem('history:B')).toBeNull();

        window.dispatchEvent(new Event('pagehide'));

        expect(
            JSON.parse(localStorage.getItem('history:A')).entries.map(
                (entry) => entry.message,
            ),
        ).toEqual(['A2', 'A1']);
        expect(
            JSON.parse(localStorage.getItem('history:B')).entries.map(
                (entry) => entry.message,
            ),
        ).toEqual(['B1']);
        expect(writes).toHaveBeenCalledTimes(2);
        manager.destroy();
        expect(writes).toHaveBeenCalledTimes(2);
    });

    it('flushes on destroy and keeps A→B→A history in memory when storage writes fail', () => {
        const manager = makeManager();
        const storeA = new BackendStore('A');
        const storeB = new BackendStore('B');
        const setItem = vi
            .spyOn(Storage.prototype, 'setItem')
            .mockImplementation(() => {
                throw new Error('storage blocked');
            });
        manager.setContext('history:A', storeA);
        manager.show('A history', { duration: 0 });
        manager.setContext('history:B', storeB);
        manager.show('B history', { duration: 0 });
        window.dispatchEvent(new Event('pagehide'));
        manager.setContext('history:A', storeA);
        manager.open();

        expect(
            document.querySelector('.notification-item-message').textContent,
        ).toBe('A history');
        expect(storeA.notifications.map((entry) => entry.message)).toEqual([
            'A history',
        ]);
        expect(setItem).toHaveBeenCalledTimes(2);
        manager.destroy();
        expect(setItem).toHaveBeenCalledTimes(3);
    });

    it('keeps dirty writes within the BackendStore limit', async () => {
        const manager = makeManager();
        const writes = vi.spyOn(Storage.prototype, 'setItem');
        for (let index = 0; index < MAX_BACKEND_STORES + 2; index += 1) {
            const store = new BackendStore(`dirty-${index}`);
            manager.setContext(`dirty-key-${index}`, store);
            manager.show(`dirty ${index}`, { duration: 0 });
        }

        await vi.advanceTimersByTimeAsync(0);

        expect(writes).toHaveBeenCalledTimes(MAX_BACKEND_STORES + 1);
    });

    it('keeps cached text when storage reads or writes throw and does not retry', async () => {
        const manager = makeManager();
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('storage blocked');
        });
        const store = new BackendStore('blocked');
        expect(() =>
            manager.setContext('blocked-history', store),
        ).not.toThrow();
        expect(store.notifications).toEqual([]);
        const writes = vi
            .spyOn(Storage.prototype, 'setItem')
            .mockImplementation(() => {
                throw new Error('quota exceeded');
            });
        manager.show('Memory survives', { duration: 0 });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);

        expect(store.notifications.map((entry) => entry.message)).toEqual([
            'Memory survives',
        ]);
        expect(writes).toHaveBeenCalledTimes(1);
    });

    it('rejects actions and stale writes after a snapshot is cleared or evicted', async () => {
        const manager = makeManager();
        const profileId = 'notifications-cache-eviction';
        const store = backendStores.get(profileId);
        manager.setContext(`history:${profileId}`, store);
        const callback = vi.fn();
        manager.show('Old context', {
            duration: 0,
            action: { text: 'Open', callback },
        });
        const snapshot = store.notifications;
        store.clear();
        document.querySelector('.toast-action-btn')?.click();
        await vi.advanceTimersByTimeAsync(0);

        expect(callback).not.toHaveBeenCalled();
        expect(store.notifications).toBeNull();
        expect(localStorage.getItem(`history:${profileId}`)).toBeNull();
        expect(snapshot).toHaveLength(1);
        backendStores.delete(profileId);
    });
});

describe('NotificationManager routing safety', () => {
    it('blocks current and new popup/drawer actions without consuming deadlines', () => {
        const manager = makeManager();
        const callback = vi.fn();
        const nextCallback = vi.fn();
        const popup = manager.show('Current action', {
            duration: 100,
            action: { text: 'Open', callback },
        });
        manager.open();
        const entry = manager['entries'][0];
        const deadline = entry.deadline;

        manager.setActionsBlocked(true);
        expect(
            sessionStorage.getItem('phi_notification_actions_blocked_v1'),
        ).toBe('1');
        expect(
            document.querySelector('#notifications-routing-status').textContent,
        ).toBe(
            'Notification actions unavailable until backend routing is confirmed.',
        );
        expect(popup.querySelector('.toast-action-btn').disabled).toBe(true);
        expect(
            document.querySelector('.notification-item-action').disabled,
        ).toBe(true);
        manager.activate(entry.id);
        expect(callback).not.toHaveBeenCalled();
        expect(entry.callback).toBe(callback);
        expect(entry.deadline).toBe(deadline);

        const nextPopup = manager.show('Arrived while blocked', {
            duration: 0,
            action: { text: 'Open next', callback: nextCallback },
        });
        const nextEntry = manager['entries'][0];
        expect(nextPopup.querySelector('.toast-action-btn').disabled).toBe(
            true,
        );
        expect(nextEntry.rowAction.disabled).toBe(true);
        manager.activate(nextEntry.id);
        expect(nextCallback).not.toHaveBeenCalled();
        expect(nextEntry.callback).toBe(nextCallback);
        expect(nextEntry.deadline).toBeNull();

        vi.advanceTimersByTime(100);
        expect(entry.expired).toBe(true);
        expect(callback).not.toHaveBeenCalled();
        manager.setActionsBlocked(false);
        expect(
            sessionStorage.getItem('phi_notification_actions_blocked_v1'),
        ).toBeNull();
        expect(
            document.querySelector('#notifications-routing-status').classList,
        ).toContain('hidden');
        expect(nextPopup.querySelector('.toast-action-btn').disabled).toBe(
            false,
        );
        manager.activate(nextEntry.id);
        expect(nextCallback).toHaveBeenCalledOnce();
    });

    it('restores the action block after manager recreation until routing is confirmed', () => {
        const first = makeManager();
        first.setActionsBlocked(true);
        first.destroy();

        const second = makeManager();
        const callback = vi.fn();
        const popup = second.show('After reload', {
            duration: 0,
            action: { text: 'Open', callback },
        });
        second.open();

        expect(
            document.querySelector('#notifications-routing-status').classList,
        ).not.toContain('hidden');
        expect(popup.querySelector('.toast-action-btn').disabled).toBe(true);
        second.activate(second['entries'][0].id);
        expect(callback).not.toHaveBeenCalled();
        second.setActionsBlocked(false);
        second.activate(second['entries'][0].id);
        expect(callback).toHaveBeenCalledOnce();
    });

    it('seals the outgoing history, drains legacy additions, and keeps the open drawer', async () => {
        const manager = makeManager();
        const storeA = new BackendStore('route-A');
        const storeB = new BackendStore('route-B');
        const callback = vi.fn();
        manager.setContext('route-A-history', storeA);
        manager.show('Outgoing action', {
            duration: 0,
            action: { text: 'Open', callback },
        });
        manager.open();
        const legacy = legacyToast({
            title: 'Legacy',
            message: 'Queued before switch',
        });
        manager.toastContainer.appendChild(legacy);

        manager.endContext();

        expect(callback).not.toHaveBeenCalled();
        expect(
            document.querySelectorAll('.notification-item-action'),
        ).toHaveLength(0);
        expect(legacy.isConnected).toBe(false);
        expect(storeA.notifications.map((entry) => entry.message)).toEqual([
            'Queued before switch',
            'Outgoing action',
        ]);
        expect(manager['opened']).toBe(true);

        manager.setContext('route-B-history', storeB);
        await flushMutations();
        expect(manager['opened']).toBe(true);
        expect(storeB.notifications).toEqual([]);
        expect(document.querySelectorAll('.notification-item')).toHaveLength(0);
        expect(
            document.querySelector('#notifications-overlay').classList,
        ).not.toContain('hidden');
    });

    it('captures late close failures into the original store as information only', () => {
        const manager = makeManager();
        const storeA = new BackendStore('late-A');
        const storeB = new BackendStore('late-B');
        const callback = vi.fn();
        manager.setContext('late-A-history', storeA);
        manager.show('A live action', {
            duration: 0,
            action: { text: 'Open', callback },
        });
        const captured = manager.captureNotifier();
        manager.endContext();
        manager.setContext('late-B-history', storeB);

        captured('Late DELETE failure', {
            type: 'error',
            title: 'Close failed',
            action: { text: 'Stale action', callback },
        });

        expect(storeA.notifications.map((entry) => entry.message)).toEqual([
            'Late DELETE failure',
            'A live action',
        ]);
        expect(storeB.notifications).toEqual([]);
        expect(document.querySelector('#toast-container > .toast')).toBeNull();
        expect(callback).not.toHaveBeenCalled();

        manager.setContext('late-A-history', storeA);
        manager.open();
        expect(
            [...document.querySelectorAll('.notification-item-message')].map(
                (node) => node.textContent,
            ),
        ).toEqual(['Late DELETE failure', 'A live action']);
        expect(
            document.querySelectorAll('.notification-item-action'),
        ).toHaveLength(0);
    });

    it('drops captured results after clear, eviction, or manager destruction', () => {
        const manager = makeManager();
        const profileId = 'captured-notification-profile';
        const store = backendStores.get(profileId);
        manager.setContext(`captured:${profileId}`, store);
        const captured = manager.captureNotifier();
        manager.show('Before forget', { duration: 0 });
        backendStores.delete(profileId);
        captured('Must be discarded');
        expect(store.notifications).toBeNull();
        expect(localStorage.getItem(`captured:${profileId}`)).toBeNull();

        const other = makeManager();
        const otherStore = new BackendStore('destroyed-capture');
        other.setContext('destroyed-capture-history', otherStore);
        const destroyedCapture = other.captureNotifier();
        other.show('Before destroy', { duration: 0 });
        other.destroy();
        destroyedCapture('Must not return');
        expect(otherStore.notifications.map((entry) => entry.message)).toEqual([
            'Before destroy',
        ]);
    });
});
