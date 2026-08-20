// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness, mockFetch, stubWebSocket } from './_dom.js';

// Covers the diff xterm copy wiring added so users can drag-select / Cmd-C
// out of the diff/status/log pane. Without these handlers, the WebGL renderer
// paints ANSI-coded git output onto a <canvas>, the browser sees a canvas on
// Cmd-C and copies nothing, and the user perceives git output as an image.
//
// Test scope: the JS wiring itself - that _wireCopyHandlers attaches the
// right listeners and dispatches to copyTextRobustly, plus the Copy button
// in the diff toolbar. xterm internals are not exercised here; we substitute
// a stub with the methods the production code actually touches.

setupDomHarness();

beforeEach(() => {
    stubWebSocket();
});

// ---- Minimal xterm stub ------------------------------------------------
// Two primitives: _setSelectionValue sets the selection without firing
// onSelectionChange (so we can populate state for keystroke/contextmenu
// tests without the auto-copy noise), and _fireSelectionChange sets AND
// fires (so we can exercise the auto-copy path explicitly).

function makeStubTerm() {
    let selection = '';
    let selectionCb = null;
    return {
        _setSelectionValue(v) {
            selection = v;
        },
        _fireSelectionChange(v) {
            selection = v;
            if (selectionCb) selectionCb();
        },
        getSelection: vi.fn(() => selection),
        onSelectionChange(cb) {
            selectionCb = cb;
        },
        attachCustomKeyEventHandler: vi.fn(() => true),
        addEventListener: vi.fn(),
        open: vi.fn(),
        loadAddon: vi.fn(),
        reset: vi.fn(),
        clear: vi.fn(),
        write: vi.fn(),
    };
}

function makeStubContainer() {
    return {
        addEventListener: vi.fn(),
    };
}

// ---- Minimal DiffController harness ------------------------------------
// We don't import the real DiffController (it pulls xterm, PTYWebSocket, and
// dozens of DOM refs). Instead we mount only the methods we want to test by
// copying them off the real class via prototype. This keeps the test honest
// about the production code path while sidestepping the constructor.

async function loadDiffControllerPrototype() {
    const mod = await import('../web/diff.js');
    const Proto = mod.DiffController.prototype;
    return {
        _wireCopyHandlers: Proto._wireCopyHandlers,
        copyDiffBuffer: Proto.copyDiffBuffer,
    };
}

function ctrlCtx({ copyTextRobustly, term, container }) {
    return {
        term,
        diffTermContainer: container,
        app: { tabManager: { copyTextRobustly: vi.fn(copyTextRobustly) } },
    };
}

// ---- _wireCopyHandlers -------------------------------------------------

