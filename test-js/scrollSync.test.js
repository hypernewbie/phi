// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness, stubWebSocket } from './_dom.js';
import { TabManager } from '../web/terminal.js';
import { TerminalClientFrame } from '../web/proto/terminal.js';

// Scroll-area desync fixes (2026-07-24):
// (1) writeToTerminal must force xterm's DOM scroll area back in sync after
//     each completed write batch (the vendored xterm leaves it stale during
//     streaming,
//     which made wheel-up jump to a stale coordinate and wheel-down clamp
//     before the real bottom).
// (2) User wheel/scrollbar scrolls never fire xterm's public onScroll
//     (suppressScrollEvent=true in Viewport._handleScroll), so a DOM scroll
//     listener must drive the scroll-to-bottom button and follow
//     re-engagement.
// (3) Wheel-down against a stale, clamped DOM viewport must still reach the
//     true bottom via term.scrollLines.

// setupDomHarness()'s afterEach also clears localStorage (createTab's
// saveTabsState() writes phi_active_pane/phi_tab_order on every mount) and
// calls vi.restoreAllMocks() — inert here since nothing in this file uses
// vi.spyOn; restoreAllMocks only undoes spies, not plain vi.fn() mocks
// (verified against @vitest/spy: mockRestore == mockReset + an optional
// spyOn-only restore callback), and every mock here is fresh per test.
setupDomHarness();

function makeTab({ viewportY = 100, baseY = 100, follow = true } = {}) {
    const syncSpy = vi.fn();
    return {
        isDead: false,
        isBusy: true, // skip the busy-transition branch (pin/title side effects)
        pinned: true,
        writeBuffer: '',
        writePending: false,
        userFollowBottom: follow,
        term: {
            // baseY advances on write, like a real terminal growing its
            // buffer. This makes the pre-write at-bottom capture observable:
            // capturing it late (after write) would see the new, taller baseY
            // and wrongly conclude the user isn't at bottom.
            write: vi.fn(function (_data, cb) {
                this.buffer.active.baseY += 1;
                if (cb) cb();
            }),
            scrollToBottom: vi.fn(),
            scrollLines: vi.fn(),
            buffer: { active: { viewportY, baseY } },
            _core: { viewport: { syncScrollArea: syncSpy } },
        },
        _syncSpy: syncSpy,
    };
}

describe('write batches sync the DOM scroll area', () => {
    it('calls _core.viewport.syncScrollArea(true) via the write callback', async () => {
        const tm = Object.create(TabManager.prototype);
        const tab = makeTab();
        tm.writeToTerminal(tab, 'hello');
        expect(tab.term.write).toHaveBeenCalledTimes(1);
        await Promise.resolve();
        expect(tab._syncSpy).toHaveBeenCalledWith(true);
    });

    it('still snaps to bottom when following at bottom (existing behavior preserved)', async () => {
        const tm = Object.create(TabManager.prototype);
        const tab = makeTab({ viewportY: 100, baseY: 100, follow: true });
        tm.writeToTerminal(tab, 'hello');
        await Promise.resolve();
        expect(tab.term.scrollToBottom).toHaveBeenCalled();
    });

    it('does not write or sync on a finalized tab', () => {
        const tm = Object.create(TabManager.prototype);
        const tab = makeTab();
        tab.finalizing = true;
        tm.writeToTerminal(tab, 'hello');
        expect(tab.term.write).not.toHaveBeenCalled();
        expect(tab._syncSpy).not.toHaveBeenCalled();
    });

    it('tolerates a term without _core.viewport (optional chain)', async () => {
        const tm = Object.create(TabManager.prototype);
        const tab = makeTab();
        delete tab.term._core;
        tm.writeToTerminal(tab, 'hello');
        await Promise.resolve();
    });
});

// The viewport-scroll listener and the wheel-down escape hatch (both added
// in createTab) are anonymous closures registered as a side effect of
// createTab, not named TabManager methods — there's no prototype method to
// call directly the way scrollFollow.test.js calls
// _cancelScrollFollowForUserScroll. Reaching them means actually running
// createTab() and dispatching the real DOM events it listens for.
//
// createTab() goes on to call this.switchTab(paneId), which pulls in
// sessionsManager / diffController / markdownManager — a large, separately
// tested surface (scrollBugs.test.js) that has nothing to do with
// scrolling. switchTab() is the LAST thing createTab does before
// saveTabsState(), i.e. strictly after both listeners under test are
// already wired to the real termContainer — so stubbing it as a no-op
// isolates the two closures under test without faking their behavior.
function stubXtermGlobals() {
    vi.stubGlobal('FitAddon', {
        FitAddon: class {
            fit() {}
        },
    });
    vi.stubGlobal('SearchAddon', { SearchAddon: class {} });
    // A plain function (not an arrow) so `new window.Terminal(...)` in
    // createTab constructs it; the returned object literal wins over the
    // default `this` under constructor semantics.
    // biome-ignore lint/complexity/useArrowFunction: arrows cannot be constructed; createTab calls new window.Terminal(...)
    vi.stubGlobal('Terminal', function (options) {
        globalThis.__lastTerminalOptions = options;
        // Mirrors real xterm.js DOM shape: term.element with a
        // .xterm-viewport child, which is what both listeners query.
        const viewportEl = document.createElement('div');
        viewportEl.className = 'xterm-viewport';
        const helperEl = document.createElement('textarea');
        helperEl.className = 'xterm-helper-textarea';
        const rootEl = document.createElement('div');
        rootEl.appendChild(viewportEl);
        rootEl.appendChild(helperEl);
        const dataListeners = [];
        const binaryListeners = [];
        const scrollListeners = [];
        const bufferChangeListeners = [];
        const oscHandlers = new Map();
        // xterm flags user-originated data through coreService.onUserInput
        // before onData; the fake keeps that hook so tests can emit as a user.
        let userInputHook = null;
        let customKeyHandler = null;
        const write = vi.fn((_data, cb) => cb?.());
        return {
            rows: 24,
            emitUserData: (data) => {
                userInputHook?.();
                dataListeners.forEach((fn) => {
                    fn(data);
                });
            },
            emitScroll: () =>
                scrollListeners.forEach((fn) => {
                    fn();
                }),
            emitData: (data) =>
                dataListeners.forEach((fn) => {
                    fn(data);
                }),
            emitBinary: (data) =>
                binaryListeners.forEach((fn) => {
                    fn(data);
                }),
            emitOsc: (ident, data) => oscHandlers.get(ident)?.(data),
            parser: {
                registerOscHandler: (ident, fn) => {
                    oscHandlers.set(ident, fn);
                    return { dispose() {} };
                },
            },
            element: rootEl,
            buffer: {
                active: { type: 'normal', viewportY: 100, baseY: 100 },
                onBufferChange: (fn) => {
                    bufferChangeListeners.push(fn);
                },
            },
            emitBufferChange: (type) => {
                bufferChangeListeners.forEach((fn) => {
                    fn({ type });
                });
            },
            // Real xterm.js renders term.element into the container passed
            // to open() — without this, .xterm-viewport is never actually a
            // descendant of termContainer, and the capture-phase listener
            // createTab installs on termContainer would silently never fire.
            open: (container) => {
                if (container) container.appendChild(rootEl);
            },
            loadAddon: () => {},
            attachCustomKeyEventHandler: (fn) => {
                customKeyHandler = fn;
            },
            emitCustomKey: (e) => customKeyHandler?.(e),
            paste: vi.fn((text) => {
                userInputHook?.();
                dataListeners.forEach((fn) => {
                    fn(text);
                });
            }),
            onSelectionChange: () => {},
            onBell: () => {},
            onScroll: (fn) => scrollListeners.push(fn),
            onData: (fn) => dataListeners.push(fn),
            onBinary: (fn) => binaryListeners.push(fn),
            getSelection: () => '',
            write,
            nativeWrite: write,
            scrollToBottom: vi.fn(),
            scrollLines: vi.fn(),
            _core: {
                viewport: { syncScrollArea: vi.fn() },
                coreService: {
                    onUserInput: (fn) => {
                        userInputHook = fn;
                    },
                },
            },
        };
    });
}

