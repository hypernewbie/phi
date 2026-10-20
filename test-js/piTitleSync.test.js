// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';

setupDomHarness();
afterEach(() => vi.useRealTimers());

function makeTabManager({
    paneId = 'pi-pane',
    sessionId = 'native-session-id',
    title = 'Saved Pi title',
    coder = 'pi',
} = {}) {
    document.body.innerHTML =
        '<div id="tabs-container"></div><button id="tab-overflow-btn"></button><div id="tab-overflow-dropdown"></div>';
    const tabsContainer = document.getElementById('tabs-container');
    const tabEl = document.createElement('div');
    tabEl.className = 'tab';
    tabEl.dataset.paneId = paneId;
    const titleEl = document.createElement('span');
    titleEl.className = 'tab-title';
    titleEl.textContent = title;
    tabEl.appendChild(titleEl);
    tabsContainer.appendChild(tabEl);

    const manager = Object.create(TabManager.prototype);
    manager.tabs = new Map();
    manager.app = { sessionsManager: { loadSessions: vi.fn() } };
    manager.updateTabOverflow = vi.fn();
    manager._refreshOverflowDropdown = vi.fn();
    manager._hieroPreview = document.createElement('div');
    manager._hieroPreview.classList.add('visible');
    manager._hieroPreviewSourceEl = tabEl;
    manager._showHieroPreview = vi.fn();

    const socket = { sendInput: vi.fn() };
    const tab = {
        paneId,
        sessionId,
        coder,
        title,
        marked: false,
        isDead: false,
        tabEl,
        ws: null,
    };
    manager.tabs.set(paneId, tab);
    manager._setCurrentTabSocket(tab, socket);
    return { manager, tab, tabEl, titleEl, socket };
}

function sessionTitle(tab, title, revision, overrides = {}) {
    return {
        type: 'session-title',
        pane_id: tab.paneId,
        session_id: tab.sessionId,
        title,
        revision,
        ...overrides,
    };
}

