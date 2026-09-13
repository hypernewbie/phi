// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    isCoarseViewport,
    isCompactViewport,
    isSidebarDrawerViewport,
    isDiffDrawerViewport,
    prefersInputBarFocus,
    visibleViewportHeight,
    COMPACT_VIEWPORT_QUERY,
} from '../web/util.js';

// Viewport contract drift guards (AGENTS.md "Viewport contract", 2026-08-12).
//
// The contract has three conditions, each with a JS form (util helpers)
// and a CSS form (web/style.css). CSS cannot import the JS constant and
// JS cannot read @media preludes, so this file pins both sides:
//
//   1. Compact layout: width <= 768 OR (short landscape AND coarse
//      pointer). CSS prelude + isCompactViewport() must stay equivalent.
//   2. Soft-keyboard ergonomics: (pointer: coarse), width-independent.
//      --vv-height must be written only on coarse shells, and every
//      base-rule consumer must keep the identical pre-var fallback so
//      fine-pointer desktops are pixel-identical.
//   3. Terminal-first side panels: below 1024px Sessions is a drawer;
//      below 1280px Diff is a drawer. Full side-by-side waits until the
//      terminal retains an 80-column working grid.
//
// If any assertion here fails, a form drifted — fix all forms in one
// commit (JS helper, CSS prelude, tests).

const CSS = readFileSync('web/style.css', 'utf8');
const UTIL_JS = readFileSync('web/util.js', 'utf8');
const APP_JS = readFileSync('web/app.js', 'utf8');

// ── JS helpers: modality ≠ geometry ──────────────────────────────────────

function setViewport(w, h) {
    Object.defineProperty(window, 'innerWidth', {
        value: w,
        configurable: true,
    });
    Object.defineProperty(window, 'innerHeight', {
        value: h,
        configurable: true,
    });
}

function setMatchMedia(map) {
    // jsdom has no matchMedia; stub it with a fixed query->matches table.
    window.matchMedia = (query) => ({
        matches: Boolean(map[query]),
        media: query,
    });
}

const originalMatchMedia = window.matchMedia;
const originalVisualViewport = window.visualViewport;
afterEach(() => {
    if (originalMatchMedia === undefined) delete window.matchMedia;
    else window.matchMedia = originalMatchMedia;
    if (originalVisualViewport === undefined) delete window.visualViewport;
    else {
        Object.defineProperty(window, 'visualViewport', {
            value: originalVisualViewport,
            configurable: true,
        });
    }
    setViewport(1024, 768);
});

describe('isCoarseViewport', () => {
    it('treats a missing matchMedia (jsdom, old embedders) as fine pointer', () => {
        delete window.matchMedia;
        expect(isCoarseViewport()).toBe(false);
    });

    it('follows (pointer: coarse) only', () => {
        setMatchMedia({ '(pointer: coarse)': true });
        expect(isCoarseViewport()).toBe(true);
        setMatchMedia({ '(pointer: coarse)': false });
        expect(isCoarseViewport()).toBe(false);
    });
});

describe('isCompactViewport', () => {
    it('compacts on narrow width regardless of pointer modality', () => {
        setMatchMedia({});
        setViewport(375, 667);
        expect(isCompactViewport()).toBe(true);
        setViewport(768, 1024);
        expect(isCompactViewport()).toBe(true);
    });

    it('keeps desktop layout on wide viewports, touch or not', () => {
        setMatchMedia({ '(pointer: coarse)': true });
        setViewport(1200, 800);
        expect(isCompactViewport()).toBe(false);
        // An 820px iPad is a touch device but NOT compact: compact-only
        // chrome stays off, although terminal-first panel topology moves
        // Sessions/Diff into drawers at that constrained width.
        setViewport(820, 1180);
        expect(isCompactViewport()).toBe(false);
    });

    it('compacts short landscape viewports only on touch devices', () => {
        // Landscape phone (932×430): compact.
        setMatchMedia({ '(pointer: coarse)': true });
        setViewport(932, 430);
        expect(isCompactViewport()).toBe(true);
        // Desktop window snapped short (2560×400, mouse-first): desktop
        // layout stays — the swipe drawer UX was designed for touch.
        setMatchMedia({});
        setViewport(2560, 400);
        expect(isCompactViewport()).toBe(false);
    });
});

describe('terminal-first drawer topology', () => {
    it('drawers Sessions below 1024px and Diff below 1280px', () => {
        // Deliberately exercise the innerWidth fallback too: an old browser
        // without matchMedia must still get the safe panel topology.
        delete window.matchMedia;
        setViewport(840, 845);
        expect(isSidebarDrawerViewport()).toBe(true);
        expect(isDiffDrawerViewport()).toBe(true);

        setViewport(1024, 845);
        expect(isSidebarDrawerViewport()).toBe(false);
        expect(isDiffDrawerViewport()).toBe(true);

        setViewport(1280, 845);
        expect(isSidebarDrawerViewport()).toBe(false);
        expect(isDiffDrawerViewport()).toBe(false);
    });

    it('keeps short touch landscape in drawer topology through compact', () => {
        setMatchMedia({ '(pointer: coarse)': true });
        setViewport(1400, 430);
        expect(isSidebarDrawerViewport()).toBe(true);
        expect(isDiffDrawerViewport()).toBe(true);
    });
});

