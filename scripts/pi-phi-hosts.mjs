#!/usr/bin/env node
// Isolated packaged-CLI loading checks for both pinned Pi versions.
// Each version loads the committed bundle from a module-less directory
// whose path contains spaces, drives a hermetic print-mode run against
// a local stub provider, and reports identities to the Go testserver.
// Unprovisioned and bad-credential runs must not prevent startup,
// input, or output. Exits nonzero with all failures.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
    copyFileSync,
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'phi-pi-hosts-'));
const failures = [];

function fail(version, what, detail = '') {
    failures.push(`${version}: ${what}${detail ? ` — ${detail}` : ''}`);
}

function run(cmd, args, opts = {}) {
    return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts });
}

// Provider stub: every completion fails like a 401 after a short delay.
// Stub hits prove the prompt reached the agent loop (input works). The
// delay simulates real provider latency and gives the extension's async
// gRPC dial time to complete: without it, a warmed-up Pi can exit in
// ~35ms, before the handshake finishes (observed flake).
let stubHits = 0;
const stub = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
        stubHits += 1;
        setTimeout(() => {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(
                JSON.stringify({
                    error: { message: 'hosts stub denies all completions' },
                }),
            );
        }, 2000);
    });
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const stubPort = stub.address().port;

// Per-version isolated identity: HOME, agent dir with the stub provider,
// and work dir. Pi versions must not share config and cache locations;
// their on-disk formats differ and cross-version reuse is unsupported.
function makeVersionDirs(name) {
    const home = join(tmp, `home-${name}`);
    const agentDir = join(tmp, `agent-${name}`);
    const workDir = join(tmp, `work-${name}`);
    mkdirSync(home, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    writeFileSync(
        join(agentDir, 'models.json'),
        JSON.stringify({
            providers: {
                'hosts-stub': {
                    baseUrl: `http://127.0.0.1:${stubPort}/v1`,
                    api: 'openai-completions',
                    apiKey: 'hosts-dummy',
                    models: [{ id: 'probe' }],
                },
            },
        }),
    );
    return { home, agentDir, workDir };
}

// Module-less extension dir with spaces: bundle copy plus fixtures.
const extDir = join(tmp, 'pi phi ext dir');
mkdirSync(extDir, { recursive: true });
copyFileSync(
    join(root, 'bonus', 'pi-phi', 'dist', 'pi-phi-extension.cjs'),
    join(extDir, 'pi-phi-extension.cjs'),
);
const probePath = join(extDir, 'probe.cjs');
writeFileSync(
    probePath,
    `const fs = require('node:fs');\n` +
        `const out = process.env.PROBE_LOG;\n` +
        `module.exports = function (pi) {\n` +
        `    for (const ev of ['session_start', 'agent_start', 'agent_settled', 'session_shutdown']) {\n` +
        `        pi.on(ev, (event, ctx) => {\n` +
        `            const rec = { ev };\n` +
        `            try { rec.session = ctx.sessionManager.getSessionId(); } catch (_e) {}\n` +
        `            try { rec.leaf = ctx.sessionManager.getLeafId(); } catch (_e) {}\n` +
        `            try { rec.model = ctx.model ? ctx.model.provider + '/' + ctx.model.id : null; } catch (_e) {}\n` +
        `            if (event && typeof event === 'object' && 'aborted' in event) rec.aborted = event.aborted;\n` +
        `            fs.appendFileSync(out, JSON.stringify(rec) + '\\n');\n` +
        `        });\n` +
        `    }\n` +
        `};\n`,
);
const extFiles = readdirSync(extDir).sort();
if (
    extFiles.join(',') !== 'pi-phi-extension.cjs,probe.cjs' ||
    !extDir.includes(' ')
) {
    fail(
        'setup',
        'extension dir is not module-less with spaces',
        extFiles.join(','),
    );
}

// Go testserver as the assertion backend. Built once; started fresh per
// version so leases and streams never cross version boundaries.
const bin = join(tmp, 'testserver');
{
    const built = run(
        'go',
        ['build', '-o', bin, './internal/pibridge/testserver'],
        {
            env: {
                ...process.env,
                GOCACHE: join(tmp, 'gocache'),
                GOTMPDIR: tmp,
            },
        },
    );
    if (built.status !== 0) {
        console.error(built.stderr || built.stdout);
        fail('setup', 'testserver build failed');
    }
}
async function startTestserver() {
    const server = spawn(bin, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    let buffer = '';
    const lineQueue = [];
    const lineWaiters = [];
    server.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        for (;;) {
            const idx = buffer.indexOf('\n');
            if (idx < 0) break;
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (line.length > 0) {
                const waiter = lineWaiters.shift();
                if (waiter) waiter(line);
                else lineQueue.push(line);
            }
        }
    });
    function readLine(timeoutMs = 15_000) {
        const queued = lineQueue.shift();
        if (queued !== undefined) return Promise.resolve(queued);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error('testserver read timeout')),
                timeoutMs,
            );
            lineWaiters.push((line) => {
                clearTimeout(timer);
                resolve(line);
            });
        });
    }
    async function control(op) {
        server.stdin.write(JSON.stringify(op) + '\n');
        return JSON.parse(await readLine());
    }
    const ready = JSON.parse(await readLine());
    async function stop() {
        server.stdin.write(JSON.stringify({ op: 'shutdown' }) + '\n');
        await new Promise((resolve) => server.once('exit', resolve));
    }
    return { control, target: ready.target, stop };
}

