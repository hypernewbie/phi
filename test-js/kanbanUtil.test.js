import { describe, it, expect } from 'vitest';
import { extractVikunjaError, safeHexColor } from '../web/util.js';

describe('extractVikunjaError', () => {
    it('returns status-based fallback for empty body', () => {
        expect(extractVikunjaError('', 500)).toBe(
            'Request failed with status 500',
        );
    });

    it('pulls the message from the single-message Vikunja envelope', () => {
        expect(
            extractVikunjaError(
                '{"message":"method not allowed error","code":7}',
                405,
            ),
        ).toBe('method not allowed error');
    });

    it('flattens the per-field "messages" envelope', () => {
        expect(
            extractVikunjaError(
                '{"messages":{"title":["can\'t be empty"],"bucket":["required"]}}',
                400,
            ),
        ).toBe("title: can't be empty; bucket: required");
    });

    it('falls back to a truncated, tag-stripped text on non-JSON (e.g. nginx HTML)', () => {
        const html =
            '<html><body><h1>502 Bad Gateway</h1><p>ohai</p></body></html>';
        const out = extractVikunjaError(html, 502);
        expect(out).toBe('502 Bad Gateway ohai');
    });

    it('truncates long messages to 240 chars + "..."', () => {
        const big = 'x'.repeat(500);
        expect(extractVikunjaError(`{"message":"${big}"}`, 500)).toMatch(
            /^x+\.\.\.$/,
        );
        expect(extractVikunjaError(`{"message":"${big}"}`, 500).length).toBe(
            243,
        );
    });
});

describe('safeHexColor', () => {
    it('accepts 3- and 6-char hex strings (with or without #)', () => {
        expect(safeHexColor('ff00aa')).toBe('ff00aa');
        expect(safeHexColor('FFF')).toBe('FFF');
        expect(safeHexColor('#abcdef')).toBe(''); // leading # rejected (we add it)
    });

    it('rejects anything else (CSS injection defense)', () => {
        expect(safeHexColor('red')).toBe('');
        expect(safeHexColor('ff00aa;background:url(evil)')).toBe('');
        expect(safeHexColor('')).toBe('');
        expect(safeHexColor(null)).toBe('');
        expect(safeHexColor(undefined)).toBe('');
        expect(safeHexColor(42)).toBe('');
        expect(safeHexColor('xyz')).toBe('');
    });
});
