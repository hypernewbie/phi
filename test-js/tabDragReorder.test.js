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

const workspaceEntries = [
    ['b1', '/repo/Beta', '/repo/Beta'],
    ['a1', '/repo/alpha', '/repo/alpha'],
    ['b2', '/repo/Beta', '/tmp/Beta-wt'],
    ['a2', '/repo/alpha', '/tmp/alpha-wt'],
    ['p1', '', '/orphan'],
    ['b3', '/repo/Beta', '/repo/Beta'],
    ['p2', '', ''],
];

function makeWorkspaceTabManager(entries = workspaceEntries) {
    const tm = makeTabManager();
    for (const [paneId, workspace, cwd] of entries) {
        const tabEl = document.createElement('div');
        tabEl.className = 'tab';
        tabEl.dataset.paneId = paneId;
        if (paneId === 'b3') tabEl.classList.add('soft-closed');
        tm.tabsContainer.appendChild(tabEl);
        const attachment = { name: `${paneId}.png` };
        const tab = {
            paneId,
            title: paneId,
            coder: paneId === 'p1' ? 'pi-rpc' : 'shell',
            workspace,
            cwd,
            tabEl,
            termContainer: document.createElement('div'),
            term: { dispose: vi.fn() },
            ws: { sendInput: vi.fn() },
            draft: paneId === 'a1' ? 'draft text' : '',
            draftAttachments: paneId === 'a1' ? [attachment] : [],
            pinned: paneId === 'b1',
            marked: paneId === 'b2',
            softClosing: paneId === 'b3',
            isDead: false,
            isReview: false,
            isKanban: paneId === 'p2',
        };
        tm.tabs.set(paneId, tab);
    }
    tm.activePaneId = 'b2';
    tm.getProjectWorktreeLabel = vi.fn((cwd) => cwd);
    return tm;
}

