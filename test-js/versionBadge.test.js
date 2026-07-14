// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { App } from '../web/app.js';

setupDomHarness();

function fixture() {
    document.body.innerHTML = `
        <button id="phi-changelog-btn">v0.7.15</button>
    `;
}

describe('loadVersion in App', () => {
    beforeEach(() => {
        fixture();
    });

    it('fetches version info and updates the sidebar badge text', async () => {
        mockFetch(() => ({
            version: '0.8.0',
            commit: 'abcdef',
            date: '2026-07-12',
            build_source: 'release',
            install_method: 'standalone'
        }));

        const app = Object.create(App.prototype);
        app.versionInfo = null;
        
        await app.loadVersion();

        const btn = document.getElementById('phi-changelog-btn');
        expect(btn.textContent).toBe('v0.8.0');
        expect(app.versionInfo.install_method).toBe('standalone');
    });

    it('keeps the HTML default when the binary reports "dev" (un-stamped build)', async () => {
        // Behavior change (v0.8.2): we no longer overwrite the HTML default
        // with "dev" - the button should always show a useful version
        // string. The HTML ships with the most recent release tag, and
        // /api/version only overrides it when the binary has a real stamp.
        mockFetch(() => ({
            version: 'dev',
            commit: 'none',
            date: 'unknown',
            build_source: 'source',
            install_method: 'dev'
        }));

        // Rebuild the fixture fresh (v0.8.4 is the current default).
        document.body.innerHTML = `
            <button id="phi-changelog-btn">v0.8.4</button>
        `;

        const app = Object.create(App.prototype);
        app.versionInfo = null;

        await app.loadVersion();

        const btn = document.getElementById('phi-changelog-btn');
        // HTML default preserved - not overwritten with "dev".
        expect(btn.textContent).toBe('v0.8.4');
    });
});
