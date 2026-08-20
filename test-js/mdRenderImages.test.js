// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { resolveRelative, rewriteRelativeImages } from '../web/md-render.js';

// Local-image rewriting for markdown rendering (web-src/md-render.ts):
// relative <img> srcs are resolved against the .md file's directory and
// pointed at /api/markdown/asset; absolute/special srcs stay untouched.

describe('resolveRelative', () => {
    it('joins a plain filename onto the base dir', () => {
        expect(resolveRelative('/a/b', 'x.png')).toBe('/a/b/x.png');
    });

    it('ignores a leading ./ segment', () => {
        expect(resolveRelative('/a/b', './x.png')).toBe('/a/b/x.png');
    });

    it('collapses ../ into the parent dir', () => {
        expect(resolveRelative('/a/b', '../x.png')).toBe('/a/x.png');
    });

    it('collapses interior sub/../ segments', () => {
        expect(resolveRelative('/a/b', 'sub/../x.png')).toBe('/a/b/x.png');
    });
});

describe('rewriteRelativeImages', () => {
    function containerWith(html) {
        const div = document.createElement('div');
        div.innerHTML = html;
        return div;
    }

    it('rewrites a relative src to the asset endpoint with URL-encoded params', () => {
        const c = containerWith('<img src="images/pic.png">');
        rewriteRelativeImages(c, '/work space/docs/readme.md', '/work space');
        // getAttribute, NOT .src — the property would return jsdom's
        // resolved absolute URL and mask what we actually wrote.
        expect(c.querySelector('img').getAttribute('src')).toBe(
            `/api/markdown/asset?path=${encodeURIComponent('/work space/docs/images/pic.png')}` +
                `&cwd=${encodeURIComponent('/work space')}`,
        );
    });

    it('strips ?/# suffixes before resolving', () => {
        const c = containerWith('<img src="pic.png?v=2">');
        rewriteRelativeImages(c, '/docs/readme.md', '/docs');
        expect(c.querySelector('img').getAttribute('src')).toBe(
            `/api/markdown/asset?path=${encodeURIComponent('/docs/pic.png')}` +
                `&cwd=${encodeURIComponent('/docs')}`,
        );
    });

    it('leaves absolute and special srcs untouched', () => {
        const untouched = [
            'https://cdn.example/x.png',
            '//cdn.example/x.png',
            '/abs/x.png',
            'data:image/png;base64,AAAA',
            '#frag',
        ];
        for (const src of untouched) {
            const c = containerWith(`<img src="${src}">`);
            rewriteRelativeImages(c, '/docs/readme.md', '/docs');
            expect(c.querySelector('img').getAttribute('src')).toBe(src);
        }
    });
});
