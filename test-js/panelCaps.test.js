// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    SIDEBAR_PANEL_CAP,
    DIFF_PANEL_CAP,
    clampPanelWidth,
} from '../web/util.js';

// Terminal-first panel topology (see web-src/util.ts, AGENTS.md
// "Viewport contract"). The terminal is the primary surface; each
// docked side column gets at most one quarter, so two can never consume
// more than half the window because of a width remembered from a bigger
// monitor.
//
// CSS cannot import JS constants, so this file pins both forms:
//   - web/style.css base .sidebar-panel / .diff-panel rules carry
//     `max-width: min(<max>px, <vw>vw)`.
//   - web-src/util.ts exports the same numbers for the drag handlers
//     (the resize handle must stop exactly where CSS stops) and for
//     clamping the localStorage replay in initResizers().
//   - Fixed-width drawer overlays must clear max-width so the vw cap
//     never squeezes them on phones.

const CSS = readFileSync('web/style.css', 'utf8');

function baseRule(selector) {
    const m = CSS.match(
        new RegExp(
            `(?:^|\\n)${selector.replace(/\./g, '\\.')}\\s*\\{[\\s\\S]*?\\n\\}`,
        ),
    );
    if (!m) throw new Error(`base rule ${selector} not found`);
    return m[0];
}

// Extract a named media block (first `@media ... {` through its
// matching close at column 0).
function mediaBlock(marker) {
    const start = CSS.indexOf(marker);
    if (start < 0) throw new Error(`media marker ${marker} not found`);
    const open = CSS.indexOf('{', start);
    let depth = 1;
    let i = open + 1;
    while (i < CSS.length && depth > 0) {
        if (CSS[i] === '{') depth++;
        else if (CSS[i] === '}') depth--;
        i++;
    }
    return CSS.slice(start, i);
}

describe('column panel proportional caps', () => {
    it('base sidebar rule caps at 25vw / 450px', () => {
        expect(baseRule('.sidebar-panel')).toMatch(
            /max-width:\s*min\(450px,\s*25vw\)/,
        );
    });

    it('base diff rule caps at 25vw / 600px', () => {
        expect(baseRule('.diff-panel')).toMatch(
            /max-width:\s*min\(600px,\s*25vw\)/,
        );
    });

    it('JS constants match the CSS fractions', () => {
        expect(SIDEBAR_PANEL_CAP).toEqual({ min: 60, max: 450, vw: 0.25 });
        expect(DIFF_PANEL_CAP).toEqual({ min: 200, max: 600, vw: 0.25 });
    });

    it('moves Sessions into a drawer before it can crush a narrow terminal', () => {
        const constrainedSidebar = mediaBlock(
            '@media (min-width: 769px) and (max-width: 1023px)',
        );
        expect(constrainedSidebar).toMatch(
            /#left-resize-handle\s*\{[^}]*display:\s*none/s,
        );
        expect(constrainedSidebar).toMatch(
            /\.mobile-only-btn\s*\{[^}]*display:\s*flex/s,
        );
        expect(constrainedSidebar).toMatch(
            /\.sidebar-panel\s*\{[^}]*position:\s*fixed[^}]*transform:\s*translateX\(-100%\)/s,
        );
        expect(constrainedSidebar).toMatch(
            /\.sidebar-panel\.drawer-open\s*\{[^}]*translateX\(0\)/s,
        );
    });

    it('fixed-width drawer overlays clear max-width so vw caps cannot squeeze them', () => {
        const compactSidebarDrawer = mediaBlock(
            '/* Sidebar as a Slide-out Drawer */',
        );
        expect(compactSidebarDrawer).toMatch(
            /\.sidebar-panel\s*\{[^}]*width:\s*280px !important[^}]*max-width:\s*none/s,
        );

        const compactDiffDrawer = mediaBlock(
            '/* Diff panel as a slide-out drawer on mobile if opened */',
        );
        expect(compactDiffDrawer).toMatch(
            /\.diff-panel\s*\{[^}]*width:\s*320px !important[^}]*max-width:\s*none/s,
        );

        const constrainedDiffDrawer = mediaBlock(
            '@media (min-width: 769px) and (max-width: 1279px)',
        );
        expect(constrainedDiffDrawer).toMatch(
            /\.diff-panel\s*\{[^}]*width:\s*320px !important[^}]*max-width:\s*none/s,
        );
    });
});

describe('clampPanelWidth', () => {
    it('caps a big-monitor width to one quarter of the viewport', () => {
        // 450px dragged on a 2560px monitor, replayed on a 900px window:
        // it becomes 225px, never a 50%-wide sessions column.
        expect(clampPanelWidth(450, SIDEBAR_PANEL_CAP, 900)).toBe(225);
        expect(clampPanelWidth(450, SIDEBAR_PANEL_CAP, 2560)).toBe(450);
    });

    it('caps the diff column at 25vw', () => {
        expect(clampPanelWidth(600, DIFF_PANEL_CAP, 900)).toBe(225);
        expect(clampPanelWidth(600, DIFF_PANEL_CAP, 2400)).toBe(600);
    });

    it('leaves in-range widths untouched', () => {
        expect(clampPanelWidth(260, SIDEBAR_PANEL_CAP, 1440)).toBe(260);
        expect(clampPanelWidth(340, DIFF_PANEL_CAP, 1440)).toBe(340);
    });

    it('never returns below the drag minimum', () => {
        expect(clampPanelWidth(40, SIDEBAR_PANEL_CAP, 1440)).toBe(60);
        expect(clampPanelWidth(150, DIFF_PANEL_CAP, 1440)).toBe(200);
    });

    it('derives the drag upper bound (handle stops where CSS stops)', () => {
        // initResizers uses clampPanelWidth(cap.max, cap) as the live
        // drag ceiling; it must equal the CSS used-width cap.
        expect(clampPanelWidth(450, SIDEBAR_PANEL_CAP, 900)).toBe(225);
        expect(clampPanelWidth(600, DIFF_PANEL_CAP, 900)).toBe(225);
    });
});
