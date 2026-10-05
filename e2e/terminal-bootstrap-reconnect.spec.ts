import { createHash } from 'node:crypto';
import { expect, test, type WebSocketRoute } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';
let phi: PhiServer;
test.beforeAll(async () => {
    phi = await startPhi();
});
test.afterAll(async () => {
    await phi.stop();
});

for (const pauseBatch of [1, 3]) {
    test(`real browser resume during parser batch ${pauseBatch} must show the newest retained screen`, async ({
        page,
    }, info) => {
        const pane = 'interrupted-bootstrap';
        const range = 2 * 1024 * 1024;
        const paint = '\x1b[1;1HSTALE SCREEN\x1b[K';
        const prefix = paint
            .repeat(Math.ceil(range / paint.length))
            .slice(0, range);
        const source = Buffer.from(
            `${prefix}\x1b[1;1HNEWEST RETAINED SCREEN\x1b[K`,
        );
        const requests: { from: number; through: number }[] = [];
        let firstSocket: WebSocketRoute | undefined;
        let connections = 0;
        await page.addInitScript(
            ({ id, batch }) => {
                interface Observed {
                    element?: HTMLElement;
                    rows: number;
                    buffer: {
                        active: {
                            baseY: number;
                            getLine(
                                i: number,
                            ):
                                | { translateToString(trim?: boolean): string }
                                | undefined;
                        };
                    };
                    write(
                        data: string | Uint8Array,
                        callback?: () => void,
                    ): void;
                }
                type Constructor = new (
                    opts: Record<string, unknown>,
                ) => Observed;
                const w = window as unknown as {
                    interruptedTerms: Observed[];
                    parserPaused: boolean;
                    terminalInput: string[];
                    pendingTerminalWrites: number;
                    lastTerminalWriteAt: number;
                    releaseParser?: () => void;
                };
                w.interruptedTerms = [];
                w.terminalInput = [];
                w.pendingTerminalWrites = 0;
                w.lastTerminalWriteAt = performance.now();
                w.parserPaused = false;
                let ctor: Constructor;
                let writes = 0;
                let interrupted = false;
                Object.defineProperty(window, 'Terminal', {
                    configurable: true,
                    get: () => ctor,
                    set: (base: Constructor) => {
                        ctor = class extends base {
                            constructor(opts: Record<string, unknown>) {
                                super(opts);
                                w.interruptedTerms.push(this);
                            }
                            write(
                                data: string | Uint8Array,
                                callback?: () => void,
                            ) {
                                const target =
                                    this.element?.closest('.term-container')
                                        ?.id === `term-${id}`;
                                if (!target) {
                                    super.write(data, callback);
                                    return;
                                }
                                w.terminalInput.push(
                                    typeof data === 'string'
                                        ? data
                                        : new TextDecoder().decode(data),
                                );
                                w.pendingTerminalWrites++;
                                w.lastTerminalWriteAt = performance.now();
                                let completed = false;
                                const finish = () => {
                                    if (completed) return;
                                    completed = true;
                                    w.pendingTerminalWrites--;
                                    callback?.();
                                };
                                try {
                                    super.write(data, () => {
                                        if (
                                            !interrupted &&
                                            ++writes === batch
                                        ) {
                                            interrupted = true;
                                            w.parserPaused = true;
                                            w.releaseParser = finish;
                                        } else finish();
                                    });
                                } catch (error) {
                                    w.pendingTerminalWrites--;
                                    throw error;
                                }
                            }
                        };
                    },
                });
            },
            { id: pane, batch: pauseBatch },
        );
        await page.route('**/api/terminals', (route) =>
            route.fulfill({
                json: [
                    {
                        id: pane,
                        title: 'Reconnect during bootstrap',
                        coder: 'bash',
                        cwd: phi.dir,
                        workspace: phi.dir,
                        session_id: '',
                        pinned: false,
                    },
                ],
            }),
        );
        await page.route('**/api/terminals/interrupted-bootstrap/**', (route) =>
            route.fulfill({ json: {} }),
        );
        await page.route(
            '**/api/terminals/interrupted-bootstrap/recording?*',
            (route) => {
                const query = new URL(route.request().url()).searchParams;
                const from = Number(query.get('from'));
                const through = Math.min(
                    Number(query.get('through')),
                    source.length,
                );
                requests.push({ from, through });
                const hdr = Buffer.from(
                    JSON.stringify({
                        epoch: 7,
                        start: from,
                        end: through,
                        resizes: [],
                    }),
                );
                const size = Buffer.alloc(4);
                size.writeUInt32BE(hdr.length);
                return route.fulfill({
                    contentType: 'application/octet-stream',
                    body: Buffer.concat([
                        size,
                        hdr,
                        source.subarray(from, through),
                    ]),
                });
            },
        );
        await page.routeWebSocket(
            '**/ws/pane/interrupted-bootstrap?*',
            (socket) => {
                connections++;
                if (!firstSocket) firstSocket = socket;
                const hdr = Buffer.from(
                    JSON.stringify({
                        epoch: 7,
                        oldest: 0,
                        head: source.length,
                    }),
                );
                const frame = Buffer.alloc(5);
                frame[0] = 0x08;
                frame.writeUInt32BE(hdr.length, 1);
                socket.send(Buffer.concat([frame, hdr]));
            },
        );
        await page.goto(phi.url);
        await page.locator(`.tab[data-pane-id="${pane}"]`).click();
        await expect
            .poll(() =>
                page.evaluate(
                    () =>
                        (window as unknown as { parserPaused: boolean })
                            .parserPaused,
                ),
            )
            .toBe(true);
        if (!firstSocket) throw new Error('attach socket was not created');
        firstSocket.close();
        // The route sends ATTACH_HEAD as soon as the second socket opens.
        // Yield to the browser so its handler starts while the old xterm
        // callback is still deliberately held.
        await expect.poll(() => connections).toBeGreaterThanOrEqual(2);
        await page.evaluate(
            () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
        );
        await page.evaluate(() =>
            (
                window as unknown as { releaseParser?: () => void }
            ).releaseParser?.(),
        );
        await expect
            .poll(
                () =>
                    page.evaluate(() => {
                        const w = window as unknown as {
                            pendingTerminalWrites: number;
                            lastTerminalWriteAt: number;
                        };
                        return (
                            w.pendingTerminalWrites === 0 &&
                            performance.now() - w.lastTerminalWriteAt >= 250
                        );
                    }),
                { timeout: 15000 },
            )
            .toBe(true);
        const result = await page.evaluate(async (id) => {
            const w = window as unknown as {
                interruptedTerms: {
                    element?: HTMLElement;
                    rows: number;
                    buffer: {
                        active: {
                            baseY: number;
                            getLine(i: number):
                                | {
                                      translateToString(trim?: boolean): string;
                                  }
                                | undefined;
                        };
                    };
                }[];
                terminalInput: string[];
            };
            const t = w.interruptedTerms.find(
                (x) =>
                    x.element?.closest('.term-container')?.id === `term-${id}`,
            );
            const input = w.terminalInput.join('');
            const digest = crypto.subtle.digest(
                'SHA-256',
                new TextEncoder().encode(input),
            );
            return {
                screen: t
                    ? Array.from({ length: t.rows }, (_, i) =>
                          t.buffer.active
                              .getLine(t.buffer.active.baseY + i)
                              ?.translateToString(true),
                      ).join('\n')
                    : '',
                inputBytes: new TextEncoder().encode(input).length,
                digest: Array.from(new Uint8Array(await digest), (byte) =>
                    byte.toString(16).padStart(2, '0'),
                ).join(''),
            };
        }, pane);
        const expectedDigest = createHash('sha256')
            .update(source)
            .digest('hex');
        await info.attach('resume-frontiers', {
            body: JSON.stringify(
                {
                    head: source.length,
                    requests,
                    connections,
                    result,
                    expectedDigest,
                },
                null,
                2,
            ),
            contentType: 'application/json',
        });
        await page.screenshot({ path: info.outputPath('resumed-screen.png') });
        expect({
            newestScreenVisible: result.screen.includes(
                'NEWEST RETAINED SCREEN',
            ),
            parserInputBytes: result.inputBytes,
            parserInputDigest: result.digest,
        }).toEqual({
            newestScreenVisible: true,
            parserInputBytes: source.length,
            parserInputDigest: expectedDigest,
        });
    });
}
