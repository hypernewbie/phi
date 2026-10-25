// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { TabManager } from '../web/terminal.js';
import { setEmbeddedBackend, serverKey } from '../web/util.js';

setupDomHarness();

function setupTerminalGlobals() {
    vi.stubGlobal('FitAddon', {
        FitAddon: class {
            fit() {}
        },
    });
    vi.stubGlobal('SearchAddon', {
        SearchAddon: class {},
    });
    vi.stubGlobal('Unicode11Addon', {
        Unicode11Addon: class {},
    });
    vi.stubGlobal('WebglAddon', {
        WebglAddon: class {},
    });
    vi.stubGlobal('Audio', class {
        play() { return Promise.resolve(); }
    });
    vi.stubGlobal('Terminal', function () {
        const rootEl = document.createElement('div');
        const viewportEl = document.createElement('div');
        viewportEl.className = 'xterm-viewport';
        rootEl.appendChild(viewportEl);

        const origWrite = vi.fn((_data, cb) => cb?.());
        return {
            cols: 80,
            rows: 24,
            element: rootEl,
            unicode: { activeVersion: '6' },
            origWrite,
            buffer: {
                active: { type: 'normal', viewportY: 0, baseY: 0 },
                onBufferChange: vi.fn(),
            },
            parser: { registerOscHandler: vi.fn() },
            _core: {
                coreService: { onUserInput: vi.fn() },
                _bufferService: {
                    buffers: {
                        normal: { lines: { onTrim: vi.fn() } },
                    },
                },
            },
            loadAddon: vi.fn(),
            open: vi.fn(function (container) {
                container?.appendChild?.(rootEl);
            }),
            resize: vi.fn(function (cols, rows) {
                this.cols = cols;
                this.rows = rows;
            }),
            write: origWrite,
            dispose: vi.fn(),
            scrollToBottom: vi.fn(),
            focus: vi.fn(),
            onBell: vi.fn(),
            onScroll: vi.fn(),
            onResize: vi.fn(),
            onData: vi.fn(),
            onBinary: vi.fn(),
            onSelectionChange: vi.fn(),
            attachCustomKeyEventHandler: vi.fn(),
            getSelection: vi.fn(() => ''),
        };
    });
}

