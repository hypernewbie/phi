#!/usr/bin/env node
// Isolated packaged-CLI loading checks for both pinned Pi versions.
// Each version loads the committed bundle from a module-less directory
// whose path contains spaces, drives a hermetic print-mode run against
// a local stub provider, and reports identities to the Go testserver.
// Each version also drives real interactive history and native Syncboard
// calls over a pty, including tool withdrawal and re-exposure on reconnect.
// Unprovisioned and bad-credential runs must not prevent startup,
// input, or output. Exits nonzero with all failures.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
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

// The default provider path denies completions. A second mode below drives
// real native Syncboard calls for both packaged Pi versions.
let stubHits = 0;
let syncboardMode = false;
let syncboardProviderRequests = 0;
let syncboardProviderError = '';
let syncboardStatePath = '';
let syncboardKey = '';
let syncboardValue = null;

function hostToolResults(messages) {
    if (!Array.isArray(messages)) return [];
    const out = [];
    for (const message of messages) {
        if (!message || typeof message !== 'object' || message.role !== 'user')
            continue;
        if (!Array.isArray(message.content)) continue;
        for (const block of message.content) {
            if (
                !block ||
                typeof block !== 'object' ||
                block.type !== 'tool_result'
            )
                continue;
            if (typeof block.content === 'string') out.push(block.content);
            else if (Array.isArray(block.content)) {
                out.push(
                    block.content
                        .filter((part) => part && typeof part.text === 'string')
                        .map((part) => part.text)
                        .join('\n'),
                );
            }
        }
    }
    return out;
}

function hostAnthropicEvents(model, body) {
    const tool = body?.type === 'tool_use';
    const rows = [
        [
            'message_start',
            {
                type: 'message_start',
                message: {
                    id: `msg_hosts_${Date.now()}`,
                    type: 'message',
                    role: 'assistant',
                    model,
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 20, output_tokens: 0 },
                },
            },
        ],
    ];
    if (tool) {
        rows.push([
            'content_block_start',
            {
                type: 'content_block_start',
                index: 0,
                content_block: {
                    type: 'tool_use',
                    id: body.id,
                    name: 'syncboard',
                    input: {},
                },
            },
        ]);
        rows.push([
            'content_block_delta',
            {
                type: 'content_block_delta',
                index: 0,
                delta: {
                    type: 'input_json_delta',
                    partial_json: JSON.stringify(body.input),
                },
            },
        ]);
    } else {
        rows.push([
            'content_block_start',
            {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' },
            },
        ]);
        rows.push([
            'content_block_delta',
            {
                type: 'content_block_delta',
                index: 0,
                delta: {
                    type: 'text_delta',
                    text: body?.text || 'Syncboard verified.',
                },
            },
        ]);
    }
    rows.push(['content_block_stop', { type: 'content_block_stop', index: 0 }]);
    rows.push([
        'message_delta',
        {
            type: 'message_delta',
            delta: {
                stop_reason: tool ? 'tool_use' : 'end_turn',
                stop_sequence: null,
            },
            usage: { output_tokens: 4 },
        },
    ]);
    rows.push(['message_stop', { type: 'message_stop' }]);
    return rows
        .map(
            ([name, data]) =>
                `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`,
        )
        .join('');
}

