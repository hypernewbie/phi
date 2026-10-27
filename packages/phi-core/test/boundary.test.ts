import { spawnSync } from 'node:child_process';
import {
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));

it('keeps source imports independent of platforms and dependencies', () => {
    for (const file of readdirSync(join(root, 'src'), {
        recursive: true,
        encoding: 'utf8',
    })) {
        if (!file.endsWith('.ts')) continue;
        const source = readFileSync(join(root, 'src', file), 'utf8');
        const imports = [
            ...source.matchAll(
                /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"]([^'"]+)['"]/g,
            ),
        ];
        for (const [, specifier] of imports) {
            expect(specifier, file).toMatch(/^\.{1,2}\//);
        }
        expect(source, file).not.toMatch(
            /\b(?:window|document|navigator|localStorage|fetch|WebSocket|process|Buffer|setTimeout|setInterval)\b/,
        );
    }
});

it('rejects DOM and Node globals with the actual source compiler configuration', () => {
    const temp = mkdtempSync(join(root, 'node_modules/.boundary-'));
    try {
        writeFileSync(
            join(temp, 'probe.ts'),
            'document.title; window.location; process.pid; Buffer.alloc(1);',
        );
        writeFileSync(
            join(temp, 'tsconfig.json'),
            JSON.stringify({
                extends: join(root, 'tsconfig.json'),
                files: ['./probe.ts'],
                include: [],
            }),
        );
        const result = spawnSync(
            'pnpm',
            ['exec', 'tsc', '-p', join(temp, 'tsconfig.json')],
            {
                cwd: root,
                encoding: 'utf8',
                timeout: 30_000,
            },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).not.toBe(0);
        for (const name of ['document', 'window', 'process', 'Buffer']) {
            expect(result.stdout).toContain(`'${name}'`);
        }
    } finally {
        rmSync(temp, { recursive: true, force: true });
    }
}, 30_000);
