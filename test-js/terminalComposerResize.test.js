// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { App } from '../web/app.js';
import { TabManager } from '../web/terminal.js';

setupDomHarness();

afterEach(() => {
    for (const listener of trackedResizeListeners)
        window.removeEventListener('resize', listener);
    trackedResizeListeners.clear();
    vi.useRealTimers();
});

const trackedResizeListeners = new Set();

function initResizers(app) {
    const addEventListener = window.addEventListener;
    const spy = vi
        .spyOn(window, 'addEventListener')
        .mockImplementation(function (type, listener, options) {
            if (type === 'resize') trackedResizeListeners.add(listener);
            return addEventListener.call(this, type, listener, options);
        });
    try {
        app.initResizers();
    } finally {
        spy.mockRestore();
    }
}

function modeHarness() {
    document.body.innerHTML = `
        <div id="input-bar-container">
            <div id="attachment-strip" class="hidden"></div>
            <div class="input-bar-row">
                <textarea id="input-textarea"></textarea>
                <div class="input-actions">
                    <button id="send-input-btn"></button>
                </div>
            </div>
        </div>
        <div id="presets-toolbar"></div>
    `;
    const bar = document.getElementById('input-bar-container');
    const textarea = document.getElementById('input-textarea');
    const toggle = document.createElement('button');
    bar.appendChild(toggle);
    const m = Object.assign(Object.create(TabManager.prototype), {
        inputBarContainer: bar,
        inputTextArea: textarea,
        directModeToggle: toggle,
        presetsContainer: document.getElementById('presets-toolbar'),
        cancelInputBtn: null,
        sessionSearchBtn: null,
        sendInputBtn: document.getElementById('send-input-btn'),
        ctrlTBtn: null,
        _setPiRpcActionVisibility: vi.fn(),
        _placeCompactQuickChips: vi.fn(),
        renderPresets: vi.fn(),
        fitActiveTerminal: vi.fn(),
        adjustInputHeight: vi.fn(),
    });
    return { m, bar, textarea, toggle };
}

function makeTab(coder, extra = {}) {
    return {
        coder,
        directMode: false,
        isDead: false,
        isAtBottom: 0,
        lastScrollY: 0,
        term: { buffer: { active: { viewportY: 0, baseY: 0 } } },
        ...extra,
    };
}

describe('terminal composer mode boundary', () => {
    it('marks terminal tabs and drops a stale autosize height', () => {
        const { m, bar, textarea } = modeHarness();
        textarea.style.height = '83px';
        m.updateDirectModeUI(makeTab('bash'));
        expect(bar.classList.contains('terminal-composer')).toBe(true);
        expect(textarea.style.height).toBe('');
        expect(m.adjustInputHeight).not.toHaveBeenCalled();
        expect(m.fitActiveTerminal).toHaveBeenCalledOnce();
    });

    it('leaves Pi RPC, review, and kanban on the autosize path', () => {
        for (const coder of ['pi-rpc', 'review', 'kanban']) {
            const { m, bar, textarea } = modeHarness();
            bar.classList.add('terminal-composer');
            textarea.style.height = '83px';
            m.updateDirectModeUI(makeTab(coder));
            expect(bar.classList.contains('terminal-composer')).toBe(false);
            expect(m.adjustInputHeight).toHaveBeenCalledOnce();
        }
    });

    it('restores the terminal class without keeping the Pi RPC height', () => {
        const { m, bar, textarea } = modeHarness();
        m.updateDirectModeUI(makeTab('pi-rpc'));
        textarea.style.height = '72px';
        m.updateDirectModeUI(makeTab('bash'));
        expect(bar.classList.contains('terminal-composer')).toBe(true);
        expect(textarea.style.height).toBe('');
    });

    it('does not toggle the class while the bar is folded', () => {
        const { m, bar } = modeHarness();
        m.updateDirectModeUI(makeTab('bash', { directMode: true }));
        expect(bar.classList.contains('terminal-composer')).toBe(true);
        expect(bar.classList.contains('direct-mode-active')).toBe(true);
    });
});

describe('adjustInputHeight in terminal composer mode', () => {
    function heightHarness() {
        const bar = document.createElement('div');
        bar.id = 'input-bar-container';
        const textarea = document.createElement('textarea');
        bar.appendChild(textarea);
        const m = Object.assign(Object.create(TabManager.prototype), {
            inputBarContainer: bar,
            inputTextArea: textarea,
        });
        return { m, bar, textarea };
    }

    it('removes the inline height and keeps the CSS height in terminal mode', () => {
        const { m, bar, textarea } = heightHarness();
        bar.classList.add('terminal-composer');
        textarea.value = 'one\ntwo\nthree\nfour';
        textarea.style.height = '84px';
        m.adjustInputHeight();
        expect(textarea.style.height).toBe('');
    });

    it('still autosizes outside terminal composer mode', () => {
        const { m, textarea } = heightHarness();
        textarea.value = 'one\ntwo\nthree\nfour';
        Object.defineProperty(textarea, 'scrollHeight', { value: 84 });
        m.adjustInputHeight();
        expect(textarea.style.height).toBe('84px');
    });
});

