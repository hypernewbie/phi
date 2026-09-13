// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
    TERMINAL_DEFAULT_FONT_SIZE,
    TERMINAL_MIN_READABLE_FONT_SIZE,
    TERMINAL_TARGET_COLUMNS,
    DIFF_TERMINAL_TARGET_COLUMNS,
    terminalPreferredFontSize,
    responsiveTerminalFontSize,
} from '../web/util.js';
import { TabManager } from '../web/terminal.js';

// Terminal typography is a constraint solver, not phone/tablet/desktop
// buckets. terminal_font_size is a preferred reading scale: FitAddon's real
// grid measurement limits it only when it would leave fewer than 80 columns
// in the main terminal (48 in the intentionally narrower Diff terminal).

describe('terminalPreferredFontSize', () => {
    it('uses the responsive default for the zero/unset sentinel', () => {
        expect(terminalPreferredFontSize(0)).toBe(TERMINAL_DEFAULT_FONT_SIZE);
        expect(terminalPreferredFontSize(undefined)).toBe(
            TERMINAL_DEFAULT_FONT_SIZE,
        );
    });

    it('preserves a valid saved user preference as the preferred scale', () => {
        expect(terminalPreferredFontSize(18)).toBe(18);
        expect(terminalPreferredFontSize(8)).toBe(8);
    });
});

describe('TabManager font resolver', () => {
    it('treats the saved setting as preferred scale, not an absolute command', () => {
        const manager = Object.create(TabManager.prototype);
        manager.app = { terminalFontSize: 20 };
        const tab = {
            term: { options: { fontSize: 14 } },
            fitAddon: { proposeDimensions: () => ({ cols: 60 }) },
        };
        // At this exact measured grid 10px is the largest whole-pixel size
        // that preserves 80 columns. A saved 20px preference does not get
        // to crush the working surface.
        expect(manager.resolveTerminalFontSize(tab)).toBe(10);
    });
});

describe('responsiveTerminalFontSize', () => {
    it('renders the exact preferred size when the measured grid has room', () => {
        expect(
            responsiveTerminalFontSize(18, 18, 100, TERMINAL_TARGET_COLUMNS),
        ).toBe(18);
        expect(
            responsiveTerminalFontSize(0, 14, 80, TERMINAL_TARGET_COLUMNS),
        ).toBe(14);
    });

    it('scales a preferred size down continuously from measured columns, not by device bucket', () => {
        // 14px currently yields 60 columns. The largest whole-pixel size
        // that yields 80 is floor(14 * 60 / 80) = 10px.
        expect(
            responsiveTerminalFontSize(14, 14, 60, TERMINAL_TARGET_COLUMNS),
        ).toBe(10);
        // Same viewport, larger user preference: geometry remains the
        // constraint, so it still settles at the actual 80-column maximum.
        expect(
            responsiveTerminalFontSize(20, 14, 60, TERMINAL_TARGET_COLUMNS),
        ).toBe(10);
    });

    it('keeps the readable floor unless the user explicitly selected smaller', () => {
        expect(
            responsiveTerminalFontSize(14, 14, 40, TERMINAL_TARGET_COLUMNS),
        ).toBe(TERMINAL_MIN_READABLE_FONT_SIZE);
        expect(
            responsiveTerminalFontSize(8, 8, 40, TERMINAL_TARGET_COLUMNS),
        ).toBe(8);
    });

    it('uses the same solver with Diff’s semantic grid target', () => {
        // 12px at 64 columns can grow to 16px for a 48-column target,
        // but the preferred scale caps it at 14px.
        expect(
            responsiveTerminalFontSize(
                14,
                12,
                64,
                DIFF_TERMINAL_TARGET_COLUMNS,
            ),
        ).toBe(14);
        // A narrow drawer scales only as far as its own 48-column grid allows.
        expect(
            responsiveTerminalFontSize(
                14,
                12,
                32,
                DIFF_TERMINAL_TARGET_COLUMNS,
            ),
        ).toBe(10);
    });

    it('fails safe to the preferred size before FitAddon has measurements', () => {
        expect(
            responsiveTerminalFontSize(
                16,
                16,
                undefined,
                TERMINAL_TARGET_COLUMNS,
            ),
        ).toBe(16);
    });
});
