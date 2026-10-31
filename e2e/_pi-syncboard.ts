// Real-Pi fixture for Syncboard routing. The provider is loopback-only and
// emits two native calls: upsert, then list. It checks each returned result
// before it emits the final assistant reply.
import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SYNCBOARD_PROVIDER = 'syncboard-fixture';
export const SYNCBOARD_MODEL = 'fixture-model';
export const SYNCBOARD_KEY = 'pi-native-syncboard-fixture';
export const SYNCBOARD_VALUE = {
    marker: 'PHI_SYNCBOARD_NATIVE_TOOL_72b1',
    count: 7,
};
export const SYNCBOARD_PROXY_NAME = 'syncboard.sock';
const UNKNOWN_UPSERT_NOTICE = 'Outcome unknown. Do not retry automatically.';

const SSE_HEADERS = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
};

export interface SyncboardProviderOptions {
    key?: string;
    value?: unknown;
    expectUnknownUpsert?: boolean;
}

export interface SyncboardFollowupStep {
    operation: 'list' | 'get' | 'upsert' | 'delete';
    key?: string;
    value?: unknown;
    expectedKey: string;
    expectedValue?: unknown;
    expectedFound?: boolean;
    expectedAlreadyAbsent?: boolean;
}

export interface SyncboardProvider {
    port: number;
    requestCount: () => number;
    resultChecks: () => {
        upsert: boolean;
        list: boolean;
        unknownUpsert: boolean;
        error: string;
        upsertResult: unknown;
        listResult: unknown;
        followup: boolean[];
    };
    queueFollowup: (steps: readonly SyncboardFollowupStep[]) => void;
    waitForRequestCount: (count: number, timeoutMs?: number) => Promise<void>;
    close: () => Promise<void>;
}

