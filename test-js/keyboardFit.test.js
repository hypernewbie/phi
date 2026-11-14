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

describe('_isKeyboardViewportResize', () => {
    const box = (width, height) => ({ width, height });
    const tab = (panel, root) => ({
        _panelBox: panel,
        _panelRootHeight: root,
    });

    it('skips a shrink when panel and app root move together', () => {
        const m = makeTm();
        setPointer(true);
        const t = tab(box(800, 600), 844);
        expect(m._isKeyboardViewportResize(t, box(800, 256), 500)).toBe(true);
    });

    it('skips a growth when panel and app root move together', () => {
        const m = makeTm();
        setPointer(true);
        const t = tab(box(800, 256), 500);
        expect(m._isKeyboardViewportResize(t, box(800, 600), 844)).toBe(true);
    });

    it('does not skip a composer or attachment change that moves only the panel', () => {
        const m = makeTm();
        setPointer(true);
        const t = tab(box(800, 600), 844);
        expect(m._isKeyboardViewportResize(t, box(800, 560), 844)).toBe(false);
    });

    it('does not skip a panel-only change while the keyboard is open', () => {
        const m = makeTm();
        setPointer(true);
        const t = tab(box(800, 256), 500);
        expect(m._isKeyboardViewportResize(t, box(800, 216), 500)).toBe(false);
    });

    it('does not skip fine-pointer height changes', () => {
        const m = makeTm();
        setPointer(false);
        const t = tab(box(800, 600), 844);
        expect(m._isKeyboardViewportResize(t, box(800, 256), 500)).toBe(false);
    });

    it('does not skip width changes (rotation or drawer)', () => {
        const m = makeTm();
        setPointer(true);
        const t = tab(box(800, 600), 844);
        expect(m._isKeyboardViewportResize(t, box(600, 256), 500)).toBe(false);
    });

    it('does not skip before the first measured box and root', () => {
        const m = makeTm();
        setPointer(true);
        expect(
            m._isKeyboardViewportResize(
                tab(undefined, undefined),
                box(800, 600),
                844,
            ),
        ).toBe(false);
        expect(
            m._isKeyboardViewportResize(
                tab(undefined, 844),
                box(800, 600),
                500,
            ),
        ).toBe(false);
    });

    it('tolerates subpixel rounding but not a real chrome delta', () => {
        const m = makeTm();
        setPointer(true);
        const t = tab(box(800, 600.5), 844.5);
        expect(m._isKeyboardViewportResize(t, box(800, 256.5), 500.25)).toBe(
            true,
        );
        expect(m._isKeyboardViewportResize(t, box(800, 254), 500.25)).toBe(
            false,
        );
    });

    it('does not skip when the app root did not move', () => {
        const m = makeTm();
        setPointer(true);
        const t = tab(box(800, 600), 844);
        expect(m._isKeyboardViewportResize(t, box(800, 600.5), 844)).toBe(
            false,
        );
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

    it('rotation while the keyboard is open recovers: exactly one fit', () => {
        // Suppression is stateless per event (classify updates its
        // baseline every call), so a width change after a suppressed
        // burst must fit — never stuck silent, never a catch-up storm.
        const m = makeTm();
        setPointer(true);
        for (const h of [700, 660, 640]) {
            setWindow(1024, h);
            m.handleWindowResize();
        }
        setWindow(768, 640);
        m.handleWindowResize();
        vi.advanceTimersByTime(5000);
        expect(m.fitActiveTerminal).toHaveBeenCalledTimes(1);
        expect(m.endResize).toHaveBeenCalledTimes(1);
    });

    it('a same-dims event is not suppressed as keyboard (downstream skip owns it)', () => {
        // classify reports layout for unchanged geometry; the cheap
        // same-dims skip inside fitActiveTerminal (fitSkip.test.js) —
        // not the NEVER gate — decides the rest. The gate must not eat
        // events it cannot classify.
        const m = makeTm();
        setPointer(true);
        setWindow(1024, 768);
        m.handleWindowResize();
        vi.advanceTimersByTime(5000);
        expect(m.fitActiveTerminal).toHaveBeenCalledTimes(1);
    });
});

describe('NEVER source contract', () => {
    it('the coalescing scheduler is gone from all runtime sources', async () => {
        const { readFileSync } = await import('node:fs');
        for (const f of [
            'web-src/terminal.ts',
            'web-src/app.ts',
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
        const src = readFileSync('web-src/terminal.ts', 'utf8');
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
        const src = readFileSync('web-src/terminal.ts', 'utf8');
        // Signature is type-annotated since the TS migration; the contract
        // is the default, not the absence of an annotation.
        expect(src).toMatch(
            /updateDirectModeUI\(tab(?:: \w+)?, skipFit = false\)/,
        );
        expect(src).toContain('if (!skipFit) this.fitActiveTerminal();');
    });

    it('the diff resize listener suppresses keyboard geometry', async () => {
        const { readFileSync } = await import('node:fs');
        const src = readFileSync('web-src/diff.ts', 'utf8');
        expect(src).toContain('heightOnly && isCoarseViewport()');
    });
});

// The picker row is built per layout: its own row on desktop, one swipe
// strip on compact. handleWindowResize is the only place a live window
// can cross that breakpoint, so it must rebuild the row exactly once.
describe('handleWindowResize presets relayout', () => {
    function makePresetTm(compact, tab = { coder: 'pi', directMode: false }) {
        const m = makeTm();
        m._presetsCompact = compact;
        m.getActiveTab = () => tab;
        m.renderPresets = vi.fn();
        return m;
    }

    it('rebuilds the row when crossing into compact', () => {
        const m = makePresetTm(false);
        setPointer(false);
        setWindow(390, 844);
        m.handleWindowResize();
        expect(m.renderPresets).toHaveBeenCalledWith('pi');
    });

    it('rebuilds the row when crossing out of compact', () => {
        const m = makePresetTm(true);
        setPointer(false);
        setWindow(1440, 900);
        m.handleWindowResize();
        expect(m.renderPresets).toHaveBeenCalledWith('pi');
    });

    it('leaves the row alone while staying on the same layout', () => {
        const m = makePresetTm(true);
        setPointer(false);
        setWindow(390, 800);
        m.handleWindowResize();
        expect(m.renderPresets).not.toHaveBeenCalled();
    });

    it('skips tabs in direct mode, where the row is hidden', () => {
        const m = makePresetTm(false, { coder: 'pi', directMode: true });
        setPointer(false);
        setWindow(390, 844);
        m.handleWindowResize();
        expect(m.renderPresets).not.toHaveBeenCalled();
    });
});
