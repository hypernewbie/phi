// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';

// Tab strip overflow affordances: +N more chip, all-tabs dropdown
// grouped by worktree glyph, sidebar worktree legend, mouse-wheel
// horizontal scroll, edge auto-scroll during drag, and drop-into-
// whitespace for the far edge.
//
// Layout is faked via a customRect helper that returns predictable
// widths; jsdom doesn't do real layout, so we override
// getBoundingClientRect + scrollWidth/clientWidth per fixture.

setupDomHarness();

// Mount all the DOM nodes the new methods read via getElementById.
function mountChromeDom() {
    document.body.innerHTML = `
        <div id="tabs-container"></div>
        <button id="tab-overflow-btn" class="tab-overflow-btn hidden">
            <span class="tab-overflow-btn-label"></span>
        </button>
        <div id="tab-overflow-dropdown" class="tab-overflow-dropdown hidden"></div>
        <div id="worktree-legend"></div>
    `;
}

function makeTabManager({ withTabs = [], width = 800 } = {}) {
    mountChromeDom();
    const tm = Object.create(TabManager.prototype);
    tm.tabs = new Map();
    tm.activePaneId = null;
    tm.dragSourceId = null;
    tm.tabsContainer = document.getElementById('tabs-container');
    document.body.appendChild(tm.tabsContainer);
    // Layout: tabs each "150px" wide, container total clientWidth 800.
    // If total tab width > clientWidth, the strip is overflowing.
    tm._layoutWidth = width;
    tm._layoutTabWidth = 150;
    let cursor = 0;
    for (const id of withTabs) {
        const tabEl = document.createElement('div');
        tabEl.className = 'tab';
        tabEl.setAttribute('data-pane-id', id);
        tabEl.dataset.worktreeGlyph = id.startsWith('A:') ? '◆'
            : id.startsWith('B:') ? '◇'
            : id.startsWith('C:') ? '▣' : '★';
        // Capture layout values at iteration time. Without this, the
        // closure would resolve `cursor` at call time when the loop
        // has already advanced past this tab.
        const tabLeft = cursor;
        const tabRight = cursor + tm._layoutTabWidth;
        tabEl.getBoundingClientRect = vi.fn(() => ({
            left: tabLeft,
            right: tabRight,
            top: 0,
            bottom: 34,
            width: tm._layoutTabWidth,
            height: 34,
            x: tabLeft,
            y: 0,
            toJSON: () => ({}),
        }));
        cursor += tm._layoutTabWidth;
        tm.tabsContainer.appendChild(tabEl);
        tm.tabs.set(id, {
            paneId: id,
            title: id,
            coder: 'shell',
            cwd: id,
            faviconUrl: '',
            tabEl,
            termContainer: document.createElement('div'),
            isDead: false,
            isReview: false,
            isKanban: false,
            pinned: false,
            marked: false,
        });
    }
    // Container bounding rect: full bar at left=0.
    tm.tabsContainer.getBoundingClientRect = vi.fn(() => ({
        left: 0, right: tm._layoutWidth,
        top: 0, bottom: 42,
        width: tm._layoutWidth, height: 42,
        x: 0, y: 0,
        toJSON: () => ({}),
    }));
    // scrollWidth = total width of all tabs.
    Object.defineProperty(tm.tabsContainer, 'scrollWidth', {
        configurable: true,
        get: () => withTabs.length * tm._layoutTabWidth,
    });
    Object.defineProperty(tm.tabsContainer, 'clientWidth', {
        configurable: true,
        get: () => tm._layoutWidth,
    });
    // Stub the worktree-label helper.
    tm.getProjectWorktreeLabel = vi.fn((cwd) => cwd === 'A:tab1' ? 'A/tab1' : cwd);
    return tm;
}

// ---- +N more chip: presence + label -------------------------------

describe('updateTabOverflow', () => {
    it('hides the chip when tabs fit in the visible area', () => {
        const tm = makeTabManager({ withTabs: ['t1', 't2', 't3'], width: 1200 });
        tm.updateTabOverflow();
        const btn = document.getElementById('tab-overflow-btn');
        expect(btn.classList.contains('hidden')).toBe(true);
    });

    it('shows the chip when tabs overflow', () => {
        // 8 tabs × 150 = 1200, clientWidth=800 -> overflow.
        const tm = makeTabManager({
            withTabs: ['t1','t2','t3','t4','t5','t6','t7','t8'],
            width: 800,
        });
        tm.updateTabOverflow();
        const btn = document.getElementById('tab-overflow-btn');
        expect(btn.classList.contains('hidden')).toBe(false);
    });

    it('chip label counts how many tabs are past the right edge', () => {
        // 8 tabs at 150 each = 1200, clientWidth 800. Tabs t1..t5 are
        // visible (0..750). Tabs t6,t7,t8 are at 750..1200 (past 800).
        // So 3 hidden tabs.
        const tm = makeTabManager({
            withTabs: ['t1','t2','t3','t4','t5','t6','t7','t8'],
            width: 800,
        });
        // Debug snapshot to see what the production code is computing.
        const strip = document.getElementById('tabs-container');
        const rect = strip.getBoundingClientRect();
        const tabs = strip.querySelectorAll('.tab');
        const tabRects = Array.from(tabs).map(t => t.getBoundingClientRect());
        console.log('stripRect', rect, 'count', tabs.length,
            'first3Rects', tabRects.slice(0,3));
        tm.updateTabOverflow();
        const label = document.querySelector('.tab-overflow-btn-label');
        expect(label.textContent).toBe('+3 more');
    });
});

