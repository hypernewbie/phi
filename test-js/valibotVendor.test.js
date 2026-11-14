import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SPECIFIER = /['"](?:\.\.?\/)+vendor\/valibot\/index\.min\.mjs['"]/;

describe('vendored valibot', () => {
    it('is one self-contained module', () => {
        // The browser loads this file as-is, with no resolver and no bundler.
        // A bare specifier or a split chunk would 404 on first import, and
        // `check:vendors` cannot see that: it compares bytes, not reachability.
        const source = readFileSync(
            new URL('../web/vendor/valibot/index.min.mjs', import.meta.url),
            'utf8',
        );
        expect(source).not.toMatch(/\bfrom\s*["']/);
        expect(source).not.toMatch(/\bimport\s*\(/);
    });

    it('reserves the name v inside modules that import it', () => {
        // `v` is the valibot namespace in these modules. A local of the same
        // name reads like a schema, so a later `v.string()` on it fails at
        // runtime only.
        const binding =
            /\b(?:const|let|var)\s+v\b|\bcatch\s*\(\s*v\b|\bfunction\b[^(]*\(\s*v\s*[:,)]|\b(?:const|let|var)\s*[[{][^\n]*\bv\b[^\n]*[\]}]\s*=/;
        const offenders = [];
        const root = new URL('../web-src/', import.meta.url);
        for (const name of readdirSync(root, { recursive: true })) {
            if (!String(name).endsWith('.ts')) continue;
            const source = readFileSync(new URL(name, root), 'utf8');
            if (!SPECIFIER.test(source)) continue;
            for (const [index, line] of source.split('\n').entries()) {
                if (binding.test(line)) {
                    offenders.push(`${name}:${index + 1}: ${line.trim()}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});
