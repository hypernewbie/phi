import { expect, test, type Page } from '@playwright/test';
import { TerminalServerFrame } from '../web/proto/terminal.js';
import type {
    MessageFns,
    TerminalServerFrame as TerminalServerMessage,
} from '../web-src/proto/terminal.js';
import { startPhi, type PhiServer } from './_server.js';
import { readReplay } from './_terminal-replay.js';

// Adverse-network recovery for the RAM window. A slow or refused replay
// must never block input, resend a request pair the server already
// refused, or leave a fresh viewer parked on an empty screen.

const ServerCodec: MessageFns<TerminalServerMessage> =
    TerminalServerFrame as unknown as MessageFns<TerminalServerMessage>;

let phi: PhiServer;

test.beforeEach(async () => {
    phi = await startPhi({ config: { replay_buffer_bytes: 65536 } });
});

test.afterEach(async () => {
    await phi.stop();
});

async function spawnShell(): Promise<string> {
    for (const coder of process.platform === 'win32'
        ? ['pwsh', 'bash']
        : ['bash']) {
        const res = await fetch(`${phi.url}/api/terminals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ coder, cols: 100, rows: 30 }),
        });
        if (res.ok) return ((await res.json()) as { pane_id: string }).pane_id;
    }
    test.skip(true, 'no shell coder available');
    throw new Error('unreachable');
}

type TrackedTerm = {
    buffer: {
        active: {
            length: number;
            getLine(i: number): { translateToString(trim: boolean): string };
        };
    };
    element?: { closest(selector: string): { id: string } | null };
    write(data: string | Uint8Array, cb?: () => void): void;
    reset(): void;
};
type TrackedWindow = {
    tracked: TrackedTerm[];
    pending: number;
};

async function installTermTracker(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const w = window as unknown as TrackedWindow;
        w.tracked = [];
        w.pending = 0;
        let Base: new (options: unknown) => TrackedTerm;
        Object.defineProperty(window, 'Terminal', {
            configurable: true,
            get: () => Base,
            set: (Original: new (options: unknown) => TrackedTerm) => {
                Base = class extends Original {
                    constructor(options: unknown) {
                        super(options);
                        w.tracked.push(this);
                    }
                    write(data: string | Uint8Array, cb?: () => void) {
                        w.pending++;
                        super.write(data, () => {
                            w.pending--;
                            cb?.();
                        });
                    }
                };
            },
        });
    });
}

const paneBody = (page: Page, pane: string) =>
    page.evaluate((id) => {
        const w = window as unknown as TrackedWindow;
        const term = w.tracked.find(
            (t) => t.element?.closest('.term-container')?.id === `term-${id}`,
        );
        if (!term || w.pending !== 0) return '';
        const lines: string[] = [];
        for (let i = 0; i < term.buffer.active.length; i++)
            lines.push(term.buffer.active.getLine(i).translateToString(true));
        return lines.join('\n');
    }, pane);

type AttachInfo = {
    epoch?: number;
    oldest?: number;
    head?: number;
    initialCols?: number;
    initialRows?: number;
    floorCols?: number;
    floorRows?: number;
    headCols?: number;
    headRows?: number;
    eventCursor?: string;
};

function watchAttach(page: Page, pane: string): { current: AttachInfo | null } {
    const seen: { current: AttachInfo | null } = { current: null };
    page.on('websocket', (socket) => {
        if (!socket.url().includes(`/ws/pane/${pane}?`)) return;
        socket.on('framereceived', ({ payload }) => {
            if (!Buffer.isBuffer(payload)) return;
            const frame = ServerCodec.decode(new Uint8Array(payload));
            if (frame.payload?.$case !== 'attach') return;
            const v = frame.payload.value;
            // Protobuf int64 arrives as BigInt; keep only plain numbers so
            // the value can cross into route handlers and reports.
            seen.current = {
                epoch: Number(v.epoch),
                oldest: Number(v.oldest),
                head: Number(v.head),
                initialCols: Number(v.initialCols),
                initialRows: Number(v.initialRows),
                floorCols: Number(v.floorCols),
                floorRows: Number(v.floorRows),
                headCols: Number(v.headCols),
                headRows: Number(v.headRows),
                eventCursor: v.eventCursor,
            };
        });
    });
    return seen;
}

const replayKey = (url: string) => {
    const u = new URL(url);
    return `${u.searchParams.get('from')}|${u.searchParams.get('after_event_cursor')}|${u.searchParams.get('through')}`;
};

test('a held replay keeps terminal input usable', async ({ page }) => {
    test.setTimeout(180_000);
    const pane = await spawnShell();
    await page.setViewportSize({ width: 1440, height: 900 });
    await installTermTracker(page);
    const holder: { release: (() => void) | null } = { release: null };
    const gate = new Promise<void>((resolve) => {
        holder.release = resolve;
    });
    let delayed = false;
    await page.route('**/api/terminals/*/replay?*', async (route) => {
        if (!delayed) {
            delayed = true;
            await gate;
        }
        await route.continue();
    });
    await page.goto(phi.url);
    const screen = page.locator(`#term-${pane} .xterm-screen`);
    await expect(screen).toBeVisible({ timeout: 30_000 });

    // With the first replay still held, the tab and the terminal surface
    // stay usable: no spinner-only block, no input gated on the read.
    await expect(page.locator(`.tab[data-pane-id="${pane}"]`)).toBeVisible();
    await expect(page.locator(`#term-${pane} .tab-loader`)).toHaveCount(0);
    await screen.click();
    await page.keyboard.type('echo DRAFT-KEPT');
    await page.keyboard.press('Enter');

    holder.release?.();

    // Input typed during the stall reached the child exactly once, and the
    // late replay did not clear or replay it twice.
    await expect
        .poll(() => paneBody(page, pane), { timeout: 60_000 })
        .toContain('DRAFT-KEPT');
    expect(
        (await paneBody(page, pane)).split('echo DRAFT-KEPT').length - 1,
    ).toBe(1);
});

test('an expired replay never repeats the same refused pair', async ({
    page,
}) => {
    test.setTimeout(180_000);
    const pane = await spawnShell();
    await page.setViewportSize({ width: 1440, height: 900 });
    await installTermTracker(page);
    const current = watchAttach(page, pane);
    const requests: string[] = [];
    const keys: string[] = [];
    await page.route('**/api/terminals/*/replay?*', async (route) => {
        requests.push(route.request().url());
        keys.push(replayKey(route.request().url()));
        const attach = current.current;
        if (!attach?.eventCursor) {
            await route.continue();
            return;
        }
        // The whole window expired: the floor is the head, certified with
        // the attach's own ordinal. A client that keeps asking for the
        // refused prefix would repeat the same pair.
        const info = {
            epoch: attach.epoch,
            oldest: attach.head,
            head: attach.head,
            floor_cols: attach.floorCols || attach.initialCols,
            floor_rows: attach.floorRows || attach.initialRows,
            head_cols: attach.headCols || attach.initialCols,
            head_rows: attach.headRows || attach.initialRows,
            floor_event_cursor: attach.eventCursor,
            event_cursor: attach.eventCursor,
        };
        await route.fulfill({
            status: 409,
            headers: { 'X-Phi-Replay-Window': JSON.stringify(info) },
            body: 'replay position expired',
        });
    });
    await page.goto(phi.url);
    const screen = page.locator(`#term-${pane} .xterm-screen`);
    await expect(screen).toBeVisible({ timeout: 30_000 });
    await expect
        .poll(() => requests.length, { timeout: 30_000 })
        .toBeGreaterThan(0);
    await page.waitForTimeout(2_000);
    // At most two history bootstrap attempts in one episode, and no two
    // requests repeat an already-refused from/cursor/through pair.
    expect(requests.length).toBeLessThanOrEqual(2);
    expect(new Set(keys).size).toBe(keys.length);

    // The pane still accepts live input after the refused history read.
    await screen.click();
    await page.keyboard.type('echo LIVE-AFTER-EXPIRY');
    await page.keyboard.press('Enter');
    await expect
        .poll(() => paneBody(page, pane), { timeout: 30_000 })
        .toContain('LIVE-AFTER-EXPIRY');
});

test('a refused prefix resumes at the certified floor', async ({ page }) => {
    test.setTimeout(180_000);
    const pane = await spawnShell();
    await page.setViewportSize({ width: 1440, height: 900 });
    await installTermTracker(page);
    const requests: string[] = [];
    const holder: { release: (() => void) | null } = { release: null };
    const gate = new Promise<void>((resolve) => {
        holder.release = resolve;
    });
    let delayed = false;
    await page.route('**/api/terminals/*/replay?*', async (route) => {
        requests.push(route.request().url());
        if (!delayed) {
            delayed = true;
            await gate;
        }
        await route.continue();
    });
    const refused: number[] = [];
    page.on('response', (response) => {
        if (response.url().includes('/replay?') && response.status() === 409)
            refused.push(response.status());
    });
    await page.goto(phi.url);
    const screen = page.locator(`#term-${pane} .xterm-screen`);
    await expect(screen).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => delayed).toBe(true);
    await screen.click();
    await page.keyboard.type(
        'yes "floor padding padding padding" | head -4000; echo "FLOOR-READY-$(printf END)"',
    );
    await page.keyboard.press('Enter');

    // Evict the captured prefix while its read is held. Use the real
    // server's byte/resize pair, not a guessed cursor inside shell output.
    let floorBytes = 0;
    await expect
        .poll(
            async () => {
                try {
                    const tail = await readReplay(phi.url, pane);
                    floorBytes = tail.oldest;
                    return tail.data.toString('utf8');
                } catch (error) {
                    // The producer can move the floor between attach and read.
                    if (
                        error instanceof Error &&
                        error.message === 'replay failed: 409'
                    )
                        return '';
                    throw error;
                }
            },
            { timeout: 30_000 },
        )
        .toContain('FLOOR-READY-END');
    expect(floorBytes).toBeGreaterThan(0);
    holder.release?.();
    await expect.poll(() => refused.length).toBe(1);
    await expect
        .poll(() => paneBody(page, pane), { timeout: 30_000 })
        .toContain('FLOOR-READY-END');
    // One refusal, then a resume from the floor: never the same pair twice.
    await expect
        .poll(
            () =>
                requests.filter((u) => {
                    const from = Number(
                        new URL(u).searchParams.get('from') ?? '0',
                    );
                    return from >= floorBytes;
                }).length,
            { timeout: 30_000 },
        )
        .toBeGreaterThan(0);
    expect(
        requests.filter((u) => new URL(u).searchParams.get('from') === '0')
            .length,
    ).toBeLessThanOrEqual(1);
    expect(new Set(requests.map(replayKey)).size).toBe(requests.length);

    const reloaded = page.locator(`#term-${pane} .xterm-screen`);
    await reloaded.click();
    await page.keyboard.type('echo AFTER-FLOOR-RESUME');
    await page.keyboard.press('Enter');
    await expect
        .poll(() => paneBody(page, pane), { timeout: 60_000 })
        .toContain('AFTER-FLOOR-RESUME');
});

