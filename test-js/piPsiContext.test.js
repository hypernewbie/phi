// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';

setupDomHarness();

// harness mounts the real coder-tab, empty-launcher, and new-session controls
// against a fake store, so the opposite-agent action is exercised through its
// production event wiring rather than a copy of it. storeMode is the store's
// effective default; null means the default is still unknown.
async function harness(storeMode = null) {
    vi.resetModules();
    mockFetch(() => ({
        pi: {
            name: 'Pi',
            sidebar_visible: true,
            input_mode: 'staged',
            capabilities: { list: true, transcript: true },
            presets: [{ name: '/help', value: '/help\r' }],
        },
    }));
    const coders = await import('../web/coders.js');
    await coders.loadCoderRegistry();
    const { SessionsManager } = await import('../web/sessions.js');
    const button = document.createElement('button');
    document.body.innerHTML =
        '<div id="coder-selector"><button class="coder-tab" data-coder="pi">Pi</button></div><div id="empty-quick-launch"><button class="empty-launch-btn" data-coder="pi">Pi</button></div>';
    const sessionList = document.createElement('div');
    document.body.appendChild(sessionList);
    const ctx = Object.assign(Object.create(SessionsManager.prototype), {
        sessionList,
        sessionRequests: new Map(),
        worktreeReads: new Map(),
        sessionRefreshGeneration: 0,
        sessionRefreshPromise: null,
        newSessionBtn: button,
        workspaceSelect: document.createElement('select'),
        addWorkspaceBtn: button,
        removeWorkspaceBtn: button,
        wsModalClose: button,
        wsModalCancelBtn: button,
        wsModalAddBtn: button,
        wsModalBrowseBtn: document.createElement('button'),
        wsModalInput: document.createElement('input'),
        activeCoder: 'pi',
        activeCWD: '/repo',
        activeWorkspace: 'ws',
        quickLaunchReady: true,
        loadSessions: vi.fn(),
        switchCoder: vi.fn(),
        spawnNewSession: vi.fn(),
        launchSession: vi.fn(),
        app: {
            piLaunchStore: storeMode ? { mode: storeMode } : null,
            tabManager: { createTab: vi.fn() },
            showToast: vi.fn(),
        },
    });
    document.body.appendChild(button);
    ctx.setupEventListeners();
    return { ctx, button, coders, SessionsManager };
}

function openMenu(target) {
    target.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
    return document.querySelector('.session-ctx-item');
}

beforeEach(() => {
    vi.useRealTimers();
});

describe('The opposite agent action follows the default', () => {
    it.each([
        '#coder-selector button',
        '#empty-quick-launch button',
        'new-session',
    ])(
        'offers Open with Psi when the default is Pi or unknown (%s)',
        async (selector) => {
            const { ctx, button } = await harness();
            const target =
                selector === 'new-session'
                    ? button
                    : document.querySelector(selector);
            const item = openMenu(target);
            expect(item).not.toBeNull();
            expect(item.textContent).toBe('Open with Psi');
            expect(ctx.spawnNewSession).not.toHaveBeenCalled();
            item.click();
            expect(ctx.spawnNewSession).toHaveBeenCalledWith(false, 'psi');
            expect(document.querySelector('.session-ctx-menu')).toBeNull();
        },
    );

    it.each([
        '#coder-selector button',
        '#empty-quick-launch button',
        'new-session',
    ])('offers Open with Pi when the default is Psi (%s)', async (selector) => {
        const { ctx, button } = await harness('psi');
        const target =
            selector === 'new-session'
                ? button
                : document.querySelector(selector);
        const item = openMenu(target);
        expect(item.textContent).toBe('Open with Pi');
        item.click();
        expect(ctx.spawnNewSession).toHaveBeenCalledWith(false, 'pi');
    });

    it('left-click remains the normal launch', async () => {
        const { ctx } = await harness();
        document.querySelector('#empty-quick-launch button').click();
        expect(ctx.spawnNewSession).toHaveBeenCalledWith();
    });

    it('saved Pi sessions offer the opposite agent without changing Launch', async () => {
        const { ctx } = await harness('psi');
        const row = document.createElement('div');
        document.body.appendChild(row);
        ctx._showSessionContextMenu(new MouseEvent('contextmenu'), row, {
            id: 'pi-ses',
            title: 'Pi Session',
            coder: 'pi',
        });
        const items = [...document.querySelectorAll('.session-ctx-item')];
        const piItem = items.find(
            (item) => item.textContent === 'Open with Pi',
        );
        expect(piItem).toBeDefined();
        piItem.click();
        expect(ctx.launchSession).toHaveBeenCalledWith(
            'pi-ses',
            'Pi Session',
            [],
            false,
            'pi',
        );
    });
});

