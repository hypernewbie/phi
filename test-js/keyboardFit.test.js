// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';

setupDomHarness();

// Software-keyboard geometry bursts (visualViewport animation frames on
// iOS, window shrinks on Android) must settle into ONE scroll-neutral
// fit — never per-frame PTY resizes flashing the TUI or _spamScroll
// runs yanking scroll position.

function makeTm() {
    const m = Object.create(TabManager.prototype);
    const wsSendResize = vi.fn();
    const fit = vi.fn(function () {
        // Default: fit is a no-op (dims already match), like FitAddon.
        // Tests that need a dims change mutate term.cols/rows here.
    });
    const tab = {
        paneId: 'p1',
        coder: 'bash',
        isDead: false,
        term: {
            cols: 80,
            rows: 24,
            options: { fontSize: 14 },
            buffer: { active: { viewportY: 10, baseY: 10 } },
            scrollToBottom: vi.fn(),
            scrollToLine: vi.fn(),
        },
        fitAddon: { fit, proposeDimensions: () => ({ cols: 80, rows: 24 }) },
        ws: { sendResize: wsSendResize },
    };
    m.tabs = new Map([['p1', tab]]);
    m.activePaneId = 'p1';
    m.getActiveTab = () => m.tabs.get(m.activePaneId);
    m.app = {
        terminalFontSize: 0,
        diffController: { fitTerminal: vi.fn() },
    };
    m.isResizing = false;
    m._spamScroll = vi.fn();
    m._keyboardFitTimer = null;
    m._lastWindowW = 1024;
    m._lastWindowH = 768;
    return { m, tab, fit, wsSendResize };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('classifyGeometryChange', () => {
    it('treats height-only movement at identical width as keyboard', () => {
        const { m } = makeTm();
        expect(m.classifyGeometryChange(1024, 700)).toBe('keyboard');
        expect(m._lastWindowW).toBe(1024);
        expect(m._lastWindowH).toBe(700);
    });

    it('treats width movement as layout (rotation, drawer, drag)', () => {
        const { m } = makeTm();
        expect(m.classifyGeometryChange(768, 768)).toBe('layout');
        expect(m.classifyGeometryChange(768, 700)).toBe('keyboard');
    });

    it('treats identical dims as layout (harmless immediate no-op path)', () => {
        const { m } = makeTm();
        expect(m.classifyGeometryChange(1024, 768)).toBe('layout');
    });
});

describe('scheduleKeyboardFit', () => {
    it('coalesces a burst into one fit and one backend resize', () => {
        const { m, fit, wsSendResize, tab } = makeTm();
        fit.mockImplementation(() => {
            tab.term.cols = 60;
            tab.term.rows = 20;
        });
        m.scheduleKeyboardFit();
        m.scheduleKeyboardFit();
        m.scheduleKeyboardFit();
        expect(fit).not.toHaveBeenCalled();
        vi.advanceTimersByTime(200);
        expect(fit).toHaveBeenCalledTimes(1);
        expect(wsSendResize).toHaveBeenCalledTimes(1);
        expect(wsSendResize).toHaveBeenCalledWith(60, 20);
        expect(m.app.diffController.fitTerminal).toHaveBeenCalledTimes(1);
    });

    it('sends no backend resize when dims settle identically (tap-in-tap-out)', () => {
        const { m, fit, wsSendResize } = makeTm();
        m.scheduleKeyboardFit();
        vi.advanceTimersByTime(200);
        expect(fit).toHaveBeenCalledTimes(1);
        expect(wsSendResize).not.toHaveBeenCalled();
    });

    it('is scroll-neutral: no _spamScroll, no scrollToBottom/ToLine', () => {
        const { m, tab } = makeTm();
        m.scheduleKeyboardFit();
        vi.advanceTimersByTime(500);
        expect(m._spamScroll).not.toHaveBeenCalled();
        expect(tab.term.scrollToBottom).not.toHaveBeenCalled();
        expect(tab.term.scrollToLine).not.toHaveBeenCalled();
    });

    it('does nothing without a live active tab', () => {
        const { m, fit, wsSendResize } = makeTm();
        m.activePaneId = 'missing';
        m.scheduleKeyboardFit();
        vi.advanceTimersByTime(500);
        expect(fit).not.toHaveBeenCalled();
        expect(wsSendResize).not.toHaveBeenCalled();
    });
});

describe('fitActiveTerminal supersedes keyboard fits', () => {
    it('cancels a pending keyboard fit (no double fit)', () => {
        const { m, fit } = makeTm();
        m.scheduleKeyboardFit();
        m.fitActiveTerminal();
        vi.advanceTimersByTime(1000);
        // Exactly one fit: the immediate real-layout one. The trailing
        // keyboard timer was cancelled, not fired.
        expect(fit).toHaveBeenCalledTimes(1);
    });
});

describe('input-bar focus/blur routing', () => {
    // Tapping the input (keyboard open) and dismissing it (keyboard
    // close) used to run immediate fits with _spamScroll — the scroll
    // yank survived the vv-burst coalescing because it fired BEFORE the
    // burst. Both must route through the scroll-neutral keyboard path.
    it('focus/blur handlers fit only via scheduleKeyboardFit', async () => {
        const { readFileSync } = await import('node:fs');
        const src = readFileSync('web/terminal.js', 'utf8');
        const focusStart = src.indexOf(
            "inputTextArea.addEventListener('focus'",
        );
        const inputStart = src.indexOf(
            "inputTextArea.addEventListener('input'",
        );
        expect(focusStart).toBeGreaterThan(-1);
        expect(inputStart).toBeGreaterThan(focusStart);
        const strip = (s) =>
            s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        const block = strip(src.slice(focusStart, inputStart));
        const blurAt = block.indexOf("addEventListener('blur'");
        expect(blurAt).toBeGreaterThan(-1);
        const focusBlock = block.slice(0, blurAt);
        const blurBlock = block.slice(blurAt);
        for (const [name, b] of [
            ['focus', focusBlock],
            ['blur', blurBlock],
        ]) {
            expect(b, `${name} must schedule a keyboard fit`).toContain(
                'scheduleKeyboardFit',
            );
            expect(b, `${name} must not run an immediate fit`).not.toContain(
                'fitActiveTerminal',
            );
            expect(
                b,
                `${name} must not fit via updateLayoutPosition(true`,
            ).not.toMatch(/updateLayoutPosition\?\.\(true/);
        }
    });
});
