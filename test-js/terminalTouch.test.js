import { describe, it, expect } from 'vitest';
import { linkAtCell, selectionRange } from '../web/terminal-touch.js';

// The link ranges from findTerminalLineLinks are 1-based on both axes.
// linkAtCell must agree with them or a tap opens a neighbouring URL.

function link(start, end) {
    return { range: { start, end }, text: 'https://example.com/x' };
}

describe('linkAtCell', () => {
    it('matches inside a single-line range, and not at either edge outside it', () => {
        const links = [link({ x: 5, y: 3 }, { x: 20, y: 3 })];
        expect(linkAtCell(links, 5, 3)).toBe(links[0]);
        expect(linkAtCell(links, 20, 3)).toBe(links[0]);
        expect(linkAtCell(links, 12, 3)).toBe(links[0]);
        expect(linkAtCell(links, 4, 3)).toBeUndefined();
        expect(linkAtCell(links, 21, 3)).toBeUndefined();
    });

    it('treats the open side of a wrapped range as open', () => {
        // Row 3 runs from column 10 to the right edge; row 5 runs from the
        // left edge to column 8. Row 4 is fully inside the range.
        const links = [link({ x: 10, y: 3 }, { x: 8, y: 5 })];
        expect(linkAtCell(links, 10, 3)).toBe(links[0]);
        expect(linkAtCell(links, 40, 3)).toBe(links[0]);
        expect(linkAtCell(links, 9, 3)).toBeUndefined();
        expect(linkAtCell(links, 1, 4)).toBe(links[0]);
        expect(linkAtCell(links, 40, 4)).toBe(links[0]);
        expect(linkAtCell(links, 8, 5)).toBe(links[0]);
        expect(linkAtCell(links, 9, 5)).toBeUndefined();
    });

    it('does not match a row outside every range', () => {
        const links = [link({ x: 1, y: 2 }, { x: 3, y: 2 })];
        expect(linkAtCell(links, 1, 1)).toBeUndefined();
        expect(linkAtCell(links, 1, 3)).toBeUndefined();
    });

    it('returns undefined for missing input', () => {
        expect(linkAtCell(undefined, 1, 1)).toBeUndefined();
        expect(linkAtCell(null, 1, 1)).toBeUndefined();
        expect(linkAtCell([], 1, 1)).toBeUndefined();
    });
});

describe('selectionRange', () => {
    it('maps one cell to a length-one range', () => {
        expect(selectionRange(3, 3, 80)).toEqual({ col: 3, row: 0, length: 1 });
    });

    it('keeps a range inside one row', () => {
        expect(selectionRange(10, 14, 80)).toEqual({
            col: 10,
            row: 0,
            length: 5,
        });
    });

    it('counts across a row boundary', () => {
        // Row 0 columns 78-79 (2 cells) + row 1 columns 0-1 (2 cells).
        expect(selectionRange(78, 81, 80)).toEqual({
            col: 78,
            row: 0,
            length: 4,
        });
    });

    it('normalises a reversed pair', () => {
        expect(selectionRange(81, 78, 80)).toEqual(selectionRange(78, 81, 80));
    });
});
