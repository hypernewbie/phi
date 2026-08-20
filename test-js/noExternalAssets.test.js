// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

// phi is routinely run on a LAN box, behind a tunnel, or fully airgapped.
// Every remote asset reference is a hard dependency on the public internet
// for something the UI needs to render, and a request the third party can
// see. Two were shipping:
//
//   fonts.googleapis.com / fonts.gstatic.com  -- Inter + JetBrains Mono
//   www.google.com/s2/favicons                -- all six coder logos
//
// Both are now vendored under web/vendor/. This test fails if any come back.

const WEB = join(process.cwd(), 'web');
const SCAN_EXT = new Set(['.html', '.css', '.js', '.ts']);

// web/vendor holds third-party bundles we ship verbatim; their sources may
// legitimately mention remote URLs in comments or sourcemap hints.
const SKIP_DIRS = new Set(['vendor', 'node_modules']);

// Hosts that are asset providers -- a reference here means the browser
// fetches something at page load.
const ASSET_HOSTS = [
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'www.google.com/s2/favicons',
    'cdn.jsdelivr.net',
    'unpkg.com',
    'cdnjs.cloudflare.com',
    'ajax.googleapis.com',
    'esm.sh',
    'cdn.skypack.dev',
    'stackpath.bootstrapcdn.com',
];

function walk(dir) {
    const out = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            if (SKIP_DIRS.has(entry)) continue;
            out.push(...walk(full));
        } else if (SCAN_EXT.has(extname(entry))) {
            out.push(full);
        }
    }
    return out;
}

// A URL inside a comment is documentation (e.g. "do not restore the remote
// link"), not a fetch. Strip comments before scanning so the guard's own
// rationale does not trip it.
function stripComments(text) {
    return text
        .replace(/<!--[\s\S]*?-->/g, '') // html
        .replace(/\/\*[\s\S]*?\*\//g, '') // block
        .replace(/^\s*\/\/.*$/gm, ''); // line
}

describe('no external asset references in web/', () => {
    const files = walk(WEB);

    it('scans a meaningful number of files', () => {
        // Guard against the walker silently matching nothing.
        expect(files.length).toBeGreaterThan(5);
    });

    it.each(ASSET_HOSTS)('does not reference %s', (host) => {
        const offenders = files
            .map((f) => [f, stripComments(readFileSync(f, 'utf8'))])
            .filter(([, body]) => body.includes(host))
            .map(([f]) => f.replace(process.cwd(), '').replace(/\\/g, '/'));

        expect(
            offenders,
            `${host} referenced in: ${offenders.join(', ')}`,
        ).toEqual([]);
    });

    it('has the vendored replacements on disk and non-empty', () => {
        const required = [
            'vendor/fonts/fonts.css',
            'vendor/logos/opencode.png',
            'vendor/logos/claude.png',
            'vendor/logos/agy.png',
            'vendor/logos/pi.png',
            'vendor/logos/bash.jpg',
            'vendor/logos/review.png',
        ];
        for (const rel of required) {
            expect(statSync(join(WEB, rel)).size, rel).toBeGreaterThan(0);
        }
    });

    it('vendored font css points only at local woff2 files', () => {
        const css = readFileSync(join(WEB, 'vendor/fonts/fonts.css'), 'utf8');
        const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) =>
            m[1].replace(/['"]/g, ''),
        );
        expect(urls.length).toBeGreaterThan(0);
        for (const u of urls) {
            expect(u.startsWith('http'), `remote font url: ${u}`).toBe(false);
            expect(u.endsWith('.woff2'), `unexpected font url: ${u}`).toBe(
                true,
            );
            expect(statSync(join(WEB, 'vendor/fonts', u)).size).toBeGreaterThan(
                0,
            );
        }
    });

    it('keeps the greek subset, which phi renders in the UI font', () => {
        // The activity indicator draws U+03A6 / U+03D5 in --font-ui. Dropping
        // the greek subset to save bytes would silently fall back to a system
        // font for the one glyph the whole title grammar is built on.
        const css = readFileSync(join(WEB, 'vendor/fonts/fonts.css'), 'utf8');
        expect(css).toMatch(/U\+0370-0377/);
    });
});