// Runs the real createTab() and returns the resulting tabInfo. Its
// termContainer and the fake term's .xterm-viewport child are wired up
// exactly as production does, so dispatching real 'scroll'/'wheel' DOM
// events exercises the actual listeners createTab installs. Every call
// gets its own TabManager with a fresh `tabs` Map, so a fixed paneId
// never collides across tests — no caller needs to pick one.
function mountRealTab({ coder = 'bash', opencodeMode = null } = {}) {
    vi.stubGlobal('requestAnimationFrame', (fn) => {
        fn();
        return 1;
    });
    stubWebSocket();
    stubXtermGlobals();
    const tm = Object.create(TabManager.prototype);
    tm.tabs = new Map();
    tm.activePaneId = null;
    tm.tabsContainer = document.createElement('div');
    tm.terminalsWrapper = document.createElement('div');
    document.body.appendChild(tm.tabsContainer);
    document.body.appendChild(tm.terminalsWrapper);
    tm.app = {};
    tm.switchTab = vi.fn();
    // pinned:false skips the fire-and-forget backend pin fetch(), which
    // has nothing to do with the listeners under test and would otherwise
    // reject noisily against jsdom's relative-URL fetch.
    tm.createTab(
        'p1',
        'sess-p1',
        'Title',
        coder,
        '',
        '',
        false,
        false,
        '',
        null,
        opencodeMode,
    );
    const tab = tm.tabs.get('p1');
    // The stub WebSocket never fires onopen, so the deferred open never
    // runs on its own. Production opens on ATTACH_HEAD / first legacy
    // frame / the 300ms fallback; tests force the same post-open path.
    tm._openTermAndViewport(tab);
    tab.__tm = tm;
    return tab;
}

describe('Pi full-screen input is independent of staged prompt mode', () => {
    it('forwards classic mouse reports as raw bytes, including coordinates above ASCII', () => {
        const tab = mountRealTab({ coder: 'pi' });
        window.WebSocket.OPEN = 1;
        tab.ws.ws.readyState = 1;
        const wireSend = vi.spyOn(tab.ws.ws, 'send');
        const mouse = `\x1b[M${String.fromCharCode(96, 180, 210)}`;
        tab.term.emitBinary(mouse);
        expect(wireSend).toHaveBeenCalledOnce();
        const frame = TerminalClientFrame.decode(
            new Uint8Array(wireSend.mock.calls[0][0]),
        );
        expect(frame.payload.$case).toBe('input');
        expect(Array.from(frame.payload.value)).toEqual([
            27, 91, 77, 96, 180, 210,
        ]);
        expect(tab.directMode).toBe(false);
    });

    it.each([
        ['wheel up', '\x1b[<64;20;5M'],
        ['wheel down', '\x1b[<65;20;5M'],
        ['scrollbar drag', '\x1b[<32;79;10M'],
    ])(
        'forwards %s reports without enabling direct typing',
        (_gesture, report) => {
            const tab = mountRealTab({ coder: 'pi' });
            const send = vi.spyOn(tab.ws, 'sendInput').mockReturnValue(true);
            expect(tab.directMode).toBe(false);
            tab.draft = 'do not send my unsent prompt';
            tab.term.emitData(report);
            expect(send).toHaveBeenCalledWith(report);
            expect(tab.directMode).toBe(false);
            expect(tab.draft).toBe('do not send my unsent prompt');
        },
    );
});

function pasteEvent(text) {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
        value: {
            types: ['text/plain'],
            getData: (type) => (type === 'text/plain' ? text : ''),
        },
    });
    return event;
}
function mountPasteTab(coder = 'pi') {
    const tab = mountRealTab({ coder });
    const tm = tab.__tm;
    tm.activePaneId = 'p1';
    tm.inputTextArea = document.createElement('textarea');
    tm.inputTextArea.value = 'seeded draft';
    tm.stagedAttachments = [];
    document.body.appendChild(tm.inputTextArea);
    tm.app = { showToast: vi.fn() };
    tm._showReconnectOverlay = vi.fn();
    tm.updateDirectModeUI = vi.fn();
    window.WebSocket.OPEN = 1;
    tab.ws.ws.readyState = 1;
    return tab;
}

describe('staged terminal paste reaches the PTY once', () => {
    it('routes a DOM paste through the common writer in staged mode', () => {
        const tab = mountPasteTab();
        expect(tab.directMode).toBe(false);
        const send = vi.spyOn(tab.ws, 'sendInput').mockReturnValue(true);
        const helper = tab.termContainer.querySelector(
            '.xterm-helper-textarea',
        );
        const event = pasteEvent('PI_PASTE_123');
        helper.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(tab.term.paste).toHaveBeenCalledWith('PI_PASTE_123');
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith('PI_PASTE_123');
        expect(tab.__tm.inputTextArea.value).toBe('seeded draft');
        expect(tab._terminalPaste).toBeNull();
        // Ordinary staged typing still stays in the composer.
        const keyResult = tab.term.emitCustomKey({
            type: 'keydown',
            key: 'x',
            ctrlKey: false,
            altKey: false,
            metaKey: false,
            preventDefault: () => {},
        });
        expect(keyResult).toBe(false);
        expect(tab.__tm.inputTextArea.value).toBe('seeded draftx');
        expect(send).toHaveBeenCalledTimes(1);
    });
    it('keeps direct-mode paste on the same path without touching the draft', () => {
        const tab = mountPasteTab('bash');
        expect(tab.directMode).toBe(true);
        const send = vi.spyOn(tab.ws, 'sendInput').mockReturnValue(true);
        const helper = tab.termContainer.querySelector(
            '.xterm-helper-textarea',
        );
        helper.dispatchEvent(pasteEvent('direct-paste-1'));
        expect(send).toHaveBeenCalledTimes(1);
        expect(tab.__tm.inputTextArea.value).toBe('seeded draft');
    });
    it('consumes an empty plain-text paste without a PTY write', () => {
        const tab = mountPasteTab();
        const send = vi.spyOn(tab.ws, 'sendInput').mockReturnValue(true);
        const helper = tab.termContainer.querySelector(
            '.xterm-helper-textarea',
        );
        const event = pasteEvent('');
        helper.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(tab.term.paste).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
    });
});

