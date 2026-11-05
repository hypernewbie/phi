import {
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    expect,
    test,
    type APIRequestContext,
    type Page,
} from '@playwright/test';
import { TerminalServerFrame } from '../web/proto/terminal.js';
import type {
    MessageFns,
    TerminalServerFrame as TerminalServerMessage,
} from '../web-src/proto/terminal.js';
import { readReplay } from './_terminal-replay.js';
import { startPhi } from './_server.js';
import { startBridgeProxy } from './_pi-bridge-proxy.js';
import {
    COMPACT_MODEL,
    COMPACT_PROVIDER,
    COMPACT_PROXY_NAME,
    COMPACT_SESSION_ID,
    seedCompactFixture,
    startCompactStub,
    type CompactSeed,
} from './_pi-context-compact.js';

// The served bundle carries no types; bind its runtime codec to the
// generated declarations so spec-side decoding is fully checked.
const ServerCodec: MessageFns<TerminalServerMessage> =
    TerminalServerFrame as unknown as MessageFns<TerminalServerMessage>;

// Real pinned Pi TUI plus the loopback provider stub from the compact
// fixture. A fresh viewer must reach the live screen by asking Pi to
// repaint, not by downloading terminal history; every failure path must
// keep the existing bounded history replay.

interface BridgeView {
    state: string;
    connected?: boolean;
    capabilities?: string[];
    running?: boolean;
}

async function paneBridge(
    request: APIRequestContext,
    url: string,
    paneID: string,
): Promise<BridgeView | undefined> {
    const response = await request.get(`${url}/api/terminals`);
    if (!response.ok()) return undefined;
    const tabs = (await response.json()) as Array<{
        id: string;
        pi_bridge?: BridgeView;
    }>;
    return tabs.find((tab) => tab.id === paneID)?.pi_bridge;
}

interface TrackedTerminal {
    write(data: string | Uint8Array, callback?: () => void): void;
    element?: HTMLElement;
    cols: number;
    rows: number;
    modes?: Record<string, unknown>;
    buffer: {
        active: {
            type: string;
            length: number;
            cursorX: number;
            cursorY: number;
            getLine(i: number): { translateToString(trim?: boolean): string };
        };
    };
}
interface TrackedWindow {
    tracked: TrackedTerminal[];
    trackedPending: number;
}
interface TerminalCtor {
    new (options: Record<string, unknown>): TrackedTerminal;
}

// Same renderer tracking as terminal-raw-replay.spec.ts: the real xterm
// instance behind each pane, so assertions read the painted screen.
async function installTermTracker(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const w = window as unknown as TrackedWindow;
        w.tracked = [];
        w.trackedPending = 0;
        let Base: TerminalCtor;
        Object.defineProperty(window, 'Terminal', {
            configurable: true,
            get: () => Base,
            set: (Original: TerminalCtor) => {
                Base = class extends Original {
                    constructor(options: Record<string, unknown>) {
                        super(options);
                        w.tracked.push(this);
                    }
                    write(data: string | Uint8Array, callback?: () => void) {
                        w.trackedPending++;
                        super.write(data, () => {
                            w.trackedPending--;
                            callback?.();
                        });
                    }
                };
            },
        });
    });
}

interface ScreenState {
    cols: number;
    rows: number;
    type: string;
    cursorX: number;
    cursorY: number;
    length: number;
    modes: string;
    text: string;
}

// The rendered screen once every admitted write has parsed.
const screenState = (page: Page, pane: string): Promise<ScreenState | null> =>
    page.evaluate((id) => {
        const w = window as unknown as TrackedWindow;
        const term = w.tracked.find(
            (t) => t.element?.closest('.term-container')?.id === `term-${id}`,
        );
        if (!term || w.trackedPending !== 0) return null;
        const buf = term.buffer.active;
        const lines: string[] = [];
        for (let i = 0; i < buf.length; i++)
            lines.push(buf.getLine(i).translateToString(true));
        let modes = 'n/a';
        try {
            modes = term.modes ? JSON.stringify(term.modes) : 'none';
        } catch {
            modes = 'unreadable';
        }
        return {
            cols: term.cols,
            rows: term.rows,
            type: buf.type,
            cursorX: buf.cursorX,
            cursorY: buf.cursorY,
            length: buf.length,
            modes,
            text: lines.join('\n'),
        };
    }, pane);

