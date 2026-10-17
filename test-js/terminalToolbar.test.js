// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';
setupDomHarness();

const html = readFileSync('web/index.html', 'utf8');
const surfaces = [
    ['desktop', 'refresh-console-btn', 'close-all-tabs-btn'],
    ['mobile', 'mobile-refresh-console-btn', 'mobile-close-all-tabs-btn'],
];

function mountMarkup() {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    document.body.innerHTML = parsed.body.innerHTML;
}

function makeTab(paneId) {
    return {
        paneId,
        coder: 'bash',
        term: {},
        ws: { close: vi.fn() },
        _historyRequestId: `${paneId}-history`,
        _historyBrowsing: true,
        _forceStateRefresh: `${paneId}-force`,
        userFollowBottom: paneId === 'pane-two',
    };
}

function setupManager() {
    mountMarkup();
    const first = makeTab('pane-one');
    const second = makeTab('pane-two');
    const tabs = new Map([
        [first.paneId, first],
        [second.paneId, second],
    ]);
    const loadSessions = vi.fn();
    const manager = Object.assign(Object.create(TabManager.prototype), {
        tabs,
        activePaneId: first.paneId,
        app: { sessionsManager: { loadSessions } },
        inputTextArea: document.getElementById('input-textarea'),
        sendInputBtn: document.getElementById('send-input-btn'),
        directModeToggle: document.getElementById('direct-mode-toggle'),
        reconnectTab: vi.fn(),
        _cancelHistoryRequest: vi.fn(),
        closeTab: vi.fn(),
        _initHieroPreview: vi.fn(),
        _setupContainerDragHandlers: vi.fn(),
        _initAttachmentDropZone: vi.fn(),
        _initAttachmentPasteHandler: vi.fn(),
        _initPromptHistoryKeydown: vi.fn(),
        _initBrandHud: vi.fn(),
    });

    vi.spyOn(document, 'addEventListener').mockImplementation(() => {});
    vi.spyOn(window, 'addEventListener').mockImplementation(() => {});
    manager.setupEventListeners();
    return { manager, first, second, tabs, loadSessions };
}

describe('terminal toolbar markup and bindings', () => {
    it('removes the toolbar reconnect buttons and labels the retained controls', () => {
        mountMarkup();
        expect(document.getElementById('reconnect-all-tabs-btn')).toBeNull();
        expect(
            document.getElementById('mobile-reconnect-all-tabs-btn'),
        ).toBeNull();

        for (const [id, label] of [
            ['refresh-console-btn', 'Reload current terminal'],
            ['mobile-refresh-console-btn', 'Reload current terminal'],
            ['close-all-tabs-btn', 'Close all sessions'],
            ['mobile-close-all-tabs-btn', 'Close all sessions'],
        ]) {
            const button = document.getElementById(id);
            expect(button.title).toBe(label);
            expect(button.getAttribute('aria-label')).toBe(label);
        }
    });

    it('uses identical outlined bomb geometry for both close-all controls', () => {
        mountMarkup();
        const svgs = [
            document.querySelector('#close-all-tabs-btn svg'),
            document.querySelector('#mobile-close-all-tabs-btn svg'),
        ];
        for (const svg of svgs) {
            expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
            expect(svg.getAttribute('fill')).toBe('none');
            expect(svg.getAttribute('stroke')).toBe('currentColor');
            expect(svg.querySelector('rect')).toBeNull();
            expect(svg.querySelector('line')).toBeNull();
            expect(svg.querySelector('circle').getAttribute('cx')).toBe('10');
            expect(svg.querySelector('circle').getAttribute('cy')).toBe('14');
            expect(svg.querySelector('circle').getAttribute('r')).toBe('7');
            expect(
                [...svg.querySelectorAll('path')].map((path) =>
                    path.getAttribute('d'),
                ),
            ).toEqual(['m15 9 3-3', 'M18 6c-1-3 2-5 4-3', 'M20 1v2m1 4h2']);
        }
    });

    it.each(surfaces)(
        '%s reload click uses the active selection at click time only',
        (_surface, reloadId) => {
            const { manager, first, second } = setupManager();
            const secondState = { ...second };

            document.getElementById(reloadId).click();
            expect(manager._cancelHistoryRequest.mock.calls).toEqual([[first]]);
            expect(manager.reconnectTab.mock.calls).toEqual([[first]]);
            expect(first._forceStateRefresh).toBe(true);
            expect(first.userFollowBottom).toBe(true);
            expect(second).toMatchObject(secondState);
            expect(second.ws).toBe(secondState.ws);

            manager.activePaneId = second.paneId;
            document.getElementById(reloadId).click();
            expect(manager._cancelHistoryRequest.mock.calls).toEqual([
                [first],
                [second],
            ]);
            expect(manager.reconnectTab.mock.calls).toEqual([
                [first],
                [second],
            ]);
        },
    );

    it.each(surfaces)(
        '%s close-all cancellation preserves both tabs',
        (_surface, _reloadId, closeId) => {
            const { manager, tabs, loadSessions } = setupManager();
            const confirm = vi.fn(() => false);
            vi.stubGlobal('confirm', confirm);

            document.getElementById(closeId).click();

            expect(confirm).toHaveBeenCalledWith(
                'Are you sure you want to close all 2 active sessions?',
            );
            expect(manager.closeTab).not.toHaveBeenCalled();
            expect(tabs.size).toBe(2);
            expect(loadSessions).not.toHaveBeenCalled();
        },
    );

    it.each(surfaces)(
        '%s close-all acceptance closes the original pane IDs before refreshing sessions',
        (_surface, _reloadId, closeId) => {
            const { manager, tabs, loadSessions } = setupManager();
            vi.stubGlobal(
                'confirm',
                vi.fn(() => true),
            );
            const originalPaneIds = [...tabs.keys()];

            document.getElementById(closeId).click();

            expect(manager.closeTab.mock.calls).toEqual(
                originalPaneIds.map((paneId) => [paneId]),
            );
            expect(loadSessions).toHaveBeenCalledOnce();
            expect(manager.closeTab.mock.invocationCallOrder[1]).toBeLessThan(
                loadSessions.mock.invocationCallOrder[0],
            );
        },
    );

    it.each(surfaces)(
        '%s close-all does nothing when there are no sessions',
        (_surface, _reloadId, closeId) => {
            const { manager, tabs, loadSessions } = setupManager();
            tabs.clear();
            const confirm = vi.fn();
            vi.stubGlobal('confirm', confirm);

            document.getElementById(closeId).click();

            expect(confirm).not.toHaveBeenCalled();
            expect(manager.closeTab).not.toHaveBeenCalled();
            expect(loadSessions).not.toHaveBeenCalled();
        },
    );
});
