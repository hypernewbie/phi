// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TabManager } from '../web/terminal.js';

function makeTab(over = {}) {
    const tabEl = document.createElement('div');
    const termContainer = document.createElement('div');
    const overlay = document.createElement('div');
    overlay.className = 'reconnect-overlay';
    const msg = document.createElement('div');
    msg.className = 'reconnect-msg';
    overlay.appendChild(msg);
    termContainer.appendChild(overlay);

    return {
        paneId: 'p1',
        isDead: false,
        coder: 'bash',
        term: { write: vi.fn(), refresh: vi.fn(), rows: 24 },
        termContainer,
        tabEl,
        reconnectAttempts: 0,
        reconnectInFlight: false,
        exitCode: null,
        ...over,
    };
}

describe('Desktop focus and disconnect banner reproduction', () => {
    let tabManager;
    let banner;

    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML =
            '<div id="disconnect-banner" class="disconnect-banner hidden"></div>';
        banner = document.getElementById('disconnect-banner');

        // Mark as desktop app
        document.documentElement.setAttribute('data-phi-desktop', '');

        tabManager = Object.create(TabManager.prototype);
        tabManager.tabs = new Map();
        tabManager.app = {
            config: { auto_reconnect: 'visible' },
            showToast: vi.fn(),
        };
        tabManager.reconnectTab = vi.fn((tab) => {
            // Emulate reconnecting
            tab.reconnectInFlight = true;
            tab.isDead = false;
        });
        tabManager.getActiveTab = vi.fn();
        tabManager.activateTabViewport = vi.fn();
        tabManager.updateDocumentTitle = vi.fn();
        tabManager._showReconnectOverlay = vi.fn();
    });

    afterEach(() => {
        document.documentElement.removeAttribute('data-phi-desktop');
    });

    it('desktop focus revives ALL dead tabs and does NOT leave "Reconnect all" banner visible', () => {
        // User has 2 tabs: active tab (p1) and background tab (p2).
        // Laptop went to sleep or network dropped: both tabs are dead.
        const tab1 = makeTab({ paneId: 'p1', isDead: true });
        const tab2 = makeTab({ paneId: 'p2', isDead: true });
        tabManager.tabs.set('p1', tab1);
        tabManager.tabs.set('p2', tab2);
        tabManager.activePaneId = 'p1';
        tabManager.getActiveTab.mockReturnValue(tab1);

        // When dead, banner is initially showing 2 disconnected tabs
        tabManager.updateDisconnectBanner();
        expect(banner.classList.contains('hidden')).toBe(false);
        expect(banner.innerHTML).toContain('2 tabs disconnected');
        expect(banner.innerHTML).toContain('Reconnect all');

        // Desktop window regains focus (e.g. user switches to Phi Desktop or wakes machine)
        // In desktop mode, focus should revive ALL dead tabs because desktop knows it is focused.
        tabManager._onDesktopFocusOrWake?.() ??
            tabManager._reviveActiveTabIfDead();

        // EXPECTATION:
        // 1. Both tabs must have reconnectTab called
        expect(tabManager.reconnectTab).toHaveBeenCalledWith(
            tab1,
            expect.any(Object),
        );
        expect(tabManager.reconnectTab).toHaveBeenCalledWith(
            tab2,
            expect.any(Object),
        );

        // 2. The "Reconnect all" red bar must NOT remain visible while focused in desktop!
        // In desktop mode, leaving a red "Reconnect all" banner when focused is an oxymoron.
        tabManager.updateDisconnectBanner();
        expect(banner.classList.contains('hidden')).toBe(true);
    });

    it('desktop auto-reconnects dead background tabs when focused instead of showing "Reconnect all" banner', () => {
        const tab1 = makeTab({ paneId: 'p1', isDead: false });
        const tab2 = makeTab({ paneId: 'p2', isDead: false });
        tabManager.tabs.set('p1', tab1);
        tabManager.tabs.set('p2', tab2);
        tabManager.activePaneId = 'p1';
        tabManager.getActiveTab.mockReturnValue(tab1);

        // Tab 2 (background tab) drops connection while desktop app is focused
        tabManager._handleTerminalDisconnect(tab2);

        // In desktop mode, background tabs must be auto-reconnected when focused
        expect(tabManager.maybeAutoReconnect(tab2)).toBe(true);

        // The banner should NOT show "Reconnect all" to the user when desktop is focused and auto-reconnecting
        expect(banner.classList.contains('hidden')).toBe(true);
    });

    it('desktop does not flash "Reconnect all" banner when active tab disconnects while focused', () => {
        const tab1 = makeTab({ paneId: 'p1', isDead: false });
        tabManager.tabs.set('p1', tab1);
        tabManager.activePaneId = 'p1';
        tabManager.getActiveTab.mockReturnValue(tab1);

        // Active tab drops while desktop app is focused and auto_reconnect is enabled
        tabManager._handleTerminalDisconnect(tab1);

        // Desktop knows it is focused and will auto-reconnect; showing a red "Reconnect all" banner is an oxymoron
        expect(banner.classList.contains('hidden')).toBe(true);
    });

    it('non-desktop browser mode preserves conservative active-tab-only reconnect and banner', () => {
        document.documentElement.removeAttribute('data-phi-desktop');

        const tab1 = makeTab({ paneId: 'p1', isDead: true });
        const tab2 = makeTab({ paneId: 'p2', isDead: true });
        tabManager.tabs.set('p1', tab1);
        tabManager.tabs.set('p2', tab2);
        tabManager.activePaneId = 'p1';
        tabManager.getActiveTab.mockReturnValue(tab1);

        // In standard browser mode, wake only revives active tab to avoid multi-window reconnect storms
        tabManager._reviveActiveTabIfDead();
        expect(tabManager.reconnectTab).toHaveBeenCalledWith(
            tab1,
            expect.any(Object),
        );
        expect(tabManager.reconnectTab).not.toHaveBeenCalledWith(
            tab2,
            expect.any(Object),
        );

        tabManager.updateDisconnectBanner();
        // Background tab remains dead, so banner correctly shows disconnected count in browser
        expect(banner.classList.contains('hidden')).toBe(false);
        expect(banner.innerHTML).toContain('1 tab disconnected');
        expect(banner.innerHTML).toContain('Reconnect all');
    });
});
