// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { SessionsManager } from '../web/sessions.js';

setupDomHarness();

function harness(ready = true) {
    document.body.innerHTML =
        '<div id="coder-selector"><button class="coder-tab" data-coder="bash"><span>Shell</span></button><button class="coder-tab" data-coder="claude">Claude</button></div>';
    const button = document.createElement('button');
    const ctx = Object.assign(Object.create(SessionsManager.prototype), {
        newSessionBtn: button,
        workspaceSelect: document.createElement('select'),
        addWorkspaceBtn: button,
        removeWorkspaceBtn: button,
        wsModalClose: button,
        wsModalCancelBtn: button,
        wsModalAddBtn: button,
        wsModalBrowseBtn: document.createElement('button'),
        wsModalInput: document.createElement('input'),
        activeCoder: 'opencode',
        quickLaunchReady: ready,
        spawnNewSession: vi.fn(),
        loadSessions: vi.fn(),
    });
    ctx.setupEventListeners();
    return ctx;
}

describe('Shell one-click launch', () => {
    it('selects Shell and launches exactly one new session, including a repeat click', () => {
        const manager = harness();
        document.querySelector('[data-coder="bash"] span').click();
        expect(manager.activeCoder).toBe('bash');
        expect(manager.spawnNewSession).toHaveBeenCalledWith();
        expect(manager.spawnNewSession).toHaveBeenCalledTimes(1);
        expect(manager.loadSessions).not.toHaveBeenCalled();
        document.querySelector('[data-coder="bash"]').click();
        expect(manager.spawnNewSession).toHaveBeenCalledTimes(2);
    });
    it('does not launch before the server configuration is ready', () => {
        const manager = harness(false);
        document.querySelector('[data-coder="bash"]').click();
        expect(manager.spawnNewSession).not.toHaveBeenCalled();
        expect(manager.loadSessions).toHaveBeenCalledTimes(1);
    });
    it('agent selection still lists history without spawning', () => {
        const manager = harness();
        document.querySelector('[data-coder="claude"]').click();
        expect(manager.spawnNewSession).not.toHaveBeenCalled();
        expect(manager.loadSessions).toHaveBeenCalledTimes(1);
    });
});