function makeTm({ withTabs = [], activePaneId = null } = {}) {
    setupTerminalGlobals();

    const tm = Object.create(TabManager.prototype);
    tm.tabs = new Map();
    tm.activePaneId = activePaneId;
    tm.tabsContainer = document.createElement('div');
    tm.tabsContainer.id = 'tabs-container';
    document.body.appendChild(tm.tabsContainer);

    tm.terminalsWrapper = document.createElement('div');
    tm.terminalsWrapper.id = 'terminals';
    document.body.appendChild(tm.terminalsWrapper);

    tm.inputBarContainer = document.createElement('div');
    tm.inputBarContainer.id = 'input-bar-container';
    document.body.appendChild(tm.inputBarContainer);

    tm.presetsContainer = document.createElement('div');
    tm.presetsContainer.id = 'presets-container';
    document.body.appendChild(tm.presetsContainer);

    tm.inputTextArea = document.createElement('textarea');

    tm.updateDirectModeUI = vi.fn();
    tm.activateTabViewport = vi.fn();
    tm.updateDocumentTitle = vi.fn();
    tm.showEmptyState = vi.fn();
    tm.hideEmptyState = vi.fn();
    tm.updateDisconnectBanner = vi.fn();
    tm.getTerminalTheme = vi.fn(() => ({}));
    tm._liveScrollbackRows = vi.fn(() => 1000);
    tm._installTerminalLinkProvider = vi.fn();
    tm._placeNewTabByWorkspace = vi.fn();
    tm.updateTabOverflow = vi.fn();
    tm.updateTabShortcutHints = vi.fn();
    tm.saveTabsState = TabManager.prototype.saveTabsState.bind(tm);
    tm.saveTabOrder = TabManager.prototype.saveTabOrder.bind(tm);
    tm.saveTabDraft = TabManager.prototype.saveTabDraft.bind(tm);
    tm.loadTabDraft = TabManager.prototype.loadTabDraft.bind(tm);
    tm.saveActiveDraft = TabManager.prototype.saveActiveDraft.bind(tm);
    tm.getActiveTab = () => tm.tabs.get(tm.activePaneId) ?? null;
    tm.switchTab = vi.fn((paneId) => {
        tm.activePaneId = paneId;
    });

    tm.app = {
        config: {},
        showToast: vi.fn(() => ({
            classList: { add: vi.fn(), remove: vi.fn() },
        })),
        kanbanManager: { cleanup: vi.fn(), openBoard: vi.fn() },
        reviewManager: { cleanup: vi.fn() },
        markdownManager: { refreshFiles: vi.fn() },
        sessionsManager: {
            activeCoder: 'shell',
            activeWorkspace: '',
            activeCWD: '',
        },
    };

    for (const tabDef of withTabs) {
        const id = typeof tabDef === 'string' ? tabDef : tabDef.paneId;
        const tabEl = document.createElement('div');
        tabEl.className = 'tab';
        tabEl.setAttribute('data-pane-id', id);
        tm.tabsContainer.appendChild(tabEl);

        const termContainer = document.createElement('div');
        termContainer.id = `term-${id}`;
        tm.terminalsWrapper.appendChild(termContainer);

        const meta = typeof tabDef === 'string' ? { paneId: id } : tabDef;
        const fullMeta = {
            paneId: meta.paneId,
            sessionId: meta.sessionId || meta.paneId,
            title: meta.title || meta.paneId,
            coder: meta.coder || 'shell',
            workspace: meta.workspace || '',
            cwd: meta.cwd || '',
            tabEl,
            termContainer,
            isDead: false,
            isReview: meta.coder === 'review',
            isKanban: meta.coder === 'kanban',
            pinned: !!meta.pinned,
            marked: !!meta.marked,
            softClosing: !!meta.softClosing,
            ws: { close: vi.fn(), sendInput: vi.fn(), sendResize: vi.fn() },
            term: {
                dispose: vi.fn(),
                scrollToBottom: vi.fn(),
                focus: vi.fn(),
                resize: vi.fn(),
                write: vi.fn(),
                buffer: { active: { viewportY: 0, baseY: 0 } },
                cols: 80,
                rows: 24,
            },
        };
        tm.tabs.set(meta.paneId, fullMeta);
    }

    return tm;
}