function events(model: string, body: unknown): string {
    const rows: Array<[string, unknown]> = [
        [
            'message_start',
            {
                type: 'message_start',
                message: {
                    id: `msg_syncboard_${Date.now()}`,
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
    if (isRecord(body) && body['type'] === 'tool_use') {
        rows.push([
            'content_block_start',
            {
                type: 'content_block_start',
                index: 0,
                content_block: {
                    type: 'tool_use',
                    id: String(body['id']),
                    name:
                        typeof body['name'] === 'string'
                            ? body['name']
                            : 'syncboard',
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
                    partial_json: JSON.stringify(body['input']),
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
                delta: { type: 'text_delta', text: 'Syncboard verified.' },
            },
        ]);
    }
    rows.push(['content_block_stop', { type: 'content_block_stop', index: 0 }]);
    rows.push([
        'message_delta',
        {
            type: 'message_delta',
            delta: {
                stop_reason:
                    isRecord(body) && body['type'] === 'tool_use'
                        ? 'tool_use'
                        : 'end_turn',
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

function validateFollowupResult(
    raw: string,
    step: SyncboardFollowupStep,
): void {
    const result = JSON.parse(raw) as unknown;
    if (step.operation === 'delete') {
        if (
            !isRecord(result) ||
            result['deleted'] !== true ||
            result['key'] !== step.expectedKey ||
            result['already_absent'] !== (step.expectedAlreadyAbsent ?? false)
        )
            throw new Error(
                'follow-up delete result did not match the expected state',
            );
        return;
    }
    if (step.operation === 'get' && step.expectedFound === false) {
        if (
            !isRecord(result) ||
            result['found'] !== false ||
            result['key'] !== step.expectedKey
        )
            throw new Error('follow-up get did not report the missing key');
        return;
    }
    const expectedValue = JSON.stringify(step.expectedValue);
    if (step.operation === 'list') {
        if (!Array.isArray(result))
            throw new Error('follow-up list result was not an array');
        const entry = result.find(
            (item) => isRecord(item) && item['key'] === step.expectedKey,
        );
        if (!isRecord(entry) || entry['value'] !== expectedValue)
            throw new Error(
                'follow-up list did not contain the expected key and value',
            );
        return;
    }
    if (
        !isRecord(result) ||
        result['key'] !== step.expectedKey ||
        result['value'] !== expectedValue
    )
        throw new Error(
            `follow-up ${step.operation} did not return the expected key and value`,
        );
}

function followupToolCall(step: SyncboardFollowupStep, index: number): unknown {
    return {
        type: 'tool_use',
        id: `toolu_syncboard_followup_${index + 1}`,
        input:
            step.operation === 'list'
                ? { operation: 'list' }
                : step.operation === 'upsert'
                  ? { operation: 'upsert', key: step.key, value: step.value }
                  : {
                        operation: step.operation,
                        key: step.key ?? step.expectedKey,
                    },
    };
}

export async function startSyncboardProvider(
    options: SyncboardProviderOptions = {},
): Promise<SyncboardProvider> {
    const key = options.key ?? SYNCBOARD_KEY;
    const value = Object.hasOwn(options, 'value')
        ? options.value
        : SYNCBOARD_VALUE;
    const valueJson = JSON.stringify(value);
    let requests = 0;
    let upsertChecked = false;
    let listChecked = false;
    let unknownUpsertChecked = false;
    let upsertResult: unknown = null;
    let listResult: unknown = null;
    let error = '';
    let seenResultCount = 0;
    let followup: {
        steps: readonly SyncboardFollowupStep[];
        offset: number;
        completed: number;
    } | null = null;
    let followupChecks: boolean[] = [];

    const server: Server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            const path = req.url ?? '';
            if (path.includes('/count_tokens')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ input_tokens: 20 }));
                return;
            }
            if (!path.includes('/v1/messages')) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'not found' }));
                return;
            }
            requests += 1;
            let reply: unknown;
            try {
                const request = JSON.parse(
                    Buffer.concat(chunks).toString('utf8'),
                ) as Record<string, unknown>;
                const tools = Array.isArray(request['tools'])
                    ? request['tools']
                    : [];
                if (
                    requests === 1 &&
                    !tools.some(
                        (tool) =>
                            isRecord(tool) && tool['name'] === 'syncboard',
                    )
                )
                    throw new Error(
                        'provider request did not declare native syncboard',
                    );
                const results = readToolResults(request['messages']);
                if (followup) {
                    const received = results.length - followup.offset;
                    const step = followup.steps[followup.completed];
                    if (!step)
                        throw new Error('follow-up request exceeded its steps');
                    if (received === followup.completed) {
                        reply = followupToolCall(step, followup.completed);
                    } else if (received === followup.completed + 1) {
                        validateFollowupResult(
                            results[followup.offset + followup.completed] ??
                                'null',
                            step,
                        );
                        followupChecks[followup.completed] = true;
                        followup.completed += 1;
                        const next = followup.steps[followup.completed];
                        reply = next
                            ? followupToolCall(next, followup.completed)
                            : { type: 'text' };
                        if (!next) followup = null;
                    } else {
                        throw new Error(
                            'follow-up tool result count did not advance by one',
                        );
                    }
                } else if (results.length === 0) {
                    reply = {
                        type: 'tool_use',
                        id: 'toolu_syncboard_upsert',
                        input: {
                            operation: 'upsert',
                            key: SYNCBOARD_KEY,
                            value,
                        },
                    };
                } else if (
                    results.length === 1 &&
                    options.expectUnknownUpsert
                ) {
                    const result = results[0] ?? '';
                    if (!result.includes(UNKNOWN_UPSERT_NOTICE))
                        throw new Error(
                            'upsert result did not report its unknown outcome',
                        );
                    unknownUpsertChecked = true;
                    upsertResult = result;
                    reply = { type: 'text' };
                } else if (results.length === 1) {
                    const result = JSON.parse(results[0] ?? 'null') as unknown;
                    const entry = isRecord(result) ? result : null;
                    if (entry?.['key'] !== key || entry['value'] !== valueJson)
                        throw new Error(
                            'upsert tool result did not contain the expected key and value',
                        );
                    upsertChecked = true;
                    upsertResult = result;
                    reply = {
                        type: 'tool_use',
                        id: 'toolu_syncboard_list',
                        input: { operation: 'list' },
                    };
                } else if (results.length === 2) {
                    const result = JSON.parse(results[1] ?? 'null') as unknown;
                    if (!Array.isArray(result))
                        throw new Error('list tool result was not an array');
                    const entry = result.find(
                        (item) => isRecord(item) && item['key'] === key,
                    );
                    if (!isRecord(entry) || entry['value'] !== valueJson)
                        throw new Error(
                            'list tool result did not contain the expected key and value',
                        );
                    listChecked = true;
                    listResult = result;
                    reply = { type: 'text' };
                } else {
                    throw new Error(
                        `unexpected tool-result count: ${results.length}`,
                    );
                }
                seenResultCount = results.length;
            } catch (cause) {
                error =
                    cause instanceof Error
                        ? cause.message
                        : 'provider fixture failed';
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error }));
                return;
            }
            res.writeHead(200, SSE_HEADERS);
            res.end(events(SYNCBOARD_MODEL, reply));
        });
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const port =
        typeof address === 'object' && address !== null ? address.port : 0;
    return {
        port,
        requestCount: () => requests,
        resultChecks: () => ({
            upsert: upsertChecked,
            list: listChecked,
            unknownUpsert: unknownUpsertChecked,
            error,
            upsertResult,
            listResult,
            followup: [...followupChecks],
        }),
        queueFollowup: (steps) => {
            const initialComplete = options.expectUnknownUpsert
                ? unknownUpsertChecked && seenResultCount === 1
                : upsertChecked && listChecked && seenResultCount === 2;
            if (followup || !initialComplete || steps.length === 0)
                throw new Error(
                    'follow-up requires a completed initial Syncboard turn',
                );
            followupChecks = steps.map(() => false);
            followup = {
                steps: [...steps],
                offset: seenResultCount,
                completed: 0,
            };
        },
        waitForRequestCount: async (count, timeoutMs = 30_000) => {
            const deadline = Date.now() + timeoutMs;
            while (requests < count) {
                if (Date.now() >= deadline)
                    throw new Error(
                        `provider received ${requests} requests, expected ${count}`,
                    );
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
        },
        close: () =>
            new Promise<void>((resolve, reject) =>
                server.close((cause) => (cause ? reject(cause) : resolve())),
            ),
    };
}

