// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    synchronize,
    VENDOR_GROUPS,
} from '../scripts/sync-frontend-vendors.mjs';

function makeFixture() {
    const rootDir = mkdtempSync(join(tmpdir(), 'phi-vendor-sync-'));
    const vendorDir = join(rootDir, 'web', 'vendor');
    const packageDirs = new Map();
    let sourceId = 0;

    for (const entries of Object.values(VENDOR_GROUPS)) {
        for (const entry of entries) {
            let packageDir = packageDirs.get(entry.packageName);
            if (!packageDir) {
                packageDir = join(
                    rootDir,
                    'packages',
                    String(packageDirs.size),
                );
                packageDirs.set(entry.packageName, packageDir);
            }
            if (entry.kind === 'license') {
                mkdirSync(packageDir, { recursive: true });
                writeFileSync(
                    join(packageDir, 'LICENSE'),
                    `license for ${entry.packageName}\n`,
                );
                continue;
            }
            const source = join(packageDir, entry.source);
            if (entry.kind === 'directory') {
                mkdirSync(source, { recursive: true });
                writeFileSync(join(source, 'root.bin'), `root-${sourceId++}`);
                mkdirSync(join(source, 'nested'), { recursive: true });
                writeFileSync(
                    join(source, 'nested', 'child.bin'),
                    `nested-${sourceId++}`,
                );
            } else {
                mkdirSync(join(source, '..'), { recursive: true });
                writeFileSync(source, `file-${sourceId++}`);
            }
        }
    }

    return {
        rootDir,
        vendorDir,
        resolvePackageDir: (packageName) => packageDirs.get(packageName),
        cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
    };
}

describe('sync-frontend-vendors', () => {
    it('selects one group, copies bytes, and recursively checks PDF trees', () => {
        const fixture = makeFixture();
        try {
            synchronize({
                ...fixture,
                group: 'xterm',
            });

            const xtermSource = join(
                fixture.resolvePackageDir('@xterm/xterm'),
                'lib/xterm.js',
            );
            const xtermDestination = join(fixture.vendorDir, 'xterm.js');
            expect(readFileSync(xtermDestination)).toEqual(
                readFileSync(xtermSource),
            );
            expect(existsSync(join(fixture.vendorDir, 'jsdiff.min.js'))).toBe(
                false,
            );

            synchronize({
                ...fixture,
                group: 'preview',
            });
            const pdfCmapSource = join(
                fixture.resolvePackageDir('pdfjs-dist'),
                'cmaps/nested/child.bin',
            );
            const pdfCmapDestination = join(
                fixture.vendorDir,
                'pdfjs/cmaps/nested/child.bin',
            );
            expect(readFileSync(pdfCmapDestination)).toEqual(
                readFileSync(pdfCmapSource),
            );

            writeFileSync(pdfCmapSource, 'changed source');
            writeFileSync(
                join(fixture.vendorDir, 'pdfjs/cmaps/stale.bcmap'),
                'stale destination',
            );
            const result = synchronize({
                ...fixture,
                group: 'preview',
                check: true,
            });
            expect(result.stale).toEqual(
                expect.arrayContaining([
                    'pdfjs/cmaps/nested/child.bin',
                    'pdfjs/cmaps/stale.bcmap',
                ]),
            );
            expect(result.stale).toHaveLength(2);
        } finally {
            fixture.cleanup();
        }
    });
});
