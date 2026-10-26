// Loopback Anthropic-Messages provider fixture for the Pi bridge skills
// spec. It exists so a real Pi pane can run a real turn without any
// credential and without any network: Pi posts its request here, the
// fixture records the request body, and it answers with a minimal
// message stream.
//
// The recorded body is the proof that a dispatched skill reached the
// model: Pi expands `/skill:<name>` into the skill body before the
// request leaves the process.

import { createServer, type Server } from 'node:http';

export interface SkillProvider {
    port: number;
    /** Recorded request bodies, oldest first. */
    requests: string[];
    /**
     * Hold the next answer open so the agent stays busy. The returned
     * function releases it. Used for the follow-up delivery case.
     */
    hold: () => () => void;
    waitForRequests: (count: number, timeoutMs?: number) => Promise<string[]>;
    close: () => Promise<void>;
}

const SSE_HEADERS = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
};

/** One minimal assistant turn: one text block, then end_turn. */
function messageStream(model: string): string {
    const events: Array<[string, unknown]> = [
        [
            'message_start',
            {
                type: 'message_start',
                message: {
                    id: 'msg_fixture',
                    type: 'message',
                    role: 'assistant',
                    model,
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 16, output_tokens: 0 },
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
                delta: { type: 'text_delta', text: 'fixture ok' },
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

export async function startSkillProvider(): Promise<SkillProvider> {
    const requests: string[] = [];
    let holdNext = false;
    let release: (() => void) | null = null;

    const server: Server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            const path = req.url ?? '';
            if (path.includes('/count_tokens')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ input_tokens: 16 }));
                return;
            }
            if (!path.includes('/v1/messages')) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'not found' }));
                return;
            }
            requests.push(body);
            res.writeHead(200, SSE_HEADERS);
            const write = () => {
                res.write(messageStream('fixture-model'));
                res.end();
            };
            if (holdNext) {
                holdNext = false;
                release = write;
                return;
            }
            write();
        });
    });

    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const port =
        typeof address === 'object' && address !== null ? address.port : 0;

    return {
        port,
        requests,
        hold: () => {
            holdNext = true;
            return () => {
                const fn = release;
                release = null;
                fn?.();
            };
        },
        waitForRequests: async (count: number, timeoutMs = 30_000) => {
            const deadline = Date.now() + timeoutMs;
            while (requests.length < count) {
                if (Date.now() > deadline) {
                    throw new Error(
                        `provider saw ${requests.length} requests, want ${count}`,
                    );
                }
                await new Promise((r) => setTimeout(r, 50));
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