describe('DiffController._wireCopyHandlers', () => {
    it('attaches onSelectionChange, contextmenu (capture), and a key handler', async () => {
        const { _wireCopyHandlers } = await loadDiffControllerPrototype();
        const term = makeStubTerm();
        const container = makeStubContainer();
        const ctx = ctrlCtx({ copyTextRobustly: vi.fn(), term, container });
        _wireCopyHandlers.call(ctx, term, container);
        // onSelectionChange registered a callback
        expect(term.onSelectionChange).toBeDefined();
        // attachCustomKeyEventHandler was called once with a function
        expect(term.attachCustomKeyEventHandler).toHaveBeenCalledTimes(1);
        expect(typeof term.attachCustomKeyEventHandler.mock.calls[0][0]).toBe(
            'function',
        );
        // contextmenu wired via capture-phase addEventListener on the container
        const ctxCall = container.addEventListener.mock.calls.find(
            (c) => c[0] === 'contextmenu',
        );
        expect(ctxCall).toBeTruthy();
        expect(ctxCall[2]).toEqual({ capture: true });
    });

    it('auto-copies silently when the selection changes', async () => {
        const { _wireCopyHandlers } = await loadDiffControllerPrototype();
        const term = makeStubTerm();
        const container = makeStubContainer();
        const copy = vi.fn();
        const ctx = ctrlCtx({ copyTextRobustly: copy, term, container });
        _wireCopyHandlers.call(ctx, term, container);

        term._fireSelectionChange('+added line');
        // silent=true matches the main terminal's behavior - no toast.
        expect(copy).toHaveBeenCalledWith('+added line', true);
    });

    it('does not call copy when the selection becomes empty', async () => {
        const { _wireCopyHandlers } = await loadDiffControllerPrototype();
        const term = makeStubTerm();
        const container = makeStubContainer();
        const copy = vi.fn();
        const ctx = ctrlCtx({ copyTextRobustly: copy, term, container });
        _wireCopyHandlers.call(ctx, term, container);

        term._fireSelectionChange('');
        expect(copy).not.toHaveBeenCalled();
    });

    it('right-click with a non-empty selection copies and prevents default', async () => {
        const { _wireCopyHandlers } = await loadDiffControllerPrototype();
        const term = makeStubTerm();
        const container = makeStubContainer();
        const copy = vi.fn();
        const ctx = ctrlCtx({ copyTextRobustly: copy, term, container });
        _wireCopyHandlers.call(ctx, term, container);

        // Populate selection WITHOUT firing auto-copy (real right-click in
        // a browser already has a selection active when the menu opens).
        term._setSelectionValue('something');
        const ctxCall = container.addEventListener.mock.calls.find(
            (c) => c[0] === 'contextmenu',
        );
        const handler = ctxCall[1];
        const ev = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
        handler(ev);
        // Assert on the first arg explicitly: copyTextRobustly forwards
        // an undefined silent flag here, which vitest counts as a 2nd arg
        // and would mismatch toHaveBeenCalledWith('something').
        expect(copy).toHaveBeenCalledTimes(1);
        expect(copy.mock.calls[0][0]).toBe('something');
        expect(ev.preventDefault).toHaveBeenCalled();
        expect(ev.stopPropagation).toHaveBeenCalled();
    });

    it('right-click with empty selection is a no-op (lets browser show its menu)', async () => {
        const { _wireCopyHandlers } = await loadDiffControllerPrototype();
        const term = makeStubTerm();
        const container = makeStubContainer();
        const copy = vi.fn();
        const ctx = ctrlCtx({ copyTextRobustly: copy, term, container });
        _wireCopyHandlers.call(ctx, term, container);

        const ctxCall = container.addEventListener.mock.calls.find(
            (c) => c[0] === 'contextmenu',
        );
        const handler = ctxCall[1];
        const ev = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
        handler(ev);
        expect(copy).not.toHaveBeenCalled();
        expect(ev.preventDefault).not.toHaveBeenCalled();
    });

    it('Cmd-C with a selection copies and swallows the keystroke (Mac)', async () => {
        Object.defineProperty(navigator, 'platform', {
            value: 'MacIntel',
            configurable: true,
        });
        const { _wireCopyHandlers } = await loadDiffControllerPrototype();
        const term = makeStubTerm();
        const container = makeStubContainer();
        const copy = vi.fn();
        const ctx = ctrlCtx({ copyTextRobustly: copy, term, container });
        _wireCopyHandlers.call(ctx, term, container);

        term._setSelectionValue('+added');
        const keyHandler = term.attachCustomKeyEventHandler.mock.calls[0][0];
        const ev = {
            type: 'keydown',
            key: 'c',
            metaKey: true,
            ctrlKey: false,
            shiftKey: false,
            preventDefault: vi.fn(),
        };
        const result = keyHandler(ev);
        expect(copy).toHaveBeenCalledTimes(1);
        expect(copy.mock.calls[0][0]).toBe('+added');
        expect(ev.preventDefault).toHaveBeenCalled();
        expect(result).toBe(false);
    });

    it('Ctrl-Shift-C with a selection copies on Linux/Windows', async () => {
        Object.defineProperty(navigator, 'platform', {
            value: 'Linux x86_64',
            configurable: true,
        });
        const { _wireCopyHandlers } = await loadDiffControllerPrototype();
        const term = makeStubTerm();
        const container = makeStubContainer();
        const copy = vi.fn();
        const ctx = ctrlCtx({ copyTextRobustly: copy, term, container });
        _wireCopyHandlers.call(ctx, term, container);

        term._setSelectionValue('+added');
        const keyHandler = term.attachCustomKeyEventHandler.mock.calls[0][0];
        const ev = {
            type: 'keydown',
            key: 'c',
            metaKey: false,
            ctrlKey: true,
            shiftKey: true,
            preventDefault: vi.fn(),
        };
        const result = keyHandler(ev);
        expect(copy).toHaveBeenCalledTimes(1);
        expect(copy.mock.calls[0][0]).toBe('+added');
        expect(result).toBe(false);
    });

    it('Cmd-C with no selection passes through (returns true)', async () => {
        Object.defineProperty(navigator, 'platform', {
            value: 'MacIntel',
            configurable: true,
        });
        const { _wireCopyHandlers } = await loadDiffControllerPrototype();
        const term = makeStubTerm();
        const container = makeStubContainer();
        const copy = vi.fn();
        const ctx = ctrlCtx({ copyTextRobustly: copy, term, container });
        _wireCopyHandlers.call(ctx, term, container);

        const keyHandler = term.attachCustomKeyEventHandler.mock.calls[0][0];
        const ev = {
            type: 'keydown',
            key: 'c',
            metaKey: true,
            ctrlKey: false,
            shiftKey: false,
            preventDefault: vi.fn(),
        };
        const result = keyHandler(ev);
        expect(copy).not.toHaveBeenCalled();
        expect(result).toBe(true);
    });

    it('plain Ctrl-C (no shift) does NOT trigger copy on Linux/Windows', async () => {
        // Plain Ctrl-C is the SIGINT keystroke for shells; we must not
        // swallow it as a copy even when there is a selection.
        Object.defineProperty(navigator, 'platform', {
            value: 'Linux x86_64',
            configurable: true,
        });
        const { _wireCopyHandlers } = await loadDiffControllerPrototype();
        const term = makeStubTerm();
        const container = makeStubContainer();
        const copy = vi.fn();
        const ctx = ctrlCtx({ copyTextRobustly: copy, term, container });
        _wireCopyHandlers.call(ctx, term, container);

        term._setSelectionValue('selected');
        const keyHandler = term.attachCustomKeyEventHandler.mock.calls[0][0];
        const ev = {
            type: 'keydown',
            key: 'c',
            metaKey: false,
            ctrlKey: true,
            shiftKey: false,
            preventDefault: vi.fn(),
        };
        const result = keyHandler(ev);
        expect(copy).not.toHaveBeenCalled();
        expect(result).toBe(true);
    });

    it('non-copy keystrokes pass through', async () => {
        const { _wireCopyHandlers } = await loadDiffControllerPrototype();
        const term = makeStubTerm();
        const container = makeStubContainer();
        const copy = vi.fn();
        const ctx = ctrlCtx({ copyTextRobustly: copy, term, container });
        _wireCopyHandlers.call(ctx, term, container);

        const keyHandler = term.attachCustomKeyEventHandler.mock.calls[0][0];
        const result = keyHandler({
            type: 'keydown',
            key: 'a',
            metaKey: false,
            ctrlKey: false,
            shiftKey: false,
        });
        expect(copy).not.toHaveBeenCalled();
        expect(result).toBe(true);
    });

    it('key-up events pass through (we only intercept keydown)', async () => {
        Object.defineProperty(navigator, 'platform', {
            value: 'MacIntel',
            configurable: true,
        });
        const { _wireCopyHandlers } = await loadDiffControllerPrototype();
        const term = makeStubTerm();
        const container = makeStubContainer();
        const copy = vi.fn();
        const ctx = ctrlCtx({ copyTextRobustly: copy, term, container });
        _wireCopyHandlers.call(ctx, term, container);

        term._setSelectionValue('selected');
        const keyHandler = term.attachCustomKeyEventHandler.mock.calls[0][0];
        const result = keyHandler({
            type: 'keyup',
            key: 'c',
            metaKey: true,
            ctrlKey: false,
            shiftKey: false,
        });
        expect(copy).not.toHaveBeenCalled();
        expect(result).toBe(true);
    });

    it('passes Ctrl/Cmd zoom shortcuts (+, -, 0, =) through to browser/desktop', async () => {
        const { _wireCopyHandlers } = await loadDiffControllerPrototype();
        const term = makeStubTerm();
        const container = makeStubContainer();
        const copy = vi.fn();
        const ctx = ctrlCtx({ copyTextRobustly: copy, term, container });
        _wireCopyHandlers.call(ctx, term, container);

        const keyHandler = term.attachCustomKeyEventHandler.mock.calls[0][0];
        for (const key of ['+', '=', '-', '_', '0', 'Add', 'Subtract']) {
            expect(
                keyHandler({
                    type: 'keydown',
                    key,
                    ctrlKey: true,
                    altKey: false,
                    metaKey: false,
                }),
            ).toBe(false);
            expect(
                keyHandler({
                    type: 'keydown',
                    key,
                    ctrlKey: false,
                    altKey: false,
                    metaKey: true,
                }),
            ).toBe(false);
        }
    });

    it('passes F5, Shift+F5, and Ctrl/Cmd+R reload/reconnect shortcuts through to browser/desktop', async () => {
        const { _wireCopyHandlers } = await loadDiffControllerPrototype();
        const term = makeStubTerm();
        const container = makeStubContainer();
        const copy = vi.fn();
        const ctx = ctrlCtx({ copyTextRobustly: copy, term, container });
        _wireCopyHandlers.call(ctx, term, container);

        const keyHandler = term.attachCustomKeyEventHandler.mock.calls[0][0];
        expect(
            keyHandler({
                type: 'keydown',
                key: 'F5',
                shiftKey: false,
                ctrlKey: false,
                altKey: false,
                metaKey: false,
            }),
        ).toBe(false);
        expect(
            keyHandler({
                type: 'keydown',
                key: 'F5',
                shiftKey: true,
                ctrlKey: false,
                altKey: false,
                metaKey: false,
            }),
        ).toBe(false);
        expect(
            keyHandler({
                type: 'keydown',
                key: 'r',
                shiftKey: true,
                ctrlKey: true,
                altKey: false,
                metaKey: false,
            }),
        ).toBe(false);
        expect(
            keyHandler({
                type: 'keydown',
                key: 'R',
                shiftKey: true,
                ctrlKey: false,
                altKey: false,
                metaKey: true,
            }),
        ).toBe(false);
    });
});

