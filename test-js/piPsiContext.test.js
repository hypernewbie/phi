// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';

setupDomHarness();

async function harness() {
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
    });
    document.body.appendChild(button);
    ctx.setupEventListeners();
    return { ctx, button, coders, SessionsManager };
}

beforeEach(() => {
    vi.useRealTimers();
});

describe('Psi is explicit and per launch for Pi', () => {
    it.each([
        '#coder-selector button',
        '#empty-quick-launch button',
        'new-session',
    ])('offers Open with Psi on right-click only (%s)', async (selector) => {
        const { ctx, button } = await harness();
        const target =
            selector === 'new-session'
                ? button
                : document.querySelector(selector);
        target.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
        );
        const item = document.querySelector('.session-ctx-item');
        expect(item).not.toBeNull();
        expect(item.textContent).toBe('Open with Psi');
        expect(ctx.spawnNewSession).not.toHaveBeenCalled();
        item.click();
        expect(ctx.spawnNewSession).toHaveBeenCalledWith(false, true);
        expect(document.querySelector('.session-ctx-menu')).toBeNull();
    });

    it('left-click remains the normal launch', async () => {
        const { ctx } = await harness();
        document.querySelector('#empty-quick-launch button').click();
        expect(ctx.spawnNewSession).toHaveBeenCalledWith();
    });

    it('saved Pi sessions get Open with Psi without changing normal Launch', async () => {
        const { ctx } = await harness();
        const row = document.createElement('div');
        document.body.appendChild(row);
        ctx._showSessionContextMenu(new MouseEvent('contextmenu'), row, {
            id: 'pi-ses',
            title: 'Pi Session',
            coder: 'pi',
        });
        const items = [...document.querySelectorAll('.session-ctx-item')];
        const psiItem = items.find(
            (item) => item.textContent === 'Open with Psi',
        );
        expect(psiItem).toBeDefined();
        psiItem.click();
        expect(ctx.launchSession).toHaveBeenCalledWith(
            'pi-ses',
            'Pi Session',
            [],
            false,
            true,
        );
    });

    it('pins a Psi request and passes pi_mode to createTab', async () => {
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
            false,
            true,
        );
        expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
            coder: 'pi',
            cwd: '/repo',
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
