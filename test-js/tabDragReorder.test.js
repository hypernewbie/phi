// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';

// Drag-to-reorder for the top tab strip. LocalStorage-only (no backend).
// These tests pin the move logic, the DOM reorder, and the localStorage
// round-trip - all without booting the full xterm.js stack.

setupDomHarness();

// Minimal TabManager harness. We only need the bits the drag logic
// touches: the `tabs` Map, the `tabsContainer` DOM, and the methods
// themselves. The full TabManager constructor touches a lot of DOM we
// don't care about (terminalsWrapper, inputBarContainer, ...), so we
// hand-build the instance instead of `new TabManager(app)`.
function makeTabManager({ withTabs = [], pinned = new Set() } = {}) {
    const tm = Object.create(TabManager.prototype);
    tm.tabs = new Map();
    tm.activePaneId = null;
    tm.dragSourceId = null;
    // Empty container ready for tabEl children.
    tm.tabsContainer = document.createElement('div');
    tm.tabsContainer.id = 'tabs-container';
    document.body.appendChild(tm.tabsContainer);

    for (const id of withTabs) {
        const tabEl = document.createElement('div');
        tabEl.className = 'tab';
        tabEl.setAttribute('data-pane-id', id);
        if (pinned.has(id)) tabEl.classList.add('pinned');
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
            pinned: pinned.has(id),
            marked: false,
        });
    }
    return tm;
}

function domOrder(tm) {
    return Array.from(tm.tabsContainer.children).map((el) =>
        el.getAttribute('data-pane-id'),
    );
}

function mapOrder(tm) {
    return Array.from(tm.tabs.keys());
}

beforeEach(() => {
    localStorage.clear();
});

describe('moveTabTo - pure ordering logic', () => {
    it('moves a later tab to before an earlier tab', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b', 'c'] });
        // Move c (idx 2) to before a (idx 0).
        tm.moveTabTo('c', 'a', true);
        expect(mapOrder(tm)).toEqual(['c', 'a', 'b']);
    });

    it('moves a later tab to after an earlier tab', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b', 'c'] });
        tm.moveTabTo('c', 'a', false);
        expect(mapOrder(tm)).toEqual(['a', 'c', 'b']);
    });

    it('moves an earlier tab to before a later tab', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b', 'c'] });
        tm.moveTabTo('a', 'c', true);
        expect(mapOrder(tm)).toEqual(['b', 'a', 'c']);
    });

    it('moves an earlier tab to after a later tab', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b', 'c'] });
        tm.moveTabTo('a', 'c', false);
        expect(mapOrder(tm)).toEqual(['b', 'c', 'a']);
    });

    it('swaps two adjacent tabs (drag right neighbor to left)', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b', 'c'] });
        tm.moveTabTo('b', 'a', false); // drop b on the right half of a
        expect(mapOrder(tm)).toEqual(['a', 'b', 'c']);
    });

    it('is a no-op when source == target', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b'] });
        const before = mapOrder(tm);
        tm.moveTabTo('a', 'a', true);
        expect(mapOrder(tm)).toEqual(before);
    });

    it('preserves the relative order of tabs that are not involved', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b', 'c', 'd', 'e'] });
        tm.moveTabTo('e', 'b', true);
        // e goes between a and b; c, d keep their relative order.
        expect(mapOrder(tm)).toEqual(['a', 'e', 'b', 'c', 'd']);
    });
});

