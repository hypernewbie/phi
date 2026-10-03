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
        },
    }));
    const coders = await import('../web/coders.js');
    await coders.loadCoderRegistry();
    const { SessionsManager } = await import('../web/sessions.js');

    const serviceRow = document.createElement('div');
    serviceRow.id = 'opencode-service-row';
    const serviceBtn = document.createElement('button');
    serviceBtn.id = 'opencode-service-btn';
    const dot = document.createElement('span');
    dot.className = 'opencode-service-dot';
    const label = document.createElement('span');
    label.className = 'opencode-service-label';
    serviceBtn.appendChild(dot);
    serviceBtn.appendChild(label);
    serviceRow.appendChild(serviceBtn);

    const ctx = Object.assign(Object.create(SessionsManager.prototype), {
        openCodeServiceRow: serviceRow,
        openCodeServiceBtn: serviceBtn,
        activeCoder: 'opencode',
        fetchOpenCodeServiceStatus: vi.fn(),
        _startOpenCodeServicePolling: vi.fn(),
        _stopOpenCodeServicePolling: vi.fn(),
    });

    return { ctx, serviceRow, serviceBtn, label };
}

describe('OpenCode service button UI', () => {
    it('shows service row for opencode v2 and hides for other coders', async () => {
        const { ctx, serviceRow } = await harness('tui');
        ctx.updateOpenCodeServiceVisibility();
        expect(serviceRow.style.display).toBe('block');
        expect(ctx.fetchOpenCodeServiceStatus).toHaveBeenCalled();

        ctx.activeCoder = 'claude';
        ctx.updateOpenCodeServiceVisibility();
        expect(serviceRow.style.display).toBe('none');
        expect(ctx._stopOpenCodeServicePolling).toHaveBeenCalled();
    });

    it('hides service row for legacy opencode', async () => {
        const { ctx, serviceRow } = await harness('legacy');
        ctx.updateOpenCodeServiceVisibility();
        expect(serviceRow.style.display).toBe('none');
    });

    it('renders running state with Kill server label and active button', async () => {
        const { ctx, serviceBtn, label } = await harness();
        ctx.renderOpenCodeServiceStatus(true, 2);
        expect(serviceBtn.getAttribute('data-state')).toBe('running');
        expect(serviceBtn.disabled).toBe(false);
        expect(label.textContent).toBe('Kill server');
        expect(serviceBtn.title).toContain('2 active tabs');
    });

    it('renders stopped state with Server off label and disabled button', async () => {
        const { ctx, serviceBtn, label } = await harness();
        ctx.renderOpenCodeServiceStatus(false, 0);
        expect(serviceBtn.getAttribute('data-state')).toBe('stopped');
        expect(serviceBtn.disabled).toBe(true);
        expect(label.textContent).toBe('Server off');
    });

    it('renders error state with retry label and enabled button', async () => {
        const { ctx, serviceBtn, label } = await harness();
        ctx.renderOpenCodeServiceError();
        expect(serviceBtn.getAttribute('data-state')).toBe('error');
        expect(serviceBtn.disabled).toBe(false);
        expect(label.textContent).toBe('Server: retry');
    });

    it('switchCoder hides service button when switching to non-opencode and shows when returning', async () => {
        const { ctx, serviceRow } = await harness('tui');
        ctx.loadSessions = vi.fn();
        ctx.activeCoder = 'opencode';
        ctx.updateOpenCodeServiceVisibility();
        expect(serviceRow.style.display).toBe('block');

        ctx.switchCoder('claude');
        expect(ctx.activeCoder).toBe('claude');
        expect(serviceRow.style.display).toBe('none');
        expect(ctx._stopOpenCodeServicePolling).toHaveBeenCalled();

        ctx.switchCoder('opencode');
        expect(ctx.activeCoder).toBe('opencode');
        expect(serviceRow.style.display).toBe('block');
    });

    it('delegated coderContainer click calls switchCoder and updates visibility', async () => {
        const { ctx, serviceRow } = await harness('tui');
        ctx.loadSessions = vi.fn();
        ctx.spawnNewSession = vi.fn();
        ctx.quickLaunchReady = true;

        const coderContainer = document.createElement('div');
        coderContainer.id = 'coder-selector';
        const opencodeTab = document.createElement('button');
        opencodeTab.className = 'coder-tab active';
        opencodeTab.setAttribute('data-coder', 'opencode');
        const claudeTab = document.createElement('button');
        claudeTab.className = 'coder-tab';
        claudeTab.setAttribute('data-coder', 'claude');
        coderContainer.appendChild(opencodeTab);
        coderContainer.appendChild(claudeTab);
        document.body.appendChild(coderContainer);

        const button = document.createElement('button');
        ctx.newSessionBtn = button;
        ctx.workspaceSelect = document.createElement('select');
        ctx.addWorkspaceBtn = button;
        ctx.removeWorkspaceBtn = button;
        ctx.wsModalClose = button;
        ctx.wsModalBrowseBtn = button;
        ctx.wsModalCancelBtn = button;
        ctx.wsModalAddBtn = button;
        ctx.wsModalInput = document.createElement('input');

        ctx.setupEventListeners =
            Object.getPrototypeOf(ctx).setupEventListeners;
        ctx.setupEventListeners();
        ctx.activeCoder = 'opencode';
        ctx.updateOpenCodeServiceVisibility();
        expect(serviceRow.style.display).toBe('block');

        // Simulate click on Claude tab
        claudeTab.click();
        expect(ctx.activeCoder).toBe('claude');
        expect(serviceRow.style.display).toBe('none');

        // Simulate click back to OpenCode tab
        opencodeTab.click();
        expect(ctx.activeCoder).toBe('opencode');
        expect(serviceRow.style.display).toBe('block');

        coderContainer.remove();
    });
});
