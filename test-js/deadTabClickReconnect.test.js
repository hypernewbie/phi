// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TabManager } from '../web/terminal.js';

const terminalJsSrc = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'terminal.js'),
    'utf8'
);

// Item 8 hardening: auto_reconnect:'off' (default) must not block an explicit
// user action (tab click, Alt+N, hostname dropdown, OS notification) from
// reviving a dead tab. Only the passive/automatic reconnect path should be
// gated behind the config setting.

function ctx(config = { auto_reconnect: 'off' }) {
    const c = Object.create(TabManager.prototype);
    c.app = { config };
    c.reconnectTab = vi.fn();
    c.getActiveTab = vi.fn(() => null);
    return c;
}

function deadTab(overrides = {}) {
    return { isDead: true, coder: 'opencode', reconnectInFlight: false, exitCode: null, ...overrides };
}

describe('activateTabViewport force option', () => {
    it('reconnects a dead tab when force=true even if auto_reconnect is off', () => {
        const c = ctx();
        const tab = deadTab();
        TabManager.prototype.activateTabViewport.call(c, tab, { scrollToBottom: false, force: true });
        expect(c.reconnectTab).toHaveBeenCalledWith(tab, { auto: true });
    });

    it('does not reconnect a dead tab without force when auto_reconnect is off', () => {
        const c = ctx();
        const tab = deadTab();
        TabManager.prototype.activateTabViewport.call(c, tab, { scrollToBottom: false });
        expect(c.reconnectTab).not.toHaveBeenCalled();
    });

    it('still reconnects without force when auto_reconnect is visible (unchanged passive behavior)', () => {
        const c = ctx({ auto_reconnect: 'visible' });
        const tab = deadTab();
        TabManager.prototype.activateTabViewport.call(c, tab, { scrollToBottom: false });
        expect(c.reconnectTab).toHaveBeenCalledWith(tab, { auto: true });
    });

    it('force does not resurrect a tab whose process actually exited', () => {
        const c = ctx();
        const tab = deadTab({ exitCode: 0 });
        TabManager.prototype.activateTabViewport.call(c, tab, { scrollToBottom: false, force: true });
        expect(c.reconnectTab).not.toHaveBeenCalled();
    });

    it('force is ignored for review/kanban panels', () => {
        const c = ctx();
        const tab = deadTab({ coder: 'kanban' });
        TabManager.prototype.activateTabViewport.call(c, tab, { scrollToBottom: false, force: true });
        expect(c.reconnectTab).not.toHaveBeenCalled();
    });

    it('force does not double-fire while a reconnect is already in flight', () => {
        const c = ctx();
        const tab = deadTab({ reconnectInFlight: true });
        TabManager.prototype.activateTabViewport.call(c, tab, { scrollToBottom: false, force: true });
        expect(c.reconnectTab).not.toHaveBeenCalled();
    });
});

describe('switchTab threads userInitiated into force', () => {
    function switchCtx(activeTab) {
        const c = ctx();
        c.activePaneId = activeTab.paneId;
        c.getActiveTab = vi.fn(() => activeTab);
        c.activateTabViewport = vi.fn();
        return c;
    }

    it('re-clicking the already-active dead tab forces reconnect when userInitiated', () => {
        const tab = deadTab({ paneId: 'p1' });
        const c = switchCtx(tab);
        TabManager.prototype.switchTab.call(c, 'p1', { userInitiated: true });
        expect(c.activateTabViewport).toHaveBeenCalledWith(tab, expect.objectContaining({ force: true }));
    });

    it('re-clicking without userInitiated stays passive (default force=false)', () => {
        const tab = deadTab({ paneId: 'p1' });
        const c = switchCtx(tab);
        TabManager.prototype.switchTab.call(c, 'p1');
        expect(c.activateTabViewport).toHaveBeenCalledWith(tab, expect.objectContaining({ force: false }));
    });
});

describe('explicit user-action call sites regression guard', () => {
    it('tab click handler passes userInitiated:true', () => {
        expect(terminalJsSrc).toContain("this.switchTab(currentPaneId, { userInitiated: true });");
    });

    it('Alt+N tab shortcut passes userInitiated:true', () => {
        expect(terminalJsSrc).toContain("this.switchTab(targetPaneId, { userInitiated: true });");
    });

    it('hostname dropdown click passes userInitiated:true', () => {
        expect(terminalJsSrc).toContain("this.switchTab(paneId, { userInitiated: true });\n                dropdown.classList.add('hidden');");
    });

    it('OS notification click passes userInitiated:true', () => {
        expect(terminalJsSrc).toContain("this.switchTab(tab.paneId, { userInitiated: true });");
    });
});