describe('applyTabOrder - DOM side effects', () => {
    it('reorders the DOM children of tabsContainer to match the new order', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b', 'c'] });
        tm.applyTabOrder(['c', 'a', 'b'], { persist: false });
        expect(domOrder(tm)).toEqual(['c', 'a', 'b']);
        expect(mapOrder(tm)).toEqual(['c', 'a', 'b']);
    });

    it('moves existing DOM nodes (does not clone them)', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b'] });
        const originalA = tm.tabsContainer.querySelector('[data-pane-id="a"]');
        tm.applyTabOrder(['b', 'a'], { persist: false });
        // Same node reference, just moved in the DOM.
        expect(tm.tabsContainer.querySelector('[data-pane-id="a"]')).toBe(
            originalA,
        );
        expect(tm.tabsContainer.children.length).toBe(2);
    });

    it('persists the new order to localStorage by default', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b', 'c'] });
        tm.applyTabOrder(['c', 'b', 'a']);
        expect(JSON.parse(localStorage.getItem('phi_tab_order'))).toEqual([
            'c',
            'b',
            'a',
        ]);
    });

    it('does not persist when persist: false', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b'] });
        tm.applyTabOrder(['b', 'a'], { persist: false });
        expect(localStorage.getItem('phi_tab_order')).toBeNull();
    });
});

describe('moveTabTo - DOM side effects', () => {
    it('reorders both Map and DOM in one call', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b', 'c'] });
        tm.moveTabTo('c', 'a', true);
        expect(domOrder(tm)).toEqual(['c', 'a', 'b']);
        expect(mapOrder(tm)).toEqual(['c', 'a', 'b']);
        // And the saved order matches.
        expect(JSON.parse(localStorage.getItem('phi_tab_order'))).toEqual([
            'c',
            'a',
            'b',
        ]);
    });
});

describe('drop indicators', () => {
    it('showDropIndicator sets the correct side class', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b'] });
        const tabB = tm.tabsContainer.querySelector('[data-pane-id="b"]');
        tm.showDropIndicator(tabB, true);
        expect(tabB.classList.contains('drop-before')).toBe(true);
        expect(tabB.classList.contains('drop-after')).toBe(false);
    });

    it('clearDropIndicators removes all drop-* classes', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b', 'c'] });
        const a = tm.tabsContainer.querySelector('[data-pane-id="a"]');
        const b = tm.tabsContainer.querySelector('[data-pane-id="b"]');
        tm.showDropIndicator(a, true);
        tm.showDropIndicator(b, false);
        tm.clearDropIndicators();
        expect(a.classList.contains('drop-before')).toBe(false);
        expect(b.classList.contains('drop-after')).toBe(false);
    });

    it('showDropIndicator clears any previous indicator on a different tab', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b'] });
        const a = tm.tabsContainer.querySelector('[data-pane-id="a"]');
        const b = tm.tabsContainer.querySelector('[data-pane-id="b"]');
        tm.showDropIndicator(a, true);
        tm.showDropIndicator(b, false);
        expect(a.classList.contains('drop-before')).toBe(false);
        expect(b.classList.contains('drop-after')).toBe(true);
    });
});

