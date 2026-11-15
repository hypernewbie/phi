// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { installTerminalTouch } from '../web/terminal-touch.js';

setupDomHarness();

// The controller reaches into xterm's private services. Those services can be
// missing on a future xterm build, so a long press must degrade to a one-cell
// selection instead of throwing. This file is the only place that exercises
// the controller with a fake terminal; the browser-level behaviour lives in
// e2e/terminal-mobile-touch.spec.ts.
function mount() {
    const container = document.createElement('div');
    container.className = 'term-container';
    const termEl = document.createElement('div');
    termEl.className = 'xterm';
    const screen = document.createElement('div');
    screen.className = 'xterm-screen';
    termEl.appendChild(screen);
    container.appendChild(termEl);
    document.body.appendChild(container);
    screen.getBoundingClientRect = () => ({
        left: 0,
        top: 0,
        right: 800,
        bottom: 480,
        width: 800,
        height: 480,
        x: 0,
        y: 0,
        toJSON: () => ({}),
    });

    const calls = [];
    const selectionHandlers = [];
    let selected = false;
    const term = {
        element: termEl,
        cols: 80,
        rows: 24,
        buffer: { active: { viewportY: 0 } },
        select: (col, row, length) => {
            selected = true;
            calls.push(['select', col, row, length]);
        },
        clearSelection: () => {
            selected = false;
            calls.push(['clearSelection']);
        },
        hasSelection: () => selected,
        getSelection: () => (selected ? 'SELECTABLE' : ''),
        onSelectionChange: (handler) => {
            selectionHandlers.push(handler);
            return {
                dispose: () => {
                    const at = selectionHandlers.indexOf(handler);
                    if (at >= 0) selectionHandlers.splice(at, 1);
                },
            };
        },
    };
    const openLink = vi.fn();
    const copyText = vi.fn();
    const controller = installTerminalTouch({
        term,
        container,
        openLink,
        copyText,
    });
    return {
        container,
        screen,
        term,
        calls,
        controller,
        openLink,
        copyText,
        dropSelection: () => {
            selected = false;
            for (const handler of [...selectionHandlers]) handler();
        },
    };
}

function touch(target, type, touches, changedTouches = []) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    event.touches = touches;
    event.changedTouches = changedTouches;
    target.dispatchEvent(event);
    return event;
}

describe('installTerminalTouch degraded path', () => {
    it('selects one cell when the private word service is missing', () => {
        vi.useFakeTimers();
        const { screen, calls, controller } = mount();
        touch(screen, 'touchstart', [{ clientX: 5, clientY: 5 }]);
        vi.advanceTimersByTime(600);
        touch(screen, 'touchend', [], [{ clientX: 5, clientY: 5 }]);

        expect(calls).toEqual([['select', 0, 0, 1]]);
        expect(controller.ownsSelection()).toBe(true);
        expect(controller.hasSelection()).toBe(true);
        controller.clear();
        expect(calls.at(-1)).toEqual(['clearSelection']);
        expect(controller.ownsSelection()).toBe(false);
        expect(controller.hasSelection()).toBe(false);
        controller.dispose();
        vi.useRealTimers();
    });

    it('does not select when the touch ends before the long-press delay', () => {
        vi.useFakeTimers();
        const { screen, calls, controller } = mount();
        touch(screen, 'touchstart', [{ clientX: 10, clientY: 10 }]);
        touch(screen, 'touchend', [], [{ clientX: 10, clientY: 10 }]);
        vi.advanceTimersByTime(600);

        expect(calls).toEqual([]);
        expect(controller.ownsSelection()).toBe(false);
        controller.dispose();
        vi.useRealTimers();
    });

    it('owns clipboard events from touchstart but has no selection yet', () => {
        // The distinction that keeps OpenCode scrolling alive: a swipe owns
        // the clipboard for its whole gesture, but only a real selection may
        // stand the scroll injection down.
        vi.useFakeTimers();
        const { screen, calls, controller } = mount();
        touch(screen, 'touchstart', [{ clientX: 5, clientY: 5 }]);
        expect(controller.ownsSelection()).toBe(true);
        expect(controller.hasSelection()).toBe(false);
        expect(calls).toEqual([]);
        vi.advanceTimersByTime(600);
        expect(controller.hasSelection()).toBe(true);
        controller.dispose();
        vi.useRealTimers();
    });

    it('drops the pill when the selection disappears without clear()', async () => {
        // A backend restart calls term.reset(), which drops the selection but
        // leaves the pill floating over nothing.
        vi.useFakeTimers();
        const { screen, calls, controller, dropSelection } = mount();
        touch(screen, 'touchstart', [{ clientX: 5, clientY: 5 }]);
        vi.advanceTimersByTime(600);
        touch(screen, 'touchend', [], [{ clientX: 5, clientY: 5 }]);
        expect(controller.hasSelection()).toBe(true);
        calls.length = 0;
        dropSelection();
        await Promise.resolve();
        expect(controller.ownsSelection()).toBe(false);
        expect(controller.hasSelection()).toBe(false);
        // The selection was already gone: tearing down must not clear again.
        expect(calls).toEqual([]);
        controller.dispose();
        vi.useRealTimers();
    });

    it('hides the pill instead of throwing when placement is impossible', () => {
        vi.useFakeTimers();
        // The fake terminal has no getSelectionPosition(): the placement
        // read throws. The pill is cosmetic and must never throw into
        // xterm's scroll emitter or the long-press timer.
        const { screen, container, controller } = mount();
        touch(screen, 'touchstart', [{ clientX: 5, clientY: 5 }]);
        expect(() => vi.advanceTimersByTime(600)).not.toThrow();
        expect(controller.hasSelection()).toBe(true);
        expect(container.querySelector('.terminal-copy-pill')?.hidden).toBe(
            true,
        );
        controller.dispose();
        vi.useRealTimers();
    });

    it('ignores a long press that starts outside the screen element', () => {
        vi.useFakeTimers();
        const { container, calls, controller } = mount();
        touch(container, 'touchstart', [{ clientX: 10, clientY: 10 }]);
        vi.advanceTimersByTime(600);
        touch(container, 'touchend', [], [{ clientX: 10, clientY: 10 }]);

        expect(calls).toEqual([]);
        controller.dispose();
        vi.useRealTimers();
    });
});
