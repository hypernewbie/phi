import { expect, test, type WebSocketRoute } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

let phi: PhiServer;
test.beforeAll(async () => {
    phi = await startPhi();
});
test.afterAll(async () => {
    await phi.stop();
});

interface ObservedTerm {
    element?: HTMLElement;
    cols: number;
    rows: number;
    write(data: string | Uint8Array, callback?: () => void): void;
    buffer: {
        active: {
            baseY: number;
            getLine(
                i: number,
            ): { translateToString(trim?: boolean): string } | undefined;
        };
    };
}
interface ObservedWindow {
    recoveryTerms: ObservedTerm[];
    recoveryPending: number;
    Terminal: new (options: Record<string, unknown>) => ObservedTerm;
}
interface Checkpoint {
    through: number;
    cols: number;
    rows: number;
    ansi: string;
}

for (const alternate of [false, true]) {
    test(`slow touch browser recovers split UTF-8, reconnect and checkpoint reload (${alternate ? 'TUI' : 'normal'})`, async ({
        browser,
    }) => {
        const context = await browser.newContext({
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
        });
        try {
            const page = await context.newPage();
            const cdp = await context.newCDPSession(page);
            await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
            const id = 'mobile-byte-recovery';
            const prefix = `${alternate ? '\x1b[?1049h\x1b[2J\x1b[H' : ''}kept `;
            const bytes = Buffer.from(`${prefix}🙂 after`);
            const boundary = Buffer.byteLength(prefix);
            const cut = boundary + 1;
            let head = 0;
            let checkpoint: Checkpoint | undefined;
            const sockets: WebSocketRoute[] = [];
            const sizedSockets = new Set<number>();
            await page.addInitScript(() => {
                const w = window as unknown as ObservedWindow;
                w.recoveryPending = 0;
                w.recoveryTerms = [];
                let ctor: typeof w.Terminal;
                Object.defineProperty(window, 'Terminal', {
                    configurable: true,
                    get: () => ctor,
                    set: (base: typeof w.Terminal) => {
                        ctor = class extends base {
                            constructor(options: Record<string, unknown>) {
                                super(options);
                                w.recoveryTerms.push(this);
                            }
                            write(
                                data: string | Uint8Array,
                                callback?: () => void,
                            ) {
                                w.recoveryPending++;
                                super.write(data, () => {
                                    w.recoveryPending--;
                                    callback?.();
                                });
                            }
                        };
                    },
                });
            });
            await page.route('**/api/terminals', (route) =>
                route.fulfill({
                    json: [
                        {
                            id,
                            title: 'Mobile recovery',
                            coder: 'bash',
                            cwd: phi.dir,
                            workspace: phi.dir,
                            session_id: '',
                            pinned: false,
                        },
                    ],
                }),
            );
            await page.route(`**/api/terminals/${id}/**`, (route) =>
                route.fulfill({ json: {} }),
            );
            await page.route(`**/api/terminals/${id}/checkpoint`, (route) => {
                checkpoint = route.request().postDataJSON() as Checkpoint;
                return route.fulfill({ json: {} });
            });
            await page.route(`**/api/terminals/${id}/recording?*`, (route) => {
                const query = new URL(route.request().url()).searchParams;
                expect(query.has('have')).toBe(false);
                const from = Number(query.get('from'));
                const end = Math.min(Number(query.get('through')), head);
                const header = Buffer.from(
                    JSON.stringify({ epoch: 7, start: from, end, resizes: [] }),
                );
                const size = Buffer.alloc(4);
                size.writeUInt32BE(header.length);
                return route.fulfill({
                    contentType: 'application/octet-stream',
                    body: Buffer.concat([
                        size,
                        header,
                        bytes.subarray(from, end),
                    ]),
                });
            });
            await page.routeWebSocket(`**/ws/pane/${id}?*`, (socket) => {
                const index = sockets.length;
                sockets.push(socket);
                socket.onMessage((message) => {
                    if (
                        Buffer.isBuffer(message) &&
                        message.length === 5 &&
                        message[0] === 0x02
                    )
                        sizedSockets.add(index);
                });
                const header = Buffer.from(
                    JSON.stringify({
                        epoch: 7,
                        oldest: 0,
                        head,
                        ...(checkpoint
                            ? {
                                  ckpt: {
                                      ...checkpoint,
                                      len: Buffer.byteLength(checkpoint.ansi),
                                  },
                              }
                            : {}),
                    }),
                );
                const size = Buffer.alloc(5);
                size[0] = 0x08;
                size.writeUInt32BE(header.length, 1);
                socket.send(
                    Buffer.concat([
                        size,
                        header,
                        checkpoint
                            ? Buffer.from(checkpoint.ansi)
                            : Buffer.alloc(0),
                    ]),
                );
            });
            const output = (start: number, end: number) => {
                head = end;
                const frame = Buffer.alloc(9);
                frame[0] = 0x09;
                frame.writeBigUInt64BE(BigInt(start), 1);
                sockets[sockets.length - 1].send(
                    Buffer.concat([frame, bytes.subarray(start, end)]),
                );
            };
            const line = () =>
                page.evaluate(() => {
                    const w = window as unknown as ObservedWindow;
                    const term = w.recoveryTerms.find(
                        (t) =>
                            t.element?.closest('.term-container')?.id ===
                            'term-mobile-byte-recovery',
                    );
                    return w.recoveryPending === 0
                        ? term?.buffer.active
                              .getLine(term.buffer.active.baseY)
                              ?.translateToString(true)
                        : null;
                });
            await page.goto(phi.url);
            await expect(page.locator(`#term-${id}`)).toBeVisible();
            await expect.poll(() => sockets.length).toBe(1);
            output(0, boundary);
            await expect.poll(line).toBe('kept ');
            output(boundary, cut);
            // Admission/completion predicates, not a CPU/time performance gate.
            await expect.poll(() => checkpoint?.through).toBe(boundary);
            await sockets[0].close();
            await page.locator(`#term-${id} .reconnect-btn`).click();
            await expect.poll(() => sockets.length).toBe(2);
            await expect.poll(() => sizedSockets.has(1)).toBe(true);
            output(cut, bytes.length);
            await expect.poll(line).toBe('kept 🙂 after');
            await expect.poll(() => checkpoint?.through).toBe(bytes.length);
            await page.reload();
            await expect(page.locator(`#term-${id}`)).toBeVisible();
            await expect.poll(line).toBe('kept 🙂 after');
            expect(checkpoint?.through).toBe(bytes.length);
        } finally {
            await context.close();
        }
    });
}