describe('terminal paste throw paths keep one recovery copy', () => {
    function helperOf(tab) {
        return tab.termContainer.querySelector('.xterm-helper-textarea');
    }
    it('preserves once as unconfirmed when the writer throws mid-send', () => {
        const tab = mountPasteTab();
        const send = vi.spyOn(tab.ws, 'sendInput').mockImplementation(() => {
            throw new Error('socket gone');
        });
        expect(() =>
            tab.__tm._routeTerminalPaste(tab, tab.term, 'THROW_MID_SEND'),
        ).toThrow('socket gone');
        expect(send).toHaveBeenCalledTimes(1);
        expect(tab._terminalPaste).toBeNull();
        expect(tab.pasteRecovery).toBe('unconfirmed');
        expect(tab.__tm.inputTextArea.value).toBe('seeded draftTHROW_MID_SEND');
        expect(tab._inputRestriction).toBe(
            'Paste preserved; delivery unconfirmed. Check the terminal before sending.',
        );
    });
    it('does not create a false refusal when the throw lands after acceptance', () => {
        const tab = mountPasteTab();
        const send = vi.spyOn(tab.ws, 'sendInput').mockReturnValue(true);
        tab.term.paste.mockImplementationOnce((text) => {
            tab.term.emitData(text);
            throw new Error('late ui fault');
        });
        expect(() =>
            tab.__tm._routeTerminalPaste(tab, tab.term, 'ACCEPTED_ONCE'),
        ).toThrow('late ui fault');
        expect(send).toHaveBeenCalledTimes(1);
        expect(tab._terminalPaste).toBeNull();
        expect(tab.pasteRecovery).toBeUndefined();
        expect(tab.__tm.inputTextArea.value).toBe('seeded draft');
    });
    it('never downgrades unconfirmed recovery to not-sent', () => {
        const tab = mountPasteTab();
        vi.spyOn(tab.ws, 'sendInput').mockReturnValue(false);
        helperOf(tab).dispatchEvent(pasteEvent('FIRST_FAIL'));
        expect(tab.pasteRecovery).toBe('unconfirmed');
        tab._resyncNeeded = true;
        helperOf(tab).dispatchEvent(pasteEvent('SECOND_HELD'));
        expect(tab.pasteRecovery).toBe('unconfirmed');
        expect(tab.__tm.inputTextArea.value).toBe(
            'seeded draftFIRST_FAILSECOND_HELD',
        );
        expect(tab._inputRestriction).toBe(
            'Paste held until live output is resynced.',
        );
    });
});

describe('terminal paste refusal sends zero bytes and holds one copy', () => {
    function helperOf(tab) {
        return tab.termContainer.querySelector('.xterm-helper-textarea');
    }
    it('holds a frozen single-line paste in the draft', () => {
        const tab = mountPasteTab();
        tab._resyncNeeded = true;
        const tm = tab.__tm;
        const resync = vi.spyOn(tm, '_resyncRetainedView');
        const send = vi.spyOn(tab.ws, 'sendInput');
        helperOf(tab).dispatchEvent(pasteEvent('FROZEN_LINE'));
        expect(send).not.toHaveBeenCalled();
        expect(tab.term.paste).not.toHaveBeenCalled();
        expect(resync).not.toHaveBeenCalled();
        expect(tm.inputTextArea.value).toBe('seeded draftFROZEN_LINE');
        expect(tab.draft).toBe('seeded draftFROZEN_LINE');
        expect(tab.pasteRecovery).toBe('not_sent');
        expect(tab._inputRestriction).toBe(
            'Paste held until live output is resynced.',
        );
        expect(tab._terminalPaste).toBeFalsy();
    });
    it('normalizes CRLF/CR to newlines in the held copy', () => {
        const tab = mountPasteTab();
        tab._resyncNeeded = true;
        const send = vi.spyOn(tab.ws, 'sendInput');
        helperOf(tab).dispatchEvent(pasteEvent('aa\r\nbb\rcc'));
        expect(send).not.toHaveBeenCalled();
        expect(tab.__tm.inputTextArea.value).toBe('seeded draftaa\nbb\ncc');
        expect(tab.pasteRecovery).toBe('not_sent');
    });
    it('holds a frozen newline-only paste without requesting resync', () => {
        const tab = mountPasteTab();
        tab._resyncNeeded = true;
        const resync = vi.spyOn(tab.__tm, '_resyncRetainedView');
        const send = vi.spyOn(tab.ws, 'sendInput');
        helperOf(tab).dispatchEvent(pasteEvent('\n'));
        expect(send).not.toHaveBeenCalled();
        expect(tab.term.paste).not.toHaveBeenCalled();
        expect(resync).not.toHaveBeenCalled();
        expect(tab.__tm.inputTextArea.value).toBe('seeded draft\n');
        expect(tab.pasteRecovery).toBe('not_sent');
    });
    it('holds the paste for a dead tab and flips it to staged mode', () => {
        const tab = mountPasteTab('bash');
        expect(tab.directMode).toBe(true);
        tab.isDead = true;
        const send = vi.spyOn(tab.ws, 'sendInput');
        helperOf(tab).dispatchEvent(pasteEvent('DEAD_HELD'));
        expect(send).not.toHaveBeenCalled();
        expect(tab.term.paste).not.toHaveBeenCalled();
        expect(tab.__tm.inputTextArea.value).toBe('seeded draftDEAD_HELD');
        expect(tab.pasteRecovery).toBe('not_sent');
        expect(tab.directMode).toBe(false);
        expect(tab._inputRestriction).toBe('Paste saved locally, not sent.');
    });
    it.each([[0], [2], [3]])(
        'holds the paste when the socket is not open (readyState %s)',
        (readyState) => {
            const tab = mountPasteTab();
            tab.ws.ws.readyState = readyState;
            const send = vi.spyOn(tab.ws, 'sendInput');
            helperOf(tab).dispatchEvent(pasteEvent('SOCKET_HELD'));
            expect(send).not.toHaveBeenCalled();
            expect(tab.term.paste).not.toHaveBeenCalled();
            expect(tab.__tm.inputTextArea.value).toBe(
                'seeded draftSOCKET_HELD',
            );
            expect(tab.pasteRecovery).toBe('not_sent');
            expect(tab._inputRestriction).toBe(
                'Paste saved locally, not sent.',
            );
        },
    );
    it('keeps the existing draft text and attachment chips with the held copy', () => {
        const tab = mountPasteTab();
        const att = {
            id: 'att-1',
            name: 's.png',
            path: '/u/s.png',
            type: 'image/png',
            sizeBytes: 8,
            source: 'paste',
        };
        tab.__tm.stagedAttachments = [att];
        tab._resyncNeeded = true;
        helperOf(tab).dispatchEvent(pasteEvent('HELD'));
        expect(tab.draft).toBe('seeded draftHELD');
        expect(tab.draftAttachments).toEqual([att]);
        expect(JSON.parse(localStorage.getItem('phi_tab_draft_p1'))).toEqual({
            text: 'seeded draftHELD',
            attachments: [att],
            pasteRecovery: 'not_sent',
        });
    });
});