function composerHarness(options = {}) {
    const {
        storage = {},
        parentHeight = 480,
        textareaHeight = 40,
        minimum = 38,
        maximum = 160,
        cellHeight = 17,
        realLifecycle = false,
        realStorage = false,
    } = options;
    document.body.innerHTML = `
        <div id="input-bar-container" class="terminal-composer">
            <textarea id="input-textarea"></textarea>
        </div>
    `;
    const bar = document.getElementById('input-bar-container');
    const textarea = document.getElementById('input-textarea');
    textarea.style.minHeight = `${minimum}px`;
    textarea.style.maxHeight = `${maximum}px`;
    const parent = document.createElement('div');
    parent.style.height = `${parentHeight}px`;
    const element = document.createElement('div');
    element.style.paddingTop = '8px';
    element.style.paddingBottom = '8px';
    parent.appendChild(element);
    document.body.appendChild(parent);
    const term = {
        element,
        dimensions: { css: { cell: { width: 9, height: cellHeight } } },
        buffer: { active: { viewportY: 0, baseY: 0 } },
        cols: 80,
        rows: 24,
    };
    if (cellHeight === null || cellHeight === undefined)
        term.dimensions = undefined;
    const tab = {
        paneId: 't1',
        coder: 'bash',
        directMode: false,
        isDead: false,
        term,
        isAtBottom: undefined,
        lastScrollY: undefined,
    };
    let active = tab;
    const tm = Object.create(TabManager.prototype);
    tm.getActiveTab = () => active;
    tm.isResizing = false;
    tm._queuePanelFit = vi.fn();
    tm.fitActiveTerminal = vi.fn();
    if (!realLifecycle) {
        tm.startResize = vi.fn();
        tm.endResize = vi.fn();
    }
    const prefs = new Map(Object.entries(storage));
    if (realStorage) {
        for (const [key, value] of Object.entries(storage))
            localStorage.setItem(key, value);
    }
    const app = Object.create(App.prototype);
    app._isDraggingDrawer = false;
    app.tabManager = tm;
    if (!realStorage) {
        app.readPanelWidthPreference = vi.fn((key) =>
            prefs.has(key) ? prefs.get(key) : null,
        );
        app.writePanelWidthPreference = vi.fn((key, value) => {
            prefs.set(key, String(value));
        });
    }
    textarea.getBoundingClientRect = () => {
        const stored =
            parseFloat(bar.style.getPropertyValue('--terminal-input-height')) ||
            textareaHeight;
        const liveMin = parseFloat(textarea.style.minHeight) || minimum;
        const liveMax = parseFloat(textarea.style.maxHeight) || maximum;
        const height = Math.max(liveMin, Math.min(liveMax, stored));
        return {
            width: 300,
            height,
            top: 0,
            left: 0,
            right: 300,
            bottom: height,
            x: 0,
            y: 0,
            toJSON() {},
        };
    };
    initResizers(app);
    const handle = document.getElementById('terminal-input-resize-handle');
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    return {
        app,
        tm,
        tab,
        term,
        parent,
        textarea,
        bar,
        handle,
        prefs,
        setActive(next) {
            active = next;
        },
        height() {
            return textarea.getBoundingClientRect().height;
        },
    };
}

function composerPointer(target, type, clientY, options = {}) {
    const event = new PointerEvent(type, {
        clientX: 100,
        clientY,
        pointerId: options.id ?? 1,
        pointerType: 'mouse',
        isPrimary: options.primary ?? true,
        button: options.button ?? 0,
        bubbles: true,
        cancelable: true,
    });
    target.dispatchEvent(event);
    return event;
}

function startComposerDrag(h, options = {}) {
    return composerPointer(h.handle, 'pointerdown', options.y ?? 300, options);
}

function moveComposerDrag(_h, y, options = {}) {
    return composerPointer(document, 'pointermove', y, options);
}

function endComposerDrag(_h, y, options = {}) {
    return composerPointer(document, 'pointerup', y, options);
}

