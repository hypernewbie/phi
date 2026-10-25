// Minimal native context-compact fixture, shared by the durable spec
// (e2e/pi-context-compact.spec.ts) and the manual parent run. Real
// pinned Pi plus a loopback-only provider stub; no mocks, no summary
// overrides, no external traffic. Bundle-safe: no playwright imports.
import { createServer, type Server } from 'node:http';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const COMPACT_SESSION_ID = 'compact-fixture-0001';
export const COMPACT_PROVIDER = 'compact-stub';
export const COMPACT_MODEL = 'summarizer';
export const COMPACT_WINDOW = 8192;
// Last seeded assistant usage; the TUI projects exactly this before
// compaction (no trailing messages after the leaf assistant).
export const COMPACT_SEED_TOKENS = 1010;
// Stub-reported usage (120 + 15); the post-compaction followup turn
// projects exactly this once its assistant message lands.
export const COMPACT_FOLLOWUP_TOKENS = 135;
const STUB_USAGE = {
    prompt_tokens: 120,
    completion_tokens: 15,
    total_tokens: 135,
};
// Six user/assistant pairs at 150 estimated tokens each; keepRecent=300
// keeps the trailing whole turn, so manual compaction issues exactly
// one summary request (no split-turn second call).
const SEEDED_PAIRS = 6;
const MESSAGE_CHARS = 600;
const KEEP_RECENT_TOKENS = 300;

function fixedText(prefix: string, length: number): string {
    const filler = 'synthetic fixture text ';
    let out = prefix;
    while (out.length < length) out += filler;
    return out.slice(0, length);
}

export interface CompactStub {
    port: number;
    count: () => number;
    heldCount: () => number;
    // Hold the next completion(s): the request is counted on arrival
    // but the response is withheld until release(). Nothing is
    // forwarded externally and no body is logged.
    holdNext: () => void;
    release: () => void;
    close: () => Promise<void>;
}

// Loopback-only openai-completions stub. Every chat completion
// succeeds with one short synthetic text and fixed usage; nothing is
// forwarded externally and no request bodies are logged (they may
// carry session content). Counts every completion in memory and,
// when given, in a JSON count file.
export function startCompactStub(countFile?: string): Promise<CompactStub> {
    let count = 0;
    let holdArmed = false;
    const held: Array<() => void> = [];
    const writeCount = () => {
        if (countFile)
            writeFileSync(countFile, JSON.stringify({ count }) + '\n');
    };
    const server: Server = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            if (
                req.method !== 'POST' ||
                !req.url?.endsWith('/chat/completions')
            ) {
                res.writeHead(404, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'not found' }));
                return;
            }
            count += 1;
            writeCount();
            const id = `stub-${count}`;
            const created = Math.floor(Date.now() / 1000);
            const chunk = (
                delta: Record<string, unknown>,
                finish: string | null,
                usage?: Record<string, number>,
            ) =>
                `data: ${JSON.stringify({
                    id,
                    object: 'chat.completion.chunk',
                    created,
                    model: COMPACT_MODEL,
                    choices: [{ index: 0, delta, finish_reason: finish }],
                    ...(usage ? { usage } : {}),
                })}\n\n`;
            const reply = () => {
                res.writeHead(200, {
                    'content-type': 'text/event-stream',
                    'cache-control': 'no-cache',
                    connection: 'keep-alive',
                });
                res.end(
                    chunk(
                        {
                            role: 'assistant',
                            content: 'Synthetic stub synthesis. ',
                        },
                        null,
                    ) +
                        chunk({ content: 'Checkpoint complete.' }, null) +
                        chunk({}, 'stop', STUB_USAGE) +
                        'data: [DONE]\n\n',
                );
            };
            if (holdArmed) {
                holdArmed = false;
                held.push(reply);
                return;
            }
            reply();
        });
    });
    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            writeCount();
            resolve({
                port: (server.address() as { port: number }).port,
                count: () => count,
                heldCount: () => held.length,
                holdNext: () => {
                    holdArmed = true;
                },
                release: () => {
                    for (const reply of held.splice(0)) reply();
                },
                close: () =>
                    new Promise<void>((done, fail) =>
                        server.close((err) => (err ? fail(err) : done())),
                    ),
            });
        });
    });
}

export interface CompactSeed {
    cwd: string;
    sessionFile: string;
}

