// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { App } from '../web/app.js';
import { SIDEBAR_PANEL_CAP, DIFF_PANEL_CAP } from '../web/util.js';

setupDomHarness();

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
            const app = makeApp();
            app.initResizers();

            const leftDrawerResizer = document.getElementById(
                'sidebar-drawer-resizer',
            );
            const rightDrawerResizer = document.getElementById(
                'diff-drawer-resizer',
            );
            expect(leftDrawerResizer).toBeTruthy();
            expect(rightDrawerResizer).toBeTruthy();

            // Simulate pointer/touch drag on left drawer handle
            const pointerDownEvt = new PointerEvent('pointerdown', {
                clientX: 280,
                bubbles: true,
                cancelable: true,
            });
            leftDrawerResizer.dispatchEvent(pointerDownEvt);
            expect(app._isDraggingDrawer).toBe(true);

            const pointerMoveEvt = new PointerEvent('pointermove', {
                clientX: 350,
                bubbles: true,
                cancelable: true,
            });
            document.dispatchEvent(pointerMoveEvt);

            expect(sidebar.style.getPropertyValue('width')).toBe('350px');
            expect(sidebar.style.getPropertyPriority('width')).toBe(
                'important',
            );
            expect(localStorage.getItem('phi_drawer_left_width')).toBe('350');

            const pointerUpEvt = new PointerEvent('pointerup', {
                clientX: 350,
                bubbles: true,
                cancelable: true,
            });
            document.dispatchEvent(pointerUpEvt);
        });

        it('dismisses left drawer when dragged left below dismiss threshold', () => {
            const app = makeApp();
            sidebar.classList.add('drawer-open');
            app.initResizers();

            const leftDrawerResizer = document.getElementById(
                'sidebar-drawer-resizer',
            );

            leftDrawerResizer.dispatchEvent(
                new PointerEvent('pointerdown', {
                    clientX: 280,
                    bubbles: true,
                    cancelable: true,
                }),
            );

            document.dispatchEvent(
                new PointerEvent('pointerup', {
                    clientX: 80, // < 100px threshold
                    bubbles: true,
                    cancelable: true,
                }),
            );

            expect(sidebar.classList.contains('drawer-open')).toBe(false);
        });
    });
});
