import { describe, it, expect } from 'vitest';
import { normalizeCwd } from '../web/diff.js';

// normalizeCwd is diff.js's shell-tab-reuse path matcher. Unlike sessions.js
// normalizePath, it is intentionally case-SENSITIVE (see the comment in
// diff.js: path equality is OS-dependent and both sides come from the same
// os.Getwd). It also strips a RUN of trailing slashes, not just one.

describe('normalizeCwd', () => {
    it('returns empty string for falsy input', () => {
        expect(normalizeCwd('')).toBe('');
        expect(normalizeCwd(null)).toBe('');
        expect(normalizeCwd(undefined)).toBe('');
    });

    it('converts backslashes to forward slashes', () => {
        expect(normalizeCwd('C:\\Users\\Foo')).toBe('C:/Users/Foo');
    });

    it('strips a run of trailing slashes', () => {
        expect(normalizeCwd('/home/user///')).toBe('/home/user');
        expect(normalizeCwd('C:\\proj\\\\')).toBe('C:/proj');
    });

    it('preserves case (case-sensitive by design)', () => {
        expect(normalizeCwd('C:/Foo/Bar')).toBe('C:/Foo/Bar');
        expect(normalizeCwd('C:/Foo')).not.toBe(normalizeCwd('c:/foo'));
    });

    it('coerces non-string input via String()', () => {
        expect(normalizeCwd(123)).toBe('123');
    });
});