describe('terminal composer height bounds', () => {
    it('zero headroom permits shrinking but not growth', () => {
        const h = composerHarness({ parentHeight: 50, textareaHeight: 120 });
        startComposerDrag(h);
        moveComposerDrag(h, 280);
        expect(h.height()).toBe(120);
        expect(h.tm.fitActiveTerminal).not.toHaveBeenCalled();
        expect(h.app.writePanelWidthPreference).not.toHaveBeenCalled();
        moveComposerDrag(h, 320);
        expect(h.height()).toBe(100);
        expect(h.tm.fitActiveTerminal).toHaveBeenCalledOnce();
        endComposerDrag(h, 320);
    });

    it('a deficit clamps down to the maximum above the minimum', () => {
        const h = composerHarness({ parentHeight: 42, textareaHeight: 120 });
        startComposerDrag(h);
        moveComposerDrag(h, 280);
        expect(h.height()).toBe(112);
        endComposerDrag(h, 280);
    });

    it('rejects ownership when the maximum is below the minimum', () => {
        const h = composerHarness({ parentHeight: 20, textareaHeight: 40 });
        startComposerDrag(h);
        expect(h.tm.startResize).not.toHaveBeenCalled();
        expect(h.handle.classList.contains('dragging')).toBe(false);
        h.parent.style.height = '480px';
        startComposerDrag(h);
        moveComposerDrag(h, 280);
        expect(h.height()).toBe(60);
        endComposerDrag(h, 280);
    });

    it('rejects missing cell metrics and zero geometry', () => {
        const noCell = composerHarness({ cellHeight: null });
        startComposerDrag(noCell);
        expect(noCell.tm.startResize).not.toHaveBeenCalled();
        const zeroPanel = composerHarness({ parentHeight: 0 });
        startComposerDrag(zeroPanel);
        expect(zeroPanel.tm.startResize).not.toHaveBeenCalled();
        const zeroEditor = composerHarness();
        zeroEditor.textarea.getBoundingClientRect = () => ({
            width: 300,
            height: 0,
            top: 0,
            left: 0,
            right: 300,
            bottom: 0,
            x: 0,
            y: 0,
            toJSON() {},
        });
        startComposerDrag(zeroEditor);
        expect(zeroEditor.tm.startResize).not.toHaveBeenCalled();
    });

    it('a throwing pointer capture does not strand the gesture', () => {
        const h = composerHarness({ textareaHeight: 80 });
        h.handle.setPointerCapture = () => {
            throw new Error('capture unavailable');
        };
        startComposerDrag(h);
        moveComposerDrag(h, 320);
        expect(h.height()).toBe(60);
        endComposerDrag(h, 320);
        expect(h.tm.startResize).toHaveBeenCalledOnce();
        expect(h.tm.endResize).toHaveBeenCalledOnce();
    });
});

