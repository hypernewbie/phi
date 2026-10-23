// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabManager } from '../web/terminal.js';

function tab(paneId) {
    const tabEl = document.createElement('div');
    tabEl.className = 'tab';
    tabEl.innerHTML = '<span class="tab-title">Session</span>';
    return { paneId, tabEl, coder: 'pi', isBusy: false };
}

let manager;
beforeEach(() => {
    document.body.innerHTML = '';
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    manager = Object.assign(Object.create(TabManager.prototype), {
        tabs: new Map(),
        activePaneId: 'active',
        updateDocumentTitle: vi.fn(),
        updateTabOverflow: vi.fn(),
        _refreshOverflowDropdown: vi.fn(),
        _refreshHostnameTabsDropdown: vi.fn(),
    });
});
afterEach(() => vi.restoreAllMocks());

describe('completion attention presentation', () => {
    it('adds one accessible status outside the title and removes it on acknowledgement', () => {
        const entry = tab('one');
        expect(manager._setTabAttention(entry, true)).toBe(true);
        expect(manager._setTabAttention(entry, true)).toBe(false);
        expect(entry.isAttention).toBe(true);
        expect(entry.tabEl.classList.contains('has-attention')).toBe(true);
        expect(
            entry.tabEl.querySelectorAll('.tab-attention-indicator'),
        ).toHaveLength(1);
        const status = entry.tabEl.querySelector('.tab-attention-indicator');
        expect(status.getAttribute('role')).toBe('img');
        expect(status.getAttribute('aria-label')).toBe('Needs attention');
        expect(entry.tabEl.querySelector('.tab-title').textContent).toBe(
            'Session',
        );
        expect(status.closest('.tab-title')).toBeNull();

        expect(manager._setTabAttention(entry, false)).toBe(true);
        expect(entry.isAttention).toBe(false);
        expect(entry.tabEl.classList.contains('has-attention')).toBe(false);
        expect(
            entry.tabEl.querySelector('.tab-attention-indicator'),
        ).toBeNull();
    });

    it('does not turn missing attention state into an unread cue', () => {
        const entry = tab('one');
        expect(manager._setTabAttention(entry, false)).toBe(false);
        expect(
            entry.tabEl.querySelector('.tab-attention-indicator'),
        ).toBeNull();
    });

    it('acknowledges only the visible active tab during polling', () => {
        const active = tab('active');
        const background = tab('background');
        manager.tabs = new Map([
            ['active', active],
            ['background', background],
        ]);
        manager._setTabAttention(active, true);
        manager._setTabAttention(background, true);
        manager.pollTerminalIdleAndNotifications();
        expect(active.isAttention).toBe(false);
        expect(
            active.tabEl.querySelector('.tab-attention-indicator'),
        ).toBeNull();
        expect(background.isAttention).toBe(true);
        expect(
            background.tabEl.querySelector('.tab-attention-indicator'),
        ).not.toBeNull();
        expect(manager.updateDocumentTitle).toHaveBeenCalledOnce();
    });

    it('clears both visual and accessible status through the existing clear-all action', () => {
        const first = tab('first');
        const second = tab('second');
        manager.tabs = new Map([
            ['first', first],
            ['second', second],
        ]);
        manager._setTabAttention(first, true);
        manager._setTabAttention(second, true);
        manager.clearAttentionIndicators();
        for (const entry of manager.tabs.values()) {
            expect(entry.isAttention).toBe(false);
            expect(
                entry.tabEl.querySelector('.tab-attention-indicator'),
            ).toBeNull();
        }
        expect(manager.updateDocumentTitle).toHaveBeenCalledOnce();
    });

    it('refreshes open tab lists only when attention actually changes', () => {
        const entry = tab('one');
        manager._setTabAttention(entry, true);
        expect(manager._refreshOverflowDropdown).toHaveBeenCalledOnce();
        expect(manager._refreshHostnameTabsDropdown).toHaveBeenCalledOnce();
        manager._setTabAttention(entry, true);
        expect(manager._refreshOverflowDropdown).toHaveBeenCalledOnce();
        expect(manager._refreshHostnameTabsDropdown).toHaveBeenCalledOnce();
    });

    it('preserves attention across native title updates and inline title editing', () => {
        const entry = tab('one');
        manager._setTabAttention(entry, true);
        const status = entry.tabEl.querySelector('.tab-attention-indicator');
        manager._setTabTitle(entry, 'Native title');
        expect(entry.tabEl.querySelector('.tab-title').textContent).toBe(
            'Native title',
        );
        expect(entry.tabEl.querySelector('.tab-attention-indicator')).toBe(
            status,
        );
        const editor = document.createElement('input');
        editor.className = 'tab-title';
        editor.value = 'Unsaved draft';
        entry.tabEl.querySelector('.tab-title').replaceWith(editor);
        manager._setTabTitle(entry, 'Another title');
        expect(editor.value).toBe('Unsaved draft');
        expect(entry.tabEl.querySelector('.tab-attention-indicator')).toBe(
            status,
        );
    });
});

