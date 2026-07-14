// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { worktreeGlyph, WORKTREE_GLYPHS } from '../web/util.js';

// worktreeGlyph deterministically maps a cwd to one of WORKTREE_GLYPHS.
// Used to give each worktree a unique monochrome shape so tabs can be
// grouped at a glance by shape rather than by reading text.

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

    it('avoids generic shapes: never returns a plain circle', () => {
        // ● ◯ ● etc. are off-limits per spec — too generic, conflicts with
        // existing markers/avatars.
        for (const cwd of [
            '/a', '/b', '/c', '/x/y', '/foo/bar/baz',
            '/home/user/proj-a', '/home/user/proj-b', '/home/user/proj-c',
            '/code/one', '/code/two',
        ]) {
            const g = worktreeGlyph(cwd);
            expect(g).not.toMatch(/[●◯◎○◌]/);
        }
    });

    it('avoids star characters', () => {
        for (const cwd of [
            '/a', '/b', '/c', '/x/y', '/foo/bar/baz',
            '/home/user/proj-a', '/home/user/proj-b', '/home/user/proj-c',
        ]) {
            const g = worktreeGlyph(cwd);
            expect(g).not.toMatch(/[★☆✦✧✶✷]/);
        }
    });

    it('distributes worktrees across the pool (12 different cwds -> >6 unique glyphs)', () => {
        // Not a hard statistical test - just makes sure we don't accidentally
        // hash everything to one bucket.
        const cwds = [
            '/a', '/b', '/c', '/d', '/e',
            '/foo', '/bar', '/baz', '/qux', '/quux',
            '/x/y', '/p/q',
        ];
        const seen = new Set(cwds.map(worktreeGlyph));
        expect(seen.size).toBeGreaterThanOrEqual(6);
    });

    it('WORKTREE_GLYPHS has 12 unique entries (avoids accidental duplicates)', () => {
        expect(WORKTREE_GLYPHS.length).toBe(12);
        expect(new Set(WORKTREE_GLYPHS).size).toBe(WORKTREE_GLYPHS.length);
    });

    it('two distinct cwds that share a path segment get different glyphs (when possible)', () => {
        // Sanity: the collision rate is ~1/12, so we just verify we hit
        // 2 distinct glyphs across 6 hand-picked cwd pairs that differ
        // in non-trivial ways.
        const cwds = [
            '/Users/dev/code/phi/main',
            '/Users/dev/code/phi/feature-a',
            '/Users/dev/code/sigma/main',
            '/Users/dev/code/sigma/feature-b',
            '/var/lib/data/worktree',
            '/var/lib/data/worktree-deep',
        ];
        const seen = new Set(cwds.map(worktreeGlyph));
        expect(seen.size).toBeGreaterThanOrEqual(2);
    });
});
