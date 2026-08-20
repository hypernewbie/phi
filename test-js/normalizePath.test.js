import { describe, it, expect } from 'vitest';
import { normalizePath } from '../web/sessions.js';

// normalizePath is the sidebar/tab path-equality helper. It powers worktree
// highlighting and tab-context sync (commits bcb3ee5 / d862975). It is
// case-INSENSITIVE by design (Windows-friendly): backslashes -> slashes,
// one trailing slash stripped, then lowercased.

describe('normalizePath', () => {
    it('returns empty string for falsy input', () => {
        expect(normalizePath('')).toBe('');
        expect(normalizePath(null)).toBe('');
        expect(normalizePath(undefined)).toBe('');
    });

    it('converts backslashes to forward slashes', () => {
        expect(normalizePath('C:\\Users\\Foo')).toBe('c:/users/foo');
        expect(normalizePath('a\\b\\c')).toBe('a/b/c');
    });

    it('handles mixed separators', () => {
        expect(normalizePath('C:\\Users/Foo\\bar')).toBe('c:/users/foo/bar');
    });

    it('lowercases the whole path', () => {
        expect(normalizePath('/Home/User/PROJECT')).toBe('/home/user/project');
    });

    it('strips a single trailing slash', () => {
        expect(normalizePath('/home/user/')).toBe('/home/user');
        expect(normalizePath('C:\\proj\\')).toBe('c:/proj');
    });

    it('preserves the root slash (does not strip when length is 1)', () => {
        expect(normalizePath('/')).toBe('/');
    });

    it('treats case- and separator-variant paths as equal', () => {
        expect(normalizePath('C:\\Users\\Foo')).toBe(
            normalizePath('c:/users/foo'),
        );
        expect(normalizePath('C:\\Users\\Foo\\')).toBe(
            normalizePath('c:/users/foo'),
        );
    });

    it('is idempotent', () => {
        const inputs = ['C:\\Users\\Foo\\', '/Home/User/', 'a\\b', '/', ''];
        for (const p of inputs) {
            expect(normalizePath(normalizePath(p))).toBe(normalizePath(p));
        }
    });

    it('only strips one trailing separator (not a run)', () => {
        // Note: normalizePath strips exactly one trailing '/', unlike diff.js
        // normalizeCwd which strips a run. This documents the current behavior.
        expect(normalizePath('/home/user//')).toBe('/home/user/');
    });
});
