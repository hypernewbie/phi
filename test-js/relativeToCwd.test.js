import { describe, it, expect } from 'vitest';
import { relativeToCwd } from '../web/util.js';

// relativeToCwd strips the cwd prefix from a file path. These tests lock in
// the CURRENT behavior, including two known quirks (case-sensitivity and
// naive prefix matching) that are intentionally preserved — see util.js.

describe('relativeToCwd', () => {
    it('returns the path relative to cwd', () => {
        expect(
            relativeToCwd('/home/user/proj/src/a.js', '/home/user/proj'),
        ).toBe('src/a.js');
    });

    it('normalizes backslashes on both sides', () => {
        expect(relativeToCwd('C:\\proj\\src\\a.js', 'C:\\proj')).toBe(
            'src/a.js',
        );
    });

    it('strips exactly one leading slash after the prefix', () => {
        expect(relativeToCwd('/proj/a.js', '/proj')).toBe('a.js');
        expect(relativeToCwd('/proj//a.js', '/proj')).toBe('/a.js');
    });

    it('returns the full (normalized) path when cwd is empty', () => {
        expect(relativeToCwd('C:\\proj\\a.js', '')).toBe('C:/proj/a.js');
        expect(relativeToCwd('/proj/a.js', null)).toBe('/proj/a.js');
        expect(relativeToCwd('/proj/a.js', undefined)).toBe('/proj/a.js');
    });

    it('returns the full path when cwd is not a prefix', () => {
        expect(relativeToCwd('/other/a.js', '/proj')).toBe('/other/a.js');
    });

    // --- documented quirks (intentionally preserved) ---
    it('QUIRK: case-sensitive prefix (no match on case difference)', () => {
        expect(relativeToCwd('/Proj/a.js', '/proj')).toBe('/Proj/a.js');
    });

    it('QUIRK: naive startsWith matches partial segment names', () => {
        // cwd '/foo' is a string-prefix of '/foobar', so it strips it.
        expect(relativeToCwd('/foobar/a.js', '/foo')).toBe('bar/a.js');
    });

    it('QUIRK: throws on nullish path (no defensive guard, matches original)', () => {
        expect(() => relativeToCwd(undefined, '/proj')).toThrow();
        expect(() => relativeToCwd(null, '/proj')).toThrow();
    });
});
