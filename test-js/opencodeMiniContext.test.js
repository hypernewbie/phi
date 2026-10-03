// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';

setupDomHarness();

async function harness(mode = 'tui') {
    vi.resetModules();
    mockFetch(() => ({
        opencode: {
            name: 'OpenCode',
            sidebar_visible: true,
            input_mode: 'staged',
            capabilities: { list: true, transcript: true },
            opencode_mode: mode,
            presets: [{ name: '/models', value: '/models\r' }],
            opencode_mini_presets: [{ name: 'menu', value: '\x10' }],
        },
    }));
    const coders = await import('../web/coders.js');
    await coders.loadCoderRegistry();
    const { SessionsManager } = await import('../web/sessions.js');
    const button = document.createElement('button');
    document.body.innerHTML =
        '<div id="coder-selector"><button class="coder-tab" data-coder="opencode">OpenCode</button></div><div id="empty-quick-launch"><button class="empty-launch-btn" data-coder="opencode">OpenCode</button></div>';
    const ctx = Object.assign(Object.create(SessionsManager.prototype), {
        newSessionBtn: button,
        workspaceSelect: document.createElement('select'),
        addWorkspaceBtn: button,
        removeWorkspaceBtn: button,
        wsModalClose: button,
        wsModalCancelBtn: button,
        wsModalAddBtn: button,
        wsModalInput: document.createElement('input'),
        activeCoder: 'opencode',
        activeCWD: '/repo',
        activeWorkspace: 'ws',
        quickLaunchReady: true,
        loadSessions: vi.fn(),
        switchCoder: vi.fn(),
        spawnNewSession: vi.fn(),
        launchSession: vi.fn(),
    });
    document.body.appendChild(button);
    ctx.setupEventListeners();
    return { ctx, button, coders, SessionsManager };
}

beforeEach(() => {
    vi.useRealTimers();
});

describe('OpenCode Mini is explicit and per launch', () => {
    it.each([
        '#coder-selector button',
        '#empty-quick-launch button',
        'new-session',
    ])('offers Open Mini on right-click only (%s)', async (selector) => {
        const { ctx, button } = await harness();
        const target =
            selector === 'new-session'
                ? button
                : document.querySelector(selector);
        target.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
        );
        const item = document.querySelector('.session-ctx-item');
        expect(item.textContent).toBe('Open Mini');
        expect(ctx.spawnNewSession).not.toHaveBeenCalled();
        item.click();
        expect(ctx.spawnNewSession).toHaveBeenCalledWith(true);
        expect(document.querySelector('.session-ctx-menu')).toBeNull();
    });

    it('left-click remains the normal launch', async () => {
        const { ctx } = await harness();
        document.querySelector('#empty-quick-launch button').click();
        expect(ctx.spawnNewSession).toHaveBeenCalledWith();
    });

    it('saved sessions get Open Mini without changing normal Launch', async () => {
        const { ctx } = await harness();
        const row = document.createElement('div');
        document.body.appendChild(row);
        ctx._showSessionContextMenu(new MouseEvent('contextmenu'), row, {
            id: 'ses',
            title: 'Session',
        });
        const items = [...document.querySelectorAll('.session-ctx-item')];
        items.find((item) => item.textContent === 'Open Mini').click();
        expect(ctx.launchSession).toHaveBeenCalledWith(
            'ses',
            'Session',
            [],
            true,
        );
    });

    it('does not offer Mini when the legacy backend is selected', async () => {
        const { ctx, button } = await harness('legacy');
        button.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
        );
        expect(document.querySelector('.session-ctx-menu')).toBeNull();
        expect(ctx.spawnNewSession).not.toHaveBeenCalled();
    });

    it('pins a Mini request and its returned mode while the active coder changes', async () => {
        const { ctx, SessionsManager } = await harness();
        let complete;
        const fetcher = mockFetch(
            () =>
                new Promise((resolve) => {
                    complete = resolve;
                }),
        );
        const createTab = vi.fn();
        ctx.app = { tabManager: { createTab }, showToast: vi.fn() };
        const launch = SessionsManager.prototype.spawnNewSession.call(
            ctx,
            true,
        );
        expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
            coder: 'opencode',
            cwd: '/repo',
            opencode_mini: true,
        });
        ctx.activeCoder = 'claude';
        ctx.activeCWD = '/other';
        ctx.activeWorkspace = 'other';
        complete({ pane_id: 'pane', session_id: '', opencode_mode: 'mini' });
        await launch;
        expect(createTab.mock.calls[0].slice(3, 6)).toEqual([
            'opencode',
            'ws',
            '/repo',
        ]);
        expect(createTab.mock.calls[0][10]).toBe('mini');
    });

    it('Mini and full tabs use different preset sets without changing the registry default', async () => {
        const { coders } = await harness();
        const { TabManager } = await import('../web/terminal.js');
        const mini = {
            coder: 'opencode',
            opencodeMode: 'mini',
            directMode: false,
        };
        const tm = Object.assign(Object.create(TabManager.prototype), {
            app: {
                codersPresetRegistry: { opencode: coders.getCoder('opencode') },
                sessionsManager: {},
            },
            presetsContainer: document.createElement('div'),
            getActiveTab: () => mini,
            _updatePiThinkingButton: vi.fn(),
        });
        tm.renderPresets('opencode');
        const names = [
            ...tm.presetsContainer.querySelectorAll('.preset-btn'),
        ].map((p) => p.innerText);
        expect(names).toContain('menu');
        expect(names).not.toContain('/models');
        expect(coders.getCoder('opencode').opencode_mode).toBe('tui');
    });
});