// ---- copyDiffBuffer ----------------------------------------------------

describe('DiffController.copyDiffBuffer', () => {
    function makeBufferTerm(lines) {
        // lines: array of plain strings. xterm pads its buffer with empty
        // rows; emulate that so copyDiffBuffer has to trim trailing empties.
        const buffer = {
            length: lines.length + 5, // 5 pretend padded rows
            getLine(i) {
                if (i >= lines.length) return null;
                return { translateToString: (_trim) => lines[i] };
            },
        };
        return {
            buffer: { active: buffer },
            getSelection: vi.fn(() => ''),
        };
    }

    it('joins all non-padded lines with \\n', async () => {
        const { copyDiffBuffer } = await loadDiffControllerPrototype();
        const term = makeBufferTerm(['a', 'b', 'c']);
        const copy = vi.fn();
        const ctx = ctrlCtx({ copyTextRobustly: copy, term });
        copyDiffBuffer.call(ctx);
        expect(copy).toHaveBeenCalledWith('a\nb\nc');
    });

    it('trims trailing whitespace-only lines so the paste has no blank padding', async () => {
        const { copyDiffBuffer } = await loadDiffControllerPrototype();
        // xterm pads its buffer with empty rows. Internal whitespace-only
        // lines (real '   ' and '\\t' from a diff hunk) must survive; only
        // the trailing empties get stripped.
        const term = makeBufferTerm([
            'first',
            'second',
            '   ',
            '\t',
            'third',
            '',
            '',
        ]);
        const copy = vi.fn();
        const ctx = ctrlCtx({ copyTextRobustly: copy, term });
        copyDiffBuffer.call(ctx);
        expect(copy).toHaveBeenCalledWith('first\nsecond\n   \n\t\nthird');
    });

    it('returns an empty string (not error) when the buffer has no lines', async () => {
        const { copyDiffBuffer } = await loadDiffControllerPrototype();
        const term = makeBufferTerm([]);
        const copy = vi.fn();
        const ctx = ctrlCtx({ copyTextRobustly: copy, term });
        copyDiffBuffer.call(ctx);
        expect(copy).toHaveBeenCalledWith('');
    });

    it('skips padded rows (getLine returns null) without throwing', async () => {
        const { copyDiffBuffer } = await loadDiffControllerPrototype();
        const term = makeBufferTerm(['x']);
        const copy = vi.fn();
        const ctx = ctrlCtx({ copyTextRobustly: copy, term });
        expect(() => copyDiffBuffer.call(ctx)).not.toThrow();
        expect(copy).toHaveBeenCalledWith('x');
    });

    it('is a no-op (no copy call) when this.term is null', async () => {
        const { copyDiffBuffer } = await loadDiffControllerPrototype();
        const copy = vi.fn();
        const ctx = { app: { tabManager: { copyTextRobustly: vi.fn(copy) } } }; // no .term
        copyDiffBuffer.call(ctx);
        expect(copy).not.toHaveBeenCalled();
    });
});