describe('terminal composer drag ownership and cancellation', () => {
    it('ignores another pointer for move and finish', () => {
        const h = composerHarness({ textareaHeight: 80 });
        startComposerDrag(h, { id: 7 });
        moveComposerDrag(h, 250, { id: 8 });
        expect(h.height()).toBe(80);
        endComposerDrag(h, 250, { id: 8 });
        expect(h.tm.endResize).not.toHaveBeenCalled();
        moveComposerDrag(h, 280, { id: 7 });
        expect(h.height()).toBe(100);
        endComposerDrag(h, 280, { id: 7 });
        expect(h.tm.endResize).toHaveBeenCalledOnce();
    });

    it.each([
        [
            'pointercancel',
            (_h) => composerPointer(document, 'pointercancel', 300, { id: 1 }),
        ],
        [
            'lostpointercapture',
            (h) => h.handle.dispatchEvent(new Event('lostpointercapture')),
        ],
        ['window blur', () => window.dispatchEvent(new Event('blur'))],
        [
            'document hide',
            () => {
                Object.defineProperty(document, 'hidden', {
                    configurable: true,
                    get: () => true,
                });
                document.dispatchEvent(new Event('visibilitychange'));
            },
        ],
    ])('cleans up on %s and permits a later drag', (_name, cancel) => {
        const h = composerHarness({ textareaHeight: 80 });
        try {
            startComposerDrag(h);
            moveComposerDrag(h, 320);
            expect(h.height()).toBe(60);
            cancel(h);
            expect(h.tm.endResize).toHaveBeenCalledOnce();
            expect(h.height()).toBe(60);
            startComposerDrag(h);
            moveComposerDrag(h, 350);
            expect(h.height()).toBe(38);
            endComposerDrag(h, 350);
        } finally {
            Object.defineProperty(document, 'hidden', {
                configurable: true,
                get: () => false,
            });
        }
    });

    it('is idempotent across repeated finish events', () => {
        const h = composerHarness({ textareaHeight: 80 });
        startComposerDrag(h);
        moveComposerDrag(h, 320);
        endComposerDrag(h, 320);
        endComposerDrag(h, 320);
        h.handle.dispatchEvent(new Event('lostpointercapture'));
        expect(h.tm.endResize).toHaveBeenCalledOnce();
    });

    it('finishes when the pane changes or the editor disappears', () => {
        const switched = composerHarness({ textareaHeight: 80 });
        startComposerDrag(switched);
        switched.setActive({ ...switched.tab, paneId: 't2' });
        moveComposerDrag(switched, 280);
        expect(switched.tm.endResize).toHaveBeenCalledOnce();
        expect(switched.height()).toBe(80);

        const folded = composerHarness({ textareaHeight: 80 });
        startComposerDrag(folded);
        folded.textarea.getBoundingClientRect = () => ({
            width: 0,
            height: 0,
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            x: 0,
            y: 0,
            toJSON() {},
        });
        moveComposerDrag(folded, 280);
        expect(folded.tm.endResize).toHaveBeenCalledOnce();
        expect(folded.height()).toBe(0);
    });

    it('real lifecycle hooks clear state and run once', () => {
        const h = composerHarness({
            textareaHeight: 80,
            realLifecycle: true,
        });
        startComposerDrag(h);
        moveComposerDrag(h, 320);
        endComposerDrag(h, 320);
        expect(h.tm.isResizing).toBe(false);
        expect(h.tab.isAtBottom).toBeUndefined();
        expect(h.tab.lastScrollY).toBeUndefined();
        expect(h.tm._queuePanelFit).toHaveBeenCalledOnce();
        expect(h.tm._queuePanelFit).toHaveBeenCalledWith(h.tab, {
            forceResize: true,
        });
        endComposerDrag(h, 320);
        expect(h.tm._queuePanelFit).toHaveBeenCalledOnce();
    });
});

function separatorKey(h, key, options = {}) {
    const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        ...options,
    });
    h.handle.dispatchEvent(event);
    return event;
}

describe('terminal composer separator keys', () => {
    it('steps, homes, and ends without fitting on focus', () => {
        const h = composerHarness({ textareaHeight: 80 });
        h.handle.dispatchEvent(new Event('focus'));
        expect(h.tm.fitActiveTerminal).not.toHaveBeenCalled();
        expect(h.handle.getAttribute('aria-valuenow')).toBe('80');
        expect(h.handle.getAttribute('aria-valuetext')).toBe('80 pixels');

        expect(separatorKey(h, 'ArrowUp').defaultPrevented).toBe(true);
        expect(h.height()).toBe(104);
        expect(h.handle.getAttribute('aria-valuenow')).toBe('104');
        expect(h.tm.startResize).toHaveBeenCalledOnce();
        expect(h.tm.fitActiveTerminal).toHaveBeenCalledOnce();
        expect(h.tm.endResize).toHaveBeenCalledOnce();
        expect(h.app.writePanelWidthPreference).toHaveBeenCalledWith(
            'phi_terminal_input_height',
            104,
        );

        separatorKey(h, 'ArrowDown');
        expect(h.height()).toBe(80);
        separatorKey(h, 'Home');
        expect(h.height()).toBe(38);
        separatorKey(h, 'End');
        expect(h.height()).toBe(160);
    });

    it('rejects an unchanged clamp without starting the lifecycle', () => {
        const h = composerHarness({ textareaHeight: 38 });
        h.tm.startResize.mockClear();
        h.tm.fitActiveTerminal.mockClear();
        h.tm.endResize.mockClear();
        const event = separatorKey(h, 'ArrowDown');
        expect(event.defaultPrevented).toBe(true);
        expect(h.height()).toBe(38);
        expect(h.tm.startResize).not.toHaveBeenCalled();
        expect(h.tm.fitActiveTerminal).not.toHaveBeenCalled();
        expect(h.tm.endResize).not.toHaveBeenCalled();
    });

    it('ignores modifiers, unsupported keys, and non-terminal modes', () => {
        const h = composerHarness({ textareaHeight: 80 });
        separatorKey(h, 'ArrowUp', { ctrlKey: true });
        separatorKey(h, 'Enter');
        expect(h.height()).toBe(80);
        h.bar.classList.remove('terminal-composer');
        separatorKey(h, 'ArrowUp');
        expect(h.height()).toBe(80);
        expect(h.tm.startResize).not.toHaveBeenCalled();
    });

    it('ignores keys while another resize owns the gesture', () => {
        const h = composerHarness({ textareaHeight: 80 });
        startComposerDrag(h);
        separatorKey(h, 'ArrowUp');
        expect(h.height()).toBe(80);
        expect(h.tm.startResize).toHaveBeenCalledOnce();
        endComposerDrag(h, 300);
    });

    it('rechecks bounds before a key change', () => {
        const h = composerHarness({ textareaHeight: 80 });
        h.parent.style.height = '0px';
        separatorKey(h, 'ArrowUp');
        expect(h.height()).toBe(80);
        expect(h.tm.startResize).not.toHaveBeenCalled();
    });

    it('uses real lifecycle hooks for key changes', () => {
        const h = composerHarness({
            textareaHeight: 80,
            realLifecycle: true,
        });
        separatorKey(h, 'ArrowUp');
        expect(h.height()).toBe(104);
        expect(h.tm.isResizing).toBe(false);
        expect(h.tab.isAtBottom).toBeUndefined();
        expect(h.tab.lastScrollY).toBeUndefined();
        expect(h.tm._queuePanelFit).toHaveBeenCalledOnce();
    });
});

