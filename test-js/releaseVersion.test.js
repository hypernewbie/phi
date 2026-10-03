import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const release = JSON.parse(read('../npm/package.json')).version;

describe('release version consistency', () => {
    it('keeps the desktop package on the same version as the npm package', () => {
        expect(
            JSON.parse(read('../desktop/electron/package.json')).version,
        ).toBe(release);
    });

    it('ships the current version in the sidebar fallback, including source builds', () => {
        const badge = read('../web/index.html').match(
            /<button\b[^>]*\bid="phi-changelog-btn"[^>]*>([\s\S]*?)<\/button>/,
        );
        expect(badge).not.toBeNull();
        expect(badge[1].trim()).toBe(`v${release}`);
    });

    it('starts the changelog with the current version', () => {
        const newest = read('../web/changelog.md').match(/^## v([^\s]+) /m);
        expect(newest).not.toBeNull();
        expect(newest[1]).toBe(release);
    });
});
