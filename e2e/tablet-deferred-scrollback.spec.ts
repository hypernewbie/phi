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
    scrollToTop?(): void;
    scrollToBottom?(): void;
}

for (const checkpoint of [false, true]) {
    test(`tablet history stays bounded on ${checkpoint ? 'one older-page gesture' : 'cold attach'}`, async ({
        browser,
    }, info) => {
        test.setTimeout(120000);
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
                inputBytes: number;
                lastWriteAt: number;
            };
            w.deferredTerms = [];
            w.pendingWrites = 0;
            w.inputBytes = 0;
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
                            w.inputBytes += new TextEncoder().encode(
                                typeof data === 'string'
                                    ? data
                                    : new TextDecoder().decode(data),
                            ).length;
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
                // Same certificate as the real journal: this fixture is ASCII
                // CRLF text, with far more than a live buffer after this reset.
                ...(!checkpoint
                    ? {
                          replay_from:
                              bytes.indexOf(
                                  '\r\n',
                                  bytes.length -
                                      (HISTORY_BUDGET_BYTES - 128 * 1024),
                              ) + 2,
                      }
                    : {}),
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
                    inputBytes: number;
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
                        inputBytes: w.inputBytes,
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
                    inputBytes: w.inputBytes,
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

            let firstPage: Awaited<ReturnType<typeof stats>> | undefined;
            let secondPage: Awaited<ReturnType<typeof stats>> | undefined;
            let firstPageTail: Awaited<ReturnType<typeof stats>> | undefined;
            let latestAfterReturn:
                | Awaited<ReturnType<typeof stats>>
                | undefined;
            const actionBytes: number[] = [];
            const pageRanges: { from: number; through: number }[][] = [];
            let oldestHistoryLine: number | undefined;
            if (checkpoint) {
                expect(requests).toHaveLength(0);
                await page.evaluate(() => {
                    (window as unknown as { inputBytes: number }).inputBytes =
                        0;
                });
                const box = await page
                    .locator(`#term-${pane} .xterm-screen`)
                    .boundingBox();
                if (!box) throw new Error('xterm viewport is not visible');
                const cdp = await context.newCDPSession(page);
                let requestIndex = requests.length;
                await cdp.send('Input.synthesizeScrollGesture', {
                    x: box.x + 80,
                    y: box.y + 80,
                    yDistance: 200,
                    gestureSourceType: 'touch',
                    speed: 400,
                });
                await expect
                    .poll(() => requests.length)
                    .toBeGreaterThan(requestIndex);
                const firstActionBytes = requests
                    .slice(requestIndex)
                    .reduce((sum, r) => sum + r.through - r.from, 0);
                await expect
                    .poll(async () => {
                        const current = await stats();
                        return (
                            activeRequests === 0 &&
                            current.pendingWrites === 0 &&
                            current.inputBytes === firstActionBytes &&
                            current.now - current.lastWriteAt >= 250
                        );
                    })
                    .toBe(true);
                firstPage = await stats();
                actionBytes.push(firstActionBytes);
                pageRanges.push(requests.slice(requestIndex));
                // Read only visible rows at the page's bottom too. The page
                // must contain the immediate older line, not merely any old text.
                await page.evaluate((id) => {
                    const w = window as unknown as {
                        deferredTerms: Observed[];
                    };
                    w.deferredTerms
                        .find(
                            (t) =>
                                t.element?.closest('.term-container')?.id ===
                                `term-${id}`,
                        )
                        ?.scrollToBottom?.();
                }, pane);
                firstPageTail = await stats();

                // Move to the top of the loaded window. The next bounded
                // recording page must move the visible anchor further back.
                requestIndex = requests.length;
                await page.evaluate(() => {
                    (window as unknown as { inputBytes: number }).inputBytes =
                        0;
                });
                await page.evaluate((id) => {
                    const w = window as unknown as {
                        deferredTerms: Observed[];
                    };
                    const term = w.deferredTerms.find(
                        (candidate) =>
                            candidate.element?.closest('.term-container')
                                ?.id === `term-${id}`,
                    );
                    term?.scrollToTop?.();
                    term?.element?.closest('.term-container')?.dispatchEvent(
                        new WheelEvent('wheel', {
                            deltaY: -100,
                            bubbles: true,
                        }),
                    );
                }, pane);
                await expect
                    .poll(() => requests.length)
                    .toBeGreaterThan(requestIndex);
                const secondActionBytes = requests
                    .slice(requestIndex)
                    .reduce((sum, r) => sum + r.through - r.from, 0);
                await expect
                    .poll(async () => {
                        const current = await stats();
                        return (
                            activeRequests === 0 &&
                            current.pendingWrites === 0 &&
                            current.inputBytes === secondActionBytes &&
                            current.now - current.lastWriteAt >= 250
                        );
                    })
                    .toBe(true);
                secondPage = await stats();
                actionBytes.push(secondActionBytes);
                pageRanges.push(requests.slice(requestIndex));
                const visibleArchiveIds = (
                    current: Awaited<ReturnType<typeof stats>>,
                ) =>
                    current.visible
                        .map((line) => line.match(/^ARCHIVE (\d{7})/))
                        .filter((match): match is RegExpMatchArray =>
                            Boolean(match),
                        )
                        .map((match) => Number(match[1]));
                let olderFrontier = Math.min(...visibleArchiveIds(secondPage));
                for (
                    let pageNumber = 0;
                    olderFrontier > 0 && pageNumber < 50;
                    pageNumber++
                ) {
                    requestIndex = requests.length;
                    await page.evaluate(() => {
                        (
                            window as unknown as { inputBytes: number }
                        ).inputBytes = 0;
                    });
                    await page.evaluate((id) => {
                        const w = window as unknown as {
                            deferredTerms: Observed[];
                        };
                        const term = w.deferredTerms.find(
                            (candidate) =>
                                candidate.element?.closest('.term-container')
                                    ?.id === `term-${id}`,
                        );
                        term?.scrollToTop?.();
                        term?.element
                            ?.closest('.term-container')
                            ?.dispatchEvent(
                                new WheelEvent('wheel', {
                                    deltaY: -100,
                                    bubbles: true,
                                }),
                            );
                    }, pane);
                    await expect
                        .poll(() => requests.length)
                        .toBeGreaterThan(requestIndex);
                    const pageBytes = requests
                        .slice(requestIndex)
                        .reduce((sum, r) => sum + r.through - r.from, 0);
                    await expect
                        .poll(async () => {
                            const current = await stats();
                            return (
                                activeRequests === 0 &&
                                current.pendingWrites === 0 &&
                                current.inputBytes === pageBytes &&
                                current.now - current.lastWriteAt >= 250
                            );
                        })
                        .toBe(true);
                    const olderPage = await stats();
                    const ids = visibleArchiveIds(olderPage);
                    const nextFrontier = Math.min(...ids);
                    if (
                        !Number.isFinite(nextFrontier) ||
                        nextFrontier >= olderFrontier ||
                        olderFrontier - nextFrontier >= olderPage.length
                    ) {
                        throw new Error(
                            `older paging skipped retained rows: ${olderFrontier} -> ${nextFrontier}`,
                        );
                    }
                    olderFrontier = nextFrontier;
                    oldestHistoryLine = nextFrontier;
                    actionBytes.push(pageBytes);
                    pageRanges.push(requests.slice(requestIndex));
                }
                if (olderFrontier !== 0) {
                    throw new Error(
                        `paging did not reach oldest retained line; stopped at ${olderFrontier}`,
                    );
                }
                await page.locator('.scroll-to-bottom-btn').click();
                await expect
                    .poll(
                        async () => (await stats()).visible.includes(NEWEST),
                        {
                            timeout: 15000,
                        },
                    )
                    .toBe(true);
                latestAfterReturn = await stats();
            }

            const actual = secondPage || firstPage || (await stats());
            const coldAttachBytes = requests.reduce(
                (sum, request) => sum + request.through - request.from,
                0,
            );
            const requestedBytes = checkpoint
                ? Math.max(0, ...actionBytes)
                : coldAttachBytes;
            const archiveIds = (
                page: Awaited<ReturnType<typeof stats>> | undefined,
            ) =>
                (page?.visible ?? [])
                    .map((line) => line.match(/^ARCHIVE (\d{7})/))
                    .filter((match): match is RegExpMatchArray =>
                        Boolean(match),
                    )
                    .map((match) => Number(match[1]));
            const firstPageIds = archiveIds(firstPage);
            const secondPageIds = archiveIds(secondPage);
            const firstPageOldest = Math.min(...firstPageIds);
            const secondPageOldest = Math.min(...secondPageIds);
            await info.attach('bounded-history-evidence', {
                body: JSON.stringify(
                    {
                        checkpoint,
                        historyLines: HISTORY_LINES,
                        actual,
                        requests,
                        requestedBytes,
                        actionBytes,
                        pageRanges,
                        firstPage,
                        firstPageTail,
                        secondPage,
                        firstPageOldest,
                        secondPageOldest,
                        latestAfterReturn,
                        immediateOlderMarker: IMMEDIATE_OLDER,
                        oldestHistoryLine,
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
                !firstPageTail?.visible.some((line) =>
                    line.startsWith(IMMEDIATE_OLDER),
                )
            )
                violations.push(
                    `first older page does not retain immediate older line ${IMMEDIATE_OLDER}`,
                );
            const pageAdvance = firstPageOldest - secondPageOldest;
            if (
                checkpoint &&
                (!Number.isFinite(pageAdvance) ||
                    pageAdvance <= 0 ||
                    pageAdvance >= (firstPage?.length ?? 0))
            )
                violations.push(
                    `second page skips beyond the retained overlap (${pageAdvance} lines)`,
                );
            if (checkpoint && !latestAfterReturn?.visible.includes(NEWEST))
                violations.push(
                    'jumping to latest did not restore the live tail',
                );
            if (actionBytes.some((n) => n > HISTORY_BUDGET_BYTES))
                violations.push(
                    'a single older-page action exceeded its byte budget',
                );
            expect(violations).toEqual([]);
        } finally {
            await context.close();
        }
    });
}