// ---- Sidebar worktree legend ----------------------------------------

describe('updateWorktreeLegend', () => {
    it('renders one entry per distinct worktree glyph with a count', () => {
        const tm = makeTabManager({ withTabs: ['A:a', 'A:b', 'B:c', 'C:d'], width: 800 });
        tm.updateWorktreeLegend();
        const entries = document.querySelectorAll('.worktree-legend-entry');
        expect(entries.length).toBe(3); // A, B, C
        // Find the A entry (◆) which should show count 2.
        const aEntry = Array.from(entries).find(e =>
            e.querySelector('.worktree-legend-entry-icon').textContent === '◆'
        );
        expect(aEntry).toBeTruthy();
        expect(aEntry.querySelector('.worktree-legend-entry-count').textContent).toBe('2');
        // B entry should show 1.
        const bEntry = Array.from(entries).find(e =>
            e.querySelector('.worktree-legend-entry-icon').textContent === '◇'
        );
        expect(bEntry.querySelector('.worktree-legend-entry-count').textContent).toBe('1');
    });

    it('clears the legend when all tabs close', () => {
        const tm = makeTabManager({ withTabs: ['A:a'], width: 800 });
        tm.updateWorktreeLegend();
        expect(document.querySelectorAll('.worktree-legend-entry').length).toBe(1);
        tm.tabs.delete('A:a');
        tm.updateWorktreeLegend();
        expect(document.querySelectorAll('.worktree-legend-entry').length).toBe(0);
    });
});

// ---- Overflow dropdown: grouping + click-to-switch ------------------

describe('_buildOverflowDropdown', () => {
    it('groups tabs by worktree glyph with a per-group header', () => {
        const tm = makeTabManager({ withTabs: ['A:a', 'A:b', 'B:c'], width: 400 });
        tm._buildOverflowDropdown();
        const dropdown = document.getElementById('tab-overflow-dropdown');
        const groups = dropdown.querySelectorAll('.tab-overflow-dropdown-group');
        expect(groups.length).toBe(2); // A and B
        // First group (A) should list 2 tabs in count badge.
        expect(groups[0].textContent).toMatch(/2 tab/);
        // Each group header has an icon matching the glyph.
        expect(groups[0].querySelector('.tab-overflow-dropdown-group-icon').textContent).toBe('◆');
        expect(groups[1].querySelector('.tab-overflow-dropdown-group-icon').textContent).toBe('◇');
        // Tab rows are interleaved per their group.
        const rows = dropdown.querySelectorAll('.hostname-dropdown-row');
        expect(rows.length).toBe(3);
    });

    it('renders an empty-state message when no tabs are open', () => {
        const tm = makeTabManager({ withTabs: [], width: 800 });
        tm._buildOverflowDropdown();
        const dropdown = document.getElementById('tab-overflow-dropdown');
        expect(dropdown.textContent).toMatch(/No tabs open/i);
    });

    it('dropdown toggle shows/hides via aria-expanded', () => {
        const tm = makeTabManager({ withTabs: ['A:a'], width: 800 });
        const btn = document.getElementById('tab-overflow-btn');
        // Start hidden.
        expect(document.getElementById('tab-overflow-dropdown').classList.contains('hidden')).toBe(true);
        tm._toggleOverflowDropdown();
        expect(document.getElementById('tab-overflow-dropdown').classList.contains('hidden')).toBe(false);
        expect(btn.getAttribute('aria-expanded')).toBe('true');
        tm._toggleOverflowDropdown();
        expect(document.getElementById('tab-overflow-dropdown').classList.contains('hidden')).toBe(true);
        expect(btn.getAttribute('aria-expanded')).toBe('false');
    });

    it('clicking a row closes the dropdown and switches the active tab', () => {
        const tm = makeTabManager({ withTabs: ['A:a', 'A:b'], width: 800 });
        // Spy on switchTab to verify the click handler calls it.
        const switchSpy = vi.spyOn(tm, 'switchTab').mockImplementation(() => {});
        tm._buildOverflowDropdown();
        const dd = document.getElementById('tab-overflow-dropdown');
        const row = dd.querySelector('.hostname-dropdown-row');
        // First row's select button should call switchTab and close.
        const selectBtn = row.querySelector('.hostname-dropdown-select-btn');
        selectBtn.click();
        expect(switchSpy).toHaveBeenCalledWith('A:a', expect.objectContaining({ userInitiated: true }));
        expect(dd.classList.contains('hidden')).toBe(true);
    });
});