function respondToHostSyncboard(res, raw) {
    const model = 'hosts-syncboard-probe';
    try {
        const body = JSON.parse(raw);
        const tools = Array.isArray(body.tools) ? body.tools : [];
        const results = hostToolResults(body.messages);
        syncboardProviderRequests += 1;
        let reply;
        if (
            syncboardProviderRequests === 1 ||
            syncboardProviderRequests === 4
        ) {
            if (!tools.some((tool) => tool && tool.name === 'syncboard'))
                throw new Error('native Syncboard declaration missing');
            const expectedResults = syncboardProviderRequests === 1 ? 0 : 2;
            if (results.length !== expectedResults)
                throw new Error(
                    `expected ${expectedResults} prior results, got ${results.length}`,
                );
            reply =
                syncboardProviderRequests === 1
                    ? {
                          type: 'tool_use',
                          id: 'hosts_syncboard_upsert',
                          input: {
                              operation: 'upsert',
                              key: syncboardKey,
                              value: syncboardValue,
                          },
                      }
                    : {
                          type: 'tool_use',
                          id: 'hosts_syncboard_list_after_reconnect',
                          input: { operation: 'list' },
                      };
        } else if (syncboardProviderRequests === 2) {
            const result = JSON.parse(results[0] || 'null');
            if (
                !result ||
                result.key !== syncboardKey ||
                result.value !== JSON.stringify(syncboardValue)
            )
                throw new Error('upsert result mismatch');
            reply = {
                type: 'tool_use',
                id: 'hosts_syncboard_list',
                input: { operation: 'list' },
            };
        } else if (syncboardProviderRequests === 3) {
            const result = JSON.parse(results[1] || 'null');
            if (
                !Array.isArray(result) ||
                !result.some(
                    (item) =>
                        item.key === syncboardKey &&
                        item.value === JSON.stringify(syncboardValue),
                )
            )
                throw new Error('initial list result mismatch');
            writeFileSync(
                syncboardStatePath,
                JSON.stringify({
                    roundOne: true,
                    requests: syncboardProviderRequests,
                }),
            );
            reply = { type: 'text' };
        } else if (syncboardProviderRequests === 5) {
            const result = JSON.parse(results[2] || 'null');
            if (
                !Array.isArray(result) ||
                !result.some(
                    (item) =>
                        item.key === syncboardKey &&
                        item.value === JSON.stringify(syncboardValue),
                )
            )
                throw new Error('reconnected list result mismatch');
            writeFileSync(
                syncboardStatePath,
                JSON.stringify({
                    roundOne: true,
                    roundTwo: true,
                    requests: syncboardProviderRequests,
                }),
            );
            reply = { type: 'text' };
        } else {
            throw new Error(
                `unexpected provider request ${syncboardProviderRequests}`,
            );
        }
        res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
        });
        res.end(hostAnthropicEvents(model, reply));
    } catch (cause) {
        syncboardProviderError =
            cause instanceof Error ? cause.message : String(cause);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: syncboardProviderError }));
    }
}