describe('drag handlers', () => {
    it('handleTabDragStart records source paneId and adds dragging class on rAF', async () => {
        const tm = makeTabManager({ withTabs: ['a', 'b'] });
        const tabA = tm.tabsContainer.querySelector('[data-pane-id="a"]');
        const dt = { setData: vi.fn(), effectAllowed: '' };
        const e = { button: 0, currentTarget: tabA, dataTransfer: dt };
        tm.handleTabDragStart(e, 'a');
        expect(tm.dragSourceId).toBe('a');
        expect(dt.setData).toHaveBeenCalledWith('text/plain', 'a');
        // Wait one rAF tick so the class is applied.
        await new Promise((r) => requestAnimationFrame(r));
        expect(tabA.classList.contains('dragging')).toBe(true);
    });

    it('handleTabDragEnd removes dragging class and clears indicators', async () => {
        const tm = makeTabManager({ withTabs: ['a', 'b'] });
        const tabA = tm.tabsContainer.querySelector('[data-pane-id="a"]');
        // Start a drag so we can end it.
        tm.dragSourceId = 'a';
        tabA.classList.add('dragging');
        const e = { currentTarget: tabA };
        tm.handleTabDragEnd(e);
        expect(tabA.classList.contains('dragging')).toBe(false);
        expect(tm.dragSourceId).toBeNull();
    });

    it('handleTabDragOver on the same source paneId is a no-op', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b'] });
        tm.dragSourceId = 'a';
        const tabA = tm.tabsContainer.querySelector('[data-pane-id="a"]');
        const e = {
            preventDefault: vi.fn(),
            dataTransfer: { dropEffect: '' },
            currentTarget: tabA,
            clientX: 50,
        };
        const rectSpy = vi
            .spyOn(tabA, 'getBoundingClientRect')
            .mockReturnValue({
                left: 0,
                right: 100,
                top: 0,
                bottom: 34,
                width: 100,
                height: 34,
            });
        tm.handleTabDragOver(e, 'a');
        expect(e.preventDefault).not.toHaveBeenCalled();
        expect(tabA.classList.contains('drop-before')).toBe(false);
        rectSpy.mockRestore();
    });

    it('handleTabDragOver on a different tab sets drop-before when cursor is in left half', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b'] });
        tm.dragSourceId = 'a';
        const tabB = tm.tabsContainer.querySelector('[data-pane-id="b"]');
        const e = {
            preventDefault: vi.fn(),
            dataTransfer: { dropEffect: '' },
            currentTarget: tabB,
            clientX: 30, // left half of a 100px-wide tab
        };
        const rectSpy = vi
            .spyOn(tabB, 'getBoundingClientRect')
            .mockReturnValue({
                left: 0,
                right: 100,
                top: 0,
                bottom: 34,
                width: 100,
                height: 34,
            });
        tm.handleTabDragOver(e, 'b');
        expect(e.preventDefault).toHaveBeenCalled();
        expect(tabB.classList.contains('drop-before')).toBe(true);
        expect(tabB.classList.contains('drop-after')).toBe(false);
        rectSpy.mockRestore();
    });

    it('handleTabDragOver sets drop-after when cursor is in right half', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b'] });
        tm.dragSourceId = 'a';
        const tabB = tm.tabsContainer.querySelector('[data-pane-id="b"]');
        const e = {
            preventDefault: vi.fn(),
            dataTransfer: { dropEffect: '' },
            currentTarget: tabB,
            clientX: 80, // right half
        };
        const rectSpy = vi
            .spyOn(tabB, 'getBoundingClientRect')
            .mockReturnValue({
                left: 0,
                right: 100,
                top: 0,
                bottom: 34,
                width: 100,
                height: 34,
            });
        tm.handleTabDragOver(e, 'b');
        expect(tabB.classList.contains('drop-after')).toBe(true);
        expect(tabB.classList.contains('drop-before')).toBe(false);
        rectSpy.mockRestore();
    });

    it('handleTabDragOver on a pinned tab is still a valid drop target', () => {
        // Pinning protects the server-side PTY across WS disconnects; it
        // no longer locks position. Pinned tabs are valid drop targets so
        // users can still reorder the strip without unpinning.
        const tm = makeTabManager({
            withTabs: ['a', 'b'],
            pinned: new Set(['b']),
        });
        tm.dragSourceId = 'a';
        const tabB = tm.tabsContainer.querySelector('[data-pane-id="b"]');
        const rectSpy = vi
            .spyOn(tabB, 'getBoundingClientRect')
            .mockReturnValue({
                left: 0,
                right: 100,
                top: 0,
                bottom: 34,
                width: 100,
                height: 34,
            });
        const e = {
            preventDefault: vi.fn(),
            dataTransfer: { dropEffect: '' },
            currentTarget: tabB,
            clientX: 80, // right half -> drop-after
        };
        tm.handleTabDragOver(e, 'b');
        expect(e.preventDefault).toHaveBeenCalled();
        expect(tabB.classList.contains('drop-after')).toBe(true);
        expect(tabB.classList.contains('drop-before')).toBe(false);
        rectSpy.mockRestore();
    });

    it('handleTabDrop reorders and clears state', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b', 'c'] });
        tm.dragSourceId = 'a';
        const tabB = tm.tabsContainer.querySelector('[data-pane-id="b"]');
        // drop-after on b means "insert source after b" - a ends up between b and c.
        tabB.classList.add('drop-after');
        const e = { preventDefault: vi.fn(), currentTarget: tabB };
        tm.handleTabDrop(e, 'b');
        expect(mapOrder(tm)).toEqual(['b', 'a', 'c']);
        expect(domOrder(tm)).toEqual(['b', 'a', 'c']);
        expect(tm.dragSourceId).toBeNull();
        expect(tabB.classList.contains('drop-after')).toBe(false);
    });

    it('handleTabDrop with source == target is a no-op', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b'] });
        tm.dragSourceId = 'a';
        const tabA = tm.tabsContainer.querySelector('[data-pane-id="a"]');
        tabA.classList.add('drop-before');
        tm.handleTabDrop({ preventDefault: vi.fn(), currentTarget: tabA }, 'a');
        expect(mapOrder(tm)).toEqual(['a', 'b']);
        expect(tm.dragSourceId).toBeNull();
    });
});