describe('terminal paste recovery stays pane-owned', () => {
    function helperOf(tab) {
        return tab.termContainer.querySelector('.xterm-helper-textarea');
    }
    function addSibling(tm) {
        tm.createTab(
            'p2',
            'sess-p2',
            'Title',
            'pi',
            '',
            '',
            false,
            false,
            '',
            null,
            null,
        );
        return tm.tabs.get('p2');
    }
    it('does not alter a sibling pane', () => {
        const tab = mountPasteTab();
        const sib = addSibling(tab.__tm);
        sib.draft = 'sibling draft';
        tab._resyncNeeded = true;
        helperOf(tab).dispatchEvent(pasteEvent('ONLY_P1'));
        expect(tab.draft).toBe('seeded draftONLY_P1');
        expect(sib.draft).toBe('sibling draft');
        expect(sib.pasteRecovery).toBeUndefined();
        expect(sib._inputRestriction).toBeUndefined();
    });
    it('holds for an inactive owner without touching the shared textarea', () => {
        const tab = mountPasteTab();
        const tm = tab.__tm;
        addSibling(tm);
        tm.activePaneId = 'p2';
        tab.draft = 'parked draft';
        tab._resyncNeeded = true;
        helperOf(tab).dispatchEvent(pasteEvent('INACTIVE_HELD'));
        expect(tm.inputTextArea.value).toBe('seeded draft');
        expect(tab.draft).toBe('parked draftINACTIVE_HELD');
        expect(tab.pasteRecovery).toBe('not_sent');
        expect(JSON.parse(localStorage.getItem('phi_tab_draft_p1')).text).toBe(
            'parked draftINACTIVE_HELD',
        );
        const line = document.createElement('div');
        line.id = 'input-restriction';
        document.body.appendChild(line);
        tm.activePaneId = 'p1';
        tm._renderInputRestriction();
        expect(line.textContent).toBe(
            'Paste held until live output is resynced.',
        );
        expect(line.classList.contains('hidden')).toBe(false);
    });
    it('does not save under a pane ID now owned by a replacement', () => {
        const tab = mountPasteTab();
        tab._resyncNeeded = true;
        tab.__tm.tabs.set('p1', {
            paneId: 'p1',
            draft: 'replacement',
            coder: 'pi',
        });
        helperOf(tab).dispatchEvent(pasteEvent('STALE_PASTE'));
        expect(tab.draft).toBe('');
        expect(localStorage.getItem('phi_tab_draft_p1')).toBeNull();
    });
    it('does not recreate a closed pane draft record', () => {
        const tab = mountPasteTab();
        tab.__tm.tabs.delete('p1');
        helperOf(tab).dispatchEvent(pasteEvent('CLOSED_PASTE'));
        expect(localStorage.getItem('phi_tab_draft_p1')).toBeNull();
    });
    it('restores text, status, and staged mode on reload, even for direct-mode coders', () => {
        const tab = mountPasteTab('bash');
        expect(tab.directMode).toBe(true);
        tab._resyncNeeded = true;
        helperOf(tab).dispatchEvent(pasteEvent('RELOAD_ME'));
        expect(tab.directMode).toBe(false);
        const re = mountRealTab({ coder: 'bash' });
        expect(re.draft).toBe('seeded draftRELOAD_ME');
        expect(re.pasteRecovery).toBe('not_sent');
        expect(re.directMode).toBe(false);
        expect(re._inputRestriction).toBe('Paste saved locally, not sent.');
    });
    it('keeps the recovery warning after resync until the text is sent or cleared', () => {
        const tab = mountPasteTab();
        tab._resyncNeeded = true;
        helperOf(tab).dispatchEvent(pasteEvent('HELD_THROUGH_RESYNC'));
        tab.__tm._updateResyncAffordance = vi.fn();
        tab.__tm._clearResyncNeeded(tab);
        expect(tab._resyncNeeded).toBe(false);
        expect(tab.pasteRecovery).toBe('not_sent');
        expect(tab._inputRestriction).toBe('Paste saved locally, not sent.');
    });
    it('clears the recovery state when the held text is explicitly cleared', () => {
        const tab = mountPasteTab();
        const tm = tab.__tm;
        tab._resyncNeeded = true;
        helperOf(tab).dispatchEvent(pasteEvent('TEMP_HELD'));
        expect(tab.pasteRecovery).toBe('not_sent');
        tab._resyncNeeded = false;
        tm.inputTextArea.value = '';
        tm.saveActiveDraft();
        expect(tab.pasteRecovery).toBeUndefined();
        expect(tab._inputRestriction).toBe('');
        expect(localStorage.getItem('phi_tab_draft_p1')).toBeNull();
    });
    it('keeps the frozen restriction when the draft is cleared while still frozen', () => {
        const tab = mountPasteTab();
        const tm = tab.__tm;
        tab._resyncNeeded = true;
        helperOf(tab).dispatchEvent(pasteEvent('STILL_FROZEN'));
        tm.inputTextArea.value = '';
        tm.saveActiveDraft();
        expect(tab.pasteRecovery).toBeUndefined();
        expect(tab._inputRestriction).toBe(
            'Paste held until live output is resynced.',
        );
        tm._updateResyncAffordance = vi.fn();
        tm._clearResyncNeeded(tab);
        expect(tab._inputRestriction).toBe('');
    });
    it('warns session-only on oversized recovery and clears after a later successful save', () => {
        const tab = mountPasteTab();
        const tm = tab.__tm;
        tab._resyncNeeded = true;
        helperOf(tab).dispatchEvent(pasteEvent('y'.repeat(1024 * 1024)));
        expect(tab.pasteRecovery).toBe('not_sent');
        expect(tm.inputTextArea.value).toHaveLength(
            'seeded draft'.length + 1024 * 1024,
        );
        expect(tab._pasteRecoveryUnsaved).toBe(true);
        expect(tab._inputRestriction).toBe(
            'Paste held until live output is resynced. Kept for this session only; copy it before reloading.',
        );
        tm._updateResyncAffordance = vi.fn();
        tm._clearResyncNeeded(tab);
        expect(tab._inputRestriction).toBe(
            'Paste saved locally, not sent. Kept for this session only; copy it before reloading.',
        );
        tm.inputTextArea.value = 'trimmed';
        tm.saveActiveDraft();
        expect(tab._pasteRecoveryUnsaved).toBe(false);
        expect(tab._inputRestriction).toBe('Paste saved locally, not sent.');
        expect(JSON.parse(localStorage.getItem('phi_tab_draft_p1')).text).toBe(
            'trimmed',
        );
    });
});

const PARTIAL_PASTE_TEXT = 'é'.repeat(512 * 1024 - 1) + '🙂tail';

