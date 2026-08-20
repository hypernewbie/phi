// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { worktreeGlyph, WORKTREE_GLYPHS } from '../web/util.js';

// worktreeGlyph deterministically maps a cwd to one of WORKTREE_GLYPHS.
// Pool is now 96 real Egyptian Hieroglyphs from U+13000-U+1342F, sampled
// for category variety and width-filtered for legibility. The bigger pool
// dramatically cuts collision rates at realistic workloads (4-10
// worktrees): <5% vs the old 12-entry pool's ~30%+.

describe('worktreeGlyph', () => {
    it('returns the fallback glyph for falsy input', () => {
        expect(worktreeGlyph('')).toBe('◆');
        expect(worktreeGlyph(null)).toBe('◆');
        expect(worktreeGlyph(undefined)).toBe('◆');
    });

    it('returns a member of WORKTREE_GLYPHS for any input', () => {
        const candidates = [
            '/home/user/project/worktree-a',
            '/Users/dev/code/feat-x',
            'C:\\code\\github\\phi\\branch-y',
            '/srv/app/very/deep/nested/path/feature-blah',
            '/short',
            'a', // single char
            // Some Windows-style paths too, since the pool hashes raw bytes.
            'C:\\Users\\dev\\project\\feat-z',
            '\\\\server\\share\\dir\\subdir',
        ];
        for (const cwd of candidates) {
            const g = worktreeGlyph(cwd);
            expect(WORKTREE_GLYPHS).toContain(g);
        }
    });

    it('is deterministic: same cwd always returns same glyph', () => {
        const cwd = '/Users/dev/code/myproject/feature-branch';
        const first = worktreeGlyph(cwd);
        for (let i = 0; i < 25; i++) {
            expect(worktreeGlyph(cwd)).toBe(first);
        }
    });

    it('every glyph is in the Egyptian Hieroglyphs Unicode block', () => {
        // Lock in the v0.8.5 decision: pool is real hieroglyphs, not the
        // old geometric symbols. This catches any regression where
        // someone tries to "just trim the pool" and accidentally pulls
        // a non-hieroglyph character in.
        for (const ch of WORKTREE_GLYPHS) {
            const cp = ch.codePointAt(0);
            expect(cp).toBeGreaterThanOrEqual(0x13000);
            expect(cp).toBeLessThanOrEqual(0x1342f);
        }
    });

    it('WORKTREE_GLYPHS has 96 unique entries (avoids accidental duplicates)', () => {
        // Pool was 12 in v0.8.4 (geometric), now 96 hieroglyphs.
        expect(WORKTREE_GLYPHS.length).toBe(96);
        expect(new Set(WORKTREE_GLYPHS).size).toBe(WORKTREE_GLYPHS.length);
    });

    it('distributes worktrees across the pool (24 different cwds -> >20 unique glyphs)', () => {
        // With 96 entries, 24 distinct cwds should land on 20+ distinct
        // glyphs by birthday-paradox bound. Loosened from the v0.8.4
        // assertion (6 of 12) since the new pool makes near-perfect
        // distribution trivial.
        const cwds = [
            '/a',
            '/b',
            '/c',
            '/d',
            '/e',
            '/foo',
            '/bar',
            '/baz',
            '/qux',
            '/quux',
            '/x/y',
            '/p/q',
            '/Users/dev/code/phi/main',
            '/Users/dev/code/phi/feature-a',
            '/Users/dev/code/sigma/main',
            '/Users/dev/code/sigma/feature-b',
            '/var/lib/data/worktree',
            '/var/lib/data/worktree-deep',
            '/srv/app/very/deep/nested/path/feature-blah',
            '/srv/app/very/deep/nested/path/feat-other',
            '/Users/dev/code/myproject/feature-branch',
            '/Users/dev/code/myproject/main',
            '/srv/app/x/y/z/w/q/r',
            '/home/me/projects/something',
        ];
        const seen = new Set(cwds.map(worktreeGlyph));
        expect(seen.size).toBeGreaterThanOrEqual(20);
    });

    it('different cwds that share a path segment usually get different glyphs', () => {
        // With a 96-pool, two random cwds collide ~1% of the time.
        // Picking 6 hand-curated cwds that differ meaningfully should
        // land on >=4 distinct glyphs (very conservative bound).
        const cwds = [
            '/Users/dev/code/phi/main',
            '/Users/dev/code/phi/feature-a',
            '/Users/dev/code/sigma/main',
            '/Users/dev/code/sigma/feature-b',
            '/var/lib/data/worktree',
            '/var/lib/data/worktree-deep',
        ];
        const seen = new Set(cwds.map(worktreeGlyph));
        expect(seen.size).toBeGreaterThanOrEqual(4);
    });

    it('handles Windows backslash paths without throwing', () => {
        // Hashing charCodes is byte-by-byte - backslashes and forward
        // slashes hash to different values, which is correct (they ARE
        // different chars). Just verify it doesn't throw and returns
        // a pool member.
        const g = worktreeGlyph('C:\\code\\github\\phi\\feat-x');
        expect(WORKTREE_GLYPHS).toContain(g);
    });

    it('produces no empty string or undefined from any pool member', () => {
        // All 96 pool entries must be non-empty strings - if any entry
        // was silently stripped during the hieroglyph sampling, this
        // catches it.
        for (const ch of WORKTREE_GLYPHS) {
            expect(typeof ch).toBe('string');
            expect(ch.length).toBeGreaterThan(0);
        }
    });
});
