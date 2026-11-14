// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { NotificationManager } from '../web/notifications.js';
import { BackendStore } from '../web/backend-store.js';

setupDomHarness();

let managers = [];
const KEY = 'schema-history';

function makeManager() {
    const manager = new NotificationManager();
    managers.push(manager);
    return manager;
}

const entry = (patch = {}) => ({
    id: 'cached-1',
    type: 'info',
    title: 'Cached',
    message: 'Body',
    timestamp: 123,
    ...patch,
});

function restore(envelope) {
    localStorage.setItem(
        KEY,
        typeof envelope === 'string' ? envelope : JSON.stringify(envelope),
    );
    const manager = makeManager();
    const store = new BackendStore(`schema-${Math.random()}`);
    manager.setContext(KEY, store);
    return store.notifications;
}

beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(10_000));
});

afterEach(() => {
    for (const manager of managers) manager.destroy();
    managers = [];
    vi.useRealTimers();
});

describe('stored notification history', () => {
    it('accepts the documented envelope', () => {
        expect(restore({ version: 1, entries: [entry()] })).toEqual([entry()]);
    });

    it('rejects an envelope it does not understand', () => {
        expect(restore({ version: 2, entries: [entry()] })).toEqual([]);
        expect(restore({ version: '1', entries: [entry()] })).toEqual([]);
        expect(restore({ entries: [entry()] })).toEqual([]);
        expect(restore([])).toEqual([]);
        expect(restore('null')).toEqual([]);
        expect(restore('not json at all')).toEqual([]);
        expect(restore({ version: 1, entries: 'nope' })).toEqual([]);
        expect(restore({ version: 1 })).toEqual([]);
    });

    it('ignores storage larger than the 1.5 MB text cap', () => {
        localStorage.setItem(
            KEY,
            `{"version":1,"entries":[${'x'.repeat(1_500_001)}]}`,
        );
        const manager = makeManager();
        const store = new BackendStore('oversized');
        manager.setContext(KEY, store);
        expect(store.notifications).toEqual([]);
    });

    it('drops a malformed entry without losing its neighbours', () => {
        const restored = restore({
            version: 1,
            entries: [
                entry({ id: 'keep-a' }),
                null,
                'junk',
                42,
                entry({ id: 'keep-b' }),
            ],
        });
        expect(restored.map((item) => item.id)).toEqual(['keep-a', 'keep-b']);
    });

    it('bounds the id to 1..64 characters', () => {
        expect(
            restore({
                version: 1,
                entries: [entry({ id: '' }), entry({ id: 'x'.repeat(64) })],
            }).map((item) => item.id),
        ).toEqual(['x'.repeat(64)]);
        expect(
            restore({ version: 1, entries: [entry({ id: 'x'.repeat(65) })] }),
        ).toEqual([]);
    });

    it('accepts only the three toast types', () => {
        for (const type of ['info', 'success', 'error']) {
            expect(
                restore({ version: 1, entries: [entry({ type })] }),
            ).toHaveLength(1);
        }
        for (const type of ['warning', '', 7, null]) {
            expect(restore({ version: 1, entries: [entry({ type })] })).toEqual(
                [],
            );
        }
    });

    it('bounds the persisted preview lengths', () => {
        expect(
            restore({
                version: 1,
                entries: [
                    entry({
                        title: 'T'.repeat(200),
                        message: 'M'.repeat(2000),
                    }),
                ],
            }),
        ).toHaveLength(1);
        expect(
            restore({
                version: 1,
                entries: [entry({ title: 'T'.repeat(201) })],
            }),
        ).toEqual([]);
        expect(
            restore({
                version: 1,
                entries: [entry({ message: 'M'.repeat(2001) })],
            }),
        ).toEqual([]);
    });

    it('keeps only a finite timestamp inside the Date range', () => {
        for (const timestamp of [0, -1, 8_640_000_000_000_000]) {
            expect(
                restore({ version: 1, entries: [entry({ timestamp })] }),
            ).toHaveLength(1);
        }
        for (const timestamp of [
            Number.NaN,
            Number.POSITIVE_INFINITY,
            8_640_000_000_000_001,
            '123',
        ]) {
            expect(
                restore({ version: 1, entries: [entry({ timestamp })] }),
            ).toEqual([]);
        }
    });

    it('drops unknown fields instead of carrying them into the UI', () => {
        const restored = restore({
            version: 1,
            entries: [entry({ action: { text: 'rm -rf', callback: 'x' } })],
        });
        expect(restored).toEqual([entry()]);
    });

    it('keeps the first entry for a duplicated id', () => {
        const restored = restore({
            version: 1,
            entries: [
                entry({ id: 'dup', message: 'first' }),
                entry({ id: 'dup', message: 'second' }),
            ],
        });
        expect(restored).toHaveLength(1);
        expect(restored[0].message).toBe('first');
    });
});

describe('toast options', () => {
    it('falls back to an info toast for an unknown type', () => {
        const manager = makeManager();
        const toast = manager.show('Message', { type: 'warning' });
        expect(toast.classList.contains('toast-info')).toBe(true);
        const error = manager.show('Message', { type: 'error' });
        expect(error.classList.contains('toast-error')).toBe(true);
    });

    it('keeps a valid duration and replaces an invalid one', () => {
        const manager = makeManager();
        // The auto-hide timer is the only timeout a toast schedules, so its
        // delay is the normalized duration.
        const timer = vi.spyOn(globalThis, 'setTimeout');
        const delayFor = (duration) => {
            timer.mockClear();
            manager.show('Message', { duration });
            return timer.mock.calls.map((call) => call[1]);
        };

        expect(delayFor(10)).toEqual([10]);
        expect(delayFor(0)).toEqual([]);
        for (const duration of [-1, Number.NaN, 2_147_483_648, '5']) {
            expect(delayFor(duration), String(duration)).toEqual([6000]);
        }
        timer.mockRestore();
    });
});
