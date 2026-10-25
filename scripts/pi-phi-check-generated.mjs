#!/usr/bin/env node
// Fail on schema or bundle drift: regenerate the bindings and rebuild
// the runtime, then require file-set- and byte-identical results to the
// worktree's canonical assets. Generated-output comparison uses bytes,
// never Git status, so consistent uncommitted outputs pass. Importing
// this module is side-effect free; the check runs only when executed.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(new URL('..', import.meta.url).pathname);
const GEN_DIRS = ['internal/pibridge/pb', 'bonus/pi-phi/src/gen'];

/**
 * Snapshot a generated tree as relative path -> bytes. A missing
 * directory snapshots as empty, so missing outputs read as drift
 * against the regeneration that recreates them.
 */
export function snapshotTree(dir) {
    const out = new Map();
    const walk = (abs, rel) => {
        let entries;
        try {
            entries = readdirSync(abs, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const childAbs = join(abs, entry.name);
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(childAbs, childRel);
            else if (entry.isFile()) out.set(childRel, readFileSync(childAbs));
        }
    };
    walk(dir, '');
    return out;
}

/**
 * Compare a worktree snapshot against a fresh regeneration. Returns
 * drift descriptions; empty means the file set and bytes agree.
 */
export function diffSnapshots(before, after) {
    const drift = [];
    for (const [name, bytes] of before) {
        if (!after.has(name)) drift.push(`only in worktree: ${name}`);
        else if (!bytes.equals(after.get(name))) {
            drift.push(`bytes differ: ${name}`);
        }
    }
    for (const name of after.keys()) {
        if (!before.has(name)) drift.push(`only after regeneration: ${name}`);
    }
    return drift.sort();
}

const run = (cmd, args, opts = {}) =>
    execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });

function main() {
    // 1. Regenerate bindings; any file-set/bytes change is drift.
    const before = new Map(
        GEN_DIRS.map((dir) => [dir, snapshotTree(join(root, dir))]),
    );
    run('node', [join('scripts', 'pi-phi-generate.mjs')]);
    const drift = [];
    for (const dir of GEN_DIRS) {
        for (const line of diffSnapshots(
            before.get(dir),
            snapshotTree(join(root, dir)),
        )) {
            drift.push(`${dir}: ${line}`);
        }
    }
    if (drift.length > 0) {
        console.error(`generated bindings drift:\n${drift.join('\n')}`);
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
}

const invokedDirectly =
    typeof process.argv[1] === 'string' &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