export interface BuiltinReadProvider {
    port: number;
    requestCount: () => number;
    resultChecked: () => boolean;
    error: () => string;
    waitForRequestCount: (count: number, timeoutMs?: number) => Promise<void>;
    close: () => Promise<void>;
}

/** Provider fixture that proves ordinary Pi read-tool use without Syncboard. */
export async function startBuiltinReadProvider(
    filePath: string | (() => string),
    expectedContent: string,
): Promise<BuiltinReadProvider> {
    let requests = 0;
    let checked = false;
    let failure = '';
    const server: Server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            const path = req.url ?? '';
            if (path.includes('/count_tokens')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ input_tokens: 20 }));
                return;
            }
            if (!path.includes('/v1/messages')) {
                res.writeHead(404).end();
                return;
            }
            requests += 1;
            let reply: unknown;
            try {
                const body = JSON.parse(
                    Buffer.concat(chunks).toString('utf8'),
                ) as Record<string, unknown>;
                const tools = Array.isArray(body['tools']) ? body['tools'] : [];
                if (requests === 1) {
                    if (
                        !tools.some(
                            (tool) => isRecord(tool) && tool['name'] === 'read',
                        )
                    )
                        throw new Error(
                            'provider request omitted the built-in read tool',
                        );
                    if (
                        tools.some(
                            (tool) =>
                                isRecord(tool) && tool['name'] === 'syncboard',
                        )
                    )
                        throw new Error(
                            'provider request exposed Syncboard without its bridge',
                        );
                    reply = {
                        type: 'tool_use',
                        id: 'toolu_builtin_read',
                        name: 'read',
                        input: {
                            path:
                                typeof filePath === 'function'
                                    ? filePath()
                                    : filePath,
                        },
                    };
                } else if (requests === 2) {
                    const results = readToolResults(body['messages']);
                    if (
                        !results.some((result) =>
                            result.includes(expectedContent),
                        )
                    )
                        throw new Error(
                            'built-in read result did not contain the expected file content',
                        );
                    checked = true;
                    reply = { type: 'text' };
                } else {
                    throw new Error(
                        'provider received an unexpected additional request',
                    );
                }
            } catch (cause) {
                failure =
                    cause instanceof Error
                        ? cause.message
                        : 'provider fixture failed';
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: failure }));
                return;
            }
            res.writeHead(200, SSE_HEADERS);
            res.end(events(SYNCBOARD_MODEL, reply));
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const port =
        typeof address === 'object' && address !== null ? address.port : 0;
    return {
        port,
        requestCount: () => requests,
        resultChecked: () => checked,
        error: () => failure,
        waitForRequestCount: async (count, timeoutMs = 30_000) => {
            const deadline = Date.now() + timeoutMs;
            while (requests < count) {
                if (Date.now() >= deadline)
                    throw new Error(
                        `provider received ${requests} requests, expected ${count}`,
                    );
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
        },
        close: () =>
            new Promise<void>((resolve, reject) =>
                server.close((cause) => (cause ? reject(cause) : resolve())),
            ),
    };
}