describe('applySavedTabOrder - restore on page reload', () => {
    it('applies the saved order, drops stale paneIds, appends new ones', () => {
        // Simulate "saved" state from a prior session.
        localStorage.setItem(
            'phi_tab_order',
            JSON.stringify(['c', 'a', 'ghost']),
        );
        const tm = makeTabManager({ withTabs: ['a', 'b', 'c'] });
        tm.applySavedTabOrder();
        // ghost is dropped; b is appended at the end.
        expect(mapOrder(tm)).toEqual(['c', 'a', 'b']);
    });

    it('is a no-op when nothing is saved', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b'] });
        tm.applySavedTabOrder();
        expect(mapOrder(tm)).toEqual(['a', 'b']);
    });

    it('survives a corrupted localStorage entry', () => {
        localStorage.setItem('phi_tab_order', 'not-valid-json{{{');
        const tm = makeTabManager({ withTabs: ['a', 'b'] });
        expect(() => tm.applySavedTabOrder()).not.toThrow();
        expect(mapOrder(tm)).toEqual(['a', 'b']);
    });

    it('does not write back to localStorage when restoring', () => {
        localStorage.setItem('phi_tab_order', JSON.stringify(['b', 'a']));
        const tm = makeTabManager({ withTabs: ['a', 'b'] });
        tm.applySavedTabOrder();
        // Value should be unchanged after a no-op restore (it already was
        // ['b','a']). applySavedTabOrder calls applyTabOrder({persist:false}).
        expect(localStorage.getItem('phi_tab_order')).toBe(
            JSON.stringify(['b', 'a']),
        );
    });
});

describe('saveTabsState - persists order alongside active pane', () => {
    it('writes both phi_active_pane and phi_tab_order in one call', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b', 'c'] });
        tm.activePaneId = 'b';
        tm.saveTabsState();
        expect(localStorage.getItem('phi_active_pane')).toBe('b');
        expect(JSON.parse(localStorage.getItem('phi_tab_order'))).toEqual([
            'a',
            'b',
            'c',
        ]);
    });
});

describe('tabs are draggable regardless of pin status', () => {
    it('all tabs get draggable=true so reordering is always available', () => {
        // We can't go through full createTab() without xterm.js, but the
        // contract is: every tab is draggable. Pinning protects the
        // server-side PTY but doesn't lock strip position. This is a
        // static source check that locks in the convention.
        const fs = require('node:fs');
        const src = fs.readFileSync('web/terminal.js', 'utf8');
        expect(src).toMatch(/tabEl\.draggable\s*=\s*true/);
        expect(src).toMatch(/dragstart[\s\S]*handleTabDragStart/);
        // Drag listeners must be set unconditionally now (no `if (!pinned)` gate).
        expect(src).not.toMatch(
            /if\s*\(\s*!pinned\s*\)\s*\{\s*tabEl\.addEventListener\(\s*['"]dragstart/,
        );
    });
});
