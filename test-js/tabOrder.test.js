// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';
import { setEmbeddedBackend, serverKey } from '../web/util.js';

setupDomHarness();

function makeTabManager({ withTabs = [] } = {}) {
    const tm = Object.create(TabManager.prototype);
    tm.tabs = new Map();
    tm.activePaneId = null;
    tm.dragSourceId = null;
    tm.tabsContainer = document.createElement('div');
    tm.tabsContainer.id = 'tabs-container';
    document.body.appendChild(tm.tabsContainer);

    for (const id of withTabs) {
        const tabEl = document.createElement('div');
        tabEl.className = 'tab';
        tabEl.setAttribute('data-pane-id', id);
        tm.tabsContainer.appendChild(tabEl);
        tm.tabs.set(id, {
            paneId: id,
            title: id,
            coder: 'shell',
            tabEl,
            termContainer: document.createElement('div'),
            isDead: false,
            isReview: false,
            isKanban: false,
        });
    }

    tm.updateDocumentTitle = vi.fn();
    tm.updateDisconnectBanner = vi.fn();
    tm.saveTabsState = TabManager.prototype.saveTabsState.bind(tm);
    tm.saveTabOrder = TabManager.prototype.saveTabOrder.bind(tm);
    tm.applyTabOrder = TabManager.prototype.applyTabOrder.bind(tm);
    tm.applySavedTabOrder = TabManager.prototype.applySavedTabOrder.bind(tm);

    return tm;
}

describe('TabManager tab order persistence and application', () => {
    afterEach(() => {
        setEmbeddedBackend(null, null);
    });

    it('persists tab order to serverKey scoped localStorage', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b', 'c'] });
        tm.saveTabOrder();

        expect(localStorage.getItem(serverKey('phi_tab_order'))).toBe(
            JSON.stringify(['a', 'b', 'c']),
        );
    });

    it('scopes tab order when embedded backend is active', () => {
        setEmbeddedBackend('prof-order-1', 'http://127.0.0.1:8000');
        const tm = makeTabManager({ withTabs: ['x', 'y'] });
        tm.saveTabOrder();

        expect(localStorage.getItem(serverKey('phi_tab_order'))).toBe(
            JSON.stringify(['x', 'y']),
        );
        expect(localStorage.getItem('phi_tab_order')).toBeNull();
    });

    it('applies saved tab order from localStorage', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b', 'c'] });
        localStorage.setItem(
            serverKey('phi_tab_order'),
            JSON.stringify(['c', 'a', 'b']),
        );

        tm.applySavedTabOrder();

        expect(Array.from(tm.tabs.keys())).toEqual(['c', 'a', 'b']);
    });

    it('filters out stale tab ids and appends new tabs at the end', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b', 'c', 'd'] });
        // 'stale-1' does not exist; 'd' is missing from saved order
        localStorage.setItem(
            serverKey('phi_tab_order'),
            JSON.stringify(['stale-1', 'c', 'a']),
        );

        tm.applySavedTabOrder();

        // 'c', 'a' come first, followed by 'b' and 'd' in current order
        expect(Array.from(tm.tabs.keys())).toEqual(['c', 'a', 'b', 'd']);
    });
});
