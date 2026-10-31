#!/usr/bin/env node
// Isolated packaged-CLI loading checks for both pinned Pi versions.
// Each version loads the committed bundle from a module-less directory
// whose path contains spaces, drives a hermetic print-mode run against
// a local stub provider, and reports identities to the Go testserver.
// Each version also drives one interactive TUI run over a pty, where a
// probe calls the shipped history reader after real editor submissions.
// Unprovisioned and bad-credential runs must not prevent startup,
// input, or output. Exits nonzero with all failures.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const stubBodies = [];
let holdNextProviderResponse = false;
let heldProviderResponse = null;
const releaseHeldProviderResponse = () => {
    const release = heldProviderResponse;
    heldProviderResponse = null;
    release?.();
};
const stub = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
        stubHits += 1;
        try {
            stubBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
            stubBodies.push(null);
        }
        const deny = () => {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(
                JSON.stringify({
                    error: { message: 'hosts stub denies all completions' },
                }),
            );
        };
        if (holdNextProviderResponse) {
            holdNextProviderResponse = false;
            heldProviderResponse = deny;
        } else {
            setTimeout(deny, 2000);
        }
    });
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const stubPort = stub.address().port;

async function waitForHost(predicate, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`timeout waiting for ${label}`);
}

function imageDataUris(value, out = []) {
    if (typeof value === 'string') {
        if (/^data:image\/(png|jpeg);base64,/i.test(value)) out.push(value);
        return out;
    }
    if (Array.isArray(value)) {
        for (const item of value) imageDataUris(item, out);
    } else if (value && typeof value === 'object') {
        for (const item of Object.values(value)) imageDataUris(item, out);
    }
    return out;
}

