// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { App } from '../web/app.js';
import { DiffController } from '../web/diff.js';
import { SIDEBAR_PANEL_CAP, DIFF_PANEL_CAP } from '../web/util.js';

setupDomHarness();

const trackedResizeListeners = new Set();
const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
const originalHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
afterEach(() => {
    for (const listener of trackedResizeListeners) {
        window.removeEventListener('resize', listener);
    }
    trackedResizeListeners.clear();
    if (vi.isFakeTimers()) vi.clearAllTimers();
    vi.useRealTimers();
    Object.defineProperty(window, 'innerWidth', originalWidth);
    Object.defineProperty(window, 'innerHeight', originalHeight);
});

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

function dispatchPointer(target, type, clientX, options = {}) {
    const event = new PointerEvent(type, {
        clientX,
        pointerId: options.pointerId ?? 1,
        pointerType: options.pointerType ?? 'mouse',
        isPrimary: options.isPrimary ?? true,
        button: options.button ?? 0,
        bubbles: true,
        cancelable: true,
    });
    target.dispatchEvent(event);
    return event;
}

function setRenderedPanelRects() {
    const sidebar = document.getElementById('sidebar-panel');
    const diffPanel = document.getElementById('diff-panel');
    for (const [panel, fallback] of [
        [sidebar, 260],
        [diffPanel, 340],
    ]) {
        Object.defineProperty(panel, 'getBoundingClientRect', {
            configurable: true,
            value: () => {
                const width =
                    parseFloat(panel.style.getPropertyValue('width')) ||
                    fallback;
                return {
                    width,
                    left: 0,
                    right: width,
                    top: 0,
                    bottom: 900,
                    height: 900,
                };
            },
        });
    }
}

function makeApp() {
    const a = Object.create(App.prototype);
    a.tabManager = {
        startResize: vi.fn(),
        endResize: vi.fn(),
        fitActiveTerminal: vi.fn(),
    };
    a.diffController = {
        fitTerminal: vi.fn(),
    };
    a.markdownManager = { openDiagModal: vi.fn() };
    a._isDraggingDrawer = false;
    return a;
}