export interface HeldSyncboardCoordinator {
    port: number;
    waitForAppliedMutation: () => Promise<void>;
    requestCount: () => number;
    mutationCount: () => number;
    message: (
        key: string,
    ) =>
        | { key: string; value: string; created_at: string; updated_at: string }
        | undefined;
    releaseResponse: () => void;
    close: () => Promise<void>;
}

/** Local coordinator fixture that commits one upsert before holding its response. */
export async function startHeldSyncboardCoordinator(): Promise<HeldSyncboardCoordinator> {
    const messages = new Map<
        string,
        { key: string; value: string; created_at: string; updated_at: string }
    >();
    let requests = 0;
    let mutations = 0;
    let release!: () => void;
    const heldResponse = new Promise<void>((resolve) => {
        release = resolve;
    });
    let applied!: () => void;
    const appliedMutation = new Promise<void>((resolve) => {
        applied = resolve;
    });
    const server: Server = createServer((req, res) => {
        requests += 1;
        const chunks: Buffer[] = [];
        res.on('error', () => {});
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            void (async () => {
                const path = new URL(req.url ?? '/', 'http://127.0.0.1')
                    .pathname;
                if (req.method === 'POST' && path === '/api/sync/messages') {
                    const body = JSON.parse(
                        Buffer.concat(chunks).toString('utf8'),
                    ) as {
                        key?: unknown;
                        value?: unknown;
                    };
                    if (typeof body.key !== 'string') {
                        res.writeHead(400).end();
                        return;
                    }
                    const previous = messages.get(body.key);
                    const now = new Date().toISOString();
                    const value =
                        typeof body.value === 'string'
                            ? body.value
                            : body.value === null
                              ? ''
                              : (JSON.stringify(body.value) ?? '');
                    const message = {
                        key: body.key,
                        value,
                        created_at: previous?.created_at ?? now,
                        updated_at: now,
                    };
                    messages.set(body.key, message);
                    mutations += 1;
                    applied();
                    await heldResponse;
                    if (!res.destroyed && !res.writableEnded)
                        res.writeHead(200, {
                            'content-type': 'application/json',
                        }).end(JSON.stringify(message));
                    return;
                }
                const prefix = '/api/sync/messages/';
                if (req.method === 'GET' && path.startsWith(prefix)) {
                    const key = decodeURIComponent(path.slice(prefix.length));
                    const message = messages.get(key);
                    if (!message) {
                        res.writeHead(404).end('Message not found');
                        return;
                    }
                    res.writeHead(200, {
                        'content-type': 'application/json',
                    }).end(JSON.stringify(message));
                    return;
                }
                res.writeHead(404).end();
            })().catch((cause: unknown) => {
                if (!res.destroyed && !res.writableEnded)
                    res.writeHead(500).end(String(cause));
            });
        });
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const port =
        typeof address === 'object' && address !== null ? address.port : 0;
    return {
        port,
        waitForAppliedMutation: () => appliedMutation,
        requestCount: () => requests,
        mutationCount: () => mutations,
        message: (key) => messages.get(key),
        releaseResponse: release,
        close: () => {
            release();
            return new Promise<void>((resolve, reject) =>
                server.close((cause) => (cause ? reject(cause) : resolve())),
            );
        },
    };
}