describe('terminal composer height preference', () => {
    const key = 'phi_terminal_input_height';

    it('applies a valid stored height and clamps only the rendering', () => {
        const h = composerHarness({
            realStorage: true,
            storage: { [key]: '120' },
            textareaHeight: 80,
            minimum: 36,
            maximum: 80,
        });
        expect(h.bar.style.getPropertyValue('--terminal-input-height')).toBe(
            '120px',
        );
        expect(h.height()).toBe(80);
        expect(localStorage.getItem(key)).toBe('120');
        h.textarea.style.maxHeight = '160px';
        h.parent.style.height = '480px';
        expect(h.height()).toBe(120);
        expect(localStorage.getItem(key)).toBe('120');
    });

    it.each(['', '   ', '0', '-4', 'Infinity', 'NaN', '80px'])(
        'ignores invalid stored value %j',
        (value) => {
            localStorage.clear();
            const h = composerHarness({
                realStorage: true,
                storage: { [key]: value },
            });
            expect(
                h.bar.style.getPropertyValue('--terminal-input-height'),
            ).toBe('');
            expect(h.height()).toBe(40);
        },
    );

    it('persists an accepted pointer height', () => {
        const h = composerHarness({ realStorage: true, textareaHeight: 80 });
        startComposerDrag(h);
        moveComposerDrag(h, 250);
        endComposerDrag(h, 250);
        expect(h.height()).toBe(130);
        expect(localStorage.getItem(key)).toBe('130');
    });

    it('keeps resizing when the localStorage getter is blocked', () => {
        const descriptor = Object.getOwnPropertyDescriptor(
            window,
            'localStorage',
        );
        Object.defineProperty(window, 'localStorage', {
            configurable: true,
            get() {
                throw new Error('blocked');
            },
        });
        try {
            const h = composerHarness({
                realStorage: true,
                textareaHeight: 80,
            });
            startComposerDrag(h);
            moveComposerDrag(h, 250);
            endComposerDrag(h, 250);
            expect(h.height()).toBe(130);
            expect(h.app.readPanelWidthPreference(key)).toBe('130');
        } finally {
            if (descriptor)
                Object.defineProperty(window, 'localStorage', descriptor);
            else delete window.localStorage;
        }
    });

    it('keeps resizing when getItem throws', () => {
        const getItem = vi
            .spyOn(Storage.prototype, 'getItem')
            .mockImplementation(() => {
                throw new Error('read blocked');
            });
        try {
            const h = composerHarness({
                realStorage: true,
                textareaHeight: 80,
            });
            startComposerDrag(h);
            moveComposerDrag(h, 250);
            endComposerDrag(h, 250);
            expect(h.height()).toBe(130);
        } finally {
            getItem.mockRestore();
        }
    });

    it('keeps the accepted height in memory when setItem throws', () => {
        const setItem = vi
            .spyOn(Storage.prototype, 'setItem')
            .mockImplementation(() => {
                throw new Error('write blocked');
            });
        try {
            const h = composerHarness({
                realStorage: true,
                textareaHeight: 80,
            });
            startComposerDrag(h);
            moveComposerDrag(h, 250);
            endComposerDrag(h, 250);
            expect(h.height()).toBe(130);
            expect(h.app.readPanelWidthPreference(key)).toBe('130');
            startComposerDrag(h);
            moveComposerDrag(h, 320);
            endComposerDrag(h, 320);
            expect(h.height()).toBe(110);
            expect(h.app.readPanelWidthPreference(key)).toBe('110');
        } finally {
            setItem.mockRestore();
        }
    });
});
