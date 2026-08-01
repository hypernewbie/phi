// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { KanbanManager } from '../web/kanban.js';

// Vikunja hands out a JWT that expires while the board sits open. Only the
// board-load path recovered from that, via initTabContainer's saved-vault
// login, so the board itself would quietly come back but the next thing the
// user touched -- opening a description, saving, dragging -- died with
// "Session expired. Please reconnect."
//
// Re-auth now lives in apiRequest, so every call recovers.

setupDomHarness();

function manager() {
    localStorage.setItem('vikunja_url', 'http://vik.local');
    localStorage.setItem('vikunja_username', 'me');
    sessionStorage.setItem('vikunja_token', 'stale');

    const c = Object.create(KanbanManager.prototype);
    c.app = { showToast: vi.fn() };
    c.taskCache = {};
    c.buckets = [];
    c.currentProjectId = 9;
    c.currentViewId = 5;
    c._reauthPromise = null;
    c.getSavedVaultPassword = vi.fn(async () => 'hunter2');
    c.attemptLogin = vi.fn(async () => 'fresh-token');
    return c;
}

// Fails every request with 401 until a fresh token shows up in the header.
function expiringToken({ freshToken = 'fresh-token' } = {}) {
    const calls = [];
    mockFetch((url, opts) => {
        const auth = opts?.headers?.Authorization || '';
        calls.push({ url: String(url), auth });
        if (auth !== `Bearer ${freshToken}`) return { ok: false, status: 401, text: 'expired' };
        return { ok: true, json: { id: 1, title: 'Recovered' } };
    });
    return calls;
}

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
});

describe('an expired Vikunja session recovers itself', () => {
    it('re-authenticates and replays the call that hit the 401', async () => {
        const c = manager();
        const calls = expiringToken();

        // This is the call the user reported failing: opening a description.
        const task = await c.apiGet('/tasks/1');

        expect(task).toEqual({ id: 1, title: 'Recovered' });
        expect(c.attemptLogin).toHaveBeenCalledWith('http://vik.local', 'me', 'hunter2');
        expect(sessionStorage.getItem('vikunja_token')).toBe('fresh-token');
        // Original attempt with the stale token, then the replay.
        expect(calls.map(c => c.auth)).toEqual(['Bearer stale', 'Bearer fresh-token']);
    });

    it('recovers a write, not just a read', async () => {
        const c = manager();
        expiringToken();

        await expect(c.apiPost('/tasks/1', { title: 'x' })).resolves.toBeTruthy();
        expect(c.attemptLogin).toHaveBeenCalledTimes(1);
    });

    it('logs in once for a burst of parallel 401s', async () => {
        // A board refresh fires several requests together; they all 401.
        const c = manager();
        expiringToken();

        await Promise.all([c.apiGet('/projects'), c.apiGet('/tasks/1'), c.apiGet('/tasks/2')]);

        expect(c.attemptLogin).toHaveBeenCalledTimes(1);
    });

    it('gives up after one retry rather than looping', async () => {
        const c = manager();
        // Login "succeeds" but the token it returns is still rejected.
        c.attemptLogin = vi.fn(async () => 'also-bad');
        const calls = expiringToken();

        await expect(c.apiGet('/tasks/1')).rejects.toThrow(/Session expired/);
        expect(c.attemptLogin).toHaveBeenCalledTimes(1);
        expect(calls).toHaveLength(2);
    });

    it('surfaces the original error when no vault credentials are saved', async () => {
        const c = manager();
        c.getSavedVaultPassword = vi.fn(async () => null);
        expiringToken();

        await expect(c.apiGet('/tasks/1')).rejects.toThrow(/Session expired/);
        expect(c.attemptLogin).not.toHaveBeenCalled();
    });

    it('does not retry when the login itself throws', async () => {
        const c = manager();
        c.attemptLogin = vi.fn(async () => { throw new Error('vikunja down'); });
        expiringToken();

        await expect(c.apiGet('/tasks/1')).rejects.toThrow(/Session expired/);
        expect(c.attemptLogin).toHaveBeenCalledTimes(1);
    });

    it('clears the single-flight guard so a later expiry can recover too', async () => {
        const c = manager();
        expiringToken();
        await c.apiGet('/tasks/1');
        expect(c._reauthPromise).toBeNull();

        // Second expiry, later in the session.
        sessionStorage.setItem('vikunja_token', 'stale-again');
        expiringToken();
        await expect(c.apiGet('/tasks/2')).resolves.toBeTruthy();
        expect(c.attemptLogin).toHaveBeenCalledTimes(2);
    });
});