// Seed one owned fixture root: agent settings (auto-compaction off,
// tiny keep window so the small session compacts in one request),
// stub provider models, a realistic synthetic session with known
// assistant usage/model, and the clean native-pi wrapper. dir is the
// fixture tmp root; the caller spawns panes with the returned cwd.
// viaProxy points only this wrapper's bridge target at the owned test
// proxy socket (same unix: shape Phi publishes); creds still come
// from Phi provisioning and are never printed.
export const COMPACT_PROXY_NAME = 'compact-proxy.sock';
export function seedCompactFixture(
    dir: string,
    stubPort: number,
    opts?: { viaProxy?: boolean },
): CompactSeed {
    const cwd = realpathSync(dir);
    const agent = join(dir, 'home', '.pi', 'agent');
    mkdirSync(agent, { recursive: true });
    writeFileSync(
        join(agent, 'settings.json'),
        JSON.stringify({
            defaultProjectTrust: 'never',
            quietStartup: true,
            enableInstallTelemetry: false,
            cacheWarming: 'off',
            compaction: {
                enabled: false,
                reserveTokens: 128,
                keepRecentTokens: KEEP_RECENT_TOKENS,
            },
        }),
    );
    writeFileSync(
        join(agent, 'models.json'),
        JSON.stringify({
            providers: {
                [COMPACT_PROVIDER]: {
                    baseUrl: `http://127.0.0.1:${stubPort}/v1`,
                    api: 'openai-completions',
                    apiKey: 'compact-dummy-key-localhost-only',
                    models: [
                        {
                            id: COMPACT_MODEL,
                            contextWindow: COMPACT_WINDOW,
                            maxTokens: 1024,
                        },
                    ],
                },
            },
        }),
    );
    const project = join(
        agent,
        'sessions',
        `--${cwd.replace(/^\//, '').replaceAll('/', '-')}--`,
    );
    mkdirSync(project, { recursive: true });
    const sessionFile = join(
        project,
        `2026-10-24T00-00-00-000Z_${COMPACT_SESSION_ID}.jsonl`,
    );
    const stamp = '2026-10-24T00:00:00.000Z';
    const baseMs = Date.parse(stamp);
    const entries: Record<string, unknown>[] = [
        {
            type: 'session',
            version: 3,
            id: COMPACT_SESSION_ID,
            timestamp: stamp,
            cwd,
        },
    ];
    const usage = {
        input: 1000,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: COMPACT_SEED_TOKENS,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    let n = 0;
    const pushPair = (i: number) => {
        const userId = (0xa0000000 + n++).toString(16);
        const prev =
            entries.length === 1
                ? null
                : (entries[entries.length - 1] as { id: string }).id;
        entries.push({
            type: 'message',
            id: userId,
            parentId: prev,
            timestamp: stamp,
            message: {
                role: 'user',
                content: fixedText(
                    `COMPACT FIXTURE PROMPT ${i} `,
                    MESSAGE_CHARS,
                ),
                timestamp: baseMs + n * 1000,
            },
        });
        const asstId = (0xa0000000 + n++).toString(16);
        entries.push({
            type: 'message',
            id: asstId,
            parentId: userId,
            timestamp: stamp,
            message: {
                role: 'assistant',
                content: [
                    {
                        type: 'text',
                        text: fixedText(
                            `COMPACT FIXTURE REPLY ${i} `,
                            MESSAGE_CHARS,
                        ),
                    },
                ],
                api: 'openai-completions',
                provider: COMPACT_PROVIDER,
                model: COMPACT_MODEL,
                usage,
                stopReason: 'stop',
                timestamp: baseMs + n * 1000,
            },
        });
    };
    for (let i = 0; i < SEEDED_PAIRS; i++) pushPair(i);
    writeFileSync(
        sessionFile,
        entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    );
    const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    const command = join(dir, 'native-pi');
    const binary = join(process.cwd(), 'node_modules', '.bin', 'pi');
    // --no-extensions blocks user extensions; Phi still appends its
    // explicit --extension bundle for managed panes.
    const proxyLine = opts?.viaProxy
        ? `export PHI_PI_BRIDGE_ENDPOINT=${shellQuote(`unix:${join(cwd, 't', COMPACT_PROXY_NAME)}`)}\n`
        : '';
    writeFileSync(
        command,
        `#!/bin/sh\n${proxyLine}exec ${shellQuote(binary)} --no-extensions --no-skills --no-prompt-templates --no-context-files --no-approve --model ${COMPACT_PROVIDER}/${COMPACT_MODEL} "$@"\n`,
        { mode: 0o755 },
    );
    const backends = join(dir, 'home', '.phi', 'backends');
    mkdirSync(backends, { recursive: true });
    writeFileSync(
        join(backends, 'pi.json'),
        JSON.stringify({ id: 'pi', command }),
    );
    return { cwd, sessionFile };
}