function spawnPi(cmd, args, env, cwd, timeoutMs = 120_000) {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, {
            cwd,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => {
            stdout += c.toString('utf8');
        });
        child.stderr.on('data', (c) => {
            stderr += c.toString('utf8');
        });
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve({ code: null, stdout, stderr, timeout: true });
        }, timeoutMs);
        child.on('exit', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr, timeout: false });
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            resolve({
                code: null,
                stdout,
                stderr: String(err),
                timeout: false,
            });
        });
    });
}

const localCli = join(
    root,
    'node_modules',
    '@earendil-works',
    'pi-coding-agent',
    'dist',
    'bundle',
    'cli.js',
);
if (!existsSync(localCli))
    fail('setup', 'workspace pi 1.0.1 bundle missing', localCli);
// Pi 1.3.0 runs from a pre-installed copy under tmp so the isolated HOME
// (which hides the user's pnpm store) cannot break module resolution.
// Installed once with the outer environment, then invoked via node like
// the workspace bundle. Network or a warm pnpm store is required here;
// the Pi spawns themselves are hermetic.
let cli130 = '';
{
    const pkgDir = join(tmp, 'pkg130');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({ name: 'phi-pi-hosts-130', private: true }),
    );
    const added = run(
        'pnpm',
        [
            'add',
            '--silent',
            '--ignore-scripts',
            '@earendil-works/pi-coding-agent@1.3.0',
        ],
        { cwd: pkgDir },
    );
    if (added.status !== 0) {
        fail(
            'setup',
            'pi 1.3.0 install failed',
            (added.stderr || added.stdout || '').slice(-300),
        );
    } else {
        cli130 = join(
            pkgDir,
            'node_modules',
            '@earendil-works',
            'pi-coding-agent',
            'dist',
            'bundle',
            'cli.js',
        );
        if (!existsSync(cli130))
            fail('setup', 'pi 1.3.0 bundle missing', cli130);
    }
}
const versions = [
    { name: '1.0.1', cmd: process.execPath, args: [localCli] },
    { name: '1.3.0', cmd: process.execPath, args: [cli130] },
];