describe('TabManager syncTabs and client-side lifecycle', () => {
    afterEach(() => {
        setEmbeddedBackend(null, null);
    });

    describe('detachAll({ flushBackendId })', () => {
        it('flushes soft-closing tabs with X-Phi-Backend header and disposes open tabs client-side', async () => {
            const fetchFn = mockFetch();
            const tm = makeTm({
                withTabs: [
                    { paneId: 'tab-soft', softClosing: true },
                    { paneId: 'tab-normal-1' },
                    { paneId: 'tab-normal-2' },
                ],
                activePaneId: 'tab-normal-1',
            });

            // Set active draft to verify saveActiveDraft runs
            tm.inputTextArea.value = 'unsaved draft text';
            localStorage.setItem(serverKey('phi_active_pane'), 'tab-normal-1');
            localStorage.setItem(serverKey('phi_tab_order'), JSON.stringify(['tab-normal-1', 'tab-normal-2']));

            const normal1 = tm.tabs.get('tab-normal-1');
            const normal2 = tm.tabs.get('tab-normal-2');

            tm.detachAll({ flushBackendId: 'backend-profile-42' });

            // 1. Soft-closing tab: DELETE was sent with X-Phi-Backend header
            expect(fetchFn).toHaveBeenCalledWith(
                '/api/terminals/tab-soft',
                expect.objectContaining({
                    method: 'DELETE',
                    headers: { 'X-Phi-Backend': 'backend-profile-42' },
                }),
            );

            // 2. Normal open tabs: NO DELETE was sent to backend
            const deleteUrls = fetchFn.mock.calls
                .filter((call) => call[1]?.method === 'DELETE')
                .map((call) => call[0]);
            expect(deleteUrls).toEqual(['/api/terminals/tab-soft']);
            expect(deleteUrls).not.toContain('/api/terminals/tab-normal-1');
            expect(deleteUrls).not.toContain('/api/terminals/tab-normal-2');

            // 3. Client resources were disposed
            expect(normal1.ws.close).toHaveBeenCalled();
            expect(normal1.term.dispose).toHaveBeenCalled();
            expect(normal2.ws.close).toHaveBeenCalled();
            expect(normal2.term.dispose).toHaveBeenCalled();
            expect(tm.tabs.size).toBe(0);

            // 4. LocalStorage state for the outgoing server was preserved
            expect(localStorage.getItem(serverKey('phi_active_pane'))).toBe('tab-normal-1');
            expect(localStorage.getItem(serverKey('phi_tab_order'))).toBe(JSON.stringify(['tab-normal-1', 'tab-normal-2']));
            expect(localStorage.getItem(serverKey('phi_tab_draft_tab-normal-1'))).toContain('unsaved draft text');

            // 5. Host UI reset
            expect(tm.activePaneId).toBeNull();
            expect(tm.showEmptyState).toHaveBeenCalled();
        });
    });

    describe('syncTabs reconciliation', () => {
        it('creates tabs with live: false + cachedScreen without creating WebSocket', async () => {
            const tm = makeTm();
            tm._connectTabSocket = vi.fn();

            const instances = [
                { id: 't1', session_id: 's1', coder: 'shell', title: 'Terminal 1' },
            ];
            const screens = {
                t1: { ansi: 'cached output line\r\n', cols: 120, rows: 40 },
            };

            await tm.syncTabs(instances, { live: false, screens });

            expect(tm.tabs.has('t1')).toBe(true);
            const tab = tm.tabs.get('t1');
            expect(tab._detachedCache).toBe(true);
            expect(tab.ws).toBeNull();
            expect(tab.term.resize).toHaveBeenCalledWith(120, 40);
            expect(tab.term.origWrite).toHaveBeenCalledWith('cached output line\r\n');
            expect(tm._connectTabSocket).not.toHaveBeenCalled();
        });

        it('upgrades detached cached tab to live when syncTabs is called with live: true', async () => {
            const tm = makeTm();
            tm._connectTabSocket = vi.fn((tab) => {
                tab.ws = { close: vi.fn() };
            });

            // 1. Initial sync in detached mode
            await tm.syncTabs([{ id: 't1', title: 'Old Title', coder: 'shell' }], {
                live: false,
                screens: { t1: { ansi: 'cached text', cols: 80, rows: 24 } },
            });

            const tab = tm.tabs.get('t1');
            expect(tab._detachedCache).toBe(true);
            expect(tab.ws).toBeNull();

            // 2. Next sync in live mode with updated title and pinned
            await tm.syncTabs(
                [{ id: 't1', title: 'New Title', coder: 'shell', pinned: true, marked: true }],
                { live: true },
            );

            expect(tab._detachedCache).toBe(false);
            expect(tm._connectTabSocket).toHaveBeenCalledWith(tab);
            expect(tab.pinned).toBe(true);
            expect(tab.marked).toBe(true);
            expect(tab.title).toBe('New Title');
        });

        it('removes missing server tabs while preserving client-only tabs (kanban, pi-rpc)', async () => {
            const tm = makeTm({
                withTabs: [
                    { paneId: 'server-stale', coder: 'shell' },
                    { paneId: 'kanban', coder: 'kanban' },
                    { paneId: 'pi-rpc-1', coder: 'pi-rpc' },
                    { paneId: 'server-live', coder: 'claude' },
                ],
            });
            tm._connectTabSocket = vi.fn();

            // Server reports only 'server-live'
            await tm.syncTabs([{ id: 'server-live', coder: 'claude' }], { live: true });

            // 'server-stale' was disposed client-side
            expect(tm.tabs.has('server-stale')).toBe(false);

            // Client-only tabs and 'server-live' survive
            expect(tm.tabs.has('kanban')).toBe(true);
            expect(tm.tabs.has('pi-rpc-1')).toBe(true);
            expect(tm.tabs.has('server-live')).toBe(true);
        });

        it('restores saved phi_active_pane even when createTab creates multiple tabs', async () => {
            const tm = makeTm();
            tm._connectTabSocket = vi.fn();
            tm.switchTab = vi.fn((paneId) => {
                tm.activePaneId = paneId;
                tm.saveTabsState();
            });
            localStorage.setItem(serverKey('phi_active_pane'), 't1');

            await tm.syncTabs(
                [
                    { id: 't1', coder: 'shell', title: 'First' },
                    { id: 't2', coder: 'shell', title: 'Second' },
                    { id: 't3', coder: 'shell', title: 'Third' },
                ],
                { live: true },
            );

            expect(tm.activePaneId).toBe('t1');
            expect(localStorage.getItem(serverKey('phi_active_pane'))).toBe('t1');
        });
    });

    describe('serverKey localStorage scoping', () => {
        it('prefixes localStorage keys when embedded backend is active and leaves unprefixed when reset', () => {
            const tm = makeTm();

            // 1. In embedded mode
            setEmbeddedBackend('srv-alpha', 'http://127.0.0.1:9090');

            tm.activePaneId = 'pane-alpha';
            tm.saveTabsState();
            expect(localStorage.getItem(serverKey('phi_active_pane'))).toBe('pane-alpha');
            expect(serverKey('phi_active_pane')).toBe('phi_active_pane:srv-alpha');
            expect(localStorage.getItem('phi_active_pane')).toBeNull();

            tm.saveTabOrder();
            expect(localStorage.getItem(serverKey('phi_tab_order'))).toBeDefined();
            expect(serverKey('phi_tab_order')).toBe('phi_tab_order:srv-alpha');
            expect(localStorage.getItem('phi_tab_order')).toBeNull();

            tm.saveTabDraft({ paneId: 'pane-alpha', draft: 'Alpha Draft' });
            expect(localStorage.getItem(serverKey('phi_tab_draft_pane-alpha'))).toContain('Alpha Draft');
            expect(serverKey('phi_tab_draft_pane-alpha')).toBe('phi_tab_draft_pane-alpha:srv-alpha');
            expect(localStorage.getItem('phi_tab_draft_pane-alpha')).toBeNull();
            expect(tm.loadTabDraft('pane-alpha').draft).toBe('Alpha Draft');

            // 2. Switching to another server
            setEmbeddedBackend('srv-beta', 'http://127.0.0.1:9091');
            expect(tm.loadTabDraft('pane-alpha').draft).toBeUndefined();

            tm.activePaneId = 'pane-beta';
            tm.saveTabsState();
            expect(localStorage.getItem(serverKey('phi_active_pane'))).toBe('pane-beta');
            expect(serverKey('phi_active_pane')).toBe('phi_active_pane:srv-beta');
            expect(localStorage.getItem('phi_active_pane:srv-alpha')).toBe('pane-alpha');

            // 3. Reset to standalone / non-embedded
            setEmbeddedBackend(null, null);
            tm.activePaneId = 'pane-standalone';
            tm.saveTabsState();
            expect(localStorage.getItem('phi_active_pane')).toBe('pane-standalone');
            expect(serverKey('phi_active_pane')).toBe('phi_active_pane');
            expect(localStorage.getItem('phi_active_pane:srv-alpha')).toBe('pane-alpha');
            expect(localStorage.getItem('phi_active_pane:srv-beta')).toBe('pane-beta');
        });
    });
});
