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

    it('displays dev directly without v prefix if version is dev', async () => {
        mockFetch(() => ({
            version: 'dev',
            commit: 'none',
            date: 'unknown',
            build_source: 'source',
            install_method: 'dev'
        }));

        const app = Object.create(App.prototype);
        app.versionInfo = null;

        await app.loadVersion();

        const btn = document.getElementById('phi-changelog-btn');
        expect(btn.textContent).toBe('dev');
    });
});