// ---- Mouse-wheel horizontal scroll ----------------------------------

describe('wheel -> horizontal scroll', () => {
    function dispatchWheel(tm, { deltaX = 0, deltaY = 0, cancelable = true } = {}) {
        const ev = new WheelEvent('wheel', {
            deltaX, deltaY, bubbles: true, cancelable,
        });
        tm.tabsContainer.dispatchEvent(ev);
        return ev;
    }

    it('translates vertical wheel to horizontal scroll when strip overflows', () => {
        const tm = makeTabManager({
            withTabs: ['t1','t2','t3','t4','t5','t6','t7','t8'],
            width: 600,
        });
        tm._setupContainerDragHandlers();
        const ev = dispatchWheel(tm, { deltaY: 100 });
        expect(ev.defaultPrevented).toBe(true);
        // scrollLeft should have advanced by exactly deltaY.
        expect(tm.tabsContainer.scrollLeft).toBe(100);
    });

    it('does NOT preventDefault when the strip has no overflow', () => {
        const tm = makeTabManager({ withTabs: ['t1','t2'], width: 1200 });
        tm._setupContainerDragHandlers();
        const ev = dispatchWheel(tm, { deltaY: 100 });
        expect(ev.defaultPrevented).toBe(false);
    });

    it('respects the scrollLeft upper bound (does not over-scroll)', () => {
        const tm = makeTabManager({
            withTabs: ['t1','t2','t3','t4','t5','t6','t7','t8'],
            width: 600,
        });
        tm._setupContainerDragHandlers();
        // totalScroll = 8*150 - 600 = 600. Push past the limit.
        const ev = dispatchWheel(tm, { deltaY: 9999 });
        expect(tm.tabsContainer.scrollLeft).toBe(600);
        expect(ev.defaultPrevented).toBe(true);
    });

    it('accepts deltaX (trackpad horizontal gesture) directly', () => {
        const tm = makeTabManager({
            withTabs: ['t1','t2','t3','t4','t5','t6'],
            width: 600,
        });
        tm._setupContainerDragHandlers();
        const ev = dispatchWheel(tm, { deltaX: 50, deltaY: 0 });
        expect(ev.defaultPrevented).toBe(true);
        expect(tm.tabsContainer.scrollLeft).toBe(50);
    });
});

// ---- Edge auto-scroll during drag ----------------------------------