test('a reload replays the retained tail exactly once', async ({ page }) => {
    test.setTimeout(180_000);
    const pane = await spawnShell();
    await page.setViewportSize({ width: 1440, height: 900 });
    await installTermTracker(page);
    let attaches = 0;
    page.on('websocket', (socket) => {
        if (socket.url().includes(`/ws/pane/${pane}?`)) attaches += 1;
    });
    await page.goto(phi.url);
    const screen = page.locator(`#term-${pane} .xterm-screen`);
    await expect(screen).toBeVisible({ timeout: 30_000 });
    await screen.click();
    await page.keyboard.type('echo KEPT-ACROSS-RELOAD');
    await page.keyboard.press('Enter');
    await expect
        .poll(() => paneBody(page, pane), { timeout: 30_000 })
        .toContain('KEPT-ACROSS-RELOAD');

    // A new attach re-reads the retained window. The client must paint the
    // tail once, not append a second copy of the same bytes.
    await page.reload();
    const reloaded = page.locator(`#term-${pane} .xterm-screen`);
    await expect(reloaded).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => attaches, { timeout: 30_000 }).toBeGreaterThan(1);
    await expect
        .poll(() => paneBody(page, pane), { timeout: 60_000 })
        .toContain('KEPT-ACROSS-RELOAD');
    await page.waitForTimeout(1_000);
    const body = await paneBody(page, pane);
    expect(body.split('echo KEPT-ACROSS-RELOAD').length - 1).toBe(1);

    await reloaded.click();
    await page.keyboard.type('echo AFTER-RELOAD');
    await page.keyboard.press('Enter');
    await expect
        .poll(() => paneBody(page, pane), { timeout: 60_000 })
        .toContain('AFTER-RELOAD');
});