const stub = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
        const path = new URL(req.url || '/', 'http://127.0.0.1').pathname;
        if (syncboardMode && path.endsWith('/count_tokens')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ input_tokens: 20 }));
            return;
        }
        if (syncboardMode && path.endsWith('/v1/messages')) {
            respondToHostSyncboard(res, Buffer.concat(chunks).toString('utf8'));
            return;
        }
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
                'hosts-syncboard': {
                    baseUrl: `http://127.0.0.1:${stubPort}`,
                    api: 'anthropic-messages',
                    apiKey: 'hosts-syncboard-dummy',
                    models: [{ id: 'syncboard-probe' }],
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
        `    const syncLog = process.env.SYNCBOARD_LOG;\n` +
        `    if (syncLog) {\n` +
        `        pi.on('session_start', () => {\n` +
        `            let previous;\n` +
        `            let attempts = 0;\n` +
        `            const timer = setInterval(() => {\n` +
        `                attempts += 1;\n` +
        `                try {\n` +
        `                    const tools = pi.getActiveTools();\n` +
        `                    const available = tools.includes('syncboard');\n` +
        `                    if (available !== previous) {\n` +
        `                        fs.appendFileSync(syncLog, JSON.stringify({ available, tools, at: Date.now() }) + '\\n');\n` +
        `                        previous = available;\n` +
        `                    }\n` +
        `                } catch {}\n` +
        `                if (attempts >= 1800) clearInterval(timer);\n` +
        `            }, 100);\n` +
        `            pi.on('session_shutdown', () => clearInterval(timer));\n` +
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
const syncboardWriterPath = join(tmp, 'syncboard-writer.cjs');
writeFileSync(
    syncboardWriterPath,
    `const fs = require('node:fs');\n` +
        `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));\n` +
        `const read = (path) => { try { return fs.readFileSync(path, 'utf8'); } catch { return ''; } };\n` +
        `const records = () => read(process.env.SYNCBOARD_LOG).split('\\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);\n` +
        `const state = () => { try { return JSON.parse(read(process.env.SYNCBOARD_STATE) || '{}'); } catch { return {}; } };\n` +
        `const seq = (want) => { let i = 0; for (const r of records()) if (r.available === want[i]) i++; return i === want.length; };\n` +
        `async function waitFor(pred, ms, label) { const end = Date.now() + ms; while (Date.now() < end) { if (fs.existsSync(process.env.SYNCBOARD_ABORT)) throw new Error('aborted'); if (pred()) return; await sleep(100); } throw new Error('timeout: ' + label); }\n` +
        `const settled = (n) => read(process.env.PROBE_LOG).split('\\n').filter((line) => { try { return JSON.parse(line).ev === 'agent_settled'; } catch { return false; } }).length >= n;\n` +
        `async function main() {\n` +
        `    await waitFor(() => fs.existsSync(process.env.SYNCBOARD_READY), 60000, 'bridge readiness');\n` +
        `    process.stdout.write('Save the item to Syncboard, then list the board.\\r');\n` +
        `    await waitFor(() => state().roundOne === true && settled(1), 90000, 'first tool turn');\n` +
        `    fs.writeFileSync(process.env.SYNCBOARD_DROP_REQUEST, 'ready');\n` +
        `    await waitFor(() => fs.existsSync(process.env.SYNCBOARD_DROP_DONE), 30000, 'bridge drop');\n` +
        `    await waitFor(() => seq([true, false]), 30000, 'tool withdrawal');\n` +
        `    await waitFor(() => fs.existsSync(process.env.SYNCBOARD_RESUME_DONE), 30000, 'bridge resume');\n` +
        `    await waitFor(() => seq([true, false, true]), 30000, 'tool re-exposure');\n` +
        `    process.stdout.write('List the saved item from Syncboard.\\r');\n` +
        `    await waitFor(() => state().roundTwo === true && settled(2), 90000, 'reconnected tool turn');\n` +
        `    fs.writeFileSync(process.env.SYNCBOARD_WRITER_DONE, JSON.stringify({ ok: true }));\n` +
        `    process.stdout.write('\\x03\\x03');\n` +
        `    await sleep(2000);\n` +
        `}\n` +
        `main().catch(async (err) => { try { fs.writeFileSync(process.env.SYNCBOARD_WRITER_DONE, JSON.stringify({ ok: false, error: String(err && err.message || err) })); } catch {} try { process.stdout.write('\\x03\\x03'); } catch {} await sleep(2000); });\n`,
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
    async function control(op) {
        server.stdin.write(`${JSON.stringify(op)}\n`);
        return JSON.parse(await readLine());
    }
    const ready = JSON.parse(await readLine());
    async function stop() {
        server.stdin.write(`${JSON.stringify({ op: 'shutdown' })}\n`);
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

function startHostBridgeProxy(upstreamPath, proxyPath) {
    if (!existsSync(upstreamPath) || !statSync(upstreamPath).isSocket())
        throw new Error('testserver bridge socket is unavailable');
    if (Buffer.byteLength(proxyPath) > 100 || existsSync(proxyPath))
        throw new Error('host bridge proxy path is not publishable');
    const pairs = new Set();
    let forwarded = 0;
    let listening = false;
    const server = net.createServer((downstream) => {
        const upstream = net.connect(upstreamPath);
        const pair = { downstream, upstream };
        pairs.add(pair);
        const forget = () => pairs.delete(pair);
        downstream.on('close', forget);
        upstream.on('close', forget);
        downstream.on('error', () => {});
        upstream.on('error', () => {});
        upstream.on('connect', () => {
            forwarded += 1;
        });
        downstream.pipe(upstream);
        upstream.pipe(downstream);
    });
    const listen = () =>
        new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(proxyPath, () => {
                server.removeListener('error', reject);
                chmodSync(proxyPath, 0o600);
                listening = true;
                resolve();
            });
        });
    const drop = async () => {
        for (const pair of pairs) {
            pair.downstream.destroy();
            pair.upstream.destroy();
        }
        pairs.clear();
        if (!listening) return;
        await new Promise((resolve, reject) =>
            server.close((err) => (err ? reject(err) : resolve())),
        );
        listening = false;
    };
    return (async () => {
        await listen();
        return {
            target: `unix:${proxyPath}`,
            forwarded: () => forwarded,
            drop,
            resume: listen,
            close: async () => {
                await drop();
                try {
                    unlinkSync(proxyPath);
                } catch {}
            },
        };
    })();
}

async function waitForHostCondition(predicate, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timeout waiting for ${label}`);
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
// Use the local 1.3.0 CLI when provided. This keeps host checks offline;
// the fallback installs the pinned package into an isolated temp directory.
let cli130 = '';
const cli130Override = process.env.PI_PHI_HOST_130_CLI;
if (cli130Override) {
    const candidate = resolve(cli130Override);
    try {
        const packageDir = dirname(dirname(dirname(candidate)));
        const packageJson = JSON.parse(
            readFileSync(join(packageDir, 'package.json'), 'utf8'),
        );
        if (
            !statSync(candidate).isFile() ||
            basename(dirname(candidate)) !== 'bundle' ||
            basename(dirname(dirname(candidate))) !== 'dist' ||
            packageJson.name !== '@earendil-works/pi-coding-agent' ||
            packageJson.version !== '1.3.0'
        ) {
            throw new Error('unexpected Pi package or CLI path');
        }
        cli130 = candidate;
    } catch (error) {
        fail(
            'setup',
            'PI_PHI_HOST_130_CLI must be an existing Pi 1.3.0 dist/bundle/cli.js',
            `${candidate}: ${String(error)}`,
        );
    }
} else {
    // Pi 1.3.0 runs from a pre-installed copy under tmp so the isolated HOME
    // (which hides the user's pnpm store) cannot break module resolution.
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
            'pi.compact.v1,pi.context.v1,pi.lifecycle.v1,pi.models.v1,pi.skills.v1,pi.syncboard.v1,pi.thinking.v1'
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

    // One real interactive tool run on each packaged host proves delayed
    // registration, dispatch, withdrawal, and re-exposure after reconnect.
    if (scriptArgv === null) {
        fail(version.name, 'Syncboard host proof requires script(1)');
    } else {
        const nativePane = `hosts-syncboard-${version.name}`;
        const nativeReg = await control({ op: 'register', pane: nativePane });
        let proxy;
        let nativeRun;
        const abortPath = join(tmp, `syncboard-abort-${version.name}`);
        const readyPath = join(tmp, `syncboard-ready-${version.name}`);
        const dropRequestPath = join(
            tmp,
            `syncboard-drop-request-${version.name}`,
        );
        const dropDonePath = join(tmp, `syncboard-drop-done-${version.name}`);
        const resumeDonePath = join(
            tmp,
            `syncboard-resume-done-${version.name}`,
        );
        const writerDonePath = join(
            tmp,
            `syncboard-writer-done-${version.name}.json`,
        );
        const availabilityPath = join(
            tmp,
            `syncboard-availability-${version.name}.jsonl`,
        );
        const statePath = join(tmp, `syncboard-state-${version.name}.json`);
        const nativeProbePath = join(
            tmp,
            `syncboard-probe-${version.name}.jsonl`,
        );
        if (!nativeReg.ok) {
            fail(version.name, 'Syncboard register failed', nativeReg.error);
        } else {
            await control({ op: 'complete', process: nativeReg.process });
            syncboardMode = true;
            syncboardProviderRequests = 0;
            syncboardProviderError = '';
            syncboardStatePath = statePath;
            syncboardKey = `pi-host-syncboard-${version.name}`;
            syncboardValue = {
                host: version.name,
                marker: 'PHI_HOST_SYNCBOARD_NATIVE_OK',
            };
            writeFileSync(statePath, '{}');
            const socketPath = target.slice('unix:'.length);
            const proxyPath = join(
                dirname(socketPath),
                `h-${version.name.replaceAll('.', '')}.sock`,
            );
            try {
                proxy = await startHostBridgeProxy(socketPath, proxyPath);
                const nativeEnv = {
                    ...env,
                    PHI_PI_BRIDGE_ENDPOINT: proxy.target,
                    PHI_PI_BRIDGE_PANE_ID: nativePane,
                    PHI_PI_BRIDGE_PROCESS_ID: nativeReg.process,
                    PHI_PI_BRIDGE_TOKEN: nativeReg.token,
                    PROBE_LOG: nativeProbePath,
                    SYNCBOARD_LOG: availabilityPath,
                    SYNCBOARD_STATE: statePath,
                    SYNCBOARD_READY: readyPath,
                    SYNCBOARD_DROP_REQUEST: dropRequestPath,
                    SYNCBOARD_DROP_DONE: dropDonePath,
                    SYNCBOARD_RESUME_DONE: resumeDonePath,
                    SYNCBOARD_WRITER_DONE: writerDonePath,
                    SYNCBOARD_ABORT: abortPath,
                };
                const nativeArgs = [
                    '--no-session',
                    '--session-dir',
                    sessionDir,
                    '--model',
                    'hosts-syncboard/syncboard-probe',
                    '--extension',
                    join(extDir, 'pi-phi-extension.cjs'),
                    '--extension',
                    probePath,
                ];
                nativeRun = spawnInteractiveTui(
                    [syncboardWriterPath],
                    version.cmd,
                    [...version.args, ...nativeArgs],
                    nativeEnv,
                    workDir,
                    180_000,
                );
                const availability = () => {
                    try {
                        return readFileSync(availabilityPath, 'utf8')
                            .trim()
                            .split('\n')
                            .filter(Boolean)
                            .map((line) => JSON.parse(line));
                    } catch {
                        return [];
                    }
                };
                const hasSequence = (values) => {
                    let index = 0;
                    for (const record of availability()) {
                        if (record.available === values[index]) index += 1;
                    }
                    return index === values.length;
                };
                await waitForHostCondition(
                    async () => {
                        const view = await control({
                            op: 'inspect',
                            process: nativeReg.process,
                        });
                        return (
                            view.ok &&
                            (view.caps || []).includes('pi.syncboard.v1') &&
                            availability().some(
                                (record) => record.available === true,
                            )
                        );
                    },
                    30_000,
                    'accepted Syncboard capability and Pi tool readiness',
                );
                writeFileSync(readyPath, 'ready');

                await waitForHostCondition(
                    () => existsSync(dropRequestPath),
                    120_000,
                    'first Syncboard turn',
                );
                await proxy.drop();
                await waitForHostCondition(
                    () => hasSequence([true, false]),
                    15_000,
                    'Syncboard withdrawal',
                );
                writeFileSync(dropDonePath, 'dropped');
                await proxy.resume();
                await waitForHostCondition(
                    async () => {
                        const view = await control({
                            op: 'inspect',
                            process: nativeReg.process,
                        });
                        return (
                            view.ok &&
                            (view.caps || []).includes('pi.syncboard.v1') &&
                            hasSequence([true, false, true]) &&
                            proxy.forwarded() >= 2
                        );
                    },
                    30_000,
                    'Syncboard re-exposure after bridge reconnect',
                );
                writeFileSync(resumeDonePath, 'resumed');

                const tui = await nativeRun;
                let writer;
                try {
                    writer = JSON.parse(readFileSync(writerDonePath, 'utf8'));
                } catch (cause) {
                    writer = { ok: false, error: String(cause) };
                }
                if (tui.timeout || writer.ok !== true)
                    fail(
                        version.name,
                        'Syncboard native TUI run',
                        `${writer.error || 'timed out'} ${(tui.out || '').slice(-250)}`,
                    );
                if (syncboardProviderError)
                    fail(
                        version.name,
                        'Syncboard provider',
                        syncboardProviderError,
                    );
                if (syncboardProviderRequests !== 5)
                    fail(
                        version.name,
                        'Syncboard provider request count',
                        String(syncboardProviderRequests),
                    );
                const message = await control({
                    op: 'syncboard-inspect',
                    key: syncboardKey,
                });
                if (
                    !message.ok ||
                    message.syncboardMessage?.value !==
                        JSON.stringify(syncboardValue)
                )
                    fail(
                        version.name,
                        'Syncboard host stored result',
                        JSON.stringify(message),
                    );
                const stats = await control({ op: 'syncboard-stats' });
                if (
                    stats.syncboardCalls !== 3 ||
                    stats.syncboardMutations !== 1
                )
                    fail(
                        version.name,
                        'Syncboard host request counts',
                        JSON.stringify(stats),
                    );
                const records = availability();
                if (!hasSequence([true, false, true]))
                    fail(
                        version.name,
                        'Syncboard availability transitions',
                        JSON.stringify(records),
                    );
                const ordinaryTools = records.map((record) =>
                    JSON.stringify(
                        (record.tools || [])
                            .filter((name) => name !== 'syncboard')
                            .sort(),
                    ),
                );
                if (ordinaryTools.some((tools) => tools !== ordinaryTools[0]))
                    fail(
                        version.name,
                        'unrelated tools changed during Syncboard transitions',
                        JSON.stringify(records),
                    );
                if (!(records[0]?.tools || []).includes('read'))
                    fail(
                        version.name,
                        'built-in read tool missing during Syncboard proof',
                    );
            } catch (cause) {
                writeFileSync(abortPath, 'abort');
                fail(
                    version.name,
                    'Syncboard native host proof',
                    String(cause),
                );
                if (nativeRun) await nativeRun;
            } finally {
                syncboardMode = false;
                await proxy?.close();
                await control({ op: 'revoke', process: nativeReg.process });
            }
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
            const writerDone = join(tmp, `writer-${version.name}.json`);
            const tuiEnv = {
                ...env,
                PHI_PI_BRIDGE_PANE_ID: tuiPane,
                PHI_PI_BRIDGE_PROCESS_ID: tuiReg.process,
                PHI_PI_BRIDGE_TOKEN: tuiReg.token,
                HISTORY_LOG: historyLog,
                HISTORY_WRITER_DONE: writerDone,
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
            const tui = await spawnInteractiveTui(
                [writerPath],
                version.cmd,
                [...version.args, ...tuiArgs],
                tuiEnv,
                workDir,
            );
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
            if (start?.available !== true) {
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
                    'pi.compact.v1,pi.context.v1,pi.history.v1,pi.lifecycle.v1,pi.models.v1,pi.reload.v1,pi.skills.v1,pi.syncboard.v1,pi.thinking.v1'
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
    'pi-phi-hosts: both pinned hosts load, identify, execute Syncboard, withdraw/re-expose its tool, and retain interactive history and Reload capability; fallback runs contained',
);