describe('terminal paste uncertain delivery is never silently replayed', () => {
    function helperOf(tab) {
        return tab.termContainer.querySelector('.xterm-helper-textarea');
    }
    it('keeps the full text unconfirmed when a later chunk fails', async () => {
        const tab = mountPasteTab();
        const tm = tab.__tm;
        const wire = vi
            .spyOn(tab.ws.ws, 'send')
            .mockImplementationOnce(() => {})
            .mockImplementationOnce(() => {
                throw new Error('socket broke');
            });
        helperOf(tab).dispatchEvent(pasteEvent(PARTIAL_PASTE_TEXT));
        expect(tm.app.showToast).toHaveBeenCalled();
        expect(wire).toHaveBeenCalledTimes(2);
        expect(tab.pasteRecovery).toBe('unconfirmed');
        expect(tm.inputTextArea.value).toBe(
            'seeded draft' + PARTIAL_PASTE_TEXT,
        );
        expect(tab._inputRestriction).toBe(
            'Paste preserved; delivery unconfirmed. Check the terminal before sending.',
        );
        const frame = TerminalClientFrame.decode(
            new Uint8Array(wire.mock.calls[0][0]),
        );
        const sentBytes = frame.payload.value;
        const fullBytes = new TextEncoder().encode(PARTIAL_PASTE_TEXT);
        expect(fullBytes.length).toBeGreaterThan(1024 * 1024);
        expect(sentBytes.length).toBe(1024 * 1024);
        expect(
            Buffer.from(sentBytes).equals(
                Buffer.from(fullBytes.slice(0, 1024 * 1024)),
            ),
        ).toBe(true);
        await Promise.resolve();
        tab.ws.ws.readyState = 0;
        tab.ws.ws.readyState = 1;
        expect(wire).toHaveBeenCalledTimes(2);
        expect(tm.inputTextArea.value).toBe(
            'seeded draft' + PARTIAL_PASTE_TEXT,
        );
        expect(tab.pasteRecovery).toBe('unconfirmed');
    });
    it('runs offline paste to reconnect to explicit Send to partial failure to reload', () => {
        const tab = mountPasteTab('bash');
        const tm = tab.__tm;
        tab.ws.ws.readyState = 0;
        helperOf(tab).dispatchEvent(pasteEvent(PARTIAL_PASTE_TEXT));
        expect(tab.pasteRecovery).toBe('not_sent');
        expect(tab.directMode).toBe(false);
        tab.ws.ws.readyState = 1;
        const wire = vi
            .spyOn(tab.ws.ws, 'send')
            .mockImplementationOnce(() => {})
            .mockImplementationOnce(() => {
                tab.ws.ws.readyState = 3;
                throw new Error('connection closed after first chunk');
            });
        tm.sendStagedInput();
        expect(wire).toHaveBeenCalledTimes(2);
        expect(tab.pasteRecovery).toBe('unconfirmed');
        expect(
            JSON.parse(localStorage.getItem('phi_tab_draft_p1')).pasteRecovery,
        ).toBe('unconfirmed');
        expect(tm.inputTextArea.value).toBe(
            'seeded draft' + PARTIAL_PASTE_TEXT,
        );
        expect(tab._inputRestriction).toBe(
            'Paste preserved; delivery unconfirmed. Check the terminal before sending.',
        );
        const re = mountRealTab({ coder: 'bash' });
        expect(re.draft).toBe('seeded draft' + PARTIAL_PASTE_TEXT);
        expect(re.pasteRecovery).toBe('unconfirmed');
        expect(re.directMode).toBe(false);
    });
    it('keeps not_sent when the explicit Send meets a known offline refusal', () => {
        const tab = mountPasteTab();
        const tm = tab.__tm;
        tab.ws.ws.readyState = 0;
        const wire = vi.spyOn(tab.ws.ws, 'send');
        helperOf(tab).dispatchEvent(pasteEvent('OFFLINE_KEPT'));
        expect(tab.pasteRecovery).toBe('not_sent');
        tm.sendStagedInput();
        expect(wire).not.toHaveBeenCalled();
        expect(tab.pasteRecovery).toBe('not_sent');
        expect(tm.inputTextArea.value).toBe('seeded draftOFFLINE_KEPT');
        expect(
            JSON.parse(localStorage.getItem('phi_tab_draft_p1')).pasteRecovery,
        ).toBe('not_sent');
    });
    it('clears the recovery state after an accepted explicit Send', () => {
        const tab = mountPasteTab();
        const tm = tab.__tm;
        tab.ws.ws.readyState = 0;
        helperOf(tab).dispatchEvent(pasteEvent('SEND_OK'));
        expect(tab.pasteRecovery).toBe('not_sent');
        tab.ws.ws.readyState = 1;
        const send = vi.spyOn(tab.ws, 'sendInput').mockReturnValue(true);
        tm.adjustInputHeight = vi.fn();
        tm._spamScrollToBottom = vi.fn();
        tm._renderAttachmentStrip = vi.fn();
        const net = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue({ ok: true });
        try {
            tm.sendStagedInput();
        } finally {
            net.mockRestore();
        }
        expect(send).toHaveBeenCalledTimes(1);
        expect(tm.inputTextArea.value).toBe('');
        expect(tab.pasteRecovery).toBeUndefined();
        expect(tab._inputRestriction).toBe('');
        expect(localStorage.getItem('phi_tab_draft_p1')).toBeNull();
    });
    it('sanitizes embedded ESC at the composer wrapping boundary', () => {
        const tab = mountPasteTab();
        const tm = tab.__tm;
        tm.adjustInputHeight = vi.fn();
        tm._spamScrollToBottom = vi.fn();
        tm._renderAttachmentStrip = vi.fn();
        const net = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue({ ok: true });
        const send = vi.spyOn(tab.ws, 'sendInput').mockReturnValue(true);
        tm.inputTextArea.value = 'explain this output please \x1b[201~tail';
        try {
            tm.sendStagedInput();
        } finally {
            net.mockRestore();
        }
        expect(send).toHaveBeenCalledTimes(1);
        const sent = send.mock.calls[0][0];
        expect(sent.startsWith('\x1b[200~')).toBe(true);
        expect(sent.endsWith('\x1b[201~\r')).toBe(true);
        const inner = sent.slice('\x1b[200~'.length, -'\x1b[201~\r'.length);
        expect(inner).toContain('\u241b[201~');
        expect(inner).not.toContain('\x1b');
    });
});

describe('terminal paste does not need the bridge', () => {
    const snapshots = [
        [
            'live managed',
            { state: 'managed', connected: true, capabilities: ['history'] },
            true,
        ],
        ['absent at startup', undefined, false],
        [
            'unavailable',
            { state: 'unavailable', connected: false, capabilities: [] },
            false,
        ],
        [
            'disconnected during use',
            { state: 'managed', connected: false, capabilities: ['history'] },
            false,
        ],
        [
            'missing capability',
            { state: 'managed', connected: true, capabilities: [] },
            true,
        ],
        [
            'reconnected',
            { state: 'managed', connected: true, capabilities: ['history'] },
            true,
        ],
    ];
    it('keeps terminal paste independent of bridge lifecycle changes', () => {
        const tab = mountPasteTab();
        const send = vi.spyOn(tab.ws, 'sendInput').mockReturnValue(true);
        const net = vi
            .spyOn(globalThis, 'fetch')
            .mockRejectedValue(new Error('no network in paste path'));
        for (const [_label, view, fresh] of snapshots) {
            tab.piBridge = view;
            tab._piBridgeFresh = fresh ? tab.ws : null;
            const callsBefore = send.mock.calls.length;
            tab.termContainer
                .querySelector('.xterm-helper-textarea')
                .dispatchEvent(pasteEvent('BRIDGE_FREE'));
            expect(send).toHaveBeenCalledTimes(callsBefore + 1);
            expect(send).toHaveBeenLastCalledWith('BRIDGE_FREE');
            expect(net).not.toHaveBeenCalled();
            expect(tab.__tm.inputTextArea.value).toBe('seeded draft');
        }
    });
});

