// Real-Pi fixture for topic pub/sub. The loopback provider asks Pi to
// subscribe once, checks the native result, then waits for an external POST
// to arrive as a model-visible user message without another tool call.
import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const TOPICS_PROVIDER = 'syncboard-topics-fixture';
export const TOPICS_MODEL = 'fixture-model';
export const TOPICS_KEY = 'pi-syncboard-topics-fixture';
export const TOPICS_MARKER = 'PHI_SYNCBOARD_TOPICS_7f31';
export const TOPICS_LARGE =
    `${TOPICS_MARKER}:` + 'ü'.repeat(5000) + ':TOPICS_END_4c2e';

const SSE_HEADERS = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
};

function events(model: string, body: unknown): string {
    const rows: Array<[string, unknown]> = [
        [
            'message_start',
            {
                type: 'message_start',
                message: {
                    id: `msg_syncboard_topics_${Date.now()}`,
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
                    name: String(body['name']),
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
                delta: { type: 'text_delta', text: 'Topic delivery verified.' },
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

export interface TopicsProviderOptions {
    /** Keep the post-subscribe provider response open until the test releases it. */
    holdSecond?: boolean;
    /** Expect the later explicit subscribe to fail after authority is fenced. */
    refuseResubscribe?: boolean;
}

export interface TopicsProvider {
    port: number;
    requestCount: () => number;
    bodies: () => string[];
    resultChecked: () => boolean;
    deliveryChecked: () => boolean;
    deliveryCount: () => number;
    error: () => string;
    waitForRequestCount: (count: number, timeoutMs?: number) => Promise<void>;
    waitForSecondHeld: (timeoutMs?: number) => Promise<void>;
    releaseSecond: () => void;
    waitForResult: (timeoutMs?: number) => Promise<void>;
    close: () => Promise<void>;
}

export async function startTopicsProvider(
    options: TopicsProviderOptions = {},
): Promise<TopicsProvider> {
    let requests = 0;
    let secondHeld = false;
    let secondReleased = false;
    let heldSecond: import('node:http').ServerResponse | undefined;
    let resultChecked = false;
    let deliveryChecked = false;
    let deliveries = 0;
    let error = '';
    const bodies: string[] = [];
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
            const raw = Buffer.concat(chunks).toString('utf8');
            bodies.push(raw);
            try {
                const request = JSON.parse(raw) as Record<string, unknown>;
                const tools = Array.isArray(request['tools'])
                    ? request['tools']
                    : [];
                const names = tools
                    .filter(isRecord)
                    .map((tool) => tool['name']);
                if (requests === 1) {
                    if (!names.includes('syncboard_subscribe'))
                        throw new Error(
                            'provider request did not declare syncboard_subscribe',
                        );
                    if (!names.includes('syncboard_publish'))
                        throw new Error(
                            'provider request did not declare syncboard_publish',
                        );
                }
                if (requests === 1) {
                    res.writeHead(200, SSE_HEADERS);
                    res.end(
                        events(TOPICS_MODEL, {
                            type: 'tool_use',
                            id: 'toolu_syncboard_subscribe',
                            name: 'syncboard_subscribe',
                            input: { topic: TOPICS_KEY },
                        }),
                    );
                    return;
                }
                if (requests === 2) {
                    const results = readToolResults(request['messages']);
                    if (results.length !== 1)
                        throw new Error('expected exactly one tool result');
                    let result: unknown;
                    try {
                        result = JSON.parse(results[0] ?? 'null') as unknown;
                    } catch {
                        throw new Error(
                            `subscribe tool result was not JSON: ${results[0] ?? ''}`,
                        );
                    }
                    if (
                        !isRecord(result) ||
                        result['subscribed'] !== TOPICS_KEY ||
                        typeof result['epoch'] !== 'string' ||
                        result['epoch'] === ''
                    )
                        throw new Error(
                            'subscribe result did not identify the topic and epoch',
                        );
                    resultChecked = true;
                    if (options.holdSecond && !secondReleased) {
                        res.writeHead(200, SSE_HEADERS);
                        res.flushHeaders();
                        heldSecond = res;
                        secondHeld = true;
                        return;
                    }
                    res.writeHead(200, SSE_HEADERS);
                    res.end(events(TOPICS_MODEL, { type: 'text' }));
                    return;
                }
                if (requests === 3 || requests === 6) {
                    const serialized = JSON.stringify(request['messages']);
                    if (!serialized.includes(TOPICS_MARKER))
                        throw new Error(
                            'topic post did not reach a model request',
                        );
                    if (!serialized.includes('ü'.repeat(100)))
                        throw new Error(
                            'topic post was truncated before the model request',
                        );
                    if (!serialized.includes('TOPICS_END_4c2e'))
                        throw new Error('topic post lost its tail');
                    if (serialized.includes('syncboard_publish'))
                        throw new Error(
                            'receiver called a publish tool to obtain the post',
                        );
                    deliveryChecked = true;
                    deliveries += 1;
                    res.writeHead(200, SSE_HEADERS);
                    res.end(events(TOPICS_MODEL, { type: 'text' }));
                    return;
                }
                if (requests === 4) {
                    res.writeHead(200, SSE_HEADERS);
                    res.end(
                        events(TOPICS_MODEL, {
                            type: 'tool_use',
                            id: 'toolu_syncboard_subscribe_2',
                            name: 'syncboard_subscribe',
                            input: { topic: TOPICS_KEY },
                        }),
                    );
                    return;
                }
                if (requests === 5) {
                    const results = readToolResults(request['messages']);
                    const latest = results.at(-1);
                    if (!latest)
                        throw new Error('expected a second tool result');
                    if (options.refuseResubscribe) {
                        if (!latest.includes('Syncboard subscribe not sent (unavailable).'))
                            throw new Error('changed authority did not refuse the later subscribe');
                        res.writeHead(200, SSE_HEADERS);
                        res.end(events(TOPICS_MODEL, { type: 'text' }));
                        return;
                    }
                    let result: unknown;
                    try {
                        result = JSON.parse(latest) as unknown;
                    } catch {
                        throw new Error(
                            `second subscribe result was not JSON: ${latest}`,
                        );
                    }
                    if (
                        !isRecord(result) ||
                        result['subscribed'] !== TOPICS_KEY ||
                        typeof result['epoch'] !== 'string' ||
                        result['epoch'] === ''
                    )
                        throw new Error(
                            'second subscribe result did not identify the topic and epoch',
                        );
                    res.writeHead(200, SSE_HEADERS);
                    res.end(events(TOPICS_MODEL, { type: 'text' }));
                    return;
                }
                throw new Error(`unexpected provider request ${requests}`);
            } catch (cause) {
                error =
                    cause instanceof Error
                        ? cause.message
                        : 'provider fixture failed';
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error }));
            }
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
        bodies: () => [...bodies],
        resultChecked: () => resultChecked,
        deliveryChecked: () => deliveryChecked,
        deliveryCount: () => deliveries,
        error: () => error,
        waitForSecondHeld: async (timeoutMs = 30_000) => {
            const deadline = Date.now() + timeoutMs;
            while (!secondHeld) {
                if (error) throw new Error(error);
                if (Date.now() >= deadline)
                    throw new Error(
                        'post-subscribe provider response was not held',
                    );
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
        },
        releaseSecond: () => {
            secondReleased = true;
            const held = heldSecond;
            heldSecond = undefined;
            held?.end(events(TOPICS_MODEL, { type: 'text' }));
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
        waitForResult: async (timeoutMs = 30_000) => {
            const deadline = Date.now() + timeoutMs;
            while (!resultChecked) {
                if (error) throw new Error(error);
                if (Date.now() >= deadline)
                    throw new Error('subscribe result was not checked');
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
        },
        close: () =>
            new Promise<void>((resolve, reject) =>
                server.close((cause) => (cause ? reject(cause) : resolve())),
            ),
    };
}

export function seedTopicsPi(
    dir: string,
    providerPort: number,
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
        }),
    );
    writeFileSync(
        join(agent, 'models.json'),
        JSON.stringify({
            providers: {
                [TOPICS_PROVIDER]: {
                    baseUrl: `http://127.0.0.1:${providerPort}`,
                    api: 'anthropic-messages',
                    apiKey: 'syncboard-topics-fixture-key-localhost-only',
                    models: [{ id: TOPICS_MODEL, input: ['text'] }],
                },
            },
        }),
    );
    const observerPath = join(dir, 'syncboard-topics-observer.jsonl');
    const observer = join(dir, 'syncboard-topics-observer.cjs');
    writeFileSync(
        observer,
        `const fs = require('node:fs');\n` +
            `module.exports = (pi) => {\n` +
            `  pi.on('session_start', () => {\n` +
            `    let previous;\n` +
            `    const timer = setInterval(() => {\n` +
            `      try {\n` +
            `        const active = pi.getActiveTools().includes('syncboard_subscribe');\n` +
            `        if (active !== previous) {\n` +
            `          fs.appendFileSync(${JSON.stringify(observerPath)}, JSON.stringify({ available: active, at: Date.now() }) + '\\n');\n` +
            `          previous = active;\n` +
            `        }\n` +
            `        if (active) clearInterval(timer);\n` +
            `      } catch {}\n` +
            `    }, 100);\n` +
            `  });\n` +
            `};\n`,
    );
    const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const command = join(dir, 'native-pi');
    const binary = join(process.cwd(), 'node_modules', '.bin', 'pi');
    writeFileSync(
        command,
        `#!/bin/sh\nexec ${shellQuote(binary)} --no-extensions --no-skills --no-prompt-templates --no-context-files --no-approve --extension ${shellQuote(observer)} --model ${TOPICS_PROVIDER}/${TOPICS_MODEL} "$@"\n`,
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

export function readTopicsObserver(
    path: string,
): Array<{ available: boolean; at: number }> {
    try {
        return readFileSync(path, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map(
                (line) =>
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
            else if (Array.isArray(result))
                out.push(
                    result
                        .filter(
                            (part) =>
                                isRecord(part) &&
                                typeof part['text'] === 'string',
                        )
                        .map((part) => part['text'] as string)
                        .join('\n'),
                );
        }
    }
    return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