describe('workspace tab grouping and sort', () => {
    it('groups the interleaved Map by exact workspace and preserves entries', () => {
        const tm = makeWorkspaceTabManager();
        const entries = Array.from(tm.tabs.entries());
        const snapshot = entries.map(([paneId, tab]) => [paneId, tab]);

        const groups = tm._workspaceTabGroups(entries);

        expect(
            groups.map(({ workspace, label }) => [workspace, label]),
        ).toEqual([
            ['/repo/alpha', 'alpha'],
            ['/repo/Beta', 'Beta'],
            ['', 'No workspace'],
        ]);
        expect(
            groups.flatMap(({ entries: groupEntries }) =>
                groupEntries.map(([id]) => id),
            ),
        ).toEqual(['a1', 'a2', 'b1', 'b2', 'b3', 'p1', 'p2']);
        for (const group of groups) {
            for (const [paneId, tab] of group.entries) {
                expect(tm.tabs.get(paneId)).toBe(tab);
            }
        }
        expect(entries).toEqual(snapshot);
        expect(Array.from(tm.tabs.keys())).toEqual(
            workspaceEntries.map(([id]) => id),
        );
    });

    it('uses full paths for colliding labels and keeps case-distinct roots separate', () => {
        const tm = makeWorkspaceTabManager([
            ['one', '/one/team/project', '/one/team/project'],
            ['missing', '', '/orphan'],
            ['two', '/two/team/project', '/two/team/project'],
            ['named', '/No workspace', '/No workspace'],
            ['upper', '/repo/Alpha', '/repo/Alpha'],
            ['lower', '/repo/alpha', '/repo/alpha'],
        ]);

        const groups = tm._workspaceTabGroups(Array.from(tm.tabs.entries()));
        const byWorkspace = new Map(
            groups.map((group) => [group.workspace, group]),
        );

        expect(byWorkspace.get('/one/team/project').label).toBe(
            '/one/team/project',
        );
        expect(byWorkspace.get('/two/team/project').label).toBe(
            '/two/team/project',
        );
        expect(byWorkspace.get('/No workspace').label).toBe('/No workspace');
        expect(byWorkspace.get('').label).toBe('No workspace');
        expect(byWorkspace.get('/repo/Alpha').label).toBe('Alpha');
        expect(byWorkspace.get('/repo/alpha').label).toBe('alpha');
        const workspaceOrder = groups.map((group) => group.workspace);
        expect(workspaceOrder.indexOf('/one/team/project')).toBeLessThan(
            workspaceOrder.indexOf('/two/team/project'),
        );
        expect(groups.at(-1).workspace).toBe('');
        expect(
            groups.flatMap((group) => group.entries.map(([id]) => id)),
        ).toHaveLength(6);
    });

    it('sorts workspace names numerically and retains input order within each group', () => {
        const tm = makeWorkspaceTabManager([
            ['ten-a', '/repo/workspace 10', '/ten-a'],
            ['two', '/repo/workspace 2', '/two'],
            ['ten-b', '/repo/workspace 10', '/ten-b'],
        ]);

        const groups = tm._workspaceTabGroups(Array.from(tm.tabs.entries()));
        expect(groups.map(({ workspace }) => workspace)).toEqual([
            '/repo/workspace 2',
            '/repo/workspace 10',
            '',
        ]);
        expect(
            groups.flatMap(({ entries: groupEntries }) =>
                groupEntries.map(([id]) => id),
            ),
        ).toEqual(['two', 'ten-a', 'ten-b']);
    });

    it('sorts every entry once, including closing tabs, without replacing tab state', () => {
        const tm = makeWorkspaceTabManager();
        const originalEntries = Array.from(tm.tabs.entries());
        const originalNodes = new Map(
            originalEntries.map(([id, tab]) => [id, tab.tabEl]),
        );
        const originalContainers = new Map(
            originalEntries.map(([id, tab]) => [id, tab.termContainer]),
        );
        const originalTerms = new Map(
            originalEntries.map(([id, tab]) => [id, tab.term]),
        );
        const originalSockets = new Map(
            originalEntries.map(([id, tab]) => [id, tab.ws]),
        );
        const attachment = tm.tabs.get('a1').draftAttachments[0];
        const attachments = tm.tabs.get('a1').draftAttachments;
        const disposeSpies = originalEntries.map(([, tab]) => tab.term.dispose);
        tm.switchTab = vi.fn();
        tm.reconnectTab = vi.fn();
        tm.sendToTab = vi.fn();
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        localStorage.setItem('phi_active_pane', 'b2');

        tm.sortTabsByWorkspace();

        const expected = ['a1', 'a2', 'b1', 'b2', 'b3', 'p1', 'p2'];
        expect(Array.from(tm.tabs.keys())).toEqual(expected);
        expect(domOrder(tm)).toEqual(expected);
        expect(JSON.parse(localStorage.getItem('phi_tab_order'))).toEqual(
            expected,
        );
        expect(new Set(Array.from(tm.tabs.keys())).size).toBe(tm.tabs.size);
        for (const [id, tab] of originalEntries) {
            expect(tm.tabs.get(id)).toBe(tab);
            expect(
                tm.tabsContainer.querySelector(`[data-pane-id="${id}"]`),
            ).toBe(originalNodes.get(id));
            expect(tab.termContainer).toBe(originalContainers.get(id));
            expect(tab.term).toBe(originalTerms.get(id));
            expect(tab.ws).toBe(originalSockets.get(id));
        }
        expect(tm.activePaneId).toBe('b2');
        expect(localStorage.getItem('phi_active_pane')).toBe('b2');
        expect(tm.tabs.get('a1').draft).toBe('draft text');
        expect(tm.tabs.get('a1').draftAttachments).toBe(attachments);
        expect(tm.tabs.get('a1').draftAttachments).toEqual([attachment]);
        expect(tm.tabs.get('a1').draftAttachments[0]).toBe(attachment);
        expect(tm.tabs.get('b1').pinned).toBe(true);
        expect(tm.tabs.get('b2').marked).toBe(true);
        expect(tm.tabs.get('b3').softClosing).toBe(true);
        expect(tm.tabs.get('p1').coder).toBe('pi-rpc');
        expect(tm.tabs.get('p2').isKanban).toBe(true);
        expect(tm.switchTab).not.toHaveBeenCalled();
        expect(tm.reconnectTab).not.toHaveBeenCalled();
        expect(tm.sendToTab).not.toHaveBeenCalled();
        expect(
            disposeSpies.every((dispose) => !dispose.mock.calls.length),
        ).toBe(true);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('keeps repeated sorts idempotent and does not mutate a later appended tab', () => {
        const tm = makeWorkspaceTabManager();
        tm.sortTabsByWorkspace();
        const sorted = Array.from(tm.tabs.keys());
        tm.sortTabsByWorkspace();
        expect(Array.from(tm.tabs.keys())).toEqual(sorted);
        expect(JSON.parse(localStorage.getItem('phi_tab_order'))).toEqual(
            sorted,
        );

        const tabEl = document.createElement('div');
        tabEl.className = 'tab';
        tabEl.dataset.paneId = 'a3';
        tm.tabsContainer.appendChild(tabEl);
        tm.tabs.set('a3', {
            paneId: 'a3',
            workspace: '/repo/alpha',
            tabEl,
            termContainer: document.createElement('div'),
        });
        expect(Array.from(tm.tabs.keys())).toEqual([...sorted, 'a3']);
        tm.sortTabsByWorkspace();
        expect(Array.from(tm.tabs.keys())).toEqual([
            'a1',
            'a2',
            'a3',
            'b1',
            'b2',
            'b3',
            'p1',
            'p2',
        ]);
    });

    it('leaves empty and one-tab Maps untouched', () => {
        for (const entries of [[], [['only', '/repo/only', '/repo/only']]]) {
            const tm = makeWorkspaceTabManager(entries);
            const applySpy = vi.spyOn(tm, 'applyTabOrder');
            const before = Array.from(tm.tabs.entries());
            tm.sortTabsByWorkspace();
            expect(applySpy).not.toHaveBeenCalled();
            expect(Array.from(tm.tabs.entries())).toEqual(before);
            expect(localStorage.getItem('phi_tab_order')).toBeNull();
        }
    });

    it('keeps manual drag ordering and saved-order restoration working', () => {
        const tm = makeWorkspaceTabManager();
        tm.sortTabsByWorkspace();
        expect(tm.moveTabTo('p1', 'b1', true)).toBe(true);
        expect(Array.from(tm.tabs.keys())).toEqual([
            'a1',
            'a2',
            'p1',
            'b1',
            'b2',
            'b3',
            'p2',
        ]);
        expect(JSON.parse(localStorage.getItem('phi_tab_order'))).toEqual([
            'a1',
            'a2',
            'p1',
            'b1',
            'b2',
            'b3',
            'p2',
        ]);

        const sortedOrder = ['a1', 'a2', 'b1', 'b2', 'b3', 'p1', 'p2'];
        localStorage.setItem('phi_tab_order', JSON.stringify(sortedOrder));
        localStorage.setItem('phi_active_pane', 'b2');
        const restored = makeWorkspaceTabManager(
            [...workspaceEntries].reverse(),
        );
        restored.applySavedTabOrder();
        expect(Array.from(restored.tabs.keys())).toEqual(sortedOrder);
        expect(restored.activePaneId).toBe('b2');
        expect(localStorage.getItem('phi_active_pane')).toBe('b2');
    });
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
