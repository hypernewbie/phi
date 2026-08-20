import { describe, it, expect } from 'vitest';
import { escapeHtml } from '../web/util.js';

// escapeHtml is the 5-char, attribute-safe escaper shared by kanban + sync.

describe('escapeHtml', () => {
    it('returns empty string for falsy input', () => {
        expect(escapeHtml('')).toBe('');
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
        expect(escapeHtml(0)).toBe('');
    });

    it('escapes all five HTML-sensitive characters', () => {
        expect(escapeHtml('&')).toBe('&amp;');
        expect(escapeHtml('<')).toBe('&lt;');
        expect(escapeHtml('>')).toBe('&gt;');
        expect(escapeHtml('"')).toBe('&quot;');
        expect(escapeHtml("'")).toBe('&#039;');
    });

    it('escapes ampersand first so entities are not double-escaped incorrectly', () => {
        expect(escapeHtml('<a href="x">&')).toBe(
            '&lt;a href=&quot;x&quot;&gt;&amp;',
        );
    });

    it('escapes every occurrence (global replace)', () => {
        expect(escapeHtml('a<b<c')).toBe('a&lt;b&lt;c');
    });

    it('leaves safe text untouched', () => {
        expect(escapeHtml('hello world 123')).toBe('hello world 123');
    });
});