describe('OpenCode 2 Mini normal scrollback', () => {
    it('does not intercept wheel gestures or inject legacy TUI scroll keys', () => {
        const tab = mountRealTab({ coder: 'opencode', opencodeMode: 'mini' });
        setViewportScrollMetrics(tab, {
            scrollTop: 50,
            clientHeight: 100,
            scrollHeight: 1000,
        });
        const send = vi.spyOn(tab.ws, 'sendInput');
        const wheel = new WheelEvent('wheel', {
            deltaY: -120,
            bubbles: true,
            cancelable: true,
        });
        tab.termContainer.dispatchEvent(wheel);
        expect(tab.opencodeMode).toBe('mini');
        expect(wheel.defaultPrevented).toBe(false);
        expect(send).not.toHaveBeenCalled();
    });

    it('leaves mobile touch scrolling to xterm instead of sending legacy keyboard navigation', () => {
        const tab = mountRealTab({ coder: 'opencode', opencodeMode: 'mini' });
        const send = vi.spyOn(tab.ws, 'sendInput');
        const start = new Event('touchstart', {
            bubbles: true,
            cancelable: true,
        });
        Object.assign(start, { touches: [{ clientY: 200 }] });
        const move = new Event('touchmove', {
            bubbles: true,
            cancelable: true,
        });
        Object.assign(move, { touches: [{ clientY: 100 }] });
        tab.termContainer.dispatchEvent(start);
        tab.termContainer.dispatchEvent(move);
        expect(move.defaultPrevented).toBe(false);
        expect(send).not.toHaveBeenCalled();
    });
});

describe('DOM scroll listener installed by createTab (drives the real handler)', () => {
    it('re-engages follow at the exact bottom, and hides the scroll-to-bottom button', () => {
        const tabInfo = mountRealTab();
        tabInfo.userFollowBottom = false;
        Object.assign(tabInfo.term.buffer.active, {
            viewportY: 100,
            baseY: 100,
        });
        tabInfo.term.element
            .querySelector('.xterm-viewport')
            .dispatchEvent(new Event('scroll', { bubbles: false }));
        expect(tabInfo.userFollowBottom).toBe(true);
        expect(tabInfo.scrollToBottomBtn.classList.contains('hidden')).toBe(
            true,
        );
    });

    it('does NOT re-engage follow above the bottom (strict predicate, no slack), and shows the button', () => {
        const tabInfo = mountRealTab();
        tabInfo.userFollowBottom = false;
        Object.assign(tabInfo.term.buffer.active, {
            viewportY: 99,
            baseY: 100,
        });
        tabInfo.term.element
            .querySelector('.xterm-viewport')
            .dispatchEvent(new Event('scroll', { bubbles: false }));
        expect(tabInfo.userFollowBottom).toBe(false);
        expect(tabInfo.scrollToBottomBtn.classList.contains('hidden')).toBe(
            false,
        );
    });

    it('defers the re-engage decision to the next animation frame, coalescing repeat scrolls into one frame', () => {
        const tabInfo = mountRealTab();
        // Override mountRealTab's synchronous rAF stub: the write-path
        // block above needs the synchronous form, so this is a local,
        // post-mount override rather than a change to mountRealTab.
        const frames = [];
        vi.stubGlobal('requestAnimationFrame', (fn) => {
            frames.push(fn);
            return frames.length;
        });
        tabInfo.userFollowBottom = false;
        Object.assign(tabInfo.term.buffer.active, {
            viewportY: 100,
            baseY: 100,
        });
        const vp = tabInfo.term.element.querySelector('.xterm-viewport');
        vp.dispatchEvent(new Event('scroll', { bubbles: false }));
        vp.dispatchEvent(new Event('scroll', { bubbles: false }));
        // Coalescing guard (viewportScrollRafPending): two scroll events
        // before the frame runs queue exactly one frame, not two.
        expect(frames.length).toBe(1);
        // Deferred: the decision hasn't run yet, so follow is still off.
        expect(tabInfo.userFollowBottom).toBe(false);
        frames.forEach((f) => {
            f();
        });
        expect(tabInfo.userFollowBottom).toBe(true);
    });
});

describe('manual older-history button', () => {
    function historyTab(viewportY = 0) {
        const tab = mountRealTab();
        tab.ws.mode = 'hot';
        tab._historyOmitted = true;
        tab.term.buffer.active.viewportY = viewportY;
        tab.term.emitScroll();
        return tab;
    }

    it('appears within one screen of the top, not for a tiny scroll from the bottom', () => {
        const load = vi
            .spyOn(TabManager.prototype, '_loadColdHistory')
            .mockResolvedValue();
        const tab = historyTab(99);
        expect(tab.loadHistoryBtn.classList.contains('hidden')).toBe(true);
        tab.term.buffer.active.viewportY = tab.term.rows;
        tab.term.emitScroll();
        expect(tab.loadHistoryBtn.classList.contains('hidden')).toBe(false);
        expect(tab.loadHistoryBtn.disabled).toBe(false);
        expect(load).not.toHaveBeenCalled();
        tab.term.buffer.active.viewportY = tab.term.rows + 1;
        tab.term.emitScroll();
        expect(tab.loadHistoryBtn.classList.contains('hidden')).toBe(true);
    });

    it('wheel, touch, scrollbar, keyboard, and programmatic scrolls never request an older book', () => {
        const load = vi
            .spyOn(TabManager.prototype, '_loadColdHistory')
            .mockResolvedValue();
        const tab = historyTab();
        tab.termContainer.dispatchEvent(
            new WheelEvent('wheel', { deltaY: -120, bubbles: true }),
        );
        for (const [type, clientY] of [
            ['touchstart', 100],
            ['touchmove', 200],
        ]) {
            const event = new Event(type, { bubbles: true });
            Object.assign(event, { touches: [{ clientY }] });
            tab.termContainer.dispatchEvent(event);
        }
        tab.term.element
            .querySelector('.xterm-viewport')
            .dispatchEvent(new Event('scroll'));
        tab.termContainer.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }),
        );
        tab.term.emitScroll();
        expect(tab.loadHistoryBtn.classList.contains('hidden')).toBe(false);
        expect(load).not.toHaveBeenCalled();
        tab.loadHistoryBtn.click();
        expect(load).toHaveBeenCalledExactlyOnceWith(tab);
    });

    it.each([
        ['no omitted history', { _historyOmitted: false }],
        ['dead pane', { isDead: true }],
        ['closing pane', { finalizing: true }],
    ])('hides for %s', (_reason, state) => {
        const tab = historyTab();
        Object.assign(tab, state);
        tab.term.emitScroll();
        expect(tab.loadHistoryBtn.classList.contains('hidden')).toBe(true);
        expect(tab.loadHistoryBtn.disabled).toBe(true);
        expect(tab.loadHistoryBtn.tabIndex).toBe(-1);
    });

    it('does not offer archive loading inside a live alternate-screen application', () => {
        const tab = historyTab();
        tab.term.buffer.active.type = 'alternate';
        tab.term.emitScroll();
        expect(tab.loadHistoryBtn.classList.contains('hidden')).toBe(true);
        tab._historyBrowsing = true;
        tab.term.emitScroll();
        expect(tab.loadHistoryBtn.classList.contains('hidden')).toBe(false);
    });

    it('shows a disabled busy state during a request, then lets the user retry', () => {
        const load = vi
            .spyOn(TabManager.prototype, '_loadColdHistory')
            .mockResolvedValue();
        const tab = historyTab();
        tab._historyLoading = true;
        tab.term.emitScroll();
        expect(tab.loadHistoryBtn.disabled).toBe(true);
        expect(tab.loadHistoryBtn.getAttribute('aria-busy')).toBe('true');
        tab.loadHistoryBtn.click();
        expect(load).not.toHaveBeenCalled();
        tab._historyLoading = false;
        tab.term.emitScroll();
        expect(tab.loadHistoryBtn.disabled).toBe(false);
        expect(tab.loadHistoryBtn.getAttribute('aria-busy')).toBe('false');
        tab.loadHistoryBtn.click();
        expect(load).toHaveBeenCalledExactlyOnceWith(tab);
    });

    it('keeps terminal/input focus on pointer activation', () => {
        const tab = historyTab();
        const input = document.createElement('textarea');
        document.body.appendChild(input);
        input.focus();
        const event = new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
        });
        tab.loadHistoryBtn.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(input);
    });

    it('updates visibility after a write is parsed, including a checkpoint with no local scrollback', () => {
        const tab = historyTab(99);
        let parsed;
        tab.term.nativeWrite.mockImplementation((_data, cb) => {
            parsed = cb;
        });
        const callback = vi.fn();
        tab.term.write('checkpoint', callback);
        tab.term.buffer.active.viewportY = 0;
        tab.term.buffer.active.baseY = 0;
        parsed();
        expect(callback).toHaveBeenCalledOnce();
        expect(tab.loadHistoryBtn.classList.contains('hidden')).toBe(false);
    });
});

