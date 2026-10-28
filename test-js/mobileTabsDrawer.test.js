// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { App } from '../web/app.js';
import { TabManager } from '../web/terminal.js';

// The compact drawer is a tab screen by default and shows the existing
// sessions block on demand. These tests pin the mode contract (state, not
// CSS visibility — jsdom never loads web/style.css) and the shared tab-tree
// builder's dual target: the desktop dropdown and the drawer body.

setupDomHarness();

function setViewport(w, h) {
    Object.defineProperty(window, 'innerWidth', {
        value: w,
        configurable: true,
    });
    Object.defineProperty(window, 'innerHeight', {
        value: h,
        configurable: true,
    });
}

const SIDEBAR_HTML = `
    <aside
        id="sidebar-panel"
        class="sidebar-panel"
        aria-label="Sessions"
        data-panel-mode="tabs"
    >
        <div class="panel-header">
            <h2 id="drawer-panel-title">SESSIONS</h2>
            <div class="panel-header-actions">
                <button id="drawer-open-sessions" type="button"></button>
                <button id="drawer-back-to-tabs" type="button"></button>
            </div>
        </div>
        <div id="drawer-tabs-body" class="drawer-tabs-body"></div>
        <div class="coder-selector" id="coder-selector"></div>
        <div class="new-session-container" id="new-session-container"></div>
        <div class="session-list-container">
            <div id="session-list"></div>
        </div>
    </aside>
    <button id="tab-overflow-btn" type="button" aria-expanded="false"></button>
    <div
        id="tab-overflow-dropdown"
        class="tab-overflow-dropdown hidden"
        tabindex="-1"
    ></div>
`;

function mountDom() {
    document.body.innerHTML = SIDEBAR_HTML;
}

function makeTabManager() {
    const tm = Object.create(TabManager.prototype);
    tm.tabs = new Map();
    tm.activePaneId = 'a1';
    tm.tabs.set('a1', {
        paneId: 'a1',
        title: 'Alpha one',
        coder: 'bash',
        cwd: '/work/alpha',
        workspace: '/work/alpha',
        faviconUrl: '',
        softClosing: false,
        isAttention: false,
    });
    tm.tabs.set('a2', {
        paneId: 'a2',
        title: 'Alpha two',
        coder: 'bash',
        cwd: '/work/alpha',
        workspace: '/work/alpha',
        faviconUrl: '',
        softClosing: false,
        isAttention: false,
    });
    tm.switchTab = vi.fn();
    tm.closeTab = vi.fn();
    return tm;
}

function makeApp(tabManager) {
    const app = Object.create(App.prototype);
    app.tabManager = tabManager;
    return app;
}

const sidebar = () => document.getElementById('sidebar-panel');
const drawerBody = () => document.getElementById('drawer-tabs-body');
const desktopDropdown = () => document.getElementById('tab-overflow-dropdown');

beforeEach(() => {
    setViewport(390, 844);
    mountDom();
});

afterEach(() => {
    setViewport(1024, 768);
});

describe('drawer mode', () => {
    it('renders the grouped tab tree in tabs mode', () => {
        const tm = makeTabManager();
        makeApp(tm).setDrawerMode('tabs');

        expect(sidebar().dataset.panelMode).toBe('tabs');
        expect(document.getElementById('drawer-panel-title').textContent).toBe(
            'TABS',
        );
        expect(sidebar().getAttribute('aria-label')).toBe('Tabs');
        expect(drawerBody().querySelectorAll('details').length).toBeGreaterThan(
            0,
        );
        expect(
            drawerBody().querySelectorAll('.hostname-dropdown-row'),
        ).toHaveLength(2);
        // The desktop dropdown is a separate target and stays untouched.
        expect(desktopDropdown().classList.contains('hidden')).toBe(true);
        expect(desktopDropdown().childElementCount).toBe(0);
    });

    it('switches the heading and label per mode', () => {
        const tm = makeTabManager();
        const app = makeApp(tm);
        app.setDrawerMode('sessions');
        expect(sidebar().dataset.panelMode).toBe('sessions');
        expect(document.getElementById('drawer-panel-title').textContent).toBe(
            'SESSIONS',
        );
        expect(sidebar().getAttribute('aria-label')).toBe('Sessions');

        app.setDrawerMode('tabs');
        expect(sidebar().dataset.panelMode).toBe('tabs');
        expect(document.getElementById('drawer-panel-title').textContent).toBe(
            'TABS',
        );
    });

    it('forces sessions mode outside the compact viewport', () => {
        setViewport(1024, 768);
        const tm = makeTabManager();
        makeApp(tm).setDrawerMode('tabs');

        expect(sidebar().dataset.panelMode).toBe('sessions');
        expect(document.getElementById('drawer-panel-title').textContent).toBe(
            'SESSIONS',
        );
        expect(drawerBody().childElementCount).toBe(0);
    });

    it('resets to tabs mode when the drawer reopens', () => {
        const tm = makeTabManager();
        const app = makeApp(tm);
        sidebar().classList.add('drawer-open');
        app.setDrawerMode('sessions');
        // Close, then reopen the way both open paths do.
        sidebar().classList.remove('drawer-open');
        sidebar().classList.add('drawer-open');
        app.setDrawerMode('tabs');

        expect(sidebar().dataset.panelMode).toBe('tabs');
        expect(
            drawerBody().querySelectorAll('.hostname-dropdown-row'),
        ).toHaveLength(2);
    });
});

describe('drawer row tap', () => {
    it('switches the tab, closes the drawer, and never touches the desktop dropdown', () => {
        const tm = makeTabManager();
        const app = makeApp(tm);
        sidebar().classList.add('drawer-open');
        app.setDrawerMode('tabs');
        const row = drawerBody().querySelector(
            '.hostname-dropdown-row[data-pane-id="a2"]',
        );

        row.querySelector('.hostname-dropdown-select-btn').click();

        expect(tm.switchTab).toHaveBeenCalledWith('a2', {
            userInitiated: true,
        });
        expect(sidebar().classList.contains('drawer-open')).toBe(false);
        expect(
            document
                .getElementById('tab-overflow-btn')
                .getAttribute('aria-expanded'),
        ).toBe('false');
        expect(desktopDropdown().classList.contains('hidden')).toBe(true);
        expect(desktopDropdown().childElementCount).toBe(0);
    });
});

describe('_refreshOverflowDropdown', () => {
    it('rebuilds both targets while the drawer is open in tabs mode', () => {
        const tm = makeTabManager();
        makeApp(tm).setDrawerMode('tabs');
        sidebar().classList.add('drawer-open');
        desktopDropdown().classList.remove('hidden');

        tm._refreshOverflowDropdown();

        expect(
            desktopDropdown().querySelectorAll('.hostname-dropdown-row'),
        ).toHaveLength(2);
        expect(
            drawerBody().querySelectorAll('.hostname-dropdown-row'),
        ).toHaveLength(2);
    });

    it('leaves the drawer body alone when closed or in sessions mode', () => {
        const tm = makeTabManager();
        const app = makeApp(tm);
        app.setDrawerMode('tabs');
        drawerBody().replaceChildren();

        // Drawer closed.
        tm._refreshOverflowDropdown();
        expect(drawerBody().childElementCount).toBe(0);

        // Drawer open in sessions mode.
        sidebar().classList.add('drawer-open');
        app.setDrawerMode('sessions');
        drawerBody().replaceChildren();
        tm._refreshOverflowDropdown();
        expect(drawerBody().childElementCount).toBe(0);
    });
});
