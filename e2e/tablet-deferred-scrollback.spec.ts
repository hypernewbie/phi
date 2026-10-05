import { expect, test } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

let phi: PhiServer;
test.beforeAll(async () => {
    phi = await startPhi();
});
test.afterAll(async () => {
    await phi.stop();
});

const LIVE_ROWS = 10000;
const HISTORY_LINES = 120000;
const HISTORY_BUDGET_BYTES = 2 * 1024 * 1024;
const NEWEST = 'DEFERRED_NEWEST';
const IMMEDIATE_OLDER = `ARCHIVE ${String(HISTORY_LINES - 1).padStart(7, '0')}`;

interface Observed {
    element?: HTMLElement;
    rows: number;
    options: { scrollback: number };
    buffer: {
        active: {
            length: number;
            viewportY: number;
            baseY: number;
            getLine(
                i: number,
            ): { translateToString(trim?: boolean): string } | undefined;
        };
    };
    write(data: string | Uint8Array, callback?: () => void): void;
}

for (const checkpoint of [false, true]) {
    test(`tablet history stays bounded on ${checkpoint ? 'one older-page gesture' : 'cold attach'}`, async ({
        browser,
    }, info) => {
        test.setTimeout(45000);
        const context = await browser.newContext({
            viewport: { width: 834, height: 1194 },
            isMobile: true,
            hasTouch: true,
            deviceScaleFactor: 2,
        });
        const page = await context.newPage();
        const pane = 'tablet-deferred';
        const history = `${Array.from(
            { length: HISTORY_LINES },
            (_, i) =>
                `ARCHIVE ${String(i).padStart(7, '0')} retained terminal line\r\n`,
        ).join('')}${NEWEST}\r\n`;
        const bytes = Buffer.from(history);
        const checkpointBytes = Buffer.from(`RECENT TAIL\r\n${NEWEST}\r\n`);
        const requests: { from: number; through: number }[] = [];
        let activeRequests = 0;
        await page.addInitScript((id: string) => {
            type Constructor = new (opts: Record<string, unknown>) => Observed;
            const w = window as unknown as {
                deferredTerms: Observed[];
                pendingWrites: number;
                lastWriteAt: number;
            };
            w.deferredTerms = [];
            w.pendingWrites = 0;
            w.lastWriteAt = performance.now();
            let ctor: Constructor;
            Object.defineProperty(window, 'Terminal', {
                configurable: true,
                get: () => ctor,
                set: (base: Constructor) => {
                    ctor = class extends base {
                        constructor(opts: Record<string, unknown>) {
                            super(opts);
                            w.deferredTerms.push(this);
                        }
                        write(
                            data: string | Uint8Array,
                            callback?: () => void,
                        ) {
                            const target =
                                this.element?.closest('.term-container')?.id ===
                                `term-${id}`;
                            if (!target) {
                                super.write(data, callback);
                                return;
                            }
                            w.pendingWrites++;
                            w.lastWriteAt = performance.now();
                            super.write(data, () => {
                                w.pendingWrites--;
                                w.lastWriteAt = performance.now();
                                callback?.();
                            });
                        }
                    };
                },
            });
        }, pane);
        await page.route('**/api/terminals', (route) =>
            route.fulfill({
                json: [
                    {
                        id: pane,
                        title: 'Long history',
                        coder: 'bash',
                        cwd: phi.dir,
                        workspace: phi.dir,
                        session_id: '',
                        pinned: false,
                    },
                ],
            }),
        );
        await page.route('**/api/terminals/tablet-deferred/**', (route) =>
            route.fulfill({ json: {} }),
        );
        await page.route(
            '**/api/terminals/tablet-deferred/recording?*',
            async (route) => {
                const query = new URL(route.request().url()).searchParams;
                const from = Number(query.get('from'));
                const through = Math.min(
                    Number(query.get('through')),
                    bytes.length,
                );
                requests.push({ from, through });
                activeRequests++;
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
                try {
                    await route.fulfill({
                        contentType: 'application/octet-stream',
                        body: Buffer.concat([
                            size,
                            hdr,
                            bytes.subarray(from, through),
                        ]),
                    });
                } finally {
                    activeRequests--;
                }
            },
        );
        await page.routeWebSocket('**/ws/pane/tablet-deferred?*', (socket) => {
            const header = {
                epoch: 7,
                oldest: 0,
                head: bytes.length,
                ...(checkpoint
                    ? {
                          ckpt: {
                              through: bytes.length,
                              cols: 80,
                              rows: 24,
                              len: checkpointBytes.length,
                          },
                      }
                    : {}),
            };
            const hdr = Buffer.from(JSON.stringify(header));
            const frame = Buffer.alloc(5);
            frame[0] = 0x08;
            frame.writeUInt32BE(hdr.length, 1);
            socket.send(
                Buffer.concat([
                    frame,
                    hdr,
                    checkpoint ? checkpointBytes : Buffer.alloc(0),
                ]),
            );
        });
        const stats = () =>
            page.evaluate((id) => {
                const w = window as unknown as {
                    deferredTerms: Observed[];
                    pendingWrites: number;
                    lastWriteAt: number;
                };
                const term = w.deferredTerms.find(
                    (candidate) =>
                        candidate.element?.closest('.term-container')?.id ===
                        `term-${id}`,
                );
                if (!term) {
                    return {
                        length: 0,
                        budget: 0,
                        rows: 0,
                        visible: [] as string[],
                        pendingWrites: w.pendingWrites,
                        lastWriteAt: w.lastWriteAt,
                        now: performance.now(),
                        coarse: false,
                    };
                }
                const buffer = term.buffer.active;
                const visible = Array.from(
                    { length: term.rows },
                    (_, i) =>
                        buffer
                            .getLine(buffer.viewportY + i)
                            ?.translateToString(true) ?? '',
                );
                return {
                    length: buffer.length,
                    budget: term.options.scrollback,
                    rows: term.rows,
                    visible,
                    pendingWrites: w.pendingWrites,
                    lastWriteAt: w.lastWriteAt,
                    now: performance.now(),
                    coarse: matchMedia('(pointer: coarse)').matches,
                };
            }, pane);
        try {
            await page.goto(phi.url);
            await page.locator(`.tab[data-pane-id="${pane}"]`).click();
            await expect
                .poll(async () => (await stats()).visible.includes(NEWEST), {
                    timeout: 25000,
                })
                .toBe(true);
            await expect
                .poll(async () => {
                    const current = await stats();
                    return (
                        current.pendingWrites === 0 &&
                        current.now - current.lastWriteAt >= 250
                    );
                })
                .toBe(true);
            const beforeGesture = await stats();
            expect(beforeGesture.coarse).toBe(true);

            if (checkpoint) {
                expect(requests).toHaveLength(0);
                const box = await page
                    .locator(`#term-${pane} .xterm-screen`)
                    .boundingBox();
                if (!box) throw new Error('xterm viewport is not visible');
                const cdp = await context.newCDPSession(page);
                await cdp.send('Input.synthesizeScrollGesture', {
                    x: box.x + 80,
                    y: box.y + 80,
                    yDistance: 200,
                    gestureSourceType: 'touch',
                    speed: 400,
                });
                await expect.poll(() => requests.length).toBeGreaterThan(0);
                await expect
                    .poll(async () => {
                        const current = await stats();
                        return (
                            activeRequests === 0 &&
                            current.pendingWrites === 0 &&
                            current.now - current.lastWriteAt >= 250
                        );
                    })
                    .toBe(true);
            }

            const actual = await stats();
            const requestedBytes = requests.reduce(
                (sum, request) => sum + request.through - request.from,
                0,
            );
            await info.attach('bounded-history-evidence', {
                body: JSON.stringify(
                    {
                        checkpoint,
                        historyLines: HISTORY_LINES,
                        actual,
                        requests,
                        requestedBytes,
                        immediateOlderMarker: IMMEDIATE_OLDER,
                    },
                    null,
                    2,
                ),
                contentType: 'application/json',
            });
            await page.screenshot({
                path: info.outputPath('tablet-history.png'),
            });

            const violations: string[] = [];
            if (!checkpoint && !actual.visible.includes(NEWEST))
                violations.push(
                    'newest retained output is not visible on cold attach',
                );
            if (actual.budget > LIVE_ROWS)
                violations.push(
                    `live scrollback is ${actual.budget} rows; budget is ${LIVE_ROWS}`,
                );
            const residentLimit = LIVE_ROWS + actual.rows;
            if (actual.length > residentLimit)
                violations.push(
                    `xterm retains ${actual.length} rows; limit is ${residentLimit}`,
                );
            if (requestedBytes > HISTORY_BUDGET_BYTES)
                violations.push(
                    `${checkpoint ? 'one touch action' : 'cold attach'} requested ${requestedBytes} bytes; budget is ${HISTORY_BUDGET_BYTES}`,
                );
            if (
                checkpoint &&
                !actual.visible.some((line) => line.startsWith(IMMEDIATE_OLDER))
            )
                violations.push(
                    `first older page does not show exact archive line ${IMMEDIATE_OLDER}`,
                );
            expect(violations).toEqual([]);
        } finally {
            await context.close();
        }
    });
}