// clientHeight/scrollHeight are getter-only in jsdom (no layout engine), so
// they need defineProperty; scrollTop is a plain writable property.
function setViewportScrollMetrics(
    tabInfo,
    { scrollTop, clientHeight, scrollHeight },
) {
    const vp = tabInfo.term.element.querySelector('.xterm-viewport');
    vp.scrollTop = scrollTop;
    Object.defineProperty(vp, 'clientHeight', {
        value: clientHeight,
        configurable: true,
    });
    Object.defineProperty(vp, 'scrollHeight', {
        value: scrollHeight,
        configurable: true,
    });
    return vp;
}

describe('wheel-down escape hatch installed by createTab (drives the real handler)', () => {
    it('scrolls the buffer exactly once when clamped below the real bottom', () => {
        const tabInfo = mountRealTab();
        Object.assign(tabInfo.term.buffer.active, {
            viewportY: 50,
            baseY: 100,
        });
        setViewportScrollMetrics(tabInfo, {
            scrollTop: 968,
            clientHeight: 32,
            scrollHeight: 1000,
        });
        tabInfo.termContainer.dispatchEvent(
            new WheelEvent('wheel', { deltaY: 120, bubbles: true }),
        );
        expect(tabInfo.term.scrollLines).toHaveBeenCalledWith(3);
        expect(tabInfo.term.scrollLines).toHaveBeenCalledTimes(1);
    });

    it('does nothing at the real bottom', () => {
        const tabInfo = mountRealTab();
        Object.assign(tabInfo.term.buffer.active, {
            viewportY: 100,
            baseY: 100,
        });
        setViewportScrollMetrics(tabInfo, {
            scrollTop: 968,
            clientHeight: 32,
            scrollHeight: 1000,
        });
        tabInfo.termContainer.dispatchEvent(
            new WheelEvent('wheel', { deltaY: 120, bubbles: true }),
        );
        expect(tabInfo.term.scrollLines).not.toHaveBeenCalled();
    });

    it('does nothing when the DOM still has room to scroll', () => {
        const tabInfo = mountRealTab();
        Object.assign(tabInfo.term.buffer.active, {
            viewportY: 50,
            baseY: 100,
        });
        setViewportScrollMetrics(tabInfo, {
            scrollTop: 0,
            clientHeight: 32,
            scrollHeight: 1000,
        });
        tabInfo.termContainer.dispatchEvent(
            new WheelEvent('wheel', { deltaY: 120, bubbles: true }),
        );
        expect(tabInfo.term.scrollLines).not.toHaveBeenCalled();
    });

    it('does nothing on wheel-up', () => {
        const tabInfo = mountRealTab();
        Object.assign(tabInfo.term.buffer.active, {
            viewportY: 50,
            baseY: 100,
        });
        setViewportScrollMetrics(tabInfo, {
            scrollTop: 968,
            clientHeight: 32,
            scrollHeight: 1000,
        });
        tabInfo.termContainer.dispatchEvent(
            new WheelEvent('wheel', { deltaY: -120, bubbles: true }),
        );
        expect(tabInfo.term.scrollLines).not.toHaveBeenCalled();
    });

    // Bubble-phase registration (web/terminal.js:1503) is load-bearing, not
    // cosmetic: the comment at :1490-1491 documents that it's what lets the
    // opencode capture-phase handler's stopPropagation exclude opencode
    // tabs from this path. A mirror-style test can't see event phase at
    // all, so this regression (escape hatch silently firing for opencode
    // tabs too) was uncatchable before driving the real listeners.
    it('is excluded for opencode tabs by the capture-phase handler stopping propagation first', () => {
        const tabInfo = mountRealTab({ coder: 'opencode' });
        Object.assign(tabInfo.term.buffer.active, {
            viewportY: 50,
            baseY: 100,
        });
        setViewportScrollMetrics(tabInfo, {
            scrollTop: 968,
            clientHeight: 32,
            scrollHeight: 1000,
        });
        tabInfo.termContainer.dispatchEvent(
            new WheelEvent('wheel', {
                deltaY: 120,
                bubbles: true,
                cancelable: true,
            }),
        );
        expect(tabInfo.term.scrollLines).not.toHaveBeenCalled();
    });
});