// The full painted state, once it stops changing. A viewer settles twice:
// after its first paint and after the post-attach fit adopts the panel
// grid. Comparing stable states avoids a reference captured mid-fit.
async function settledScreen(
    page: Page,
    pane: string,
    quietMs = 600,
    timeoutMs = 60_000,
): Promise<ScreenState> {
    const deadline = Date.now() + timeoutMs;
    let last: ScreenState | null = null;
    let stableSince = 0;
    while (Date.now() < deadline) {
        const state = await screenState(page, pane);
        const same =
            state !== null &&
            last !== null &&
            state.text === last.text &&
            state.modes === last.modes &&
            state.type === last.type &&
            state.cols === last.cols &&
            state.rows === last.rows &&
            state.length === last.length &&
            state.cursorX === last.cursorX &&
            state.cursorY === last.cursorY;
        if (!same) stableSince = Date.now();
        else if (Date.now() - stableSince >= quietMs) return state;
        last = state;
        await page.waitForTimeout(150);
    }
    throw new Error(`terminal ${pane} never settled`);
}

// The live viewport. Two viewers may legitimately hold different
// scrollback depths: the repaint redraws the screen, not the archive.
function visibleRows(state: ScreenState): string {
    return state.text.split('\n').slice(-state.rows).join('\n');
}

function watchViewer(page: Page, pane: string) {
    const attaches: Array<Record<string, unknown>> = [];
    const receipts: Array<{ requestId: string; outcome: number }> = [];
    const replayRequests: string[] = [];
    const problems: string[] = [];
    page.on('request', (req) => {
        const url = req.url();
        if (url.includes(`/api/terminals/${pane}/replay?`))
            replayRequests.push(url);
    });
    page.on('pageerror', (error) => problems.push(String(error)));
    page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const text = message.text();
        if (text.includes('Failed to load resource')) return;
        problems.push(text.slice(0, 300));
    });
    page.on('websocket', (socket) => {
        if (!socket.url().includes(`/ws/pane/${pane}?`)) return;
        socket.on('framereceived', ({ payload }) => {
            if (!Buffer.isBuffer(payload)) return;
            const frame = ServerCodec.decode(new Uint8Array(payload));
            if (frame.payload?.$case === 'attach')
                attaches.push(
                    frame.payload.value as unknown as Record<string, unknown>,
                );
            if (frame.payload?.$case === 'refreshResult')
                receipts.push({
                    requestId: frame.payload.value.requestId ?? '',
                    outcome: frame.payload.value.outcome ?? 0,
                });
        });
    });
    return { attaches, receipts, replayRequests, problems };
}

const DISPATCHED = 1;

async function openViewer(page: Page, url: string, pane: string) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installTermTracker(page);
    const viewer = watchViewer(page, pane);
    await page.goto(url);
    await page.locator(`.tab[data-pane-id="${pane}"]`).click();
    await expect(page.locator(`#term-${pane} .xterm-screen`)).toBeVisible({
        timeout: 30_000,
    });
    return viewer;
}

async function spawnPane(
    request: APIRequestContext,
    url: string,
    cwd: string,
    title: string,
    sessionID: string,
): Promise<string> {
    const response = await request.post(`${url}/api/terminals`, {
        data: { coder: 'pi', cwd, title, session_id: sessionID },
    });
    expect(response.ok()).toBe(true);
    return ((await response.json()) as { pane_id: string }).pane_id;
}

async function waitForPanes(
    request: APIRequestContext,
    url: string,
    pane: string,
    view: Record<string, unknown>,
) {
    await expect
        .poll(() => paneBridge(request, url, pane), { timeout: 30_000 })
        .toMatchObject(view);
}