describe('Panel resize methods and shortcuts', () => {
    let sidebar;
    let diffPanel;

    beforeEach(() => {
        document.body.innerHTML = `
            <div class="main-layout">
                <aside id="sidebar-panel" style="width: 260px;"></aside>
                <div id="left-resize-handle" class="resize-handle"></div>
                <main class="terminal-panel"></main>
                <div id="right-resize-handle" class="resize-handle"></div>
                <aside id="diff-panel" style="width: 340px;"></aside>
            </div>
        `;
        sidebar = document.getElementById('sidebar-panel');
        diffPanel = document.getElementById('diff-panel');
        // Give window a wide desktop width in jsdom for 25vw caps
        Object.defineProperty(window, 'innerWidth', {
            writable: true,
            configurable: true,
            value: 3000,
        });
        Object.defineProperty(window, 'innerHeight', {
            writable: true,
            configurable: true,
            value: 900,
        });
    });

    describe('adjustLeftPanelWidth', () => {
        it('widens the left sidebar panel by step', () => {
            const app = makeApp();
            app.adjustLeftPanelWidth(24);

            expect(sidebar.style.width).toBe('284px');
            expect(localStorage.getItem('phi_panel_left_width')).toBe('284');
            expect(app.tabManager.startResize).toHaveBeenCalled();
            expect(app.tabManager.fitActiveTerminal).toHaveBeenCalled();
            expect(app.tabManager.endResize).toHaveBeenCalled();
        });

        it('thins the left sidebar panel by step', () => {
            const app = makeApp();
            app.adjustLeftPanelWidth(-24);

            expect(sidebar.style.width).toBe('236px');
            expect(localStorage.getItem('phi_panel_left_width')).toBe('236');
        });

        it('clamps within SIDEBAR_PANEL_CAP min and max', () => {
            const app = makeApp();
            // Try to shrink way below min
            app.adjustLeftPanelWidth(-500);
            expect(sidebar.style.width).toBe(`${SIDEBAR_PANEL_CAP.min}px`);

            // Try to expand way above max
            app.adjustLeftPanelWidth(1000);
            expect(sidebar.style.width).toBe(`${SIDEBAR_PANEL_CAP.max}px`);
        });

        it('toggles sidebar-narrow class when under 120px', () => {
            const app = makeApp();
            app.adjustLeftPanelWidth(-180); // 260 - 180 = 80px (< 120)
            expect(sidebar.classList.contains('sidebar-narrow')).toBe(true);

            app.adjustLeftPanelWidth(100); // 80 + 100 = 180px (>= 120)
            expect(sidebar.classList.contains('sidebar-narrow')).toBe(false);
        });
    });

    describe('adjustRightPanelWidth', () => {
        it('widens the diff/cmd panel by step', () => {
            const app = makeApp();
            app.adjustRightPanelWidth(24);

            expect(diffPanel.style.width).toBe('364px');
            expect(localStorage.getItem('phi_panel_right_width')).toBe('364');
            expect(app.tabManager.startResize).toHaveBeenCalled();
            expect(app.tabManager.fitActiveTerminal).toHaveBeenCalled();
            expect(app.diffController.fitTerminal).toHaveBeenCalled();
            expect(app.tabManager.endResize).toHaveBeenCalled();
        });

        it('thins the diff/cmd panel by step', () => {
            const app = makeApp();
            app.adjustRightPanelWidth(-24);

            expect(diffPanel.style.width).toBe('316px');
            expect(localStorage.getItem('phi_panel_right_width')).toBe('316');
        });

        it('clamps within DIFF_PANEL_CAP min and max', () => {
            const app = makeApp();
            app.adjustRightPanelWidth(-500);
            expect(diffPanel.style.width).toBe(`${DIFF_PANEL_CAP.min}px`);

            app.adjustRightPanelWidth(1000);
            expect(diffPanel.style.width).toBe(`${DIFF_PANEL_CAP.max}px`);
        });
    });

    describe('handlePanelResizeShortcut', () => {
        it('narrows left panel on Ctrl+Alt+[', () => {
            const app = makeApp();
            const evt = new KeyboardEvent('keydown', {
                key: '[',
                code: 'BracketLeft',
                ctrlKey: true,
                altKey: true,
                cancelable: true,
            });
            const handled = app.handlePanelResizeShortcut(evt);

            expect(handled).toBe(true);
            expect(evt.defaultPrevented).toBe(true);
            expect(sidebar.style.width).toBe('236px');
        });

        it('widens left panel on Ctrl+Alt+]', () => {
            const app = makeApp();
            const evt = new KeyboardEvent('keydown', {
                key: ']',
                code: 'BracketRight',
                ctrlKey: true,
                altKey: true,
                cancelable: true,
            });
            const handled = app.handlePanelResizeShortcut(evt);

            expect(handled).toBe(true);
            expect(evt.defaultPrevented).toBe(true);
            expect(sidebar.style.width).toBe('284px');
        });

        it('narrows right panel on Ctrl+Alt+-', () => {
            const app = makeApp();
            const evt = new KeyboardEvent('keydown', {
                key: '-',
                code: 'Minus',
                ctrlKey: true,
                altKey: true,
                cancelable: true,
            });
            const handled = app.handlePanelResizeShortcut(evt);

            expect(handled).toBe(true);
            expect(evt.defaultPrevented).toBe(true);
            expect(diffPanel.style.width).toBe('316px');
        });

        it('widens right panel on Ctrl+Alt+=', () => {
            const app = makeApp();
            const evt = new KeyboardEvent('keydown', {
                key: '=',
                code: 'Equal',
                ctrlKey: true,
                altKey: true,
                cancelable: true,
            });
            const handled = app.handlePanelResizeShortcut(evt);

            expect(handled).toBe(true);
            expect(evt.defaultPrevented).toBe(true);
            expect(diffPanel.style.width).toBe('364px');
        });

        it('handles Shift chords (Ctrl+Alt+Shift+[ -> { etc)', () => {
            const app = makeApp();
            const evt = new KeyboardEvent('keydown', {
                key: '{',
                code: 'BracketLeft',
                ctrlKey: true,
                altKey: true,
                shiftKey: true,
                cancelable: true,
            });
            const handled = app.handlePanelResizeShortcut(evt);

            expect(handled).toBe(true);
            expect(evt.defaultPrevented).toBe(true);
            expect(sidebar.style.width).toBe('236px');
        });

        it('does not fire if metaKey (Cmd) is pressed', () => {
            const app = makeApp();
            const evt = new KeyboardEvent('keydown', {
                key: ']',
                code: 'BracketRight',
                ctrlKey: true,
                altKey: true,
                metaKey: true,
                cancelable: true,
            });
            const handled = app.handlePanelResizeShortcut(evt);

            expect(handled).toBe(false);
            expect(evt.defaultPrevented).toBe(false);
            expect(sidebar.style.width).toBe('260px');
        });

        it('does not fire without both ctrlKey and altKey', () => {
            const app = makeApp();
            const evt1 = new KeyboardEvent('keydown', {
                key: ']',
                code: 'BracketRight',
                ctrlKey: true,
                altKey: false,
                cancelable: true,
            });
            expect(app.handlePanelResizeShortcut(evt1)).toBe(false);

            const evt2 = new KeyboardEvent('keydown', {
                key: ']',
                code: 'BracketRight',
                ctrlKey: false,
                altKey: true,
                cancelable: true,
            });
            expect(app.handlePanelResizeShortcut(evt2)).toBe(false);
        });

        it('ignores already prevented events', () => {
            const app = makeApp();
            const evt = new KeyboardEvent('keydown', {
                key: ']',
                code: 'BracketRight',
                ctrlKey: true,
                altKey: true,
                cancelable: true,
            });
            evt.preventDefault();
            expect(app.handlePanelResizeShortcut(evt)).toBe(false);
            expect(sidebar.style.width).toBe('260px');
        });
    });

    describe('document global shortcut integration', () => {
        it('responds to document-level keydown events', () => {
            const app = makeApp();
            app.initGlobalShortcuts();

            document.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: ']',
                    code: 'BracketRight',
                    ctrlKey: true,
                    altKey: true,
                    bubbles: true,
                    cancelable: true,
                }),
            );

            expect(sidebar.style.width).toBe('284px');
        });

        it('respects proportional 25vw cap on narrower screens', () => {
            const app = makeApp();
            window.innerWidth = 1200; // 25vw = 300px
            app.adjustLeftPanelWidth(1000);
            expect(sidebar.style.width).toBe('300px');
        });

        it('is wired into terminal attachCustomKeyEventHandler', async () => {
            const { readFileSync } = await import('node:fs');
            const termSrc = readFileSync('web/terminal.js', 'utf8');
            expect(termSrc).toContain('handlePanelResizeShortcut');
        });
    });

    describe('desktop pointer resizing', () => {
        it.each([
            {
                handleId: 'left-resize-handle',
                panel: () => sidebar,
                preference: 'phi_panel_left_width',
                expectedDelta: (delta) => delta,
            },
            {
                handleId: 'right-resize-handle',
                panel: () => diffPanel,
                preference: 'phi_panel_right_width',
                expectedDelta: (delta) => -delta,
            },
        ])(
            '$handleId follows pointer movement from both target edges',
            ({ handleId, panel, preference, expectedDelta }) => {
                setRenderedPanelRects();
                const app = makeApp();
                initResizers(app);
                const handle = document.getElementById(handleId);
                const targetPanel = panel();
                let pointerId = 10;

                for (const startX of [1, 23]) {
                    for (const delta of [-10, 10]) {
                        const before =
                            targetPanel.getBoundingClientRect().width;
                        const actualPointerId = pointerId++;
                        try {
                            dispatchPointer(handle, 'pointerdown', startX, {
                                pointerId: actualPointerId,
                            });
                            dispatchPointer(
                                document,
                                'pointermove',
                                startX + delta,
                                { pointerId: actualPointerId },
                            );
                            expect(
                                targetPanel.getBoundingClientRect().width -
                                    before,
                            ).toBe(expectedDelta(delta));
                            expect(localStorage.getItem(preference)).toBe(
                                String(before + expectedDelta(delta)),
                            );
                        } finally {
                            dispatchPointer(
                                document,
                                'pointerup',
                                startX + delta,
                                { pointerId: actualPointerId },
                            );
                        }
                    }
                }
            },
        );

        it('ignores other pointers and rejects non-primary or non-left starts', () => {
            setRenderedPanelRects();
            const app = makeApp();
            initResizers(app);
            const left = document.getElementById('left-resize-handle');
            const right = document.getElementById('right-resize-handle');

            const secondary = dispatchPointer(left, 'pointerdown', 12, {
                pointerId: 1,
                isPrimary: false,
            });
            const rightButton = dispatchPointer(left, 'pointerdown', 12, {
                pointerId: 2,
                button: 2,
            });
            expect(secondary.defaultPrevented).toBe(false);
            expect(rightButton.defaultPrevented).toBe(false);
            expect(left.classList.contains('dragging')).toBe(false);
            expect(app.tabManager.startResize).not.toHaveBeenCalled();

            dispatchPointer(left, 'pointerdown', 12, { pointerId: 3 });
            try {
                dispatchPointer(document, 'pointermove', 32, { pointerId: 4 });
                dispatchPointer(document, 'pointerup', 32, { pointerId: 4 });
                dispatchPointer(right, 'pointerdown', 100, { pointerId: 5 });
                expect(sidebar.getBoundingClientRect().width).toBe(260);
                expect(diffPanel.getBoundingClientRect().width).toBe(340);
                expect(left.classList.contains('dragging')).toBe(true);
                expect(right.classList.contains('dragging')).toBe(false);
                dispatchPointer(document, 'pointermove', 22, { pointerId: 3 });
                expect(sidebar.style.width).toBe('270px');
            } finally {
                dispatchPointer(document, 'pointerup', 22, { pointerId: 3 });
            }
            expect(left.classList.contains('dragging')).toBe(false);
            expect(app.tabManager.startResize).toHaveBeenCalledTimes(1);
            expect(app.tabManager.endResize).toHaveBeenCalledTimes(1);
        });

        it('does not persist widths at the strict docked limits', () => {
            setRenderedPanelRects();
            const app = makeApp();
            initResizers(app);
            const left = document.getElementById('left-resize-handle');

            for (const delta of [-201, 190]) {
                const pointerId = 20 - delta;
                try {
                    dispatchPointer(left, 'pointerdown', 100, { pointerId });
                    dispatchPointer(document, 'pointermove', 100 + delta, {
                        pointerId,
                    });
                    expect(sidebar.getBoundingClientRect().width).toBe(260);
                    expect(localStorage.getItem('phi_panel_left_width')).toBe(
                        null,
                    );
                } finally {
                    dispatchPointer(document, 'pointerup', 100 + delta, {
                        pointerId,
                    });
                }
            }
        });

        it.each([
            ['left-resize-handle', () => sidebar, 260],
            ['right-resize-handle', () => diffPanel, 340],
        ])(
            '%s cleans up pointer cancellation and capture',
            (id, getPanel, width) => {
                setRenderedPanelRects();
                const app = makeApp();
                initResizers(app);
                const handle = document.getElementById(id);
                handle.setPointerCapture = vi.fn();
                handle.releasePointerCapture = vi.fn();
                try {
                    dispatchPointer(handle, 'pointerdown', 50, {
                        pointerId: 51,
                    });
                    dispatchPointer(document, 'pointercancel', 50, {
                        pointerId: 52,
                    });
                    expect(handle.classList.contains('dragging')).toBe(true);
                    dispatchPointer(document, 'pointercancel', 50, {
                        pointerId: 51,
                    });
                    expect(handle.classList.contains('dragging')).toBe(false);
                    expect(handle.releasePointerCapture).toHaveBeenCalledWith(
                        51,
                    );
                    expect(app.tabManager.endResize).toHaveBeenCalled();
                    expect(getPanel().getBoundingClientRect().width).toBe(
                        width,
                    );
                } finally {
                    dispatchPointer(document, 'pointercancel', 50, {
                        pointerId: 51,
                    });
                }
            },
        );

        it('keeps resizing and accepted width in memory when storage fails', () => {
            setRenderedPanelRects();
            const app = makeApp();
            vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
                throw new DOMException('denied', 'SecurityError');
            });
            vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
                throw new DOMException('quota', 'QuotaExceededError');
            });

            expect(() => initResizers(app)).not.toThrow();
            const left = document.getElementById('left-resize-handle');
            try {
                dispatchPointer(left, 'pointerdown', 12, { pointerId: 30 });
                dispatchPointer(document, 'pointermove', 22, { pointerId: 30 });
                expect(sidebar.style.width).toBe('270px');
                expect(app.tabManager.fitActiveTerminal).toHaveBeenCalled();
                dispatchPointer(document, 'pointerup', 22, { pointerId: 30 });

                window.dispatchEvent(new Event('resize'));
                expect(sidebar.style.width).toBe('270px');
            } finally {
                if (left.classList.contains('dragging')) {
                    dispatchPointer(document, 'pointerup', 22, {
                        pointerId: 30,
                    });
                }
            }
        });
    });

    describe('storage and pointer fallbacks', () => {
        it('keeps handlers usable when the localStorage accessor is denied', () => {
            setRenderedPanelRects();
            const descriptor = Object.getOwnPropertyDescriptor(
                window,
                'localStorage',
            );
            Object.defineProperty(window, 'localStorage', {
                configurable: true,
                get() {
                    throw new DOMException('denied', 'SecurityError');
                },
            });
            const app = makeApp();
            const handle = document.getElementById('left-resize-handle');
            try {
                expect(() => initResizers(app)).not.toThrow();
                dispatchPointer(handle, 'pointerdown', 12);
                dispatchPointer(document, 'pointermove', 22);
                expect(sidebar.style.width).toBe('270px');
                expect(
                    app.readPanelWidthPreference('phi_panel_left_width'),
                ).toBe('270');
            } finally {
                dispatchPointer(document, 'pointerup', 22);
                Object.defineProperty(window, 'localStorage', descriptor);
            }
            expect(app.tabManager.endResize).toHaveBeenCalled();
        });

        it('restores separate topology preferences after failed writes and viewport changes', () => {
            window.innerWidth = 1440;
            setRenderedPanelRects();
            localStorage.setItem('phi_panel_left_width', '280');
            localStorage.setItem('phi_panel_right_width', '320');
            localStorage.setItem('phi_drawer_left_width', '300');
            localStorage.setItem('phi_drawer_right_width', '310');
            const app = makeApp();
            initResizers(app);
            const save = vi
                .spyOn(Storage.prototype, 'setItem')
                .mockImplementation(() => {
                    throw new DOMException('quota', 'QuotaExceededError');
                });
            try {
                app.adjustLeftPanelWidth(10);
                app.adjustRightPanelWidth(10);
                window.dispatchEvent(new Event('resize'));
                expect(sidebar.style.width).toBe('290px');
                expect(diffPanel.style.width).toBe('330px');
                window.innerWidth = 390;
                window.dispatchEvent(new Event('resize'));
                expect(sidebar.style.width).toBe('300px');
                expect(diffPanel.style.width).toBe('310px');
                app.adjustLeftPanelWidth(10);
                app.adjustRightPanelWidth(10);
                window.dispatchEvent(new Event('resize'));
                expect(sidebar.style.width).toBe('310px');
                expect(diffPanel.style.width).toBe('320px');
                window.innerWidth = 1440;
                window.dispatchEvent(new Event('resize'));
                expect(sidebar.style.width).toBe('290px');
                expect(diffPanel.style.width).toBe('330px');
                window.innerWidth = 250;
                window.dispatchEvent(new Event('resize'));
                expect(sidebar.style.width).toBe('226px');
                expect(diffPanel.style.width).toBe('226px');
                window.innerWidth = 390;
                window.dispatchEvent(new Event('resize'));
                expect(sidebar.style.width).toBe('310px');
                expect(diffPanel.style.width).toBe('320px');
            } finally {
                save.mockRestore();
            }
        });

        it('uses mouse events without pointer-only fields in the fallback', () => {
            const descriptor = Object.getOwnPropertyDescriptor(
                window,
                'PointerEvent',
            );
            delete window.PointerEvent;
            setRenderedPanelRects();
            const app = makeApp();
            try {
                initResizers(app);
                const handle = document.getElementById('right-resize-handle');
                handle.dispatchEvent(
                    new MouseEvent('mousedown', { button: 2, clientX: 100 }),
                );
                expect(app.tabManager.startResize).not.toHaveBeenCalled();
                handle.dispatchEvent(
                    new MouseEvent('mousedown', { button: 0, clientX: 100 }),
                );
                document.dispatchEvent(
                    new MouseEvent('mousemove', { clientX: 90 }),
                );
                expect(diffPanel.style.width).toBe('350px');
                document.dispatchEvent(
                    new MouseEvent('mouseup', { clientX: 90 }),
                );
                expect(handle.classList.contains('dragging')).toBe(false);
                expect(app.tabManager.endResize).toHaveBeenCalled();
            } finally {
                document.dispatchEvent(
                    new MouseEvent('mouseup', { clientX: 90 }),
                );
                if (descriptor)
                    Object.defineProperty(window, 'PointerEvent', descriptor);
            }
        });
    });

    describe('drawer gesture ownership and cancellation', () => {
        beforeEach(() => {
            window.innerWidth = 800;
            sidebar.style.width = '280px';
            diffPanel.style.width = '320px';
            sidebar.classList.add('drawer-open');
            diffPanel.classList.add('mobile-open');
            setRenderedPanelRects();
        });

        it.each([
            ['left', 'sidebar-drawer-resizer', 'phi_drawer_left_width', 280],
            ['right', 'diff-drawer-resizer', 'phi_drawer_right_width', 480],
        ])(
            '%s drawer follows both directions and clamps accepted widths',
            (side, id, key, start) => {
                const app = makeApp();
                initResizers(app);
                const panel = side === 'left' ? sidebar : diffPanel;
                const handle = document.getElementById(id);
                const sign = side === 'left' ? 1 : -1;
                for (const offset of [-10, 10]) {
                    for (const delta of [-10, 10]) {
                        const before = panel.getBoundingClientRect().width;
                        try {
                            dispatchPointer(
                                handle,
                                'pointerdown',
                                start + offset,
                            );
                            dispatchPointer(
                                document,
                                'pointermove',
                                start + offset + delta,
                            );
                            expect(panel.getBoundingClientRect().width).toBe(
                                before + sign * delta,
                            );
                            expect(localStorage.getItem(key)).toBe(
                                String(before + sign * delta),
                            );
                        } finally {
                            dispatchPointer(
                                document,
                                'pointerup',
                                start + offset + delta,
                            );
                        }
                    }
                }
                const maxMove = side === 'left' ? 1200 : -1200;
                try {
                    dispatchPointer(handle, 'pointerdown', start);
                    dispatchPointer(document, 'pointermove', start + maxMove);
                    expect(panel.getBoundingClientRect().width).toBe(776);
                    expect(localStorage.getItem(key)).toBe('776');
                } finally {
                    dispatchPointer(document, 'pointerup', start + maxMove);
                }
            },
        );

        it.each([
            [
                'left',
                'sidebar-drawer-resizer',
                'phi_drawer_left_width',
                280,
                290,
            ],
            [
                'right',
                'diff-drawer-resizer',
                'phi_drawer_right_width',
                480,
                470,
            ],
        ])(
            '%s drawer retains accepted widths when persistence fails',
            (side, id, key, start, move) => {
                const app = makeApp();
                initResizers(app);
                const handle = document.getElementById(id);
                const panel = side === 'left' ? sidebar : diffPanel;
                const save = vi
                    .spyOn(Storage.prototype, 'setItem')
                    .mockImplementation(() => {
                        throw new DOMException('quota', 'QuotaExceededError');
                    });
                try {
                    const expected = panel.getBoundingClientRect().width + 10;
                    dispatchPointer(handle, 'pointerdown', start);
                    dispatchPointer(document, 'pointermove', move);
                    dispatchPointer(document, 'pointerup', move);
                    expect(panel.getBoundingClientRect().width).toBe(expected);
                    expect(app.readPanelWidthPreference(key)).toBe(
                        String(expected),
                    );
                    window.dispatchEvent(new Event('resize'));
                    expect(panel.getBoundingClientRect().width).toBe(expected);
                    expect(handle.classList.contains('dragging')).toBe(false);
                } finally {
                    dispatchPointer(document, 'pointercancel', move);
                    save.mockRestore();
                }
            },
        );

        it.each([
            [
                'left',
                'sidebar-drawer-resizer',
                'phi_drawer_left_width',
                280,
                80,
                290,
            ],
            [
                'right',
                'diff-drawer-resizer',
                'phi_drawer_right_width',
                480,
                700,
                330,
            ],
        ])(
            '%s drawer retains accepted width and ignores other pointers on cancel',
            (side, id, key, start, preview, accepted) => {
                const app = makeApp();
                initResizers(app);
                const handle = document.getElementById(id);
                const panel = side === 'left' ? sidebar : diffPanel;
                handle.setPointerCapture = vi.fn();
                handle.releasePointerCapture = vi.fn();
                const move = side === 'left' ? start + 10 : start - 10;
                try {
                    dispatchPointer(handle, 'pointerdown', start, {
                        pointerId: 41,
                    });
                    dispatchPointer(document, 'pointermove', preview, {
                        pointerId: 42,
                    });
                    dispatchPointer(document, 'pointercancel', preview, {
                        pointerId: 42,
                    });
                    expect(handle.classList.contains('dragging')).toBe(true);
                    expect(panel.getBoundingClientRect().width).toBe(
                        side === 'left' ? 280 : 320,
                    );
                    dispatchPointer(document, 'pointermove', move, {
                        pointerId: 41,
                    });
                    expect(panel.getBoundingClientRect().width).toBe(accepted);
                    expect(localStorage.getItem(key)).toBe(String(accepted));
                    dispatchPointer(document, 'pointermove', preview, {
                        pointerId: 41,
                    });
                    expect(localStorage.getItem(key)).toBe(String(accepted));
                    dispatchPointer(document, 'pointercancel', preview, {
                        pointerId: 41,
                    });
                    expect(panel.getBoundingClientRect().width).toBe(accepted);
                    expect(localStorage.getItem(key)).toBe(String(accepted));
                    expect(
                        panel.classList.contains(
                            side === 'left' ? 'drawer-open' : 'mobile-open',
                        ),
                    ).toBe(true);
                    expect(handle.classList.contains('dragging')).toBe(false);
                    expect(panel.classList.contains('resizing')).toBe(false);
                    expect(handle.setPointerCapture).toHaveBeenCalledWith(41);
                    expect(handle.releasePointerCapture).toHaveBeenCalledWith(
                        41,
                    );
                } finally {
                    dispatchPointer(document, 'pointercancel', preview, {
                        pointerId: 41,
                    });
                }
            },
        );

        it.each([
            [
                'left',
                'sidebar-drawer-resizer',
                'phi_drawer_left_width',
                280,
                80,
                280,
            ],
            [
                'right',
                'diff-drawer-resizer',
                'phi_drawer_right_width',
                480,
                700,
                320,
            ],
        ])(
            '%s cancel before an accepted move does not save a preview',
            (side, id, key, start, preview, width) => {
                const app = makeApp();
                initResizers(app);
                const handle = document.getElementById(id);
                const panel = side === 'left' ? sidebar : diffPanel;
                try {
                    dispatchPointer(handle, 'pointerdown', start);
                    dispatchPointer(document, 'pointermove', preview);
                    dispatchPointer(document, 'pointercancel', preview);
                    expect(panel.getBoundingClientRect().width).toBe(width);
                    expect(localStorage.getItem(key)).toBeNull();
                    expect(
                        panel.classList.contains(
                            side === 'left' ? 'drawer-open' : 'mobile-open',
                        ),
                    ).toBe(true);
                    expect(handle.classList.contains('dragging')).toBe(false);
                } finally {
                    dispatchPointer(document, 'pointercancel', preview);
                }
            },
        );

        it.each([
            ['left', 99, true],
            ['left', 100, false],
            ['right', 681, true],
            ['right', 680, false],
        ])('%s release at %i has dismissal=%s', (side, end, dismiss) => {
            const app = makeApp();
            app.diffController.togglePanel = vi.fn(() =>
                diffPanel.classList.remove('mobile-open'),
            );
            initResizers(app);
            const id =
                side === 'left'
                    ? 'sidebar-drawer-resizer'
                    : 'diff-drawer-resizer';
            const handle = document.getElementById(id);
            const panel = side === 'left' ? sidebar : diffPanel;
            try {
                dispatchPointer(
                    handle,
                    'pointerdown',
                    side === 'left' ? 280 : 480,
                );
                dispatchPointer(document, 'pointermove', end);
                dispatchPointer(document, 'pointerup', end);
                expect(
                    panel.classList.contains(
                        side === 'left' ? 'drawer-open' : 'mobile-open',
                    ),
                ).toBe(!dismiss);
                expect(handle.classList.contains('dragging')).toBe(false);
            } finally {
                dispatchPointer(document, 'pointerup', end);
            }
        });

        it.each(['sidebar-drawer-resizer', 'diff-drawer-resizer'])(
            'old suppression timer cannot clear a new drag on %s',
            (nextId) => {
                vi.useFakeTimers();
                const app = makeApp();
                initResizers(app);
                const first = document.getElementById('sidebar-drawer-resizer');
                const next = document.getElementById(nextId);
                try {
                    dispatchPointer(first, 'pointerdown', 280, {
                        pointerId: 1,
                    });
                    dispatchPointer(document, 'pointerup', 280, {
                        pointerId: 1,
                    });
                    vi.advanceTimersByTime(49);
                    dispatchPointer(next, 'pointerdown', 480, { pointerId: 2 });
                    vi.advanceTimersByTime(2);
                    expect(app._isDraggingDrawer).toBe(true);
                    dispatchPointer(document, 'pointerup', 480, {
                        pointerId: 2,
                    });
                    vi.advanceTimersByTime(49);
                    expect(app._isDraggingDrawer).toBe(true);
                    vi.advanceTimersByTime(1);
                    expect(app._isDraggingDrawer).toBe(false);
                } finally {
                    dispatchPointer(document, 'pointercancel', 480, {
                        pointerId: 2,
                    });
                }
            },
        );

        it('dismisses through the real Diff controller even when storage fails', () => {
            vi.useFakeTimers();
            const app = makeApp();
            const controller = Object.create(DiffController.prototype);
            controller.app = app;
            controller.diffPanel = diffPanel;
            controller.headerDiffToggleBtn = document.createElement('button');
            controller.currentWs = { close: vi.fn() };
            controller.fitTerminal = vi.fn();
            controller.refreshDiff = vi.fn();
            app.diffController = controller;
            controller.togglePanel(true);
            expect(localStorage.getItem('phi_diff_panel_open')).toBe('true');
            const socket = controller.currentWs;
            initResizers(app);
            const handle = document.getElementById('diff-drawer-resizer');
            const save = vi
                .spyOn(Storage.prototype, 'setItem')
                .mockImplementation(() => {
                    throw new DOMException('quota', 'QuotaExceededError');
                });
            try {
                dispatchPointer(handle, 'pointerdown', 480);
                dispatchPointer(document, 'pointermove', 470);
                dispatchPointer(document, 'pointermove', 700);
                dispatchPointer(document, 'pointerup', 700);
                expect(controller.isPanelOpen).toBe(false);
                expect(diffPanel.classList.contains('hidden')).toBe(true);
                expect(diffPanel.classList.contains('mobile-open')).toBe(false);
                expect(socket.close).toHaveBeenCalledOnce();
                expect(controller.currentWs).toBeNull();
                expect(diffPanel.style.width).toBe('330px');
                expect(handle.classList.contains('dragging')).toBe(false);
                vi.advanceTimersByTime(150);
                expect(app._isDraggingDrawer).toBe(false);
                expect(app.tabManager.fitActiveTerminal).toHaveBeenCalled();
            } finally {
                dispatchPointer(document, 'pointercancel', 700);
                save.mockRestore();
            }
            controller.togglePanel(true);
            controller.togglePanel(false);
            expect(localStorage.getItem('phi_diff_panel_open')).toBe('false');
        });
    });

    describe('mobile drawer touch-drag and shortcut resizing', () => {
        beforeEach(() => {
            window.innerWidth = 800; // Drawer mode (< 1024px)
        });

        it('adjusts mobile drawer width with !important and saves preference', () => {
            const app = makeApp();
            app.adjustLeftPanelWidth(40);

            expect(sidebar.style.getPropertyValue('width')).toBe('300px');
            expect(sidebar.style.getPropertyPriority('width')).toBe(
                'important',
            );
            expect(localStorage.getItem('phi_drawer_left_width')).toBe('300');
        });

        it('adjusts diff drawer width with !important on mobile', () => {
            const app = makeApp();
            app.adjustRightPanelWidth(50);

            expect(diffPanel.style.getPropertyValue('width')).toBe('390px');
            expect(diffPanel.style.getPropertyPriority('width')).toBe(
                'important',
            );
            expect(localStorage.getItem('phi_drawer_right_width')).toBe('390');
        });

        it('creates drawer touch resize handles in initResizers and updates width on drag', () => {
            sidebar.style.setProperty('width', '280px', 'important');
            sidebar.classList.add('drawer-open');
            setRenderedPanelRects();
            const app = makeApp();
            initResizers(app);

            const leftDrawerResizer = document.getElementById(
                'sidebar-drawer-resizer',
            );
            const rightDrawerResizer = document.getElementById(
                'diff-drawer-resizer',
            );
            expect(leftDrawerResizer).toBeTruthy();
            expect(rightDrawerResizer).toBeTruthy();

            // Simulate a primary-pointer drag on the left drawer handle.
            dispatchPointer(leftDrawerResizer, 'pointerdown', 280);
            expect(app._isDraggingDrawer).toBe(true);

            dispatchPointer(document, 'pointermove', 350);

            expect(sidebar.style.getPropertyValue('width')).toBe('350px');
            expect(sidebar.style.getPropertyPriority('width')).toBe(
                'important',
            );
            expect(localStorage.getItem('phi_drawer_left_width')).toBe('350');

            dispatchPointer(document, 'pointerup', 350);
        });

        it('dismisses left drawer when dragged left below dismiss threshold', () => {
            sidebar.style.setProperty('width', '280px', 'important');
            sidebar.classList.add('drawer-open');
            setRenderedPanelRects();
            const app = makeApp();
            initResizers(app);

            const leftDrawerResizer = document.getElementById(
                'sidebar-drawer-resizer',
            );

            dispatchPointer(leftDrawerResizer, 'pointerdown', 280);
            dispatchPointer(document, 'pointerup', 80); // < 100px threshold

            expect(sidebar.classList.contains('drawer-open')).toBe(false);
        });
    });
});