describe('Pi launch requests carry the resolved agent', () => {
    it('pins an explicit Psi request and passes pi_mode to createTab', async () => {
        const { ctx, SessionsManager } = await harness();
        let complete;
        const fetcher = mockFetch(
            () =>
                new Promise((resolve) => {
                    complete = resolve;
                }),
        );
        const createTab = ctx.app.tabManager.createTab;
        const launch = SessionsManager.prototype.spawnNewSession.call(
            ctx,
            false,
            'psi',
        );
        expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
            coder: 'pi',
            cwd: '/repo',
            pi_mode: 'psi',
            pi_psi: true,
        });
        complete({ pane_id: 'pane-psi', session_id: '', pi_mode: 'psi' });
        await launch;
        expect(createTab.mock.calls[0].slice(3, 6)).toEqual([
            'pi',
            'ws',
            '/repo',
        ]);
        expect(createTab.mock.calls[0][2]).toBe('+ Psi');
        expect(createTab.mock.calls[0][12]).toEqual({ piMode: 'psi' });
    });

    it('uses the confirmed default when the caller names no agent', async () => {
        const { ctx, SessionsManager } = await harness('psi');
        const fetcher = mockFetch(() => ({ pane_id: 'p', session_id: '' }));
        await SessionsManager.prototype.spawnNewSession.call(ctx);
        const body = JSON.parse(fetcher.mock.calls[0][1].body);
        expect(body.pi_mode).toBe('psi');
        expect(body.pi_psi).toBe(true);
        expect(body.title).toBe('+ Psi');
    });

    it('leaves the choice to the server when no default is known', async () => {
        // A cold start must not wait for a settings GET, and must not guess Pi:
        // both mode fields are omitted and the returned mode titles the tab.
        const { ctx, SessionsManager } = await harness();
        const fetcher = mockFetch(() => ({
            pane_id: 'p',
            session_id: '',
            pi_mode: 'psi',
        }));
        const createTab = ctx.app.tabManager.createTab;
        await SessionsManager.prototype.spawnNewSession.call(ctx);
        const body = JSON.parse(fetcher.mock.calls[0][1].body);
        expect('pi_mode' in body).toBe(false);
        expect('pi_psi' in body).toBe(false);
        expect(body.title).toBe('');
        expect(createTab.mock.calls[0][2]).toBe('+ Psi');
        expect(createTab.mock.calls[0][12]).toEqual({ piMode: 'psi' });
    });

    it('does not send Pi fields for another coder', async () => {
        const { ctx, SessionsManager } = await harness('psi');
        ctx.activeCoder = 'bash';
        const fetcher = mockFetch(() => ({ pane_id: 'p', session_id: '' }));
        await SessionsManager.prototype.spawnNewSession.call(ctx);
        const body = JSON.parse(fetcher.mock.calls[0][1].body);
        expect('pi_mode' in body).toBe(false);
        expect('pi_psi' in body).toBe(false);
    });

    it('restart keeps the pane agent instead of the configured default', async () => {
        const { TabManager } = await import('../web/terminal.js');
        const fetcher = mockFetch(() => ({
            pane_id: 'p',
            session_id: '',
            ok: false,
        }));
        const noop = () => {};
        const tm = Object.assign(Object.create(TabManager.prototype), {
            app: { piLaunchStore: { mode: 'pi' } },
            tabs: new Map([['old', {}]]),
            activePaneId: 'old',
            _invalidatePiBridgeThinking: noop,
            _invalidatePiBridgeCompact: noop,
            _invalidatePiBridgeReload: noop,
        });
        const termContainer = document.createElement('div');
        tm.restartTab({
            paneId: 'old',
            coder: 'pi',
            piMode: 'psi',
            cwd: '/repo',
            sessionId: 'sid',
            title: 'Saved',
            workspace: 'ws',
            termContainer,
            tabEl: document.createElement('div'),
        });
        const body = JSON.parse(fetcher.mock.calls[0][1].body);
        expect(body.pi_mode).toBe('psi');
        expect(body.pi_psi).toBe(true);
    });

    it('hides attachment control when tab is running in psi mode', async () => {
        const { TabManager } = await import('../web/terminal.js');
        const attachInputBtn = document.createElement('button');
        const tm = Object.assign(Object.create(TabManager.prototype), {
            attachInputBtn,
            _restoreAttachmentDraft: vi.fn(),
            _updatePiThinkingButton: vi.fn(),
        });

        // Normal Pi tab -> visible
        tm._updateAttachmentControl({ coder: 'pi', piMode: null });
        expect(attachInputBtn.classList.contains('hidden')).toBe(false);

        // Psi Pi tab -> hidden
        tm._updateAttachmentControl({ coder: 'pi', piMode: 'psi' });
        expect(attachInputBtn.classList.contains('hidden')).toBe(true);
    });
});
