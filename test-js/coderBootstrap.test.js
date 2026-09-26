// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { App } from '../web/app.js';
import { SessionsManager } from '../web/sessions.js';
import { visibleCoders } from '../web/coders.js';

setupDomHarness();

const html = readFileSync('web/index.html', 'utf8');
const staticSidebar = html.match(
    /<div class="coder-selector" id="coder-selector">[\s\S]*?<\/div>/,
)?.[0];
const staticQuickLaunch = html.match(
    /<div\s+class="empty-quick-launch"\s+id="empty-quick-launch"\s*>[\s\S]*?<\/div>/,
)?.[0];
const ids = (selector) =>
    [...document.querySelectorAll(selector)].map((el) => el.dataset.coder);

function expectBuiltInSidebar() {
    const buttons = [...document.querySelectorAll('.coder-tab')].slice(0, 5);
    expect(buttons.map((b) => b.dataset.coder)).toEqual([
        'opencode',
        'claude',
        'agy',
        'pi',
        'bash',
    ]);
    expect(buttons.map((b) => b.title)).toEqual([
        'OpenCode',
        'Claude Code',
        'Antigravity / Agy',
        'Pi (term)',
        'Shell Prompt',
    ]);
    expect(buttons.map((b) => b.querySelector('img.coder-logo')?.alt)).toEqual([
        'OpenCode',
        'Claude',
        'Agy',
        'Pi',
        'Shell',
    ]);
    expect(
        buttons.map((b) => b.querySelectorAll(':scope > span').length),
    ).toEqual([1, 1, 1, 1, 1]);
}

describe('default coder UI parity', () => {
    it('keeps the pre-JS buttons, logo structure, titles, quick-launch order, and in-memory selection', async () => {
        expect(staticSidebar).toBeTruthy();
        expect(staticQuickLaunch).toBeTruthy();
        document.body.innerHTML = `${staticSidebar}${staticQuickLaunch}`;
        // Before any fetch or script render, the built-in controls exist.
        expectBuiltInSidebar();
        expect(ids('.empty-launch-btn')).toEqual([
            'opencode',
            'claude',
            'pi',
            'agy',
            'bash',
        ]);
        expect(document.querySelector('.coder-tab.active').dataset.coder).toBe(
            'opencode',
        );

        const descriptor = (id, order, label, name, logo) => ({
            id,
            order,
            name,
            short_label: label,
            logo,
            sidebar_visible: true,
            input_mode: 'staged',
            presets: [],
            capabilities: { list: false },
        });
        const fetcher = mockFetch((url) => {
            expect(url).toBe('/api/coders');
            return {
                agy: descriptor(
                    'agy',
                    2,
                    'Agy',
                    'Antigravity',
                    'vendor/logos/agy.png',
                ),
                bash: descriptor(
                    'bash',
                    4,
                    'Shell',
                    'Shell',
                    'vendor/logos/bash.jpg',
                ),
                claude: descriptor(
                    'claude',
                    1,
                    'Claude',
                    'Claude Code',
                    'vendor/logos/claude.png',
                ),
                opencode: {
                    ...descriptor(
                        'opencode',
                        0,
                        'OpenCode',
                        'OpenCode',
                        'vendor/logos/opencode.png',
                    ),
                    presets: [{ name: '/exit', value: '/exit\r' }],
                },
                pi: descriptor(
                    'pi',
                    3,
                    'Pi',
                    'Pi Coder',
                    'vendor/logos/pi.png',
                ),
                'custom-agent': {
                    ...descriptor(
                        'custom-agent',
                        5,
                        'Custom',
                        'Custom Agent',
                        'emoji:🤖',
                    ),
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
            'pi',
            'bash',
            'custom-agent',
        ]);

        // A stale preference written by the registry release must not
        // override the original OpenCode-on-reload behavior.
        localStorage.setItem('phi_active_coder', 'claude');
        const sidebar = { activeCoder: 'opencode', loadSessions: vi.fn() };
        SessionsManager.prototype.renderCoderTabs.call(sidebar);
        SessionsManager.prototype.renderQuickLaunchButtons.call(sidebar);
        expectBuiltInSidebar();
        expect(ids('.empty-launch-btn')).toEqual([
            'opencode',
            'claude',
            'pi',
            'agy',
            'bash',
            'custom-agent',
        ]);
        expect(sidebar.activeCoder).toBe('opencode');
        expect(sidebar.loadSessions).not.toHaveBeenCalled();
        expect(document.querySelector('.coder-tab.active').dataset.coder).toBe(
            'opencode',
        );
        expect(
            document.querySelector('[data-coder="custom-agent"] .coder-logo')
                .textContent,
        ).toBe('🤖');

        sidebar.activeCoder = 'agy';
        SessionsManager.prototype.renderCoderTabs.call(sidebar);
        expect(sidebar.activeCoder).toBe('agy');
        expect(document.querySelector('.coder-tab.active').dataset.coder).toBe(
            'agy',
        );
    });

    it('delegates exactly one click to static and rebuilt quick-launch buttons', () => {
        document.body.innerHTML = `${staticSidebar}${staticQuickLaunch}`;
        const button = document.createElement('button');
        const ctx = {
            newSessionBtn: button,
            workspaceSelect: document.createElement('select'),
            addWorkspaceBtn: button,
            removeWorkspaceBtn: button,
            wsModalClose: button,
            wsModalCancelBtn: button,
            wsModalAddBtn: button,
            wsModalInput: document.createElement('input'),
            loadSessions: vi.fn(),
            switchCoder: vi.fn(),
            spawnNewSession: vi.fn(),
            activeCoder: 'opencode',
            quickLaunchReady: false,
        };
        SessionsManager.prototype.setupEventListeners.call(ctx);
        document.querySelector('.coder-tab[data-coder="claude"]').click();
        expect(ctx.activeCoder).toBe('claude');
        expect(localStorage.getItem('phi_active_coder')).toBeNull();
        expect(ctx.loadSessions).toHaveBeenCalledTimes(1);

        const quick = document.getElementById('empty-quick-launch');
        quick.querySelector('[data-coder="pi"]').click();
        expect(ctx.spawnNewSession).not.toHaveBeenCalled();
        ctx.quickLaunchReady = true;
        quick.querySelector('[data-coder="pi"]').click();
        expect(ctx.spawnNewSession).toHaveBeenCalledTimes(1);
        quick.innerHTML =
            '<button class="empty-launch-btn" data-coder="agy">Agy</button>';
        quick.querySelector('button').click();
        expect(ctx.spawnNewSession).toHaveBeenCalledTimes(2);
        expect(ctx.switchCoder.mock.calls).toEqual([['pi'], ['agy']]);
    });
});
