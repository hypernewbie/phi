// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';

setupDomHarness();

// NEVER contract: opening or closing the virtual keyboard must NEVER
// trigger a refit, a backend resize, or any scroll touch — in ANY
// situation. Frozen rows: the keyboard overlays, the grid stays.
// Touch shells suppress height-only window geometry; width changes
// (rotation, drawer) and all fine-pointer resizes keep fitting.

function makeTm() {
    const m = Object.create(TabManager.prototype);
    m._lastWindowW = 1024;
    m._lastWindowH = 768;
    m._windowResizeTimeout = null;
    m.startResize = vi.fn();
    m.endResize = vi.fn();
    m.fitActiveTerminal = vi.fn();
    return m;
}

const realInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
const realInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
const realMatchMedia = window.matchMedia;

function setWindow(w, h) {
    Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        writable: true,
        value: w,
    });
    Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        writable: true,
        value: h,
    });
}

function setPointer(coarse) {
    window.matchMedia = vi.fn(() => ({ matches: coarse }));
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    if (realInnerWidth)
        Object.defineProperty(window, 'innerWidth', realInnerWidth);
    if (realInnerHeight)
        Object.defineProperty(window, 'innerHeight', realInnerHeight);
    window.matchMedia = realMatchMedia;
});

describe('classifyGeometryChange', () => {
    it('treats height-only movement at identical width as keyboard', () => {
        const m = makeTm();
        expect(m.classifyGeometryChange(1024, 700)).toBe('keyboard');
    });

    it('treats width movement as layout', () => {
        const m = makeTm();
        expect(m.classifyGeometryChange(768, 768)).toBe('layout');
    });

    it('treats identical dims as layout', () => {
        const m = makeTm();
        expect(m.classifyGeometryChange(1024, 768)).toBe('layout');
    });
});

describe('handleWindowResize NEVER suppression', () => {
    it('coarse + height-only: NO fit, NO send, ever', () => {
        const m = makeTm();
        setPointer(true);
        setWindow(1024, 700);
        m.handleWindowResize();
        vi.advanceTimersByTime(5000);
        expect(m.fitActiveTerminal).not.toHaveBeenCalled();
        expect(m.startResize).not.toHaveBeenCalled();
    });

    it('coarse + width change (rotation/drawer): fits on the debounce', () => {
        const m = makeTm();
        setPointer(true);
        setWindow(768, 768);
        m.handleWindowResize();
        expect(m.fitActiveTerminal).not.toHaveBeenCalled();
        vi.advanceTimersByTime(100);
        expect(m.fitActiveTerminal).toHaveBeenCalledTimes(1);
        expect(m.endResize).toHaveBeenCalledTimes(1);
    });

    it('fine-pointer + height-only (docked devtools): still fits', () => {
        const m = makeTm();
        setPointer(false);
        setWindow(1024, 700);
        m.handleWindowResize();
        vi.advanceTimersByTime(100);
        expect(m.fitActiveTerminal).toHaveBeenCalledTimes(1);
    });

    it('a burst of keyboard frames schedules nothing at all', () => {
        const m = makeTm();
        setPointer(true);
        for (const h of [740, 700, 660, 640]) {
            setWindow(1024, h);
            m.handleWindowResize();
        }
        vi.advanceTimersByTime(5000);
        expect(m.fitActiveTerminal).not.toHaveBeenCalled();
    });
});

describe('NEVER source contract', () => {
    it('the coalescing scheduler is gone from all runtime sources', async () => {
        const { readFileSync } = await import('node:fs');
        for (const f of [
            'web/terminal.js',
            'web/app.js',
            'web-src/diff.ts',
            'web/diff.js',
        ]) {
            const src = readFileSync(f, 'utf8');
            expect(src, `${f} must not reference the scheduler`).not.toContain(
                'scheduleKeyboardFit',
            );
            expect(src, `${f} must not reference the timer`).not.toContain(
                '_keyboardFitTimer',
            );
        }
    });

    it('focus/blur handlers fit nothing and schedule nothing', async () => {
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
        for (const [name, b] of [
            ['focus', block.slice(0, blurAt)],
            ['blur', block.slice(blurAt)],
        ]) {
            expect(b, `${name} must not fit`).not.toContain(
                'fitActiveTerminal',
            );
            expect(b, `${name} must not schedule`).not.toContain(
                'scheduleKeyboardFit',
            );
        }
        expect(block).toContain('updateLayoutPosition?.(false, true)');
        expect(block).toContain(
            'updateDirectModeUI(activeTab, isCoarseViewport())',
        );
    });

    it('updateDirectModeUI skips its fit only when asked', async () => {
        const { readFileSync } = await import('node:fs');
        const src = readFileSync('web/terminal.js', 'utf8');
        expect(src).toContain('updateDirectModeUI(tab, skipFit = false)');
        expect(src).toContain('if (!skipFit) this.fitActiveTerminal();');
    });

    it('the diff resize listener suppresses keyboard geometry', async () => {
        const { readFileSync } = await import('node:fs');
        const src = readFileSync('web-src/diff.ts', 'utf8');
        expect(src).toContain('heightOnly && isCoarseViewport()');
    });
});