for (const mobile of [false, true]) {
    test.describe(
        mobile ? 'touch manual recovery' : 'desktop manual recovery',
        () => {
            test.use({
                viewport: mobile
                    ? { width: 390, height: 844 }
                    : { width: 1440, height: 900 },
                hasTouch: mobile,
                isMobile: mobile,
            });

            test('manual refresh retries history after live-only recovery', async ({
                page,
            }, testInfo) => {
                const pane = await spawnShell();
                const errors: string[] = [];
                page.on('pageerror', (error) => errors.push(error.message));
                await installTermTracker(page);
                await page.goto(phi.url);
                const screen = page.locator(`#term-${pane} .xterm-screen`);
                await expect(screen).toBeVisible({ timeout: 30_000 });
                if (mobile) await screen.tap();
                else await screen.click();
                await page.keyboard.type('echo "RECOVERED-$(printf SCREEN)"');
                await page.keyboard.press('Enter');
                await expect
                    .poll(() => paneBody(page, pane))
                    .toContain('RECOVERED-SCREEN');

                // The server still owns the output, but the local view needs repair.
                await page.evaluate((id) => {
                    const w = window as unknown as TrackedWindow;
                    w.tracked
                        .find(
                            (t) =>
                                t.element?.closest('.term-container')?.id ===
                                `term-${id}`,
                        )
                        ?.reset();
                }, pane);
                let refuse = true;
                let requests = 0;
                await page.route(
                    '**/api/terminals/*/replay?*',
                    async (route) => {
                        requests++;
                        if (refuse)
                            await route.fulfill({
                                status: 503,
                                body: 'temporary replay failure',
                            });
                        else await route.continue();
                    },
                );
                const reload = page.getByRole('button', {
                    name: 'Reload current terminal',
                    exact: true,
                });
                if (mobile) await reload.tap();
                else await reload.click();
                await expect(
                    page.getByText(
                        'History could not be recovered; showing live output only.',
                        { exact: true },
                    ),
                ).toBeVisible({ timeout: 30_000 });
                expect(await paneBody(page, pane)).not.toContain(
                    'RECOVERED-SCREEN',
                );
                expect(requests).toBe(2);

                // No new PTY output is needed to unlock an explicit retry.
                refuse = false;
                if (mobile) await reload.tap();
                else await reload.click();
                await expect
                    .poll(() => paneBody(page, pane), { timeout: 30_000 })
                    .toContain('RECOVERED-SCREEN');
                expect(requests).toBe(3);
                expect(
                    (await paneBody(page, pane)).split('RECOVERED-SCREEN')
                        .length - 1,
                ).toBe(1);
                await expect(
                    page.locator(`#term-${pane} .tab-loader`),
                ).toHaveCount(0);
                expect(
                    await page.evaluate(
                        () =>
                            document.documentElement.scrollWidth <=
                            window.innerWidth,
                    ),
                ).toBe(true);
                await page.screenshot({
                    path: testInfo.outputPath('manual-recovery.png'),
                });
                if (mobile) await screen.tap();
                else await screen.click();
                await page.keyboard.type('echo AFTER-MANUAL-RECOVERY');
                await page.keyboard.press('Enter');
                await expect
                    .poll(() => paneBody(page, pane))
                    .toContain('AFTER-MANUAL-RECOVERY');
                expect(errors).toEqual([]);
            });
        },
    );
}