function makeAttachmentHandoff(name) {
    const handoffRoot = join(tmp, `handoff-${name}`);
    mkdirSync(handoffRoot, { recursive: true, mode: 0o700 });
    const basename = 'att-0123456789abcdef.png';
    const bytes = readFileSync(join(root, 'web', 'vendor', 'logos', 'pi.png'));
    writeFileSync(join(handoffRoot, basename), bytes, { mode: 0o600 });
    return {
        root: handoffRoot,
        bytes,
        reference: {
            basename,
            size_bytes: bytes.length,
            mime_type: 'image/png',
            kind: 'image',
            sha256: createHash('sha256').update(bytes).digest('hex'),
        },
    };
}

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
        join(agentDir, 'settings.json'),
        JSON.stringify({
            defaultProjectTrust: 'never',
            quietStartup: true,
            enableInstallTelemetry: false,
            cacheWarming: 'off',
            retry: { enabled: false },
            compaction: { enabled: false },
        }),
    );
    writeFileSync(
        join(agentDir, 'models.json'),
        JSON.stringify({
            providers: {
                'hosts-stub': {
                    baseUrl: `http://127.0.0.1:${stubPort}/v1`,
                    api: 'openai-completions',
                    apiKey: 'hosts-dummy',
                    models: [{ id: 'probe', input: ['text', 'image'] }],
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
const probeHistoryPath = join(extDir, 'probe-history.cjs');
writeFileSync(
    probeHistoryPath,
    `const fs = require('node:fs');\n` +
        `const out = process.env.HISTORY_LOG;\n` +
        `const bundle = require('./pi-phi-extension.cjs');\n` +
        `module.exports = function (pi) {\n` +
        `    pi.on('session_start', (_e, ctx) => snapshot(ctx, 'start'));\n` +
        `    for (const ev of ['agent_end', 'agent_settled']) {\n` +
        `        pi.on(ev, (_e, ctx) => snapshot(ctx, ev));\n` +
        `    }\n` +
        `    function snapshot(ctx, phase) {\n` +
        `        const rec = { phase };\n` +
        `        try { rec.session = ctx.sessionManager.getSessionId(); } catch (_e) {}\n` +
        `        try {\n` +
        `            if (typeof bundle.readEditorHistory !== 'function') throw new Error('no-reader-export');\n` +
        `            const entries = bundle.readEditorHistory(ctx.ui);\n` +
        `            rec.available = entries !== null;\n` +
        `            rec.count = entries === null ? -1 : entries.length;\n` +
        `            rec.entries = entries;\n` +
        `        } catch (err) { rec.error = String(err); }\n` +
        `        try {\n` +
        `            const before = observe(ctx);\n` +
        `            bundle.readEditorHistory(ctx.ui);\n` +
        `            const after = observe(ctx);\n` +
        `            rec.neutral = JSON.stringify(before) === JSON.stringify(after);\n` +
        `        } catch (err) { rec.neutral = 'observe-failed:' + err; }\n` +
        `        fs.appendFileSync(out, JSON.stringify(rec) + '\\n');\n` +
        `    }\n` +
        `    function observe(ctx) {\n` +
        `        let tui = null;\n` +
        `        ctx.ui.setWidget('phi.probe.observe', (t) => { tui = t; return { render: () => [] }; }, { placement: 'belowEditor' });\n` +
        `        try {\n` +
        `            const ed = tui.getFocusedComponent();\n` +
        `            return { text: typeof ed.getText === 'function' ? ed.getText() : null, len: Array.isArray(ed.history) ? ed.history.length : -1, idx: ed.historyIndex, draft: ed.historyDraft };\n` +
        `        } finally { ctx.ui.setWidget('phi.probe.observe', undefined); }\n` +
        `    }\n` +
        `};\n`,
);
// Interactive prompt writer: runs outside Pi, polls the history log for
// readiness markers, and emits prompts on stdout, which the shell pipes
// to script(1)'s stdin. A real shell pipe is required: BSD script
// rejects node's socket-based pipe stdin (tcgetattr ioctl error).
// Always records its own outcome in HISTORY_WRITER_DONE, since the
// pipeline exit status only reflects script(1), not the writer.
const writerPath = join(tmp, 'history-writer.cjs');
writeFileSync(
    writerPath,
    `const fs = require('node:fs');\n` +
        `const LOG = process.env.HISTORY_LOG;\n` +
        `const DONE = process.env.HISTORY_WRITER_DONE;\n` +
        `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));\n` +
        `function recs() {\n` +
        `    try { return fs.readFileSync(LOG, 'utf8').trim().split('\\n').filter(Boolean).map((l) => JSON.parse(l)); }\n` +
        `    catch { return []; }\n` +
        `}\n` +
        `async function waitFor(pred, timeoutMs, label) {\n` +
        `    const t0 = Date.now();\n` +
        `    for (;;) {\n` +
        `        if (pred(recs())) return;\n` +
        `        if (Date.now() - t0 > timeoutMs) throw new Error('writer timeout: ' + label);\n` +
        `        await sleep(200);\n` +
        `    }\n` +
        `}\n` +
        `function settled(n) { return (rs) => rs.filter((r) => r.phase === 'agent_settled').length >= n; }\n` +
        `async function main() {\n` +
        `    await waitFor((rs) => rs.some((r) => r.phase === 'start'), 60000, 'start');\n` +
        `    await sleep(1500);\n` +
        `    process.stdout.write('say one\\r');\n` +
        `    await waitFor(settled(1), 90000, 'settled-1');\n` +
        `    await sleep(800);\n` +
        `    process.stdout.write('say one\\r');\n` +
        `    await waitFor(settled(2), 90000, 'settled-2');\n` +
        `    await sleep(800);\n` +
        `    process.stdout.write('!echo bang\\r');\n` +
        `    await sleep(6000);\n` +
        `    process.stdout.write('line1\\nline2\\r');\n` +
        `    await waitFor(settled(3), 90000, 'settled-3');\n` +
        `    await sleep(800);\n` +
        `    process.stdout.write('say last\\r');\n` +
        `    await waitFor(settled(4), 90000, 'settled-4');\n` +
        `    await sleep(800);\n` +
        `    fs.writeFileSync(DONE, JSON.stringify({ ok: true }));\n` +
        `    if (process.env.ATTACHMENT_READY) fs.writeFileSync(process.env.ATTACHMENT_READY, 'ready');\n` +
        `    if (process.env.ATTACHMENT_DONE) await waitFor(() => fs.existsSync(process.env.ATTACHMENT_DONE), 120000, 'attachment completion');\n` +
        `    process.stdout.write('\\x03\\x03');\n` +
        `    await sleep(3000);\n` +
        `}\n` +
        `main().catch(async (err) => {\n` +
        `    try { fs.writeFileSync(DONE, JSON.stringify({ ok: false, error: String(err && err.message || err) })); } catch {}\n` +
        `    try { process.stdout.write('\\x03\\x03'); } catch {}\n` +
        `    await sleep(3000);\n` +
        `    process.exit(2);\n` +
        `});\n`,
);
const extFiles = readdirSync(extDir).sort();
if (
    extFiles.join(',') !== 'pi-phi-extension.cjs,probe-history.cjs,probe.cjs' ||
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
    async function control(op, timeoutMs = 15_000) {
        server.stdin.write(JSON.stringify(op) + '\n');
        return JSON.parse(await readLine(timeoutMs));
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

// Interactive runs drive the real TUI editor through script(1), which
// owns the pty. Flags differ per platform; without script(1) the
// interactive history proof cannot run.
let scriptArgv = null;
{
    const found = run('sh', ['-c', 'command -v script']);
    if (found.status === 0) {
        if (process.platform === 'darwin') scriptArgv = ['-q', '/dev/null'];
        else if (process.platform === 'linux') scriptArgv = ['-qec'];
    }
}
const quoteArg = (a) => `'${a.replaceAll(`'`, `'\\''`)}'`;

// Run one interactive Pi: writer stdout pipes into script(1) stdin,
// script(1) hosts the pty Pi attaches to. Detached so the watchdog
// can kill the whole pipeline group on timeout.
function spawnInteractiveTui(
    writerArgs,
    piCmd,
    piArgs,
    env,
    cwd,
    timeoutMs = 240_000,
) {
    const piLine = [piCmd, ...piArgs].map(quoteArg).join(' ');
    const scriptLine =
        process.platform === 'linux'
            ? ['script', ...scriptArgv, piLine, '/dev/null']
                  .map(quoteArg)
                  .join(' ')
            : [
                  'script',
                  ...scriptArgv,
                  ...[piCmd, ...piArgs].map(quoteArg),
              ].join(' ');
    const pipeline = `${['node', ...writerArgs].map(quoteArg).join(' ')} | ${scriptLine}`;
    return new Promise((resolve) => {
        const child = spawn('sh', ['-c', pipeline], {
            cwd,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
        });
        let out = '';
        const keep = (c) => {
            out += c.toString('utf8');
            if (out.length > 60_000) out = out.slice(-60_000);
        };
        child.stdout.on('data', keep);
        child.stderr.on('data', keep);
        const timer = setTimeout(() => {
            try {
                process.kill(-child.pid, 'SIGKILL');
            } catch (_e) {}
            resolve({ code: null, out, timeout: true });
        }, timeoutMs);
        child.on('exit', (code) => {
            clearTimeout(timer);
            resolve({ code, out, timeout: false });
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            resolve({ code: null, out: String(err), timeout: false });
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
const versions = [{ name: '1.0.1', cmd: process.execPath, args: [localCli] }];
if (cli130)
    versions.push({ name: '1.3.0', cmd: process.execPath, args: [cli130] });

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
        // Allowlist only process-launch settings. Never pass provider keys or
        // the operator's Pi/config paths into a test host.
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        SYSTEMROOT: process.env.SYSTEMROOT,
        COMSPEC: process.env.COMSPEC,
        PATHEXT: process.env.PATHEXT,
        LANG: 'en_US.UTF-8',
        TMPDIR: tmp,
        TMP: tmp,
        TEMP: tmp,
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_CACHE_HOME: join(home, '.cache'),
        XDG_DATA_HOME: join(home, '.local', 'share'),
        HOME: home,
        USERPROFILE: home,
        APPDATA: join(home, 'AppData', 'Roaming'),
        LOCALAPPDATA: join(home, 'AppData', 'Local'),
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
    stubBodies.length = 0;
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
        if (
            (view.caps || []).join(',') !==
            'pi.compact.v1,pi.context.v1,pi.lifecycle.v1,pi.models.v1,pi.skills.v1,pi.thinking.v1'
        ) {
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
        stubBodies.length = 0;
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
    // Interactive history proof: the real TUI editor on this host,
    // driven over a pty. The probe loads the committed bundle and
    // calls the shipped reader after real submissions (ordinary,
    // consecutive duplicate, `!` bang, ctrl+j multiline). Print-mode
    // assertions alone do not prove this access path.
    if (scriptArgv === null) {
        fail(
            version.name,
            'interactive history proof unavailable',
            `script(1) is required on a supported macOS/Linux host (current: ${process.platform})`,
        );
    } else {
        const tuiPane = `hosts-tui-${version.name}`;
        const tuiReg = await control({ op: 'register', pane: tuiPane });
        if (!tuiReg.ok) {
            fail(version.name, 'interactive register failed', tuiReg.error);
        } else {
            await control({ op: 'complete', process: tuiReg.process });
            const historyLog = join(tmp, `history-${version.name}.log`);
            const tuiProbeLog = join(tmp, `tui-probe-${version.name}.log`);
            const writerDone = join(tmp, `writer-${version.name}.json`);
            const attachmentDone = join(tmp, `attachment-done-${version.name}`);
            const attachmentReady = join(
                tmp,
                `attachment-ready-${version.name}`,
            );
            const handoff = makeAttachmentHandoff(version.name);
            const tuiEnv = {
                ...env,
                PHI_PI_BRIDGE_PANE_ID: tuiPane,
                PHI_PI_BRIDGE_PROCESS_ID: tuiReg.process,
                PHI_PI_BRIDGE_TOKEN: tuiReg.token,
                HISTORY_LOG: historyLog,
                HISTORY_WRITER_DONE: writerDone,
                PROBE_LOG: tuiProbeLog,
                ATTACHMENT_DONE: attachmentDone,
                ATTACHMENT_READY: attachmentReady,
                PHI_PI_ATTACHMENT_ROOT: handoff.root,
            };
            const tuiArgs = [
                '--no-session',
                '--session-dir',
                sessionDir,
                '--model',
                'hosts-stub/probe',
                '--extension',
                join(extDir, 'pi-phi-extension.cjs'),
                '--extension',
                probeHistoryPath,
            ];
            const tuiPromise = spawnInteractiveTui(
                [writerPath],
                version.cmd,
                [...version.args, ...tuiArgs],
                tuiEnv,
                workDir,
            );
            try {
                await waitForHost(
                    () => existsSync(writerDone),
                    180_000,
                    'history writer readiness',
                );
                const writerState = JSON.parse(
                    readFileSync(writerDone, 'utf8'),
                );
                if (writerState.ok !== true)
                    throw new Error(
                        writerState.error || 'history writer failed',
                    );
                await waitForHost(
                    () => existsSync(attachmentReady),
                    10_000,
                    'attachment writer readiness',
                );
                const view = await control({
                    op: 'inspect',
                    process: tuiReg.process,
                });
                if (
                    !view.ok ||
                    !(view.caps || []).includes('pi.attachments.v1')
                ) {
                    fail(
                        version.name,
                        'attachment capability missing',
                        (view.caps || []).join(','),
                    );
                } else {
                    const before = stubBodies.length;
                    holdNextProviderResponse = true;
                    const started = Date.now();
                    const dispatched = await control(
                        {
                            op: 'attachment',
                            process: tuiReg.process,
                            generation: Number(view.generation),
                            session: view.session,
                            leaf: view.leaf,
                            provider: 'hosts-stub',
                            model: 'probe',
                            text: 'Inspect this public image fixture.',
                            attachments: [handoff.reference],
                            imageRequired: true,
                            timeoutMs: 20_000,
                        },
                        25_000,
                    );
                    const ackMs = Date.now() - started;
                    if (
                        !dispatched.ok ||
                        dispatched.outcome !==
                            'ATTACHMENT_PROMPT_OUTCOME_DISPATCHED'
                    ) {
                        fail(
                            version.name,
                            'attachment dispatch',
                            `${dispatched.error || dispatched.outcome || 'no outcome'} (${dispatched.reason || ''})`,
                        );
                    }
                    if (ackMs >= 2_000) {
                        fail(
                            version.name,
                            'attachment ack waited for provider response',
                            `${ackMs}ms`,
                        );
                    }
                    await waitForHost(
                        () =>
                            stubBodies
                                .slice(before)
                                .some(
                                    (request) =>
                                        imageDataUris(request).length > 0,
                                ),
                        30_000,
                        'native image provider payload',
                    );
                    const imageRequests = stubBodies
                        .slice(before)
                        .filter((request) => imageDataUris(request).length > 0);
                    if (imageRequests.length !== 1) {
                        fail(
                            version.name,
                            'native image request count',
                            String(imageRequests.length),
                        );
                    }
                    const uri = imageDataUris(imageRequests[0])[0] || '';
                    const encoded = uri.match(
                        /^data:image\/(png|jpeg);base64,(.+)$/i,
                    );
                    const decoded = encoded
                        ? Buffer.from(encoded[2], 'base64')
                        : Buffer.alloc(0);
                    const pngSignature = Buffer.from([
                        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
                    ]);
                    if (
                        !encoded ||
                        !decoded.subarray(0, 8).equals(pngSignature)
                    ) {
                        fail(
                            version.name,
                            'native image payload missing or invalid',
                            uri.slice(0, 32),
                        );
                    }
                    if (heldProviderResponse === null) {
                        fail(
                            version.name,
                            'provider response was not held during dispatch',
                        );
                    }
                    releaseHeldProviderResponse();
                    await new Promise((resolve) => setTimeout(resolve, 2_100));
                    if (
                        stubBodies
                            .slice(before)
                            .filter(
                                (request) => imageDataUris(request).length > 0,
                            ).length !== 1
                    ) {
                        fail(
                            version.name,
                            'duplicate native image provider request',
                        );
                    }
                }
            } catch (err) {
                fail(version.name, 'attachment smoke', String(err));
            } finally {
                holdNextProviderResponse = false;
                releaseHeldProviderResponse();
                writeFileSync(attachmentDone, 'done');
            }
            const tui = await tuiPromise;
            let writerOk = false;
            let writerError = '';
            try {
                const done = JSON.parse(readFileSync(writerDone, 'utf8'));
                writerOk = done.ok === true;
                writerError = done.error || '';
            } catch (err) {
                writerError = `writer done file unreadable: ${err}`;
            }
            if (tui.timeout) {
                fail(version.name, 'interactive run timed out', writerError);
            } else if (!writerOk) {
                fail(
                    version.name,
                    'interactive prompts not delivered',
                    `${writerError} ${tui.out.slice(-300)}`,
                );
            }
            let records = [];
            try {
                records = readFileSync(historyLog, 'utf8')
                    .trim()
                    .split('\n')
                    .filter(Boolean)
                    .map((line) => JSON.parse(line));
            } catch (err) {
                fail(version.name, 'history log unreadable', String(err));
            }
            const start = records.find((r) => r.phase === 'start');
            if (!start || start.available !== true) {
                fail(
                    version.name,
                    'reader unavailable at session start',
                    JSON.stringify(start || null),
                );
            } else if (start.count !== 0) {
                fail(
                    version.name,
                    'start history not empty',
                    String(start.count),
                );
            }
            const settled = records.filter((r) => r.phase === 'agent_settled');
            const want = ['say last', 'line1\nline2', '!echo bang', 'say one'];
            const last = settled[settled.length - 1];
            if (settled.length < 4) {
                fail(
                    version.name,
                    'settled snapshots',
                    `${settled.length} want >= 4`,
                );
            } else if (JSON.stringify(last.entries) !== JSON.stringify(want)) {
                fail(
                    version.name,
                    'editor history entries',
                    JSON.stringify(last.entries),
                );
            }
            const dup = settled[1];
            if (
                dup &&
                JSON.stringify(dup.entries) !== JSON.stringify(['say one'])
            ) {
                fail(
                    version.name,
                    'duplicate collapse',
                    JSON.stringify(dup.entries),
                );
            }
            for (const r of records) {
                if (r.available !== true || r.neutral !== true || r.error) {
                    fail(
                        version.name,
                        `history snapshot ${r.phase}`,
                        JSON.stringify(r).slice(0, 300),
                    );
                    break;
                }
            }
            const tuiView = await control({
                op: 'inspect',
                process: tuiReg.process,
            });
            if (!tuiView.ok) {
                fail(version.name, 'interactive inspect failed', tuiView.error);
            } else {
                if (tuiView.generation !== '1') {
                    fail(
                        version.name,
                        'interactive generation',
                        tuiView.generation,
                    );
                }
                if (
                    (tuiView.caps || []).join(',') !==
                    'pi.attachments.v1,pi.compact.v1,pi.context.v1,pi.history.v1,pi.lifecycle.v1,pi.models.v1,pi.skills.v1,pi.thinking.v1'
                ) {
                    fail(
                        version.name,
                        'interactive accepted caps',
                        (tuiView.caps || []).join(','),
                    );
                }
                if (tuiView.session !== start?.session) {
                    fail(
                        version.name,
                        'interactive bridge session',
                        tuiView.session,
                    );
                }
                if (tuiView.model !== 'hosts-stub/probe') {
                    fail(
                        version.name,
                        'interactive bridge model',
                        tuiView.model,
                    );
                }
            }
            await control({ op: 'revoke', process: tuiReg.process });
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
    'pi-phi-hosts: both pinned hosts load, flow, and identify; inert and bad-credential runs contained; interactive history and native image dispatch proven',
);
