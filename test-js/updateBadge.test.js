// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { App } from '../web/app.js';

// Phase 7 T1 update-badge tests. The badge appears as a dot on the
// sidebar version button when /api/update/status reports an upgrade
// is available. dev builds never get the badge (server-side skipped,
// client-side defended).

setupDomHarness();

function fixture() {
    document.body.innerHTML = `
        <button id="phi-changelog-btn" class="sidebar-version-btn">v0.7.15</button>
    `;
}

function makeApp() {
    return Object.create(App.prototype);
}

describe('App.renderUpdateBadge', () => {
    beforeEach(fixture);

    it('adds .has-update when update_available=true', () => {
        const a = makeApp();
        a.renderUpdateBadge({
            current: 'v0.7.15',
            latest: 'v0.8.0',
            update_available: true,
            install_method: 'standalone',
            instructions: 'Download the latest release'
        });
        const btn = document.getElementById('phi-changelog-btn');
        expect(btn.classList.contains('has-update')).toBe(true);
        expect(btn.title).toContain('v0.8.0');
        expect(btn.title).toContain('Download');
    });

    it('removes .has-update when no update', () => {
        const a = makeApp();
        const btn = document.getElementById('phi-changelog-btn');
        btn.classList.add('has-update');
        a.renderUpdateBadge({
            current: 'v0.8.0',
            latest: 'v0.8.0',
            update_available: false
        });
        expect(btn.classList.contains('has-update')).toBe(false);
    });

    it('removes .has-update when current=dev (defense in depth)', () => {
        const a = makeApp();
        const btn = document.getElementById('phi-changelog-btn');
        btn.classList.add('has-update');
        a.renderUpdateBadge({
            current: 'dev',
            latest: 'v9.9.9',
            update_available: true
        });
        expect(btn.classList.contains('has-update')).toBe(false);
    });

    it('handles missing badge button gracefully', () => {
        document.body.innerHTML = ''; // no button
        const a = makeApp();
        expect(() => a.renderUpdateBadge({
            current: 'v0.7.15', latest: 'v0.8.0', update_available: true
        })).not.toThrow();
    });
});

describe('App.checkForUpdate', () => {
    beforeEach(fixture);

    it('fetches /api/update/status and applies the badge', async () => {
        const a = makeApp();
        const fakeFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                current: 'v0.7.15',
                latest: 'v0.8.0',
                update_available: true,
                install_method: 'npm',
                instructions: 'npm update -g @hypernewbie/phi-code'
            })
        });
        vi.stubGlobal('fetch', fakeFetch);

        await a.checkForUpdate();

        expect(fakeFetch).toHaveBeenCalledWith('/api/update/status');
        expect(a.updateStatus.latest).toBe('v0.8.0');
        const btn = document.getElementById('phi-changelog-btn');
        expect(btn.classList.contains('has-update')).toBe(true);
    });

    it('does nothing when fetch fails', async () => {
        const a = makeApp();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
        await a.checkForUpdate();
        expect(a.updateStatus).toBeUndefined();
    });

    it('does nothing when fetch throws (offline)', async () => {
        const a = makeApp();
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
        await a.checkForUpdate();
        expect(a.updateStatus).toBeUndefined();
    });
});