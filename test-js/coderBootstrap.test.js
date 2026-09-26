// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { App } from '../web/app.js';
import { SessionsManager } from '../web/sessions.js';
import { visibleCoders } from '../web/coders.js';

setupDomHarness();

describe('coder bootstrap', () => {
    it('fetches once, exposes presets, preserves server order, and restores the initial selection', async () => {
        const descriptor = (id, order, presets = []) => ({
            id,
            order,
            name: id,
            sidebar_visible: true,
            input_mode: 'staged',
            presets,
            capabilities: { list: false },
        });
        // Go encodes the ID-keyed /api/coders map alphabetically, not in
        // the manager's sidebar order. Order must survive on each entry.
        const fetcher = mockFetch((url) => {
            expect(url).toBe('/api/coders');
            return {
                agy: descriptor('agy', 2),
                claude: descriptor('claude', 1),
                opencode: descriptor('opencode', 0, [
                    { name: '/exit', value: '/exit\r' },
                ]),
                'custom-agent': {
                    ...descriptor('custom-agent', 3),
                    env: { API_KEY: 'do-not-copy-to-browser-state' },
                },
            };
        });
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const app = { codersPresetRegistry: {} };
        await App.prototype.fetchCoderPresets.call(app);

        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(app.codersPresetRegistry.opencode.presets).toEqual([
            { name: '/exit', value: '/exit\r' },
        ]);
        expect(app.codersPresetRegistry['custom-agent']).not.toHaveProperty(
            'env',
        );
        expect(log.mock.calls.flat().join(' ')).not.toContain('API_KEY');
        expect(visibleCoders().map((coder) => coder.id)).toEqual([
            'opencode',
            'claude',
            'agy',
            'custom-agent',
        ]);

        document.body.innerHTML = '<div id="coder-selector"></div>';
        localStorage.setItem('phi_active_coder', 'claude');
        const sidebar = {
            activeCoder: 'opencode',
            coderTabsInitialized: false,
            loadSessions: vi.fn(),
        };
        SessionsManager.prototype.renderCoderTabs.call(sidebar);
        expect(sidebar.activeCoder).toBe('claude');
        expect(
            [...document.querySelectorAll('.coder-tab')].map((tab) =>
                tab.getAttribute('data-coder'),
            ),
        ).toEqual(['opencode', 'claude', 'agy', 'custom-agent']);
        expect(document.querySelector('.coder-tab.active').dataset.coder).toBe(
            'claude',
        );

        // Later re-renders retain an in-memory choice even if the saved
        // preference still names a different backend.
        sidebar.activeCoder = 'agy';
        SessionsManager.prototype.renderCoderTabs.call(sidebar);
        expect(sidebar.activeCoder).toBe('agy');
        expect(document.querySelector('.coder-tab.active').dataset.coder).toBe(
            'agy',
        );
    });
});