describe('Pi terminal title controls', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.useRealTimers();
    });

    it('validates identity, title, and safe revisions; renders with textContent only', () => {
        const fetch = mockFetch(() => ({ ok: true, status: 200, json: {} }));
        const { manager, tab, titleEl, socket } = makeTabManager();
        const unsafeTitle = '<img src=x onerror=alert(1)>';
        const invalid = [
            sessionTitle(tab, 'wrong pane', 1, { pane_id: 'other-pane' }),
            sessionTitle(tab, 'wrong session', 1, { session_id: 'other-id' }),
            sessionTitle(tab, '', 1),
            sessionTitle(tab, 4, 1),
            sessionTitle(tab, 'negative revision', -1),
            sessionTitle(tab, 'fractional revision', 1.5),
            sessionTitle(tab, 'unsafe revision', Number.MAX_SAFE_INTEGER + 1),
        ];
        for (const control of invalid) {
            manager.handleControlMessage(tab, control, socket);
            expect(tab.title).toBe('Saved Pi title');
            expect(tab._piTitleRevision).toBe(-1);
        }
        tab.coder = 'pi-rpc';
        manager.handleControlMessage(
            tab,
            sessionTitle(tab, 'RPC title is deferred', 1),
            socket,
        );
        expect(tab.title).toBe('Saved Pi title');
        tab.coder = 'pi';

        manager.handleControlMessage(
            tab,
            sessionTitle(tab, unsafeTitle, 2),
            socket,
        );
        expect(tab.title).toBe(unsafeTitle);
        expect(titleEl.textContent).toBe(unsafeTitle);
        expect(titleEl.querySelector('img')).toBeNull();
        expect(manager.updateTabOverflow).toHaveBeenCalled();
        expect(manager._refreshOverflowDropdown).toHaveBeenCalled();
        expect(manager._showHieroPreview).toHaveBeenCalledWith(tab.tabEl);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('rejects missing, null, and empty native-ID bindings even when they match the tab', () => {
        for (const sessionId of [undefined, null, '']) {
            const { manager, tab, socket } = makeTabManager();
            tab.sessionId = sessionId;
            manager.handleControlMessage(
                tab,
                sessionTitle(tab, 'Unbound title', 1),
                socket,
            );
            expect(tab.title).toBe('Saved Pi title');
            expect(tab._piTitleRevision).toBe(-1);
        }
    });

    it('rejects stale sockets and replaced tabs while resetting the revision baseline on reconnect', () => {
        const { manager, tab, socket } = makeTabManager();
        manager.handleControlMessage(
            tab,
            sessionTitle(tab, 'Current', 12),
            socket,
        );
        expect(tab._piTitleRevision).toBe(12);

        const replacementSocket = { sendInput: vi.fn() };
        manager._setCurrentTabSocket(tab, replacementSocket);
        expect(tab._piTitleRevision).toBe(-1);
        manager.handleControlMessage(
            tab,
            sessionTitle(tab, 'Old socket snapshot', 30),
            socket,
        );
        expect(tab.title).toBe('Current');
        manager.handleControlMessage(
            tab,
            sessionTitle(tab, 'New socket baseline', 2),
            replacementSocket,
        );
        expect(tab.title).toBe('New socket baseline');
        expect(tab._piTitleRevision).toBe(2);
        manager.handleControlMessage(
            tab,
            sessionTitle(tab, 'Out-of-order attach snapshot', 1),
            replacementSocket,
        );
        expect(tab.title).toBe('New socket baseline');

        const replacementEl = document.createElement('div');
        replacementEl.className = 'tab';
        replacementEl.dataset.paneId = tab.paneId;
        const replacementLabel = document.createElement('span');
        replacementLabel.className = 'tab-title';
        replacementLabel.textContent = 'Replacement object';
        replacementEl.appendChild(replacementLabel);
        const replacementTab = {
            ...tab,
            title: 'Replacement object',
            tabEl: replacementEl,
            ws: replacementSocket,
            _piTitleRevision: -1,
        };
        manager.tabs.set(tab.paneId, replacementTab);
        manager.handleControlMessage(
            tab,
            sessionTitle(tab, 'Replaced tab object', 40),
            replacementSocket,
        );
        expect(tab.title).toBe('New socket baseline');
        expect(replacementTab.title).toBe('Replacement object');
        expect(replacementLabel.textContent).toBe('Replacement object');
    });

    it('keeps rename drafts, restores the latest native label, and gives Pi one backend request', async () => {
        vi.useFakeTimers();
        const fetch = mockFetch(() => ({ ok: true, status: 200, json: {} }));
        const { manager, tab, tabEl, titleEl, socket } = makeTabManager();
        manager.openTabRenamer(tab.paneId, titleEl);
        const input = tabEl.querySelector('input.rename-input');
        expect(input).not.toBeNull();
        input.value = 'Draft rename';

        manager.handleControlMessage(
            tab,
            sessionTitle(tab, 'Native update during edit', 3),
            socket,
        );
        expect(tab.title).toBe('Native update during edit');
        expect(tabEl.querySelector('input.rename-input')).toBe(input);
        expect(input.value).toBe('Draft rename');

        input.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
                cancelable: true,
            }),
        );
        await Promise.resolve();
        await Promise.resolve();
        input.dispatchEvent(new Event('blur'));
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls[0][0]).toBe('/api/terminals/pi-pane/title');
        expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
            title: 'Draft rename',
        });
        expect(socket.sendInput).not.toHaveBeenCalled();
        expect(tab.title).toBe('Native update during edit');
        expect(tabEl.querySelector('.tab-title').textContent).toBe(
            'Native update during edit',
        );

        manager.handleControlMessage(
            tab,
            sessionTitle(tab, 'Draft rename', 4),
            socket,
        );
        expect(tabEl.querySelector('.tab-title').textContent).toBe(
            'Draft rename',
        );

        manager.openTabRenamer(tab.paneId, tabEl.querySelector('.tab-title'));
        const cancelInput = tabEl.querySelector('input.rename-input');
        cancelInput.value = 'Unsent draft';
        manager.handleControlMessage(
            tab,
            sessionTitle(tab, 'Latest before cancel', 5),
            socket,
        );
        expect(cancelInput.value).toBe('Unsent draft');
        cancelInput.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Escape',
                bubbles: true,
                cancelable: true,
            }),
        );
        expect(tabEl.querySelector('.tab-title').textContent).toBe(
            'Latest before cancel',
        );
        expect(fetch).toHaveBeenCalledTimes(1);

        manager.openTabRenamer(tab.paneId, tabEl.querySelector('.tab-title'));
        const blurInput = tabEl.querySelector('input.rename-input');
        blurInput.value = 'Blur request';
        blurInput.dispatchEvent(new Event('blur'));
        await Promise.resolve();
        await Promise.resolve();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(tab.title).toBe('Latest before cancel');
        expect(tabEl.querySelector('.tab-title').textContent).toBe(
            'Latest before cancel',
        );
    });

    it('does not resend an untouched opening draft after a native update on Enter or blur', () => {
        const fetch = mockFetch(() => ({ ok: true, status: 200, json: {} }));
        const { manager, tab, tabEl, titleEl, socket } = makeTabManager();
        manager.openTabRenamer(tab.paneId, titleEl);
        let input = tabEl.querySelector('input.rename-input');
        expect(input.value).toBe('Saved Pi title');
        manager.handleControlMessage(
            tab,
            sessionTitle(tab, 'Native before Enter', 1),
            socket,
        );
        input.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
                cancelable: true,
            }),
        );
        expect(fetch).not.toHaveBeenCalled();
        expect(tab.title).toBe('Native before Enter');
        expect(tabEl.querySelector('.tab-title').textContent).toBe(
            'Native before Enter',
        );

        manager.openTabRenamer(tab.paneId, tabEl.querySelector('.tab-title'));
        input = tabEl.querySelector('input.rename-input');
        expect(input.value).toBe('Native before Enter');
        manager.handleControlMessage(
            tab,
            sessionTitle(tab, 'Native before blur', 2),
            socket,
        );
        input.dispatchEvent(new Event('blur'));
        expect(fetch).not.toHaveBeenCalled();
        expect(tab.title).toBe('Native before blur');
        expect(tabEl.querySelector('.tab-title').textContent).toBe(
            'Native before blur',
        );

        manager.openTabRenamer(tab.paneId, tabEl.querySelector('.tab-title'));
        const acknowledgedInput = tabEl.querySelector('input.rename-input');
        acknowledgedInput.value = 'Already acknowledged';
        manager.handleControlMessage(
            tab,
            sessionTitle(tab, 'Already acknowledged', 3),
            socket,
        );
        acknowledgedInput.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
                cancelable: true,
            }),
        );
        expect(fetch).not.toHaveBeenCalled();
        expect(tabEl.querySelector('.tab-title').textContent).toBe(
            'Already acknowledged',
        );
    });

    it('keeps optimistic rename for other coders and reports HTTP title failures', async () => {
        const fetch = mockFetch(() => ({ ok: true, status: 200, json: {} }));
        const { manager, tab, tabEl, titleEl } = makeTabManager({
            coder: 'bash',
        });
        manager.openTabRenamer(tab.paneId, titleEl);
        const input = tabEl.querySelector('input.rename-input');
        input.value = 'Shell alias';
        input.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
                cancelable: true,
            }),
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(tab.title).toBe('Shell alias');
        expect(tabEl.querySelector('.tab-title').textContent).toBe(
            'Shell alias',
        );

        const error = new Error('HTTP 503 renaming terminal');
        const failedFetch = mockFetch(() => ({
            ok: false,
            status: 503,
            text: 'offline',
        }));
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(
            manager.syncBackendTitle(tab.paneId, 'Rejected alias'),
        ).rejects.toThrow(error.message);
        expect(failedFetch).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith(
            '[term] Failed to sync title on backend:',
            expect.any(Error),
        );
    });
});