describe('edge auto-scroll during drag', () => {
    function dragOver(tm, clientX) {
        const ev = new Event('dragover', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clientX', { value: clientX });
        Object.defineProperty(ev, 'dataTransfer', {
            value: { dropEffect: '', effectAllowed: '' },
        });
        tm.tabsContainer.dispatchEvent(ev);
        return ev;
    }

    it('sets scroll direction + velocity when cursor is in the right edge zone', () => {
        const tm = makeTabManager({
            withTabs: ['t1','t2','t3','t4','t5','t6'],
            width: 800,
        });
        tm.dragSourceId = 't1';
        tm._setupContainerDragHandlers();
        // Cursor at clientX = 800-10 = 790. Edge zone is 48px from right
        // (800-48 = 752). 790 > 752 → right direction.
        dragOver(tm, 790);
        expect(tm._dragScrollDir).toBe(1);
        expect(tm._dragScrollVel).toBeGreaterThan(0);
        expect(tm._dragScrollVel).toBeLessThanOrEqual(15);
    });

    it('sets scroll direction -1 when cursor is in the left edge zone', () => {
        const tm = makeTabManager({
            withTabs: ['t1','t2','t3','t4','t5','t6'],
            width: 800,
        });
        tm.dragSourceId = 't1';
        tm._setupContainerDragHandlers();
        // Cursor at clientX = 10. Edge zone is 48px from left.
        // 10 < 48 → left direction.
        dragOver(tm, 10);
        expect(tm._dragScrollDir).toBe(-1);
        expect(tm._dragScrollVel).toBeGreaterThan(0);
    });

    it('sets velocity to zero when cursor is in the middle of the strip', () => {
        const tm = makeTabManager({
            withTabs: ['t1','t2','t3','t4','t5','t6'],
            width: 800,
        });
        tm.dragSourceId = 't1';
        tm._setupContainerDragHandlers();
        // Mid-strip: clientX=400 (well past both edge zones).
        dragOver(tm, 400);
        expect(tm._dragScrollDir).toBe(0);
        expect(tm._dragScrollVel).toBe(0);
    });

    it('does not act when no drag is in progress', () => {
        const tm = makeTabManager({
            withTabs: ['t1','t2','t3','t4','t5','t6'],
            width: 800,
        });
        tm.dragSourceId = null;
        tm._setupContainerDragHandlers();
        dragOver(tm, 790);
        expect(tm._dragScrollDir).toBe(0);
    });

    it('preventDefaults so dragover keeps firing over whitespace', () => {
        const tm = makeTabManager({
            withTabs: ['t1','t2'],
            width: 1200,
        });
        tm.dragSourceId = 't1';
        tm._setupContainerDragHandlers();
        const ev = dragOver(tm, 0);
        expect(ev.defaultPrevented).toBe(true);
    });

    it('_stopDragAutoScroll clears state and cancels the rAF', () => {
        const tm = makeTabManager({ withTabs: ['t1'], width: 800 });
        tm._dragScrollDir = 1;
        tm._dragScrollVel = 10;
        tm._dragScrollRaf = 123; // truthy stub
        tm._stopDragAutoScroll();
        expect(tm._dragScrollDir).toBe(0);
        expect(tm._dragScrollVel).toBe(0);
        expect(tm._dragScrollRaf).toBe(null);
    });

    it('handleTabDragEnd clears auto-scroll state (cleanup)', () => {
        const tm = makeTabManager({ withTabs: ['t1'], width: 800 });
        tm.dragSourceId = 't1';
        tm._dragScrollDir = 1;
        tm._dragScrollVel = 8;
        tm._dragScrollRaf = 456;
        // jsdom doesn't supply e.currentTarget here, but handleTabDragEnd
        // only touches it if present.
        tm.handleTabDragEnd({ currentTarget: null });
        expect(tm.dragSourceId).toBe(null);
        expect(tm._dragScrollDir).toBe(0);
        expect(tm._dragScrollVel).toBe(0);
    });
});

// ---- Container-level drop on whitespace ----------------------------

describe('container drop on whitespace', () => {
    function fireDropOnStrip(tm, clientX) {
        const ev = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clientX', { value: clientX });
        // Pretend the drop landed on the strip itself, not a child.
        Object.defineProperty(ev, 'target', {
            value: tm.tabsContainer,
        });
        tm.tabsContainer.dispatchEvent(ev);
        return ev;
    }

    it('appends source tab to end when dropping past the right edge of strip', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b', 'c'], width: 800 });
        tm.dragSourceId = 'a';
        tm._setupContainerDragHandlers();
        // Mock tabsContainer.contains to return false (drop on whitespace, not a tab).
        tm.tabsContainer.contains = vi.fn(() => false);
        fireDropOnStrip(tm, 850); // past the right edge (800-4=796)
        expect(tm.tabs.has('a')).toBe(true);
        // 'a' should now be last in the Map order.
        const order = Array.from(tm.tabs.keys());
        expect(order[order.length - 1]).toBe('a');
    });

    it('prepends source tab to start when dropping before the left edge', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b', 'c'], width: 800 });
        tm.dragSourceId = 'c';
        tm._setupContainerDragHandlers();
        tm.tabsContainer.contains = vi.fn(() => false);
        fireDropOnStrip(tm, -10); // before the left edge
        // 'c' should now be first.
        const order = Array.from(tm.tabs.keys());
        expect(order[0]).toBe('c');
    });

    it('stops auto-scroll on whitespace drop', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b'], width: 800 });
        tm.dragSourceId = 'a';
        tm._dragScrollDir = 1;
        tm._dragScrollVel = 5;
        tm._setupContainerDragHandlers();
        tm.tabsContainer.contains = vi.fn(() => false);
        fireDropOnStrip(tm, 850);
        expect(tm._dragScrollDir).toBe(0);
        expect(tm._dragScrollVel).toBe(0);
    });

    it('is a no-op if no tab is being dragged', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b'], width: 800 });
        tm.dragSourceId = null;
        tm._setupContainerDragHandlers();
        tm.tabsContainer.contains = vi.fn(() => false);
        const orderBefore = Array.from(tm.tabs.keys());
        fireDropOnStrip(tm, 850);
        const orderAfter = Array.from(tm.tabs.keys());
        expect(orderAfter).toEqual(orderBefore);
    });
});
