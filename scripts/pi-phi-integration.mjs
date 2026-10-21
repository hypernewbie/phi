#!/usr/bin/env node
// M1 interop runner: builds the Go testserver, runs the TS integration
// suite over native Unix IPC, streams output, and exits nonzero with a
// small tail on failure. POSIX sh via node; no bashisms.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'phi-pi-integration-'));
const bin = join(tmp, 'testserver');
const goCache = join(tmp, 'gocache');

function run(cmd, args, opts = {}) {
    const res = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
    return res.status ?? 1;
}

function fail(message) {
    console.error(`pi-phi-integration: ${message}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
}

console.log(`pi-phi-integration: tmp=${tmp}`);
let code = run('go', ['build', '-o', bin, './internal/pibridge/testserver'], {
    env: { ...process.env, GOCACHE: goCache, GOTMPDIR: tmp },
});
if (code !== 0) fail(`testserver build exited ${code}`);

code = run(
    'pnpm',
    [
        '--filter',
        '@phi/pi-phi',
        'exec',
        'vitest',
        'run',
        '-c',
        'vitest.integration.config.mts',
    ],
    {
        env: {
            ...process.env,
            PI_PHI_TESTSERVER: bin,
            GOCACHE: goCache,
            GOTMPDIR: tmp,
        },
    },
);
rmSync(tmp, { recursive: true, force: true });
if (code !== 0) fail(`integration suite exited ${code}`);
console.log('pi-phi-integration: pass');