describe('source contracts', () => {
    it('write path syncs the scroll area, scroll listener + escape hatch exist, no bottom slack', async () => {
        const fs = await import('node:fs');
        const src = fs.readFileSync('web/terminal.js', 'utf8');
        expect(src).toContain(
            'tabInfo.term._core?.viewport?.syncScrollArea(true)',
        );
        expect(src).toMatch(/termContainer\.addEventListener\(\s*'scroll'/);
        expect(src).toContain(
            'vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 1',
        );
        expect(src).not.toContain('baseY - 1');
    });
});

// Enter-only follow (decision: submit resumes follow, typing does not).
describe('only an accepted submit resumes follow', () => {
    it('disables xterm’s own follow-on-any-data', () => {
        mountRealTab();
        expect(globalThis.__lastTerminalOptions?.scrollOnUserInput).toBe(false);
    });

    it('a send without submit authority leaves the reader alone', () => {
        const tm = Object.create(TabManager.prototype);
        const tab = { paneId: 'p9', isDead: false, userFollowBottom: false };
        tm.sendInput = vi.fn(() => true);
        tm._spamScrollToBottom = vi.fn();
        expect(tm.sendToTab(tab, 'typed text')).toBe(true);
        expect(tm._spamScrollToBottom).not.toHaveBeenCalled();
        expect(tab.userFollowBottom).toBe(false);
    });

    it('an accepted submit resumes follow', () => {
        const tm = Object.create(TabManager.prototype);
        const tab = { paneId: 'p9', isDead: false, userFollowBottom: false };
        tm.sendInput = vi.fn(() => true);
        tm._spamScrollToBottom = vi.fn();
        tm.sendToTab(tab, 'prompt\r', { submit: true });
        expect(tm._spamScrollToBottom).toHaveBeenCalledTimes(1);
        expect(tab.userFollowBottom).toBe(true);
    });

    it('a refused send resumes no follow', () => {
        const tm = Object.create(TabManager.prototype);
        const tab = { paneId: 'p9', isDead: false, userFollowBottom: false };
        tm.sendInput = vi.fn(() => false);
        tm._spamScrollToBottom = vi.fn();
        tm.sendToTab(tab, 'prompt\r', { submit: true });
        expect(tm._spamScrollToBottom).not.toHaveBeenCalled();
    });

    it('forwarded Enter resumes follow, forwarded navigation keys do not', () => {
        const tm = Object.create(TabManager.prototype);
        const tab = { coder: 'bash', paneId: 'p9', isDead: false };
        tm.sendToTab = vi.fn(() => true);
        const enter = { key: 'Enter', preventDefault: vi.fn() };
        tm._forwardKeyToPty(enter, tab);
        expect(tm.sendToTab).toHaveBeenLastCalledWith(tab, '\r', {
            submit: true,
        });
        for (const key of ['ArrowUp', 'PageUp', 'Home', 'Escape', 'Tab']) {
            tm._forwardKeyToPty({ key, preventDefault: vi.fn() }, tab);
            expect(tm.sendToTab).toHaveBeenLastCalledWith(
                tab,
                expect.any(String),
            );
        }
    });

    it('direct-mode Enter follows, printable input and paste newlines do not', () => {
        const tab = mountRealTab({ coder: 'bash' });
        const tm = tab.__tm;
        tab.directMode = true;
        tm.sendInput = vi.fn(() => true);
        tm._spamScrollToBottom = vi.fn();
        tab.term.emitUserData('a');
        expect(tm._spamScrollToBottom).not.toHaveBeenCalled();
        tab.term.emitUserData('pasted\r\nlines');
        expect(tm._spamScrollToBottom).not.toHaveBeenCalled();
        tab.term.emitUserData('\r');
        expect(tm._spamScrollToBottom).toHaveBeenCalledTimes(1);
        expect(tab.userFollowBottom).toBe(true);
    });

    it('a newer gesture cancels the deferred slash-command follow but not its send', () => {
        vi.useFakeTimers();
        try {
            const tm = Object.create(TabManager.prototype);
            const tab = {
                coder: 'opencode',
                paneId: 'p9',
                isDead: false,
                userFollowBottom: true,
            };
            tm.sendToTab = vi.fn(() => true);
            tm._focusAfterSlashCommand = vi.fn();
            tm.isOpenCodeMini = () => false;
            tm.sendSlashCommand(tab, '/status');
            expect(tm.sendToTab.mock.calls[0][2]).toEqual({ submit: true });
            // The reader scrolls up inside the 200 ms window.
            tm._cancelScrollFollowForUserScroll(tab);
            vi.advanceTimersByTime(200);
            expect(tm.sendToTab).toHaveBeenCalledTimes(2);
            expect(tm.sendToTab.mock.calls[1][1]).toBe('\r');
            expect(tm.sendToTab.mock.calls[1][2]).toEqual({ submit: false });
            expect(tab.userFollowBottom).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});

// The alternate-screen rule must not fire for a pane repainting its own
// buffer: a history load swaps the buffer and then places the view itself.
describe('alternate-screen exit resumes follow only for the app', () => {
    it('the app leaving its full-screen TUI lands at the bottom', () => {
        const tab = mountRealTab({ coder: 'bash' });
        const tm = tab.__tm;
        tm._spamScrollToBottom = vi.fn();
        tab.userFollowBottom = false;
        tab.term.emitBufferChange('normal');
        expect(tm._spamScrollToBottom).toHaveBeenCalledTimes(1);
        expect(tab.userFollowBottom).toBe(true);
    });

    it('a pane rewriting its own buffer leaves the view to the loader', () => {
        const tab = mountRealTab({ coder: 'bash' });
        const tm = tab.__tm;
        tm._spamScrollToBottom = vi.fn();
        tab._ownBufferReset = true;
        tab.userFollowBottom = false;
        tab.term.emitBufferChange('normal');
        tab._ownBufferReset = false;
        expect(tm._spamScrollToBottom).not.toHaveBeenCalled();
        expect(tab.userFollowBottom).toBe(false);
    });

    it('a history load in progress leaves the view to the loader', () => {
        const tab = mountRealTab({ coder: 'bash' });
        const tm = tab.__tm;
        tm._spamScrollToBottom = vi.fn();
        for (const flag of ['_historyParsing', '_historyBrowsing']) {
            tab.userFollowBottom = false;
            tab[flag] = true;
            tab.term.emitBufferChange('normal');
            tab[flag] = false;
            expect(tm._spamScrollToBottom).not.toHaveBeenCalled();
            expect(tab.userFollowBottom).toBe(false);
        }
    });
});

// A replayed window is history: painting it must not overwrite the clipboard.
describe('replay provenance for OSC 52', () => {
    const clip = (data) => `c;${Buffer.from(data, 'utf8').toString('base64')}`;

    it('a live copy reaches the clipboard', () => {
        const tab = mountRealTab({ coder: 'bash' });
        const tm = tab.__tm;
        tm._agentClipboardCopy = vi.fn();
        tab.term.emitOsc(52, clip('live copy'));
        expect(tm._agentClipboardCopy).toHaveBeenCalledWith('live copy');
    });

    it('a copy parsed while a history load owns the parser is dropped', () => {
        const tab = mountRealTab({ coder: 'bash' });
        const tm = tab.__tm;
        tm._agentClipboardCopy = vi.fn();
        tab._historyParsing = true;
        tab.term.emitOsc(52, clip('archived copy'));
        tab._historyParsing = false;
        expect(tm._agentClipboardCopy).not.toHaveBeenCalled();
    });

    it('a copy parsed against a browsed window is dropped', () => {
        const tab = mountRealTab({ coder: 'bash' });
        const tm = tab.__tm;
        tm._agentClipboardCopy = vi.fn();
        tab._historyBrowsing = true;
        tab.term.emitOsc(52, clip('archived copy'));
        expect(tm._agentClipboardCopy).not.toHaveBeenCalled();
        // Leaving the archive restores genuine live copies.
        tab._historyBrowsing = false;
        tab.term.emitOsc(52, clip('live again'));
        expect(tm._agentClipboardCopy).toHaveBeenCalledWith('live again');
    });
});
