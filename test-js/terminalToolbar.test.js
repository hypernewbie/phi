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
        cancelInputBtn: document.getElementById('cancel-input-btn'),
        inputBarContainer: document.getElementById('input-bar-container'),
        presetsContainer: document.getElementById('presets-container'),
        copyInputBtn: document.getElementById('copy-input-btn'),
        ctrlTBtn: document.getElementById('ctrl-t-btn'),
        directModeToggle: document.getElementById('direct-mode-toggle'),
        thinkingVisibilityBtn: document.getElementById(
            'thinking-visibility-btn',
        ),
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
    it('orders desktop actions as dropdown, sort, reload, and close-all with a shared style', () => {
        mountMarkup();
        const buttons = [
            ...document.querySelectorAll('.terminal-tabs-bar > button'),
        ];
        expect(buttons.map((button) => button.id)).toEqual([
            'tab-overflow-btn',
            'sort-tabs-btn',
            'refresh-console-btn',
            'close-all-tabs-btn',
        ]);
        for (const button of buttons) {
            expect(button.classList.contains('tab-action-btn')).toBe(true);
            expect(button.getAttribute('type')).toBe('button');
        }
    });

    it('folds on click, moves the existing interrupt button, and restores the draft on expand', () => {
        const { manager, first } = setupManager();
        Object.assign(manager, {
            renderPresets: vi.fn(),
            _placeCompactQuickChips: vi.fn(),
            fitActiveTerminal: vi.fn(),
            focusActiveTerminal: vi.fn(),
        });
        Object.assign(first, { directMode: false, isAtBottom: true });
        const cancel = manager.cancelInputBtn;
        const expandedActions = manager.sendInputBtn.parentElement;
        manager.inputTextArea.value = 'keep this draft';

        manager.directModeToggle.click();

        expect(first.directMode).toBe(true);
        expect(
            manager.inputBarContainer.classList.contains('direct-mode-active'),
        ).toBe(true);
        expect(manager.presetsContainer.classList.contains('hidden')).toBe(
            true,
        );
        expect(cancel.parentElement.className).toBe('presets-actions');
        expect(cancel.nextElementSibling).toBe(manager.directModeToggle);
        expect(manager.directModeToggle.getAttribute('aria-expanded')).toBe(
            'false',
        );
        expect(manager.focusActiveTerminal).toHaveBeenCalledOnce();

        manager.directModeToggle.click();

        expect(first.directMode).toBe(false);
        expect(
            manager.inputBarContainer.classList.contains('direct-mode-active'),
        ).toBe(false);
        expect(cancel.parentElement).toBe(expandedActions);
        expect(document.querySelectorAll('#cancel-input-btn')).toHaveLength(1);
        expect(manager.inputTextArea.value).toBe('keep this draft');
        expect(manager.directModeToggle.getAttribute('aria-expanded')).toBe(
            'true',
        );
    });

    it.each([
        ['bash', '\x03'],
        ['pi', '\x1b'],
        ['claude', '\x1b'],
        ['opencode', '\x1b'],
    ])(
        'interrupts %s while keeping the composer collapsed',
        (coder, expectedKey) => {
            const { manager, first } = setupManager();
            Object.assign(manager, {
                renderPresets: vi.fn(),
                _placeCompactQuickChips: vi.fn(),
                fitActiveTerminal: vi.fn(),
                focusActiveTerminal: vi.fn(),
                sendRawInput: vi.fn(),
            });
            Object.assign(first, {
                coder,
                directMode: false,
                isAtBottom: true,
            });
            manager.inputTextArea.value = 'unsent draft';
            manager.directModeToggle.click();

            manager.cancelInputBtn.click();

            expect(manager.sendRawInput).toHaveBeenCalledExactlyOnceWith(
                expectedKey,
            );
            expect(first.directMode).toBe(true);
            expect(manager.cancelInputBtn.parentElement.className).toBe(
                'presets-actions',
            );
            expect(manager.inputTextArea.value).toBe('unsent draft');
        },
    );

    it.each(['bash', 'pi-rpc'])(
        'restores interrupt beside Send when switching to an expanded %s pane',
        (coder) => {
            const { manager, first, second } = setupManager();
            Object.assign(manager, {
                renderPresets: vi.fn(),
                _placeCompactQuickChips: vi.fn(),
                fitActiveTerminal: vi.fn(),
                focusActiveTerminal: vi.fn(),
            });
            Object.assign(first, { directMode: false, isAtBottom: true });
            manager.directModeToggle.click();
            Object.assign(second, {
                coder,
                directMode: false,
                isAtBottom: true,
            });
            manager.activePaneId = second.paneId;

            manager.updateDirectModeUI(second, true);

            expect(first.directMode).toBe(true);
            expect(second.directMode).toBe(false);
            expect(manager.cancelInputBtn.parentElement).toBe(
                manager.sendInputBtn.parentElement,
            );
            expect(
                manager.inputBarContainer.classList.contains(
                    'direct-mode-active',
                ),
            ).toBe(false);
            expect(manager.directModeToggle.classList.contains('hidden')).toBe(
                coder === 'pi-rpc',
            );
        },
    );

    it('keeps Enter and Tab on collapsed controls out of the mobile PTY fallback', () => {
        const { manager } = setupManager();
        vi.stubGlobal(
            'matchMedia',
            vi.fn(() => ({ matches: true })),
        );
        manager.inputBarContainer.classList.remove('hidden');
        manager._forwardKeyToPty = vi.fn();
        manager.directModeToggle.before(manager.cancelInputBtn);
        const fallback = document.addEventListener.mock.calls.find(
            ([type, handler]) =>
                type === 'keydown' &&
                handler.toString().includes('_forwardKeyToPty'),
        )[1];

        for (const id of ['direct-mode-toggle', 'cancel-input-btn']) {
            for (const key of ['Enter', 'Tab']) {
                const event = new KeyboardEvent('keydown', {
                    key,
                    cancelable: true,
                });
                Object.defineProperty(event, 'target', {
                    value: document.getElementById(id),
                });
                fallback(event);
                expect(event.defaultPrevented).toBe(false);
            }
        }
        expect(manager._forwardKeyToPty).not.toHaveBeenCalled();

        const terminalKey = new KeyboardEvent('keydown', { key: 'Enter' });
        Object.defineProperty(terminalKey, 'target', { value: document.body });
        fallback(terminalKey);
        expect(manager._forwardKeyToPty).toHaveBeenCalledOnce();
    });

    it('toggles thinking only in the active Pi RPC pane', () => {
        const { manager, first, second } = setupManager();
        const container = document.createElement('div');
        const block = document.createElement('div');
        block.className = 'thinking-block collapsed';
        const toggle = document.createElement('span');
        toggle.className = 'thinking-toggle';
        toggle.textContent = '▶';
        block.append(toggle);
        container.append(block);
        first.coder = 'pi-rpc';
        first.termContainer = container;
        manager.renderPresets = vi.fn();
        manager._setPiRpcActionVisibility(first);

        manager.thinkingVisibilityBtn.click();

        expect(manager._thinkingAllVisible.get(first.paneId)).toBe(true);
        expect(block.classList.contains('collapsed')).toBe(false);
        expect(toggle.textContent).toBe('▼');
        expect(manager.renderPresets).toHaveBeenCalledWith('pi-rpc');

        manager.thinkingVisibilityBtn.click();
        expect(manager._thinkingAllVisible.get(first.paneId)).toBe(false);
        expect(block.classList.contains('collapsed')).toBe(true);
        expect(toggle.textContent).toBe('▶');

        manager.activePaneId = second.paneId;
        manager.thinkingVisibilityBtn.click();
        expect(manager._thinkingAllVisible.has(second.paneId)).toBe(false);
    });

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
