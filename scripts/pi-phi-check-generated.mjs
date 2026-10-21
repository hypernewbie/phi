#!/usr/bin/env node
// Fail on schema or bundle drift: regenerate the bindings and rebuild
// the runtime, then require byte-identical results to the committed
// canonical assets.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const run = (cmd, args, opts = {}) =>
    execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });

const status = (paths) =>
    execFileSync('git', ['status', '--porcelain', '--', ...paths], {
        cwd: root,
        encoding: 'utf8',
    }).trim();

// 1. Regenerate bindings; any diff is drift.
run('node', [join('scripts', 'pi-phi-generate.mjs')]);
const genDrift = status(['internal/pibridge/pb', 'bonus/pi-phi/src/gen']);
if (genDrift) {
    console.error(`generated bindings drift:\n${genDrift}`);
    process.exit(1);
}

// 2. Rebuild the bundle into a temp dir; bytes must match.
const tmp = mkdtempSync(join(tmpdir(), 'phi-pi-bundle-check-'));
try {
    const pkgDir = join(root, 'bonus/pi-phi');
    const esbuildBin = join(
        pkgDir,
        'node_modules',
        '.bin',
        process.platform === 'win32' ? 'esbuild.exe' : 'esbuild',
    );
    execFileSync(
        esbuildBin,
        [
            join('src', 'extension-entry.cts'),
            '--bundle',
            '--platform=node',
            '--target=node20',
            '--format=cjs',
            `--outfile=${join(tmp, 'pi-phi-extension.cjs')}`,
            '--log-level=warning',
        ],
        { cwd: pkgDir, stdio: 'inherit' },
    );
    const committed = readFileSync(
        join(pkgDir, 'dist', 'pi-phi-extension.cjs'),
    );
    const rebuilt = readFileSync(join(tmp, 'pi-phi-extension.cjs'));
    if (!committed.equals(rebuilt)) {
        console.error(
            `bundle drift: rebuilt dist/pi-phi-extension.cjs differs (${committed.length} vs ${rebuilt.length} bytes)`,
        );
        process.exit(1);
    }
} finally {
    rmSync(tmp, { recursive: true, force: true });
}

// 3. Regenerate third-party notices in place; any change is drift.
// Runs after the pristine bundle compare so an in-place rebuild can
// never mask bundle drift. Compares bytes, not git status: dist/ is
// generated output.
const noticesPath = join(root, 'bonus/pi-phi/dist/NOTICES.txt');
const noticesBefore = readFileSync(noticesPath);
run('node', [join('scripts', 'pi-phi-build.mjs')]);
const noticesAfter = readFileSync(noticesPath);
if (!noticesBefore.equals(noticesAfter)) {
    console.error(
        'notices drift: rebuilt dist/NOTICES.txt differs; run pnpm build:pi-phi',
    );
    process.exit(1);
}

console.log('pi-phi generated assets: no drift');