describe('unread-first tab-list ordering', () => {
    function workspaceTab(paneId, workspace, isAttention) {
        return [paneId, { paneId, workspace, isAttention }];
    }

    it('partitions explicit sort unread-first with workspace order secondary', () => {
        manager.tabs = new Map([
            workspaceTab('beta-read', 'beta', false),
            workspaceTab('alpha-unread', 'alpha', true),
            workspaceTab('alpha-read', 'alpha', false),
            workspaceTab('beta-unread', 'beta', true),
        ]);
        manager.applyTabOrder = vi.fn();
        manager.sortTabsByWorkspace();
        expect(manager.applyTabOrder).toHaveBeenCalledWith([
            'alpha-unread',
            'beta-unread',
            'alpha-read',
            'beta-read',
        ]);
    });

    it('keeps workspace order unchanged when nothing needs attention', () => {
        manager.tabs = new Map([
            workspaceTab('beta-read', 'beta', false),
            workspaceTab('alpha-read', 'alpha', false),
        ]);
        manager.applyTabOrder = vi.fn();
        manager.sortTabsByWorkspace();
        expect(manager.applyTabOrder).toHaveBeenCalledWith([
            'alpha-read',
            'beta-read',
        ]);
    });

    it('keeps closing tabs in the read partition of explicit sort', () => {
        manager.tabs = new Map([
            workspaceTab('alpha-read', 'alpha', false),
            [
                'beta-closing',
                {
                    paneId: 'beta-closing',
                    workspace: 'beta',
                    isAttention: true,
                    softClosing: true,
                },
            ],
            workspaceTab('beta-unread', 'beta', true),
        ]);
        manager.applyTabOrder = vi.fn();
        manager.sortTabsByWorkspace();
        expect(manager.applyTabOrder).toHaveBeenCalledWith([
            'beta-unread',
            'alpha-read',
            'beta-closing',
        ]);
    });

    it('lists unread sessions first in the hostname dropdown', () => {
        document.body.innerHTML = '<div id="hostname-tabs-dropdown"></div>';
        manager.tabs = new Map([
            [
                'read',
                {
                    paneId: 'read',
                    title: 'Read Tab',
                    coder: 'bash',
                    cwd: '/r',
                    isAttention: false,
                },
            ],
            [
                'unread',
                {
                    paneId: 'unread',
                    title: 'Unread Tab',
                    coder: 'pi',
                    cwd: '/u',
                    isAttention: true,
                },
            ],
        ]);
        manager.activePaneId = 'read';
        manager.renderHostnameTabsDropdown();
        const rows = Array.from(
            document.querySelectorAll(
                '#hostname-tabs-dropdown .hostname-dropdown-row',
            ),
        );
        // Titles use innerText, which jsdom does not render; the favicon
        // alt attribute carries the same per-row identity for ordering.
        expect(rows.map((row) => row.querySelector('img').alt)).toEqual([
            'pi',
            'bash',
        ]);
        expect(rows[0].classList.contains('has-attention')).toBe(true);
        const status = rows[0].querySelector('.hostname-dropdown-attention');
        expect(status?.getAttribute('aria-label')).toBe('Needs attention');
        expect(
            rows[1].querySelector('.hostname-dropdown-attention'),
        ).toBeNull();
    });

    it('refreshes only a visible hostname dropdown', () => {
        document.body.innerHTML =
            '<div id="hostname-tabs-dropdown" class="hidden">stale</div>';
        manager.tabs = new Map();
        TabManager.prototype._refreshHostnameTabsDropdown.call(manager);
        expect(
            document.getElementById('hostname-tabs-dropdown').textContent,
        ).toBe('stale');
        document
            .getElementById('hostname-tabs-dropdown')
            .classList.remove('hidden');
        TabManager.prototype._refreshHostnameTabsDropdown.call(manager);
        expect(
            document.querySelector(
                '#hostname-tabs-dropdown .hostname-dropdown-item',
            ),
        ).not.toBeNull();
    });

    it('preserves focus and scroll when a live settlement refreshes the hostname list', () => {
        document.body.innerHTML = '<div id="hostname-tabs-dropdown"></div>';
        manager.tabs = new Map([
            [
                'read',
                {
                    paneId: 'read',
                    title: 'Read Tab',
                    coder: 'bash',
                    cwd: '/r',
                    isAttention: false,
                },
            ],
            [
                'later',
                {
                    paneId: 'later',
                    title: 'Later Tab',
                    coder: 'pi',
                    cwd: '/u',
                    isAttention: false,
                },
            ],
        ]);
        manager.activePaneId = 'read';
        // Exercise the real refresh path instead of the stubbed hook.
        delete manager._refreshHostnameTabsDropdown;
        TabManager.prototype.renderHostnameTabsDropdown.call(manager);
        const dropdown = document.getElementById('hostname-tabs-dropdown');
        dropdown.scrollTop = 42;
        dropdown
            .querySelector('[data-pane-id="read"] .hostname-dropdown-close-btn')
            .focus();
        manager._setTabAttention(manager.tabs.get('later'), true);
        expect(document.activeElement).toBe(
            dropdown.querySelector(
                '[data-pane-id="read"] .hostname-dropdown-close-btn',
            ),
        );
        expect(dropdown.scrollTop).toBe(42);
        expect(
            dropdown.querySelector('.hostname-dropdown-row').dataset.paneId,
        ).toBe('later');
    });

    it('restores hostname focus for pane IDs containing quotes or backslashes', () => {
        document.body.innerHTML = '<div id="hostname-tabs-dropdown"></div>';
        const hostileId = 'review-a"b\\c';
        manager.tabs = new Map([
            [
                hostileId,
                {
                    paneId: hostileId,
                    title: 'Hostile',
                    coder: 'pi',
                    cwd: '/r',
                    isAttention: false,
                },
            ],
            [
                'later',
                {
                    paneId: 'later',
                    title: 'Later Tab',
                    coder: 'pi',
                    cwd: '/u',
                    isAttention: false,
                },
            ],
        ]);
        manager.activePaneId = hostileId;
        delete manager._refreshHostnameTabsDropdown;
        TabManager.prototype.renderHostnameTabsDropdown.call(manager);
        const dropdown = document.getElementById('hostname-tabs-dropdown');
        const findRow = () =>
            Array.from(
                dropdown.querySelectorAll('.hostname-dropdown-row'),
            ).find((candidate) => candidate.dataset.paneId === hostileId);
        findRow().querySelector('.hostname-dropdown-pin-btn').focus();
        expect(() =>
            manager._setTabAttention(manager.tabs.get('later'), true),
        ).not.toThrow();
        expect(document.activeElement).toBe(
            findRow().querySelector('.hostname-dropdown-pin-btn'),
        );
    });

    it('grants closing rows no attention styling or priority in the hostname list', () => {
        document.body.innerHTML = '<div id="hostname-tabs-dropdown"></div>';
        manager.tabs = new Map([
            [
                'read',
                {
                    paneId: 'read',
                    title: 'Read Tab',
                    coder: 'bash',
                    cwd: '/r',
                    isAttention: false,
                },
            ],
            [
                'closing',
                {
                    paneId: 'closing',
                    title: 'Closing Tab',
                    coder: 'pi',
                    cwd: '/u',
                    isAttention: true,
                    softClosing: true,
                },
            ],
            [
                'unread',
                {
                    paneId: 'unread',
                    title: 'Unread Tab',
                    coder: 'pi',
                    cwd: '/v',
                    isAttention: true,
                },
            ],
        ]);
        manager.activePaneId = 'read';
        manager.renderHostnameTabsDropdown();
        const rows = Array.from(
            document.querySelectorAll(
                '#hostname-tabs-dropdown .hostname-dropdown-row',
            ),
        );
        expect(rows.map((row) => row.dataset.paneId)).toEqual([
            'unread',
            'read',
            'closing',
        ]);
        const closingRow = rows.find((row) => row.dataset.paneId === 'closing');
        expect(closingRow.classList.contains('has-attention')).toBe(false);
        expect(
            closingRow.querySelector('.hostname-dropdown-attention'),
        ).toBeNull();
    });

    it('drops hostname cues and priority when an open-list tab is soft-closed', () => {
        vi.useFakeTimers();
        try {
            document.body.innerHTML = '<div id="hostname-tabs-dropdown"></div>';
            const listTab = (paneId) => {
                const tabEl = document.createElement('div');
                tabEl.className = 'tab';
                return [
                    paneId,
                    {
                        paneId,
                        title: `${paneId} Tab`,
                        coder: 'pi',
                        cwd: '/t',
                        tabEl,
                        isAttention: true,
                    },
                ];
            };
            manager.tabs = new Map([listTab('keep'), listTab('closing')]);
            manager.activePaneId = 'keep';
            delete manager._refreshHostnameTabsDropdown;
            TabManager.prototype.renderHostnameTabsDropdown.call(manager);
            const dropdown = document.getElementById('hostname-tabs-dropdown');
            expect(
                dropdown.querySelectorAll('.hostname-dropdown-attention'),
            ).toHaveLength(2);
            // Render-before-close: the list is already open when the
            // strip-× soft-close lands, so the transition must refresh it.
            TabManager.prototype.softCloseTab.call(manager, 'closing');
            const rows = Array.from(
                dropdown.querySelectorAll('.hostname-dropdown-row'),
            );
            expect(rows.map((row) => row.dataset.paneId)).toEqual([
                'keep',
                'closing',
            ]);
            const closingRow = rows.find(
                (row) => row.dataset.paneId === 'closing',
            );
            expect(closingRow.classList.contains('has-attention')).toBe(false);
            expect(
                closingRow.querySelector('.hostname-dropdown-attention'),
            ).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('overflow tree attention', () => {
    function treeTab(
        paneId,
        { workspace, cwd, isAttention, softClosing = false },
    ) {
        const tabEl = document.createElement('div');
        tabEl.className = 'tab';
        tabEl.dataset.worktreeGlyph = '◆';
        return [
            paneId,
            {
                paneId,
                title: paneId,
                coder: 'pi',
                workspace,
                cwd,
                tabEl,
                isAttention,
                softClosing,
            },
        ];
    }

    function treeManager(entries) {
        document.body.innerHTML =
            '<div id="tab-overflow-dropdown" class="tab-overflow-dropdown hidden" tabindex="-1"></div>';
        return Object.assign(Object.create(TabManager.prototype), {
            tabs: new Map(entries),
            activePaneId: null,
            _softCloseRemainingSeconds: () => 5,
        });
    }

    it('marks unread rows and their workspace and worktree summaries', () => {
        const tm = treeManager([
            treeTab('read-row', {
                workspace: 'ws',
                cwd: '/w',
                isAttention: false,
            }),
            treeTab('unread-row', {
                workspace: 'ws',
                cwd: '/w',
                isAttention: true,
            }),
        ]);
        tm._buildOverflowDropdown();
        const unreadRow = document.querySelector('[data-pane-id="unread-row"]');
        expect(unreadRow.classList.contains('has-attention')).toBe(true);
        expect(
            unreadRow
                .querySelector('.hostname-dropdown-attention')
                ?.getAttribute('aria-label'),
        ).toBe('Needs attention');
        const readRow = document.querySelector('[data-pane-id="read-row"]');
        expect(readRow.classList.contains('has-attention')).toBe(false);
        expect(
            readRow.querySelector('.hostname-dropdown-attention'),
        ).toBeNull();
        const workspace = document.querySelector(
            'details.tab-overflow-workspace',
        );
        expect(workspace.classList.contains('has-attention')).toBe(true);
        expect(
            workspace
                .querySelector(':scope > summary .tab-overflow-attention')
                ?.getAttribute('aria-label'),
        ).toBe('Contains tabs needing attention');
        const worktree = document.querySelector(
            'details.tab-overflow-worktree',
        );
        expect(worktree.classList.contains('has-attention')).toBe(true);
        expect(
            worktree.querySelector(':scope > summary .tab-overflow-attention'),
        ).not.toBeNull();
    });

    it('prioritizes unread rows, worktrees, and workspaces without regrouping', () => {
        const tm = treeManager([
            treeTab('aaa-read', {
                workspace: 'aaa',
                cwd: '/r',
                isAttention: false,
            }),
            treeTab('w-read-first', {
                workspace: 'w',
                cwd: '/first',
                isAttention: false,
            }),
            treeTab('w-read-then', {
                workspace: 'w',
                cwd: '/second',
                isAttention: false,
            }),
            treeTab('w-unread', {
                workspace: 'w',
                cwd: '/second',
                isAttention: true,
            }),
            treeTab('zzz-unread', {
                workspace: 'zzz',
                cwd: '/u',
                isAttention: true,
            }),
        ]);
        tm._buildOverflowDropdown();
        const dropdown = document.getElementById('tab-overflow-dropdown');
        expect(
            Array.from(
                dropdown.querySelectorAll(
                    ':scope > details.tab-overflow-workspace',
                ),
            ).map((group) => group.dataset.workspace),
        ).toEqual(['w', 'zzz', 'aaa']);
        const wGroup = dropdown.querySelector(
            'details.tab-overflow-workspace[data-workspace="w"]',
        );
        expect(
            Array.from(
                wGroup.querySelectorAll(
                    ':scope > details.tab-overflow-worktree',
                ),
            ).map((group) => group.dataset.cwd),
        ).toEqual(['/second', '/first']);
        const second = wGroup.querySelector(
            'details.tab-overflow-worktree[data-cwd="/second"]',
        );
        expect(
            Array.from(
                second.querySelectorAll(':scope > .hostname-dropdown-row'),
            ).map((row) => row.dataset.paneId),
        ).toEqual(['w-unread', 'w-read-then']);
    });

    it('keeps the closing section first and free of attention markers', () => {
        const tm = treeManager([
            treeTab('live', { workspace: 'ws', cwd: '/w', isAttention: false }),
            treeTab('closing', {
                workspace: 'ws',
                cwd: '/w',
                isAttention: true,
                softClosing: true,
            }),
        ]);
        tm._buildOverflowDropdown();
        const dropdown = document.getElementById('tab-overflow-dropdown');
        expect(dropdown.children[0].textContent).toContain('Closing tabs');
        const closingRow = dropdown.querySelector('[data-pane-id="closing"]');
        expect(closingRow.classList.contains('tab-overflow-closing-row')).toBe(
            true,
        );
        expect(
            closingRow.querySelector('.hostname-dropdown-attention'),
        ).toBeNull();
    });

    it('updates an open tree when attention arrives without rebuilding a hidden one', () => {
        const entries = [
            treeTab('live', { workspace: 'ws', cwd: '/w', isAttention: false }),
        ];
        const tm = treeManager(entries);
        tm._buildOverflowDropdown();
        const dropdown = document.getElementById('tab-overflow-dropdown');
        tm._setTabAttention(tm.tabs.get('live'), true);
        expect(
            dropdown
                .querySelector('[data-pane-id="live"]')
                .classList.contains('has-attention'),
        ).toBe(false);
        dropdown.classList.remove('hidden');
        tm._setTabAttention(tm.tabs.get('live'), false);
        tm._setTabAttention(tm.tabs.get('live'), true);
        const row = dropdown.querySelector('[data-pane-id="live"]');
        expect(row.classList.contains('has-attention')).toBe(true);
        expect(
            row.querySelector('.hostname-dropdown-attention'),
        ).not.toBeNull();
    });
});