// ---- Copy toolbar button click handler ---------------------------------
// The Copy button in the diff header either copies the active selection
// (if any) or falls through to copyDiffBuffer. We verify both branches
// by reading setupEventListeners off the prototype and exercising the
// registered click handler with a stubbed this.term.

describe('DiffController Copy button', () => {
    async function loadSetup() {
        const mod = await import('../web/diff.js');
        return mod.DiffController.prototype.setupEventListeners;
    }

    function mountCopyButtonDom() {
        // Minimal DOM: setupEventListeners references several elements by id.
        // We only care about #copy-diff-btn being clicked; the other handlers
        // are inert without their own DOM refs, which we stub as no-ops.
        document.body.innerHTML = `
            <button id="close-diff-btn"></button>
            <button id="header-diff-toggle-btn"></button>
            <button id="copy-diff-btn"></button>
            <button id="refresh-diff-btn"></button>
        `;
    }

    it('copies the active xterm selection when one exists', async () => {
        const setupEventListeners = await loadSetup();
        mountCopyButtonDom();
        const copyTextRobustly = vi.fn();
        const term = { getSelection: vi.fn(() => 'SELECTED TEXT') };
        const ctx = {
            closeDiffBtn: document.getElementById('close-diff-btn'),
            headerDiffToggleBtn: document.getElementById(
                'header-diff-toggle-btn',
            ),
            copyDiffBtn: document.getElementById('copy-diff-btn'),
            refreshDiffBtn: document.getElementById('refresh-diff-btn'),
            term,
            app: { tabManager: { copyTextRobustly } },
        };
        setupEventListeners.call(ctx);
        document.getElementById('copy-diff-btn').click();
        expect(term.getSelection).toHaveBeenCalled();
        expect(copyTextRobustly).toHaveBeenCalledWith('SELECTED TEXT');
    });

    it('falls through to copyDiffBuffer when there is no selection', async () => {
        const setupEventListeners = await loadSetup();
        mountCopyButtonDom();
        const copyTextRobustly = vi.fn();
        const term = { getSelection: vi.fn(() => '') };
        // Stub copyDiffBuffer on the context so we can assert it was called
        // without depending on xterm's buffer internals here.
        const copyDiffBuffer = vi.fn();
        const ctx = {
            closeDiffBtn: document.getElementById('close-diff-btn'),
            headerDiffToggleBtn: document.getElementById(
                'header-diff-toggle-btn',
            ),
            copyDiffBtn: document.getElementById('copy-diff-btn'),
            refreshDiffBtn: document.getElementById('refresh-diff-btn'),
            term,
            copyDiffBuffer,
            app: { tabManager: { copyTextRobustly } },
        };
        setupEventListeners.call(ctx);
        document.getElementById('copy-diff-btn').click();
        expect(term.getSelection).toHaveBeenCalled();
        // copyTextRobustly not called directly; copyDiffBuffer is the fallback.
        expect(copyTextRobustly).not.toHaveBeenCalled();
        expect(copyDiffBuffer).toHaveBeenCalled();
    });

    it('is a no-op when this.term is null (button clicked before terminal init)', async () => {
        const setupEventListeners = await loadSetup();
        mountCopyButtonDom();
        const copyTextRobustly = vi.fn();
        const ctx = {
            closeDiffBtn: document.getElementById('close-diff-btn'),
            headerDiffToggleBtn: document.getElementById(
                'header-diff-toggle-btn',
            ),
            copyDiffBtn: document.getElementById('copy-diff-btn'),
            refreshDiffBtn: document.getElementById('refresh-diff-btn'),
            term: null,
            app: { tabManager: { copyTextRobustly } },
        };
        setupEventListeners.call(ctx);
        expect(() =>
            document.getElementById('copy-diff-btn').click(),
        ).not.toThrow();
        expect(copyTextRobustly).not.toHaveBeenCalled();
    });
});
