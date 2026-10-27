import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));

it('resolves the workspace core without importing a legacy platform', async () => {
    expect(await import('@phi/core')).toBeDefined();
});

it('keeps network, persistence, timing, and rendering globals inside platform owners', () => {
    for (const file of readdirSync(join(root, 'src'), {
        recursive: true,
        encoding: 'utf8',
    })) {
        if (!/\.tsx?$/.test(file) || file.endsWith('.d.ts')) continue;
        const source = readFileSync(join(root, 'src', file), 'utf8');
        expect(source, file).not.toMatch(
            /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"][^'"]*(?:web-src|\/web\/|desktop\/|node:)/,
        );
        if (file.startsWith('platform/')) continue;
        expect(source, file).not.toMatch(
            /\b(?:window|navigator|localStorage|sessionStorage|fetch|WebSocket|setTimeout|setInterval|requestAnimationFrame)\b/,
        );
        if (file !== 'main.tsx') {
            expect(source, file).not.toMatch(
                /\bdocument\b|['"](?:react-dom|@xterm\/)/,
            );
        }
    }
});

it('keeps source, unit, and browser compiler discovery explicit without NodeNext inheritance', () => {
    const source = JSON.parse(
        readFileSync(join(root, 'tsconfig.json'), 'utf8'),
    );
    const unit = JSON.parse(
        readFileSync(join(root, 'tsconfig.test.json'), 'utf8'),
    );
    const browser = JSON.parse(
        readFileSync(join(root, 'tsconfig.e2e.json'), 'utf8'),
    );
    expect(source.extends).toBeUndefined();
    expect(source.compilerOptions).toMatchObject({
        moduleResolution: 'Bundler',
        jsx: 'react-jsx',
        strict: true,
        noEmit: true,
    });
    expect(unit.include).toEqual(
        expect.arrayContaining([
            'src/vite-env.d.ts',
            'vite.config.js',
            'test/**/*.ts',
            'test/**/*.tsx',
        ]),
    );
    expect(unit.exclude).toContain('test/e2e/**');
    expect(browser.include).toEqual(
        expect.arrayContaining([
            'src/vite-env.d.ts',
            'playwright.config.ts',
            'test/e2e/**/*.ts',
        ]),
    );
});
