import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { v } from '../web/valibot.js';

const bundle = readFileSync(
    new URL('../web/valibot.js', import.meta.url),
    'utf8',
);

// Guards the shipped browser runtime, not valibot itself: a facade that stops
// exporting a function breaks every converted module at load time. Schema
// behavior is covered by the modules that use it.
describe('shipped valibot runtime', () => {
    it('exposes every function the facade declares', () => {
        const expected = [
            'array',
            'boolean',
            'check',
            'exactOptional',
            'fallback',
            'finite',
            'integer',
            'literal',
            'maxBytes',
            'maxLength',
            'maxValue',
            'minLength',
            'minValue',
            'null',
            'nullable',
            'number',
            'object',
            'optional',
            'picklist',
            'pipe',
            'record',
            'safeInteger',
            'safeParse',
            'string',
            'strictObject',
            'transform',
            'union',
            'unknown',
        ];
        expect(Object.keys(v).sort()).toEqual(expected.sort());
        for (const name of expected) {
            expect(typeof v[name], name).toBe('function');
        }
    });

    it('reserves the name v inside modules that import the facade', () => {
        // `v` is the facade in these modules. A local of the same name reads
        // like a schema, so a later `v.string()` on it fails at runtime only.
        const binding =
            /\b(?:const|let|var)\s+v\b|\bcatch\s*\(\s*v\b|\bfunction\b[^(]*\(\s*v\s*[:,)]|\b(?:const|let|var)\s*[[{][^\n]*\bv\b[^\n]*[\]}]\s*=/;
        const offenders = [];
        const root = new URL('../web-src/', import.meta.url);
        for (const name of readdirSync(root, { recursive: true })) {
            if (!String(name).endsWith('.ts')) continue;
            const source = readFileSync(new URL(name, root), 'utf8');
            if (!source.includes("'./valibot.js'")) continue;
            for (const [index, line] of source.split('\n').entries()) {
                if (binding.test(line)) {
                    offenders.push(`${name}:${index + 1}: ${line.trim()}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('stays self-contained and inside the size budget', () => {
        // The browser loads this as a plain module, with no import map and no
        // bundler. A bare import here breaks every converted module.
        expect(bundle).not.toMatch(/\bfrom\s*["']/);
        expect(bundle).not.toMatch(/\bimport\s*\(/);
        // Budget from the plan. Growing the facade is allowed; growing it by
        // accident is not, because every module pays for it on first load.
        expect(gzipSync(bundle, { level: 9 }).length).toBeLessThanOrEqual(4000);
    });
});