for (const version of versions) {
    const pane = `hosts-${version.name}`;
    const { control, target, stop } = await startTestserver();
    const reg = await control({ op: 'register', pane });
    if (!reg.ok) {
        fail(version.name, 'register failed', reg.error);
        await stop();
        continue;
    }
    await control({ op: 'complete', process: reg.process });
    const { home, agentDir, workDir } = makeVersionDirs(
        version.name.replaceAll('.', '_'),
    );
    const probeLog = join(tmp, `probe-${version.name}.log`);
    const sessionDir = join(tmp, `sessions-${version.name}`);
    mkdirSync(sessionDir, { recursive: true });
    const env = {
        ...process.env,
        HOME: home,
        PI_CODING_AGENT_DIR: agentDir,
        PROBE_LOG: probeLog,
        PHI_PI_BRIDGE_ENDPOINT: target,
        PHI_PI_BRIDGE_PANE_ID: pane,
        PHI_PI_BRIDGE_PROCESS_ID: reg.process,
        PHI_PI_BRIDGE_TOKEN: reg.token,
    };
    const printArgs = [
        '--print',
        '--no-session',
        '--session-dir',
        sessionDir,
        '--model',
        'hosts-stub/probe',
        '--extension',
        join(extDir, 'pi-phi-extension.cjs'),
        '--extension',
        probePath,
        '--',
        'say hello',
    ];
    stubHits = 0;
    const run = await spawnPi(
        version.cmd,
        [...version.args, ...printArgs],
        env,
        workDir,
    );
    // The stub denies every completion, so Pi always exits nonzero here.
    // Startup success means the process exited (not hung) after reaching
    // the agent loop, producing output, and emitting lifecycle events.
    // An extension-load failure exits before the loop and fails below via
    // stub hits and the probe log, with stderr kept in the detail.
    if (run.timeout) {
        fail(version.name, 'provisioned run timed out');
    } else if (run.code === null) {
        fail(
            version.name,
            'provisioned run did not exit',
            (run.stderr || run.stdout).slice(-300),
        );
    }
    if (stubHits < 1) {
        fail(
            version.name,
            'prompt never reached the agent loop',
            (run.stderr || run.stdout).slice(-300),
        );
    }

    let events = [];
    try {
        events = readFileSync(probeLog, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
    } catch (err) {
        fail(version.name, 'probe log unreadable', String(err));
    }
    const kinds = events.map((e) => e.ev);
    // Retries emit extra agent_start edges before the single settlement;
    // the bridge treats them as one logical run. Accept one or more
    // starts followed by exactly one settled between start and shutdown.
    const middle = kinds.slice(1, -1);
    const flowOk =
        kinds.length >= 4 &&
        kinds[0] === 'session_start' &&
        kinds[kinds.length - 1] === 'session_shutdown' &&
        middle.length >= 2 &&
        middle[middle.length - 1] === 'agent_settled' &&
        middle.slice(0, -1).every((k) => k === 'agent_start');
    if (!flowOk) {
        fail(version.name, 'event flow', kinds.join(',') || '(none)');
    }
    const edgeCount = middle.filter(
        (k) => k === 'agent_start' || k === 'agent_settled',
    ).length;
    const sessions = new Set(events.map((e) => e.session));
    const models = new Set(events.map((e) => e.model));
    if (sessions.size !== 1 || sessions.has(undefined))
        fail(version.name, 'session identity', [...sessions].join(','));
    if (models.size !== 1 || ![...models][0]?.endsWith('/probe')) {
        fail(version.name, 'model identity', [...models].join(','));
    }
    // Pi forks a new leaf per retry, so the probe sees several leaves and
    // the bridge reports the leaf from its last transition. All observed
    // leaves must belong to the one stable session; the bridge leaf must
    // be one of them.
    const settledEvent = events.find((e) => e.ev === 'agent_settled');
    if (
        version.name === '1.3.0' &&
        settledEvent &&
        !('aborted' in settledEvent)
    ) {
        fail(version.name, '1.3.0 settled event lacks the abort bit');
    }

    const view = await control({ op: 'inspect', process: reg.process });
    if (!view.ok) {
        fail(version.name, 'inspect failed', view.error);
    } else {
        if (view.generation !== '1')
            fail(version.name, 'generation', view.generation);
        if (!view.runtimeId) fail(version.name, 'runtime id missing');
        if ((view.caps || []).join(',') !== 'pi.lifecycle.v1') {
            fail(version.name, 'accepted caps', (view.caps || []).join(','));
        }
        if (view.session !== events[0]?.session)
            fail(version.name, 'bridge session', view.session);
        const probeLeaves = new Set(
            events
                .map((e) => e.leaf)
                .filter((l) => l !== undefined && l !== null),
        );
        if (!probeLeaves.has(view.leaf)) {
            fail(
                version.name,
                'bridge leaf',
                `${view.leaf} not in ${[...probeLeaves].join(',')}`,
            );
        }
        if (view.model !== 'hosts-stub/probe')
            fail(version.name, 'bridge model', view.model);
        if (view.journalLast !== String(edgeCount))
            fail(
                version.name,
                'journal edges',
                `${view.journalLast} want ${edgeCount}`,
            );
    }
    await control({ op: 'revoke', process: reg.process });

    // Optional-plugin failures must not prevent startup, input, or
    // output. The bundle loads but stays inert without credentials, and
    // a rejected credential fails the handshake without throwing into
    // Pi's agent loop. Both runs must still reach the stub provider.
    // NOTE: Pi itself exits(1) before the agent loop when an extension
    // FILE cannot load (missing path, top-level throw, invalid factory).
    // Phi therefore validates the runtime marker before materializing and
    // launches unmanaged (no --extension flag) on any provisioning
    // failure, so an unloadable file is never injected. These cases cover
    // the injected bundle's runtime failures, which the factory contains.
    const bundleArgs = [
        '--print',
        '--no-session',
        '--session-dir',
        sessionDir,
        '--model',
        'hosts-stub/probe',
        '--extension',
        join(extDir, 'pi-phi-extension.cjs'),
        '--',
        'say hello',
    ];
    for (const [label, creds] of [
        [
            'unprovisioned',
            {
                PHI_PI_BRIDGE_ENDPOINT: '',
                PHI_PI_BRIDGE_PANE_ID: '',
                PHI_PI_BRIDGE_PROCESS_ID: '',
                PHI_PI_BRIDGE_TOKEN: '',
            },
        ],
        [
            'bad-token',
            {
                PHI_PI_BRIDGE_ENDPOINT: target,
                PHI_PI_BRIDGE_PANE_ID: pane,
                PHI_PI_BRIDGE_PROCESS_ID: reg.process,
                PHI_PI_BRIDGE_TOKEN: '0'.repeat(64),
            },
        ],
    ]) {
        stubHits = 0;
        const contained = await spawnPi(
            version.cmd,
            [...version.args, ...bundleArgs],
            { ...env, ...creds },
            workDir,
        );
        if (contained.timeout) fail(version.name, `${label} run hung`);
        else if (contained.code === null) {
            fail(
                version.name,
                `${label} run did not exit`,
                contained.stderr.slice(-200),
            );
        }
        if (stubHits < 1) {
            fail(
                version.name,
                `${label} run blocked input`,
                (contained.stderr || contained.stdout).slice(-300),
            );
        }
        if ((contained.stdout + contained.stderr).trim().length === 0) {
            fail(version.name, `${label} run produced no output`);
        }
    }
    await stop();
}

stub.close();
if (failures.length > 0) {
    console.error(`pi-phi-hosts: ${failures.length} failure(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
}
rmSync(tmp, { recursive: true, force: true });
console.log(
    'pi-phi-hosts: both pinned hosts load, flow, and identify; inert and bad-credential runs contained',
);
