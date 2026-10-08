// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import {
    encode,
    replayHarness,
    recordingEnvelope,
} from './_terminalReplayHarness.js';

setupDomHarness();
const LIMIT = 2 * 1024 * 1024;
const text =
    '\x1b[31mFIRST: 你好 🙂 e\u0301\x1b[0m\r\n' +
    'retained history\r\n'.repeat(32) +
    'LAST\r\n';
const small = encode(text);

function assertComplete(h, source) {
    const observed = encode(h.tape.join(''));
    expect(
        observed.byteLength,
        'every recording byte must enter the parser, in order',
    ).toBe(source.byteLength);
    expect(
        Buffer.from(observed).equals(Buffer.from(source)),
        'no omission, duplication, notice injection, or reordering',
    ).toBe(true);
    expect(
        h.tab.drainedSeq,
        'the watermark must describe parsed bytes, not skipped bytes',
    ).toBe(source.length);
}

const faults = [
    [
        'network failure',
        () => {
            throw new TypeError('offline');
        },
    ],
    [
        'aborted request',
        () => {
            throw new DOMException('abort', 'AbortError');
        },
    ],
    ...[404, 408, 409, 425, 429, 500, 502, 503, 504].map((status) => [
        `HTTP ${status}`,
        () => ({ ok: false, status }),
    ]),
    ['204 after cache eviction', () => ({ ok: true, status: 204 })],
    [
        'body read failure',
        () => ({
            ok: true,
            status: 200,
            arrayBuffer: async () => {
                throw new TypeError('body interrupted');
            },
        }),
    ],
    [
        'short binary header',
        () => ({
            ok: true,
            status: 200,
            arrayBuffer: async () => new Uint8Array(3).buffer,
        }),
    ],
    [
        'impossible JSON length',
        () => ({
            ok: true,
            status: 200,
            arrayBuffer: async () => new Uint8Array([0, 0, 255, 255, 0]).buffer,
        }),
    ],
    [
        'invalid JSON header',
        () => ({
            ok: true,
            status: 200,
            arrayBuffer: async () => new Uint8Array([0, 0, 0, 1, 123]).buffer,
        }),
    ],
    [
        'negative span start',
        ({ from, to }) => recordingEnvelope(small.slice(from, to), -1, to),
    ],
    [
        'end before start',
        ({ from }) => recordingEnvelope(new Uint8Array(), from, from - 1),
    ],
    [
        'short body with a full-length header',
        ({ from, to }) =>
            recordingEnvelope(small.slice(from, to - 3), from, to),
    ],
    [
        'body longer than its declared span',
        ({ from, to }) =>
            recordingEnvelope(encode('foreign data'.repeat(90)), from, to),
    ],
    [
        'response from a different pane epoch',
        ({ from, to }) =>
            recordingEnvelope(encode('foreign lifetime'), from, to, {
                epoch: 99,
            }),
    ],
];

// These are independently named failure scenarios, NOT a claim that every
// matrix cell is a different root cause. The audit ledger groups root causes.
for (const phase of ['initial attach', 'live gap']) {
    describe(`${phase}: recording recovery must be lossless`, () => {
        it.each(faults)(
            '%s must recover when the same bytes become available',
            async (_name, fail) => {
                vi.spyOn(console, 'error').mockImplementation(() => {});
                const h = replayHarness(small, (request) =>
                    request.attempt === 1 ? fail(request) : null,
                );
                try {
                    if (phase === 'initial attach') {
                        h.pty.ws.head({
                            epoch: 7,
                            oldest: 0,
                            head: small.length,
                        });
                    } else {
                        h.pty.ws.head({ epoch: 7, oldest: 0, head: 0 });
                        h.pty.ws.output(0, small.slice(0, 12));
                        h.pty.ws.output(small.length - 6, small.slice(-6));
                    }
                    await h.settle();
                    assertComplete(h, small);
                    expect(
                        h.requests.length,
                        'invalid or temporary responses must not become permanent data loss',
                    ).toBeGreaterThan(1);
                } finally {
                    h.dispose();
                }
            },
        );
    });
}