test.describe('mobile', () => {
    test.use({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
    });

    test('a slow replay leaves a usable touch layout without overflow', async ({
        page,
    }) => {
        test.setTimeout(180_000);
        const pane = await spawnShell();
        await installTermTracker(page);
        const holder: { release: (() => void) | null } = { release: null };
        const gate = new Promise<void>((resolve) => {
            holder.release = resolve;
        });
        let delayed = false;
        await page.route('**/api/terminals/*/replay?*', async (route) => {
            if (!delayed) {
                delayed = true;
                await gate;
            }
            await route.continue();
        });
        await page.goto(phi.url);
        const screen = page.locator(`#term-${pane} .xterm-screen`);
        await expect(screen).toBeVisible({ timeout: 60_000 });
        // A real touch event focuses the terminal before replay lands.
        await screen.tap();
        await expect(
            page.locator(`#term-${pane} .xterm-helper-textarea`),
        ).toBeFocused();
        await page.keyboard.type('echo MOBILE-TOUCH-OK');
        await page.keyboard.press('Enter');
        holder.release?.();
        await expect
            .poll(
                () =>
                    page.evaluate(
                        () =>
                            document.documentElement.scrollWidth <=
                            window.innerWidth,
                    ),
                { timeout: 30_000 },
            )
            .toBe(true);
        await expect
            .poll(() => paneBody(page, pane), { timeout: 60_000 })
            .toContain('MOBILE-TOUCH-OK');
    });
});
