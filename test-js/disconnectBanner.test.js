// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TabManager } from '../web/terminal.js';

function makeTab(over = {}) {
    return {
        paneId: 'pane-1',
        isDead: false,
        coder: 'bash',
        term: { write: vi.fn() },
        termContainer: document.createElement('div'),
        tabEl: document.createElement('div'),
        ...over,
    };
}

describe('Disconnect Banner UX', () => {
    let tabManager;
    let banner;

    beforeEach(() => {
        vi.clearAllMocks();
        // Setup mock DOM
        document.body.innerHTML =
            '<div id="disconnect-banner" class="disconnect-banner hidden"></div>';
        banner = document.getElementById('disconnect-banner');

        tabManager = Object.create(TabManager.prototype);
        tabManager.tabs = new Map();
        tabManager.app = { config: { auto_reconnect: 'off' } };
        tabManager.reconnectTab = vi.fn();
        tabManager.getActiveTab = vi.fn();
        tabManager.activateTabViewport = vi.fn();
    });

    it('does not report an expected WebSocket close during tab finalization', () => {
        const tab = makeTab({ finalizing: true });
        tabManager.app.showToast = vi.fn();
        tabManager.updateDocumentTitle = vi.fn();
        tabManager._showReconnectOverlay = vi.fn();
        tabManager.updateDisconnectBanner = vi.fn();
        tabManager.maybeAutoReconnect = vi.fn();

        tabManager._handleTerminalDisconnect(tab);

        expect(tab.term.write).not.toHaveBeenCalled();
        expect(tab.isDead).toBe(false);
        expect(tab.tabEl.classList.contains('dead')).toBe(false);
        expect(tabManager._showReconnectOverlay).not.toHaveBeenCalled();
        expect(tabManager.updateDisconnectBanner).not.toHaveBeenCalled();
        expect(tabManager.app.showToast).not.toHaveBeenCalled();
    });

    it('banner is hidden when there are no dead tabs', () => {
        tabManager.updateDisconnectBanner();
        expect(banner.classList.contains('hidden')).toBe(true);
    });

    it('banner appears when a tab is dead by disconnect', () => {
        const tab = makeTab({ isDead: true });
        tabManager.tabs.set(tab.paneId, tab);

        tabManager.updateDisconnectBanner();
        expect(banner.classList.contains('hidden')).toBe(false);
        expect(banner.innerHTML).toContain('1 tab disconnected');
    });

    it('banner counts multiple disconnected tabs', () => {
        const tab1 = makeTab({ paneId: 'p1', isDead: true });
        const tab2 = makeTab({ paneId: 'p2', isDead: true });
        tabManager.tabs.set(tab1.paneId, tab1);
        tabManager.tabs.set(tab2.paneId, tab2);

        tabManager.updateDisconnectBanner();
        expect(banner.innerHTML).toContain('2 tabs disconnected');
    });

    it('banner ignores dead-by-exit tabs', () => {
        const tab1 = makeTab({ paneId: 'p1', isDead: true }); // disconnect
        const tab2 = makeTab({ paneId: 'p2', isDead: true, exitCode: 0 }); // exit
        tabManager.tabs.set(tab1.paneId, tab1);
        tabManager.tabs.set(tab2.paneId, tab2);

        tabManager.updateDisconnectBanner();
        expect(banner.innerHTML).toContain('1 tab disconnected');
    });

    it('Reconnect all calls reconnectTab only for dead-by-disconnect tabs', () => {
        const tab1 = makeTab({ paneId: 'p1', isDead: true }); // disconnect
        const tab2 = makeTab({ paneId: 'p2', isDead: true, exitCode: 2 }); // exit
        const tab3 = makeTab({ paneId: 'p3', isDead: false }); // live
        tabManager.tabs.set(tab1.paneId, tab1);
        tabManager.tabs.set(tab2.paneId, tab2);
        tabManager.tabs.set(tab3.paneId, tab3);

        tabManager.reconnectAllDead();
        expect(tabManager.reconnectTab).toHaveBeenCalledWith(tab1, {
            auto: false,
        });
        expect(tabManager.reconnectTab).not.toHaveBeenCalledWith(
            tab2,
            expect.any(Object),
        );
        expect(tabManager.reconnectTab).not.toHaveBeenCalledWith(
            tab3,
            expect.any(Object),
        );
    });

    it('banner can be dismissed and re-arms on new death', () => {
        const tab1 = makeTab({ paneId: 'p1', isDead: true });
        tabManager.tabs.set(tab1.paneId, tab1);

        tabManager.updateDisconnectBanner();
        expect(banner.classList.contains('hidden')).toBe(false);

        // Click dismiss
        banner.querySelector('.dismiss-banner-btn').click();
        expect(banner.classList.contains('hidden')).toBe(true);
        expect(tabManager._bannerDismissed).toBe(true);

        // Update banner again with same state: should remain hidden
        tabManager.updateDisconnectBanner();
        expect(banner.classList.contains('hidden')).toBe(true);

        // A new tab dies: banner should re-appear
        const tab2 = makeTab({ paneId: 'p2', isDead: true });
        tabManager.tabs.set(tab2.paneId, tab2);
        tabManager.updateDisconnectBanner();
        expect(banner.classList.contains('hidden')).toBe(false);
        expect(banner.innerHTML).toContain('2 tabs disconnected');
    });

    it('reconnect overlay displays Session expired (PTY gone) when exitCode is -1', () => {
        const tab = makeTab({ isDead: true, exitCode: -1 });
        tabManager._showReconnectOverlay(tab);

        const overlay = tab.termContainer.querySelector('.reconnect-overlay');
        expect(overlay).not.toBeNull();
        expect(overlay.querySelector('.reconnect-msg').textContent).toBe(
            'Session expired (PTY gone)',
        );
        expect(overlay.querySelector('.reconnect-btn')).toBeNull(); // No reconnect button
        expect(overlay.querySelector('.restart-btn')).not.toBeNull(); // Restart button present
    });

    it('reconnect overlay displays Connection lost when exitCode is null/undefined', () => {
        const tab = makeTab({ isDead: true });
        tabManager._showReconnectOverlay(tab);

        const overlay = tab.termContainer.querySelector('.reconnect-overlay');
        expect(overlay).not.toBeNull();
        expect(overlay.querySelector('.reconnect-msg').textContent).toBe(
            'Connection lost',
        );
        expect(overlay.querySelector('.reconnect-btn')).not.toBeNull(); // Reconnect button present
        expect(overlay.querySelector('.restart-btn')).not.toBeNull();
    });
});
