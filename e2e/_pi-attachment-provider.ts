// Loopback-only Pi provider used by attachment E2E specs. It records the
// model request, can hold one reply, and can ask Pi to read an attached file.
import { createServer, type Server } from 'node:http';

export interface AttachmentProviderRequest {
    path: string;
    body: Record<string, unknown>;
}

export interface AttachmentProvider {
    port: number;
    requests: AttachmentProviderRequest[];
    holdNext: () => () => void;
    waitForRequests: (
        count: number,
        timeoutMs?: number,
    ) => Promise<AttachmentProviderRequest[]>;
    close: () => Promise<void>;
}

const SSE_HEADERS = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
};

function allText(value: unknown): string {
    if (Array.isArray(value)) return value.map(allText).join('\n');
    if (!value || typeof value !== 'object') return '';
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    return Object.values(record).map(allText).join('\n');
}

function findAttachedPath(text: string): string | null {
    const match = text.match(
        /Attached file path \(JSON-quoted\): ("(?:[^"\\]|\\.)*")/,
    );
    if (!match) return null;
    try {
        const value = JSON.parse(match[1]!);
        return typeof value === 'string' ? value : null;
    } catch {
        return null;
    }
}

function anthropicTextStream(model: string): string {
    const events: Array<[string, unknown]> = [
        [
            'message_start',
            {
                type: 'message_start',
                message: {
                    id: 'attachment-fixture',
                    type: 'message',
                    role: 'assistant',
                    model,
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 8, output_tokens: 0 },
                },
            },
        ],
        [
            'content_block_start',
            {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' },
            },
        ],
        [
            'content_block_delta',
            {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'fixture response' },
            },
        ],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        [
            'message_delta',
            {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { output_tokens: 2 },
            },
        ],
        ['message_stop', { type: 'message_stop' }],
    ];
    return events
        .map(
            ([name, data]) =>
                `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`,
        )
        .join('');
}

function anthropicReadStream(model: string, path: string): string {
    const input = JSON.stringify({ path });
    const events: Array<[string, unknown]> = [
        [
            'message_start',
            {
                type: 'message_start',
                message: {
                    id: 'attachment-read',
                    type: 'message',
                    role: 'assistant',
                    model,
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 8, output_tokens: 0 },
                },
            },
        ],
        [
            'content_block_start',
            {
                type: 'content_block_start',
                index: 0,
                content_block: {
                    type: 'tool_use',
                    id: 'attachment-read-1',
                    name: 'read',
                    input: {},
                },
            },
        ],
        [
            'content_block_delta',
            {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'input_json_delta', partial_json: input },
            },
        ],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        [
            'message_delta',
            {
                type: 'message_delta',
                delta: { stop_reason: 'tool_use', stop_sequence: null },
                usage: { output_tokens: 2 },
            },
        ],
        ['message_stop', { type: 'message_stop' }],
    ];
    return events
        .map(
            ([name, data]) =>
                `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`,
        )
        .join('');
}

function openAITextStream(model: string): string {
    const events = [
        {
            id: 'attachment-fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model,
            choices: [
                {
                    index: 0,
                    delta: { role: 'assistant', content: 'fixture response' },
                    finish_reason: null,
                },
            ],
        },
        {
            id: 'attachment-fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        },
        '[DONE]',
    ];
    return events
        .map(
            (event) =>
                `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`,
        )
        .join('');
}

export async function startAttachmentProvider(): Promise<AttachmentProvider> {
    const requests: AttachmentProviderRequest[] = [];
    let holdNext = false;
    let release: (() => void) | null = null;

    const server: Server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            const path = req.url ?? '';
            const raw = Buffer.concat(chunks).toString('utf8');
            if (path.includes('/count_tokens')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ input_tokens: 8 }));
                return;
            }
            if (
                !path.includes('/messages') &&
                !path.includes('/chat/completions')
            ) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'not found' }));
                return;
            }
            let body: Record<string, unknown>;
            try {
                body = JSON.parse(raw) as Record<string, unknown>;
            } catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'bad json' }));
                return;
            }
            requests.push({ path, body });
            const model =
                typeof body.model === 'string' ? body.model : 'fixture-model';
            const content = path.includes('/messages')
                ? (body.messages as unknown[] | undefined)
                : (body.messages as unknown[] | undefined);
            const text = allText(content);
            const hasToolResult = JSON.stringify(body.messages ?? []).includes(
                '"type":"tool_result"',
            );
            const attachedPath =
                !hasToolResult && text.includes('PHI_ATTACH_READ_FIXTURE')
                    ? findAttachedPath(text)
                    : null;
            const payload = path.includes('/messages')
                ? attachedPath
                    ? anthropicReadStream(model, attachedPath)
                    : anthropicTextStream(model)
                : openAITextStream(model);
            const write = () => {
                res.writeHead(200, SSE_HEADERS);
                res.end(payload);
            };
            if (holdNext) {
                holdNext = false;
                release = write;
                return;
            }
            write();
        });
    });

    await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    const port =
        typeof address === 'object' && address !== null ? address.port : 0;
    return {
        port,
        requests,
        holdNext: () => {
            holdNext = true;
            return () => {
                const done = release;
                release = null;
                done?.();
            };
        },
        waitForRequests: async (count, timeoutMs = 30_000) => {
            const deadline = Date.now() + timeoutMs;
            while (requests.length < count) {
                if (Date.now() > deadline)
                    throw new Error(
                        `provider saw ${requests.length} requests, want ${count}`,
                    );
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return requests;
        },
        close: () =>
            new Promise<void>((resolve) => {
                release?.();
                server.close(() => resolve());
            }),
    };
}