// One owned fixture per test: stub provider, seeded Pi session, server.
async function startFixture(
    options: { viaProxy?: boolean; tuiMode?: 'regular' | 'fullscreen' } = {},
) {
    const stubTmp = mkdtempSync(join(tmpdir(), 'ptr-'));
    const closers: Array<() => Promise<unknown>> = [];
    const stub = await startCompactStub(join(stubTmp, 'provider-count.json'));
    closers.push(() => stub.close());
    let seed: CompactSeed | undefined;
    const phi = await startPhi({
        config: { auto_reconnect: 'off' },
        env: { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
        setup(dir) {
            seed = seedCompactFixture(dir, stub.port, options);
            if (options.tuiMode) {
                const settingsPath = join(
                    dir,
                    'home',
                    '.pi',
                    'agent',
                    'settings.json',
                );
                const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
                writeFileSync(
                    settingsPath,
                    JSON.stringify({ ...settings, tuiMode: options.tuiMode }),
                );
            }
        },
    });
    closers.push(() => phi.stop());
    if (!seed) throw new Error('fixture seed missing');
    return {
        stub,
        phi,
        seed,
        closers,
        cleanup: async () => {
            let failure: unknown = null;
            for (const close of closers.reverse()) {
                try {
                    await close();
                } catch (err) {
                    failure ??= err;
                }
            }
            rmSync(stubTmp, { recursive: true, force: true });
            expect(failure, 'fixture cleanup failed').toBeNull();
        },
    };
}

for (const tuiMode of ['fullscreen', 'regular'] as const) {
    test(`fresh viewer repaints the live Pi ${tuiMode} screen without history`, async ({
        page,
        browser,
        request,
    }) => {
        test.setTimeout(240_000);
        const fixture = await startFixture({ tuiMode });
        try {
            const { phi, seed } = fixture;
            const pane = await spawnPane(
                request,
                phi.url,
                seed.cwd,
                'Pi repaint',
                COMPACT_SESSION_ID,
            );
            await waitForPanes(request, phi.url, pane, {
                state: 'managed',
                connected: true,
                capabilities: expect.arrayContaining([
                    'pi.terminal-refresh.v1',
                    'pi.history.v1',
                ]),
            });

            // First viewer paints from history: this is the reference screen.
            const viewerA = await openViewer(page, phi.url, pane);
            await settledScreen(page, pane);
            // Unsent Phi and Pi drafts must both survive a repaint.
            await page.locator('#input-textarea').fill('PHI DRAFT KEPT');
            await page.locator('#direct-mode-toggle').click();
            await expect(page.locator('#input-textarea')).toBeHidden({
                timeout: 10_000,
            });
            await page.keyboard.type('PI DRAFT KEPT');
            const reference = await settledScreen(page, pane);
            expect(reference.text).toContain('PI DRAFT KEPT');
            // The two documented modes really are different surfaces: fullscreen
            // repaints the alternate screen, regular repaints the normal one.
            expect(reference.type).toBe(
                tuiMode === 'fullscreen' ? 'alternate' : 'normal',
            );
            expect(reference.length).toBeGreaterThan(10);
            const baselineReplays = viewerA.replayRequests.length;

            // A second viewer is a genuinely fresh client.
            const context = await browser.newContext();
            try {
                const pageB = await context.newPage();
                const viewerB = await openViewer(pageB, phi.url, pane);
                // Same composer state as the reference viewer, so both fit the
                // terminal to the same grid before they are compared.
                await pageB.locator('#direct-mode-toggle').click();
                const painted = await settledScreen(pageB, pane);
                expect(visibleRows(painted)).toBe(visibleRows(reference));
                expect(painted.modes).toBe(reference.modes);
                expect(painted.type).toBe(reference.type);
                expect([painted.cols, painted.rows]).toEqual([
                    reference.cols,
                    reference.rows,
                ]);
                expect([painted.cursorX, painted.cursorY]).toEqual([
                    reference.cursorX,
                    reference.cursorY,
                ]);
                // The server advertised the repaint and it was dispatched...
                expect(viewerB.attaches.at(-1)?.terminalRefreshAvailable).toBe(
                    true,
                );
                await expect
                    .poll(
                        () =>
                            viewerB.receipts.filter(
                                (r) => r.outcome === DISPATCHED,
                            ),
                        { timeout: 15_000 },
                    )
                    .toHaveLength(1);
                // ...so this pane's history was never downloaded.
                expect(viewerB.replayRequests).toEqual([]);

                // Both viewers stay live and usable; typing reaches the PTY once.
                await pageB.keyboard.type('echo LIVE-AFTER-REPAINT');
                await pageB.keyboard.press('Enter');
                await expect
                    .poll(
                        async () =>
                            (await screenState(pageB, pane))?.text ?? '',
                        {
                            timeout: 30_000,
                        },
                    )
                    .toContain('LIVE-AFTER-REPAINT');
                await expect
                    .poll(
                        async () => (await screenState(page, pane))?.text ?? '',
                        {
                            timeout: 30_000,
                        },
                    )
                    .toContain('LIVE-AFTER-REPAINT');
                await page.locator('#direct-mode-toggle').click();
                await expect(page.locator('#input-textarea')).toHaveValue(
                    'PHI DRAFT KEPT',
                );
                expect(viewerA.replayRequests.length).toBe(baselineReplays);
                expect(viewerB.replayRequests).toEqual([]);
                expect(viewerA.problems).toEqual([]);
                expect(viewerB.problems).toEqual([]);
            } finally {
                await context.close();
            }
        } finally {
            await fixture.cleanup();
        }
    });
}

test('Refresh Console repaints in place and keeps the draft', async ({
    page,
    request,
}) => {
    test.setTimeout(240_000);
    const fixture = await startFixture();
    try {
        const { phi, seed } = fixture;
        const pane = await spawnPane(
            request,
            phi.url,
            seed.cwd,
            'Pi repaint manual',
            COMPACT_SESSION_ID,
        );
        await waitForPanes(request, phi.url, pane, {
            connected: true,
            capabilities: expect.arrayContaining(['pi.terminal-refresh.v1']),
        });
        const viewer = await openViewer(page, phi.url, pane);
        const reference = await settledScreen(page, pane);
        expect(reference.text).toContain('COMPACT FIXTURE REPLY 5');
        const replays = viewer.replayRequests.length;
        await page.locator('#input-textarea').fill('DRAFT ACROSS REPAINT');

        await page.locator('#refresh-console-btn').click();
        await expect
            .poll(
                () => viewer.receipts.filter((r) => r.outcome === DISPATCHED),
                { timeout: 30_000 },
            )
            .toHaveLength(1);
        // The repaint restores the screen, the cursor, and every mode the
        // TUI set at startup (alt screen, mouse, paste, focus reporting).
        const repainted = await settledScreen(page, pane);
        expect(repainted).toEqual(reference);
        expect(viewer.replayRequests.length).toBe(replays);
        await expect(page.locator('#input-textarea')).toHaveValue(
            'DRAFT ACROSS REPAINT',
        );
        expect(viewer.problems).toEqual([]);
    } finally {
        await fixture.cleanup();
    }
});

test('absent bridge keeps the bounded history fallback', async ({
    page,
    request,
}) => {
    test.setTimeout(240_000);
    const fixture = await startFixture();
    try {
        const { phi, seed } = fixture;
        const enabled = await request.post(
            `${phi.url}/api/config/pi-bridge-no-inject`,
            { data: { enabled: true } },
        );
        expect(enabled.ok()).toBe(true);
        const pane = await spawnPane(
            request,
            phi.url,
            seed.cwd,
            'Pi repaint absent',
            COMPACT_SESSION_ID,
        );
        // Without the bridge the pane is plain: no capability, no receipt,
        // and the history path must paint the same session.
        await waitForPanes(request, phi.url, pane, { connected: false });
        // Wait until the journal holds the seeded transcript, so the attach
        // has history to replay instead of an empty head.
        await expect
            .poll(
                async () =>
                    (await readReplay(phi.url, pane)).data.toString('utf8'),
                { timeout: 60_000 },
            )
            .toContain('COMPACT FIXTURE REPLY 5');
        const viewer = await openViewer(page, phi.url, pane);
        const painted = await settledScreen(page, pane);
        expect(painted.text).toContain('COMPACT FIXTURE REPLY 5');
        expect(viewer.attaches.at(-1)?.terminalRefreshAvailable).toBeFalsy();
        expect(viewer.receipts).toEqual([]);
        expect(viewer.replayRequests.length).toBeGreaterThan(0);

        // Keyboard input still reaches the live PTY.
        await page.locator('#direct-mode-toggle').click();
        await page.keyboard.type('echo FALLBACK-INPUT-OK');
        await page.keyboard.press('Enter');
        await expect
            .poll(async () => (await screenState(page, pane))?.text ?? '', {
                timeout: 30_000,
            })
            .toContain('FALLBACK-INPUT-OK');
        expect(viewer.problems).toEqual([]);
    } finally {
        await fixture.cleanup();
    }
});

test('a repaint mid-turn neither resubmits nor duplicates the turn', async ({
    page,
    request,
}) => {
    test.setTimeout(240_000);
    const fixture = await startFixture();
    try {
        const { phi, seed, stub } = fixture;
        const pane = await spawnPane(
            request,
            phi.url,
            seed.cwd,
            'Pi repaint streaming',
            COMPACT_SESSION_ID,
        );
        await waitForPanes(request, phi.url, pane, {
            connected: true,
            capabilities: expect.arrayContaining(['pi.terminal-refresh.v1']),
        });
        const viewer = await openViewer(page, phi.url, pane);
        await settledScreen(page, pane);
        const replays = viewer.replayRequests.length;

        // Hold the completion so the run stays active across the repaint.
        stub.holdNext();
        const input = await request.post(
            `${phi.url}/api/terminals/${pane}/input`,
            { data: { text: 'REFRESH MID TURN' } },
        );
        expect(input.status()).toBe(204);
        await waitForPanes(request, phi.url, pane, { running: true });
        await expect.poll(() => stub.heldCount(), { timeout: 20_000 }).toBe(1);
        expect(stub.count()).toBe(1);

        const receiptsBefore = viewer.receipts.length;
        const attachesBefore = viewer.attaches.length;
        await page.locator('#refresh-console-btn').click();
        await expect
            .poll(
                () => viewer.receipts.filter((r) => r.outcome === DISPATCHED),
                { timeout: 30_000 },
            )
            .toHaveLength(receiptsBefore + 1);
        // The repaint is screen-only: one request, still running, one echo.
        expect(stub.count()).toBe(1);
        await waitForPanes(request, phi.url, pane, { running: true });
        // The spinner keeps painting, so read the screen instead of waiting
        // for quiescence while the turn streams.
        await expect
            .poll(async () => (await screenState(page, pane))?.text ?? '', {
                timeout: 30_000,
            })
            .toContain('REFRESH MID TURN');
        const midTurn = await screenState(page, pane);
        if (!midTurn) throw new Error('streaming screen unreadable');
        expect(midTurn.text.split('REFRESH MID TURN').length - 1).toBe(1);
        expect(viewer.attaches).toHaveLength(2);
        expect(viewer.replayRequests.length).toBe(replays);

        stub.release();
        await expect
            .poll(async () => (await screenState(page, pane))?.text ?? '', {
                timeout: 60_000,
            })
            .toContain('Checkpoint complete.');
        expect(stub.count()).toBe(1);
        const settled = await settledScreen(page, pane);
        expect(settled.text.split('REFRESH MID TURN').length - 1).toBe(1);
        expect(viewer.attaches).toHaveLength(2);
        expect(viewer.problems).toEqual([]);
    } finally {
        await fixture.cleanup();
    }
});

test('a withheld receipt falls back once and never retries', async ({
    page,
    request,
}) => {
    test.setTimeout(240_000);
    const fixture = await startFixture({ viaProxy: true });
    try {
        const { phi, seed } = fixture;
        // Discover Phi's real private socket inside the owned tmp.
        const runTmp = join(phi.dir, 't');
        const upstreams = readdirSync(runTmp, { withFileTypes: true })
            .filter(
                (entry) =>
                    entry.isDirectory() && entry.name.startsWith('phi-pi-'),
            )
            .map((entry) => join(runTmp, entry.name, 'bridge.sock'));
        expect(upstreams).toHaveLength(1);
        const proxy = await startBridgeProxy(
            phi.dir,
            upstreams[0] as string,
            join(runTmp, COMPACT_PROXY_NAME),
        );
        fixture.closers.push(() => proxy.close());

        const pane = await spawnPane(
            request,
            phi.url,
            seed.cwd,
            'Pi repaint held ack',
            COMPACT_SESSION_ID,
        );
        await waitForPanes(request, phi.url, pane, {
            connected: true,
            capabilities: expect.arrayContaining(['pi.terminal-refresh.v1']),
        });
        const viewer = await openViewer(page, phi.url, pane);
        const reference = await settledScreen(page, pane);
        const replays = viewer.replayRequests.length;

        // Phi-to-Pi frames still flow; the acknowledgement does not.
        const resume = proxy.pausePiToPhi();
        const receiptsBefore = viewer.receipts.length;
        const fallbackPage = page.waitForResponse((res) =>
            res.url().includes(`/api/terminals/${pane}/replay?`),
        );
        await page.locator('#refresh-console-btn').click();
        // The repaint itself repaints: the screen returns before the ack.
        await expect
            .poll(
                async () => {
                    const state = await screenState(page, pane);
                    return state ? visibleRows(state) : '';
                },
                { timeout: 30_000 },
            )
            .toBe(visibleRows(reference));
        // Output that arrives before the missing receipt does not end the
        // episode: the repaint is unacknowledged, so no receipt exists yet.
        expect(viewer.receipts.slice(receiptsBefore)).toEqual([]);
        // The bounded budget expires and asks for exactly one fallback
        // attach. Repaint bytes arriving first never renew the budget.
        await expect
            .poll(() => viewer.attaches.length, { timeout: 60_000 })
            .toBe(3);
        // The fallback must replay a certified prefix, not combine byte
        // zero with the later ordinal left by the unconfirmed repaint.
        expect((await fallbackPage).status()).toBe(200);
        await expect
            .poll(async () => (await screenState(page, pane))?.text ?? '', {
                timeout: 30_000,
            })
            .toContain('COMPACT FIXTURE REPLY 5');
        expect(visibleRows(await settledScreen(page, pane))).toBe(
            visibleRows(reference),
        );
        await page.waitForTimeout(2000);
        expect(viewer.attaches).toHaveLength(3);
        expect(viewer.replayRequests).toHaveLength(replays + 1);
        resume();
        // The late receipt is stale: it cannot repaint, retry, or attach.
        await page.waitForTimeout(1500);
        expect(viewer.attaches).toHaveLength(3);
        expect(viewer.replayRequests).toHaveLength(replays + 1);
        expect(viewer.problems).toEqual([]);
    } finally {
        await fixture.cleanup();
    }
});

test('a dropped bridge keeps input and the fallback, then repaints again', async ({
    page,
    request,
}) => {
    test.setTimeout(240_000);
    const fixture = await startFixture({ viaProxy: true });
    try {
        const { phi, seed } = fixture;
        const runTmp = join(phi.dir, 't');
        const upstreams = readdirSync(runTmp, { withFileTypes: true })
            .filter(
                (entry) =>
                    entry.isDirectory() && entry.name.startsWith('phi-pi-'),
            )
            .map((entry) => join(runTmp, entry.name, 'bridge.sock'));
        expect(upstreams).toHaveLength(1);
        const proxy = await startBridgeProxy(
            phi.dir,
            upstreams[0] as string,
            join(runTmp, COMPACT_PROXY_NAME),
        );
        fixture.closers.push(() => proxy.close());

        const pane = await spawnPane(
            request,
            phi.url,
            seed.cwd,
            'Pi repaint bridge loss',
            COMPACT_SESSION_ID,
        );
        await waitForPanes(request, phi.url, pane, {
            connected: true,
            capabilities: expect.arrayContaining(['pi.terminal-refresh.v1']),
        });
        const viewer = await openViewer(page, phi.url, pane);
        const reference = await settledScreen(page, pane);
        const replays = viewer.replayRequests.length;
        const receiptsBefore = viewer.receipts.length;

        // Only the bridge stream drops: Pi, the PTY, and the browser stay.
        await proxy.drop();
        await waitForPanes(request, phi.url, pane, { connected: false });
        await page.locator('#refresh-console-btn').click();
        // Without the capability the attach carries no hint and the client
        // replays history instead of waiting for a repaint that cannot come.
        await expect
            .poll(() => viewer.attaches.length, { timeout: 30_000 })
            .toBe(2);
        expect(viewer.attaches.at(-1)?.terminalRefreshAvailable).toBeFalsy();
        const afterDrop = await settledScreen(page, pane);
        expect(visibleRows(afterDrop)).toBe(visibleRows(reference));

        // Keyboard input still reaches the same live process.
        await page.locator('#direct-mode-toggle').click();
        await page.keyboard.type('echo INPUT-DURING-BRIDGE-LOSS');
        await page.keyboard.press('Enter');
        await expect
            .poll(async () => (await screenState(page, pane))?.text ?? '', {
                timeout: 30_000,
            })
            .toContain('INPUT-DURING-BRIDGE-LOSS');
        // No repaint was requested or acknowledged while the capability was
        // gone: the fallback attach never asked Pi for one.
        expect(viewer.receipts.length).toBe(receiptsBefore);

        // The bridge returns: the capability is re-advertised per attach.
        await proxy.resume();
        await waitForPanes(request, phi.url, pane, {
            connected: true,
            capabilities: expect.arrayContaining(['pi.terminal-refresh.v1']),
        });
        await page.locator('#direct-mode-toggle').click();
        await page.locator('#refresh-console-btn').click();
        await expect
            .poll(
                () => viewer.receipts.filter((r) => r.outcome === DISPATCHED),
                { timeout: 30_000 },
            )
            .toHaveLength(receiptsBefore + 1);
        expect(viewer.attaches).toHaveLength(3);
        expect(viewer.attaches.at(-1)?.terminalRefreshAvailable).toBe(true);
        expect(viewer.problems).toEqual([]);
    } finally {
        await fixture.cleanup();
    }
});