for (const phase of [
    'first open',
    'same-pane reconnect',
    'new lifetime',
    'large live gap',
]) {
    describe(`${phase}: limits must bound work, not discard history`, () => {
        it.each([LIMIT + 1, LIMIT + 73, LIMIT * 2 + 7])(
            'preserves a %i-byte retained recording',
            async (size) => {
                const source = encode(
                    `FIRST\r\n${'x'.repeat(size)}\r\nLAST\r\n`,
                );
                const h = replayHarness(source);
                try {
                    if (
                        phase === 'same-pane reconnect' ||
                        phase === 'new lifetime'
                    ) {
                        h.tab._termOpened = true;
                        if (phase === 'new lifetime') h.tab.paneEpoch = 6;
                    }
                    if (phase === 'large live gap') {
                        h.pty.ws.head({ epoch: 7, oldest: 0, head: 0 });
                        h.pty.ws.output(0, source.slice(0, 7));
                        h.pty.ws.output(source.length - 8, source.slice(-8));
                    } else {
                        h.pty.ws.head({
                            epoch: 7,
                            oldest: 0,
                            head: source.length,
                        });
                    }
                    await h.settle();
                    assertComplete(h, source);
                    expect(
                        h.requests.every((r) => r.to - r.from <= LIMIT),
                        'recovery stays bounded per request',
                    ).toBe(true);
                    const buffer = h.term.buffer.active;
                    const liveTail = Array.from(
                        { length: Math.min(24, buffer.length) },
                        (_, i) =>
                            buffer
                                .getLine(
                                    buffer.length -
                                        Math.min(24, buffer.length) +
                                        i,
                                )
                                ?.translateToString(true) ?? '',
                    ).join('\n');
                    expect(
                        liveTail,
                        'bounded xterm retains the newest part of the fully verified recording',
                    ).toContain('LAST');
                } finally {
                    h.dispose();
                }
            },
        );
    });
}

for (const event of ['process exit', 'socket disconnect']) {
    for (const inactive of [false, true]) {
        describe(`${event} while ${inactive ? 'inactive' : 'active'}: queued output is still history`, () => {
            it.each([1, 7, 9, 13, 22, 35])(
                'finishes already received bytes after parse split %i',
                async (split) => {
                    const source = encode(
                        'FIRST 你好 🙂\r\n\x1b[31mSECOND\x1b[0m\r\nLAST\r\n',
                    );
                    const h = replayHarness(source);
                    h.tab.tabEl = document.createElement('div');
                    h.manager._showReconnectOverlay = vi.fn();
                    h.manager.maybeAutoReconnect = vi.fn();
                    h.manager.updateDisconnectBanner = vi.fn();
                    h.manager.activePaneId = inactive
                        ? 'another-pane'
                        : h.tab.paneId;
                    const write = h.term.write.bind(h.term);
                    let releaseParse;
                    let first = true;
                    let parsed;
                    const complete = new Promise((resolve) => {
                        parsed = resolve;
                    });
                    h.term.write = (data, callback) => {
                        if (first) {
                            first = false;
                            releaseParse = () =>
                                write(data, () => {
                                    callback();
                                    parsed();
                                });
                        } else {
                            write(data, callback);
                        }
                    };
                    try {
                        h.pty.ws.head({ epoch: 7, oldest: 0, head: 0 });
                        // Empty attachment still settles geometry before live
                        // bytes enter the paused parser below.
                        await h.settle();
                        h.pty.ws.output(0, source.slice(0, split));
                        h.pty.ws.output(split, source.slice(split));
                        if (event === 'process exit')
                            h.manager.handleControlMessage(h.tab, {
                                type: 'pty-exited',
                                code: 0,
                            });
                        else h.manager._handleTerminalDisconnect(h.tab);
                        releaseParse();
                        await complete;
                        await h.settle();
                        assertComplete(h, source);
                    } finally {
                        h.dispose();
                    }
                },
            );
        });
    }
}

for (const inactive of [false, true]) {
    describe(`${inactive ? 'inactive' : 'active'} terminal: refused writes remain retryable`, () => {
        it.each([1, 2, 3])(
            'retries refused parse batch %i without losing data',
            async (refusal) => {
                vi.spyOn(console, 'error').mockImplementation(() => {});
                const source = encode(
                    'batch one\r\nbatch two\r\nbatch three\r\n',
                );
                const h = replayHarness(source);
                const write = h.term.write.bind(h.term);
                let calls = 0;
                h.term.write = (data, cb) => {
                    if (++calls === refusal)
                        throw new Error('write buffer is full');
                    return write(data, cb);
                };
                h.manager.activePaneId = inactive
                    ? 'another-pane'
                    : h.tab.paneId;
                try {
                    h.pty.ws.head({ epoch: 7, oldest: 0, head: 0 });
                    let seq = 0;
                    for (const line of [
                        'batch one\r\n',
                        'batch two\r\n',
                        'batch three\r\n',
                    ]) {
                        const bytes = encode(line);
                        h.pty.ws.output(seq, bytes);
                        seq += bytes.length;
                        await h.settle();
                    }
                    assertComplete(h, source);
                } finally {
                    h.dispose();
                }
            },
        );
    });
}
