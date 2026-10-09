import { expect, test } from '@playwright/test';
import type { WebSocketRoute } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

let phi: PhiServer;
test.beforeAll(async () => {
    phi = await startPhi();
});
test.afterAll(async () => {
    await phi.stop();
});

interface AttachTerminal {
    element?: HTMLElement;
    cols: number;
    rows: number;
    buffer: {
        active: {
            baseY: number;
            viewportY: number;
            length: number;
            getLine(
                i: number,
            ): { translateToString(trim?: boolean): string } | undefined;
        };
    };
    write(data: string | Uint8Array, callback?: () => void): void;
    scrollToLine(line: number): void;
    scrollToTop(): void;
}
interface TerminalConstructor {
    new (options: Record<string, unknown>): AttachTerminal;
}
interface PerfWindow {
    attachTerms: AttachTerminal[];
    writes: number;
    pending: number;
    longTasks: number;
    bytes: number;
    Terminal: TerminalConstructor;
}

test('long archive attaches from bounded state and fetches older books only on a near-top button click', async ({
    page,
}) => {
    const id = 'two-hour-terminal';
    const line = Buffer.from(
        '\x1b[38;2;120;80;220mARCHIVE-BOOK 你🙂 history payload\x1b[0m\r\n',
    );
    const archive = Buffer.alloc(line.length * 300000);
    for (let at = 0; at < archive.length; at += line.length)
        line.copy(archive, at);
    const checkpoint = Buffer.from(
        '\x1b[2J\x1b[H' +
            Array.from({ length: 200 }, (_, i) => `RESIDENT ROW ${i}\r\n`).join(
                '',
            ) +
            '\x1b[32mCURRENT SCREEN READY\x1b[0m\r\nprompt> ',
    );
    const epoch = 9001,
        cols = 100,
        rows = 30;
    let sentAttachBytes = 0,
        recordingRequests: { from: number; through: number }[] = [];
    let stateRequests = 0;
    page.on('request', (request) => {
        if (request.url().includes(`/api/terminals/${id}/state?`))
            stateRequests++;
    });
    const socketRoutes: WebSocketRoute[] = [];
    const frames: { type: number; bytes: number }[] = [];
    await page.addInitScript(() => {
        const w = window as unknown as PerfWindow;
        w.attachTerms = [];
        w.writes = 0;
        w.pending = 0;
        w.longTasks = 0;
        w.bytes = 0;
        new PerformanceObserver((entries) => {
            w.longTasks += entries.getEntries().length;
        }).observe({ type: 'longtask', buffered: true });
        let Base: TerminalConstructor;
        Object.defineProperty(window, 'Terminal', {
            configurable: true,
            get: () => Base,
            set: (Original: TerminalConstructor) => {
                Base = class extends Original {
                    constructor(options: Record<string, unknown>) {
                        super(options);
                        w.attachTerms.push(this);
                    }
                    write(data: string | Uint8Array, callback?: () => void) {
                        const size =
                            typeof data === 'string'
                                ? new TextEncoder().encode(data).byteLength
                                : data.byteLength;
                        w.writes++;
                        w.bytes += size;
                        w.pending++;
                        super.write(data, () => {
                            w.pending--;
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
                    title: 'Two hour session',
                    coder: 'bash',
                    cwd: phi.dir,
                    workspace: phi.dir,
                    session_id: '',
                    pinned: false,
                },
            ],
        }),
    );
    await page.route(`**/api/terminals/${id}/recording?*`, (route) => {
        const query = new URL(route.request().url()).searchParams,
            from = Number(query.get('from')),
            through = Math.min(Number(query.get('through')), archive.length);
        recordingRequests.push({ from, through });
        const body = archive.subarray(from, through),
            header = Buffer.from(
                JSON.stringify({
                    epoch,
                    start: from,
                    end: through,
                    resizes: [],
                }),
            ),
            prefix = Buffer.alloc(4);
        prefix.writeUInt32BE(header.length);
        return route.fulfill({
            contentType: 'application/octet-stream',
            body: Buffer.concat([prefix, header, body]),
        });
    });
    await page.route(`**/api/terminals/${id}/**`, (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('/recording')) return route.fallback();
        if (url.pathname.endsWith('/state')) {
            const latest = url.searchParams.get('through') === 'latest';
            const through = latest
                ? archive.length
                : Number(url.searchParams.get('through'));
            const bytes = latest
                ? checkpoint
                : Buffer.concat([
                      Buffer.from('\x1b[2J\x1b[H'),
                      line.subarray(0, through % line.length),
                  ]);
            const header = Buffer.from(
                JSON.stringify({
                    epoch,
                    oldest: 0,
                    head: through,
                    ckpt: {
                        kind: 'ansi-v1',
                        through,
                        cols,
                        rows,
                        len: bytes.length,
                    },
                }),
            );
            const prefix = Buffer.alloc(4);
            prefix.writeUInt32BE(header.length);
            return route.fulfill({
                contentType: 'application/octet-stream',
                body: Buffer.concat([prefix, header, bytes]),
            });
        }
        return route.fulfill({ json: {} });
    });
    await page.routeWebSocket(`**/ws/pane/${id}?*`, (socket) => {
        socketRoutes.push(socket);
        const header = Buffer.from(
            JSON.stringify({
                epoch,
                oldest: 0,
                head: archive.length,
                ckpt: {
                    kind: 'ansi-v1',
                    through: archive.length,
                    cols,
                    rows,
                    len: checkpoint.length,
                },
            }),
        );
        const prefix = Buffer.alloc(5);
        prefix[0] = 0x08;
        prefix.writeUInt32BE(header.length, 1);
        const message = Buffer.concat([prefix, header, checkpoint]);
        sentAttachBytes += message.length;
        frames.push({ type: 0x08, bytes: message.length });
        socket.send(message);
        socket.onMessage((message) => {
            if (Buffer.isBuffer(message))
                frames.push({ type: message[0], bytes: message.length });
        });
    });
    await page.goto(phi.url);
    await expect(page.locator(`#term-${id}`)).toBeVisible();
    await expect
        .poll(() =>
            page.evaluate(() => {
                const w = window as unknown as PerfWindow;
                const term = w.attachTerms.find(
                    (t) =>
                        t.element?.closest('.term-container')?.id ===
                        'term-two-hour-terminal',
                );
                return (
                    !!term &&
                    w.pending === 0 &&
                    Array.from(
                        { length: term.buffer.active.length },
                        (_, i) =>
                            term.buffer.active
                                .getLine(i)
                                ?.translateToString(true) || '',
                    ).some((line) => line.includes('prompt> '))
                );
            }),
        )
        .toBe(true);
    expect(sentAttachBytes).toBeLessThan(archive.length / 100);
    const attachWriteBytes = await page.evaluate(
        () => (window as unknown as PerfWindow).bytes,
    );
    expect(attachWriteBytes).toBeLessThan(archive.length / 100);
    expect(recordingRequests).toHaveLength(0);
    expect(frames[0]?.type).toBe(0x08);
    const historyButton = page.locator(`#term-${id} .load-history-btn`);
    await page.locator(`#term-${id} .xterm-screen`).hover();
    await page.mouse.wheel(0, -40);
    await expect
        .poll(() =>
            page.evaluate(() => {
                const term = (window as unknown as PerfWindow).attachTerms.find(
                    (t) =>
                        t.element?.closest('.term-container')?.id ===
                        'term-two-hour-terminal',
                );
                const buffer = term?.buffer.active;
                return (
                    !!term &&
                    !!buffer &&
                    buffer.viewportY < buffer.baseY &&
                    buffer.viewportY > term.rows
                );
            }),
        )
        .toBe(true);
    await expect(historyButton).toHaveClass(/hidden/);
    expect(recordingRequests).toHaveLength(0);
    expect(stateRequests).toBe(0);
    // Even near the top, scrolling reveals a button without fetching a book.
    await page.evaluate(() => {
        const term = (window as unknown as PerfWindow).attachTerms.find(
            (t) =>
                t.element?.closest('.term-container')?.id ===
                'term-two-hour-terminal',
        );
        term?.scrollToLine(term.rows);
    });
    await expect(historyButton).not.toHaveClass(/hidden/);
    await expect(historyButton).toBeEnabled();
    expect(recordingRequests).toHaveLength(0);
    expect(stateRequests).toBe(0);
    await page.evaluate(() => {
        (window as unknown as PerfWindow).attachTerms
            .find(
                (t) =>
                    t.element?.closest('.term-container')?.id ===
                    'term-two-hour-terminal',
            )
            ?.scrollToTop();
    });
    await page.mouse.wheel(0, -120);
    await expect(historyButton).toBeEnabled();
    expect(recordingRequests).toHaveLength(0);
    expect(stateRequests).toBe(0);
    // An explicit click retains the existing exact, bounded book contract.
    await historyButton.click();
    await expect.poll(() => recordingRequests.length).toBe(1);
    const pageRequest = recordingRequests.at(-1);
    expect(pageRequest).toBeDefined();
    if (!pageRequest) throw new Error('history request disappeared');
    expect(pageRequest.from).toBeGreaterThanOrEqual(0);
    expect(pageRequest.through).toBe(archive.length);
    expect(pageRequest.through - pageRequest.from).toBeLessThanOrEqual(
        (2 << 20) / 20,
    );
    await expect
        .poll(() =>
            page.evaluate(() => {
                const w = window as unknown as PerfWindow;
                const term = w.attachTerms.find(
                    (t) =>
                        t.element?.closest('.term-container')?.id ===
                        'term-two-hour-terminal',
                );
                if (!term || w.pending !== 0) return false;
                for (let row = 0; row < term.buffer.active.length; row++)
                    if (
                        term.buffer.active
                            .getLine(row)
                            ?.translateToString(true)
                            .includes('ARCHIVE-BOOK')
                    )
                        return true;
                return false;
            }),
        )
        .toBe(true);
    await expect(historyButton).toBeEnabled();
    await page.mouse.wheel(0, -120);
    await expect(historyButton).toBeEnabled();
    expect(recordingRequests).toHaveLength(1);
    expect(stateRequests).toBe(1);
    const metrics = await page.evaluate(() => {
        const w = window as unknown as PerfWindow;
        return {
            terminalWrites: w.writes,
            terminalWriteBytes: w.bytes,
            longTasks: w.longTasks,
        };
    });
    console.log(
        'BOUNDED ATTACH PERFORMANCE',
        JSON.stringify({
            archiveBytes: archive.length,
            attachBytes: sentAttachBytes,
            historyRanges: recordingRequests,
            metrics,
        }),
    );
    expect(metrics.terminalWriteBytes).toBeLessThanOrEqual(
        attachWriteBytes + (2 << 20),
    );
});