export function seedSyncboardPi(
    dir: string,
    providerPort: number,
    options: { viaProxy?: boolean; phiBridgeDisabled?: boolean } = {},
): { cwd: string; observerPath: string } {
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
            ...(options.phiBridgeDisabled
                ? { phiBridge: { enabled: false } }
                : {}),
        }),
    );
    writeFileSync(
        join(agent, 'models.json'),
        JSON.stringify({
            providers: {
                [SYNCBOARD_PROVIDER]: {
                    baseUrl: `http://127.0.0.1:${providerPort}`,
                    api: 'anthropic-messages',
                    apiKey: 'syncboard-fixture-key-localhost-only',
                    models: [{ id: SYNCBOARD_MODEL }],
                },
            },
        }),
    );

    const observerPath = join(dir, 'syncboard-observer.jsonl');
    const observer = join(dir, 'syncboard-observer.cjs');
    writeFileSync(
        observer,
        `const fs = require('node:fs');\n` +
            `module.exports = (pi) => {\n` +
            `  pi.on('session_start', () => {\n` +
            `    let previous;\n` +
            `    let attempts = 0;\n` +
            `    const timer = setInterval(() => {\n` +
            `      attempts += 1;\n` +
            `      try {\n` +
            `        const active = pi.getActiveTools().includes('syncboard');\n` +
            `        if (active !== previous) {\n` +
            `          fs.appendFileSync(${JSON.stringify(observerPath)}, JSON.stringify({ available: active, at: Date.now() }) + '\\n');\n` +
            `          previous = active;\n` +
            `        }\n` +
            `        if (active || attempts >= 300) clearInterval(timer);\n` +
            `      } catch {}\n` +
            `    }, 100);\n` +
            `  });\n` +
            `};\n`,
    );

    const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const command = join(dir, 'native-pi');
    const binary = join(process.cwd(), 'node_modules', '.bin', 'pi');
    const proxyLine = options.viaProxy
        ? `export PHI_PI_BRIDGE_ENDPOINT=${shellQuote(`unix:${join(cwd, 't', SYNCBOARD_PROXY_NAME)}`)}\n`
        : '';
    writeFileSync(
        command,
        `#!/bin/sh\n${proxyLine}exec ${shellQuote(binary)} --no-extensions --no-skills --no-prompt-templates --no-context-files --no-approve --extension ${shellQuote(observer)} --model ${SYNCBOARD_PROVIDER}/${SYNCBOARD_MODEL} "$@"\n`,
        { mode: 0o755 },
    );
    const backends = join(dir, 'home', '.phi', 'backends');
    mkdirSync(backends, { recursive: true });
    writeFileSync(
        join(backends, 'pi.json'),
        JSON.stringify({ id: 'pi', command }),
    );
    return { cwd, observerPath };
}

export function readSyncboardObserver(
    path: string,
): Array<{ available: boolean; at: number }> {
    try {
        return readFileSync(path, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map(
                (line: string) =>
                    JSON.parse(line) as { available: boolean; at: number },
            );
    } catch {
        return [];
    }
}

function readToolResults(messages: unknown): string[] {
    if (!Array.isArray(messages)) return [];
    const out: string[] = [];
    for (const message of messages) {
        if (!isRecord(message) || message['role'] !== 'user') continue;
        const content = message['content'];
        if (!Array.isArray(content)) continue;
        for (const block of content) {
            if (!isRecord(block) || block['type'] !== 'tool_result') continue;
            const result = block['content'];
            if (typeof result === 'string') out.push(result);
            else if (Array.isArray(result)) {
                out.push(
                    result
                        .filter(
                            (part) =>
                                isRecord(part) &&
                                typeof part['text'] === 'string',
                        )
                        .map((part) => (part as { text: string }).text)
                        .join('\n'),
                );
            }
        }
    }
    return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