describe('visibleViewportHeight', () => {
    it('uses innerHeight when old Chromium has no visualViewport', () => {
        delete window.visualViewport;
        setViewport(840, 700);
        expect(visibleViewportHeight()).toBe(700);
    });

    it('uses the smaller valid measurement when Chrome reports stale visual height', () => {
        setViewport(840, 700);
        Object.defineProperty(window, 'visualViewport', {
            value: { height: 760 },
            configurable: true,
        });
        expect(visibleViewportHeight()).toBe(700);
    });

    it('keeps Safari keyboard geometry when visualViewport is smaller', () => {
        setViewport(840, 845);
        Object.defineProperty(window, 'visualViewport', {
            value: { height: 450 },
            configurable: true,
        });
        expect(visibleViewportHeight()).toBe(450);
    });
});

describe('prefersInputBarFocus', () => {
    it('is a superset of compact: any coarse pointer qualifies', () => {
        setMatchMedia({ '(pointer: coarse)': true });
        setViewport(820, 1180);
        expect(prefersInputBarFocus()).toBe(true);
    });

    it('is false on fine-pointer desktops', () => {
        setMatchMedia({});
        setViewport(1440, 900);
        expect(prefersInputBarFocus()).toBe(false);
    });
});

describe('COMPACT_VIEWPORT_QUERY', () => {
    it('matches the CSS prelude used by every compact block', () => {
        // Collapse whitespace: biome wraps the long prelude across lines.
        const squash = (s) => s.replace(/\s+/g, ' ');
        const cssForm = squash(CSS);
        // The CSS form, as it appears in web/style.css preludes.
        expect(cssForm).toContain(
            '@media (max-width: 768px), (max-height: 500px) and (orientation: landscape) and (pointer: coarse) {',
        );
        // The JS form must be the same comma-separated condition set.
        expect(COMPACT_VIEWPORT_QUERY).toBe(
            '(max-width: 768px), (max-height: 500px) and (orientation: landscape) and (pointer: coarse)',
        );
        expect(UTIL_JS).toContain(COMPACT_VIEWPORT_QUERY);
    });
});

// ── CSS drift guards ─────────────────────────────────────────────────────

describe('style.css compact blocks', () => {
    it('has no bare (max-width: 768px) prelude left — all were extended', () => {
        expect(CSS).not.toMatch(/@media\s*\(max-width:\s*768px\)\s*\{/);
    });

    it('extends every 768px prelude with the touch-landscape clause', () => {
        const preludes =
            CSS.match(/@media[^{]*\(max-width:\s*768px\)[^{]*\{/g) ?? [];
        expect(preludes.length).toBeGreaterThanOrEqual(11);
        for (const prelude of preludes) {
            expect(prelude).toContain('(max-height: 500px)');
            expect(prelude).toContain('(orientation: landscape)');
            expect(prelude).toContain('(pointer: coarse)');
        }
    });
});

describe('style.css keyboard-aware app root', () => {
    it('base .app-container consumes --vv-height with the old 100vh fallback', () => {
        const m = CSS.match(/(?:^|\n)\.app-container\s*\{[\s\S]*?\n\}/m);
        expect(m, '.app-container base rule not found').toBeTruthy();
        expect(m[0]).toMatch(/height:\s*var\(--vv-height,\s*100vh\)/);
        // The var is only written on coarse shells, so fine-pointer
        // desktops resolve this to the exact old value.
        expect(APP_JS).toMatch(/isCoarseViewport\(\)/);
        expect(APP_JS).not.toMatch(/innerWidth\s*<=\s*768[^=]/);
    });

    it('gives old Chromium a valid --vv-height baseline and innerHeight fallback', () => {
        // Chrome before dvh support must never expand an unset var fallback
        // to an invalid 100dvh declaration. The root baseline is valid CSS;
        // modern engines progressively replace it with 100dvh.
        expect(CSS).toMatch(/:root\s*\{[\s\S]*?--vv-height:\s*100vh/);
        expect(CSS).toContain('@supports (height: 100dvh)');
        // app.js defines the updater even without visualViewport and uses the
        // conservative min(visualViewport.height, innerHeight) helper.
        expect(APP_JS).toContain('visibleViewportHeight()');
        expect(APP_JS).toContain('window.visualViewport?.addEventListener');
    });
});

describe('style.css terminal-first side panels', () => {
    it('769–1279px turns Diff into a slide-over drawer', () => {
        const m = CSS.match(
            /@media \(min-width: 769px\) and \(max-width: 1279px\) \{[\s\S]*?\n\}/,
        );
        expect(m, 'constrained Diff media block not found').toBeTruthy();
        const block = m[0];
        expect(block).toMatch(/\.diff-panel\s*\{[^}]*position:\s*fixed/);
        expect(block).toMatch(/transform:\s*translateX\(100%\)/);
        expect(block).toMatch(/\.diff-panel:not\(\.hidden\)\.mobile-open/);
        expect(block).toMatch(/#right-resize-handle\s*\{[^}]*display:\s*none/);
    });

    it('769–1023px turns Sessions into a slide-over drawer', () => {
        const m = CSS.match(
            /@media \(min-width: 769px\) and \(max-width: 1023px\) \{[\s\S]*?\n\}/,
        );
        expect(m, 'constrained Sessions media block not found').toBeTruthy();
        const block = m[0];
        expect(block).toMatch(/#left-resize-handle\s*\{[^}]*display:\s*none/);
        expect(block).toMatch(/\.mobile-only-btn\s*\{[^}]*display:\s*flex/);
        expect(block).toMatch(/\.sidebar-panel\s*\{[^}]*position:\s*fixed/);
        expect(block).toMatch(/\.sidebar-panel\.drawer-open/);
    });
});
