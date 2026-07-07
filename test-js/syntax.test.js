import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Guard against parse-level breakage in the browser JS. terminal.js once
// shipped a duplicate `const` (a SyntaxError) that no test caught because the
// controllers are never imported by unit tests. `node --check` parses each
// file the same way a browser's module loader would, so a broken file fails
// here instead of silently failing to load in the app.

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const jsFiles = readdirSync(webDir)
    .filter((f) => f.endsWith('.js'))
    .sort();

describe('web/*.js parse cleanly (node --check)', () => {
    it('finds JS files to check', () => {
        expect(jsFiles.length).toBeGreaterThan(0);
    });

    it.each(jsFiles)('%s has no syntax errors', (file) => {
        expect(() => {
            execFileSync(process.execPath, ['--check', join(webDir, file)], {
                stdio: 'pipe',
            });
        }).not.toThrow();
    });
});
