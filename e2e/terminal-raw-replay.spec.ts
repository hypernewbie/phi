import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { TerminalServerFrame } from '../web/proto/terminal.js';
import type {
    MessageFns,
    TerminalServerFrame as TerminalServerMessage,
} from '../web-src/proto/terminal.js';
import { createHeadlessSandbox } from '../test-js/_xtermHeadless.js';
import { startPhi } from './_server.js';

// The served bundle carries no types; bind its runtime codec to the
// generated declarations so spec-side decoding is fully checked.
const ServerCodec: MessageFns<TerminalServerMessage> =
    TerminalServerFrame as unknown as MessageFns<TerminalServerMessage>;

const FIXTURE = join('e2e', 'fixtures', 'raw-replay-backend.py');
const EXIT_FIXTURE = join('e2e', 'fixtures', 'raw-replay-exit-backend.sh');

interface ReplayTerminal {
    element?: HTMLElement;
    cols: number;
    rows: number;
    modes?: Record<string, unknown>;
    resize(cols: number, rows: number): void;
    buffer: {
        active: {
            type: string;
            length: number;
            cursorX: number;
            cursorY: number;
            getLine(i: number):
                | {
                      length: number;
                      translateToString(trim?: boolean): string;
                      getCell(x: number, cell: unknown): void;
                  }
                | undefined;
            getNullCell?(): {
                getFgColor(): number;
                getBgColor(): number;
                isBold?(): unknown;
                isItalic?(): unknown;
                isDim?(): unknown;
                isUnderline?(): unknown;
                isBlink?(): unknown;
                isInverse?(): unknown;
                isInvisible?(): unknown;
            };
        };
    };
    write(data: string | Uint8Array, callback?: () => void): void;
}
interface ReplayConstructor {
    new (options: Record<string, unknown>): ReplayTerminal;
}
interface ReplayWindow {
    replayTerms: ReplayTerminal[];
    replayPending: number;
    Terminal: ReplayConstructor;
}

interface ScreenState {
    cols: number;
    rows: number;
    type: string;
    cursorX: number;
    cursorY: number;
    length: number;
    attrs: boolean;
    h1: string;
    h2: string;
    modes: string;
}

function waitFlag(dir: string, name: string, timeoutMs: number): Promise<void> {
    const path = join(dir, 'home', name);
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const poll = () => {
            if (existsSync(path)) return resolve();
            if (Date.now() >= deadline)
                return reject(new Error(`flag ${name} never appeared`));
            setTimeout(poll, 100);
        };
        poll();
    });
}

// Tracks one viewer: attach frames, replay/state requests, console health,
// and a quiescent full-buffer hash (text plus cell attributes).
function watchViewer(page: Page, pane: string) {
    const attaches: Array<Record<string, unknown>> = [];
    const replayRequests: string[] = [];
    const stateRequests: string[] = [];
    const problems: string[] = [];
    const badTerminal: string[] = [];
    page.on('request', (req) => {
        const url = req.url();
        if (url.includes(`/api/terminals/${pane}/replay?`))
            replayRequests.push(url);
        if (url.includes('/state?')) stateRequests.push(url);
    });
    page.on('response', (res) => {
        const url = res.url();
        if (
            res.status() >= 400 &&
            (url.includes('/ws/') ||
                url.includes('/replay?') ||
                url.includes('/api/terminals'))
        )
            badTerminal.push(`${res.status()} ${url}`);
    });
    page.on('websocket', (socket) => {
        if (!socket.url().includes(`/ws/pane/${pane}?`)) return;
        socket.on('framereceived', ({ payload }) => {
            if (!Buffer.isBuffer(payload)) return;
            const decoded = ServerCodec.decode(new Uint8Array(payload));
            if (decoded.payload?.$case === 'attach')
                attaches.push(
                    decoded.payload.value as unknown as Record<string, unknown>,
                );
        });
    });
    page.on('pageerror', (error) => problems.push(String(error)));
    page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const text = message.text();
        // Fixture backends have no session history; the sessions
        // panel's failed scans are environmental noise, not terminal
        // regressions. Terminal failures surface via badTerminal.
        if (text.includes('Failed to load resource')) return;
        problems.push(text.slice(0, 300));
    });
    return { attaches, replayRequests, stateRequests, problems, badTerminal };
}

async function installTermTracker(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const w = window as unknown as ReplayWindow;
        w.replayTerms = [];
        w.replayPending = 0;
        let Base: ReplayConstructor;
        Object.defineProperty(window, 'Terminal', {
            configurable: true,
            get: () => Base,
            set: (Original: ReplayConstructor) => {
                Base = class extends Original {
                    constructor(options: Record<string, unknown>) {
                        super(options);
                        w.replayTerms.push(this);
                    }
                    write(data: string | Uint8Array, callback?: () => void) {
                        w.replayPending++;
                        super.write(data, () => {
                            w.replayPending--;
                            callback?.();
                        });
                    }
                };
            },
        });
    });
}

const screenText = (page: Page, pane: string): Promise<string> =>
    page.evaluate((id) => {
        const w = window as unknown as ReplayWindow;
        const term = w.replayTerms.find(
            (t) => t.element?.closest('.term-container')?.id === `term-${id}`,
        );
        if (!term || w.replayPending !== 0) return '';
        const buf = term.buffer.active;
        const lines: string[] = [];
        for (let i = 0; i < buf.length; i++)
            lines.push(buf.getLine(i)?.translateToString(true) ?? '');
        return lines.join('\n');
    }, pane);

// FNV-1a over every line's text plus every cell's colors and flags.
// The Node reference below repeats this logic over headless xterm; keep
// the two in sync or the differential fails loudly.
const screenState = (page: Page, pane: string): Promise<ScreenState | null> =>
    page.evaluate((id) => {
        const w = window as unknown as ReplayWindow;
        const term = w.replayTerms.find(
            (t) => t.element?.closest('.term-container')?.id === `term-${id}`,
        );
        if (!term || w.replayPending !== 0) return null;
        const buf = term.buffer.active;
        const probe = buf.getNullCell ? buf.getNullCell() : null;
        let h1 = 0x811c9dc5;
        let h2 = 0x811c9dc5;
        const mix = (n: number) => {
            h1 = Math.imul(h1 ^ (n & 0xffff), 16777619) >>> 0;
            h2 = Math.imul(h2 ^ ((n >>> 16) & 0xffff), 16777619) >>> 0;
        };
        const flag = (cell: NonNullable<typeof probe>, name: string) => {
            const fn = (cell as Record<string, unknown>)[name];
            return typeof fn === 'function'
                ? Number((fn as (this: unknown) => unknown).call(cell) ? 1 : 0)
                : 0;
        };
        for (let i = 0; i < buf.length; i++) {
            const line = buf.getLine(i);
            if (!line) {
                mix(0);
                continue;
            }
            const text = line.translateToString(true);
            for (let j = 0; j < text.length; j++) mix(text.charCodeAt(j));
            mix(0x1f);
            if (probe) {
                for (let x = 0; x < line.length; x++) {
                    line.getCell(x, probe);
                    mix(probe.getFgColor());
                    mix(probe.getBgColor());
                    mix(
                        flag(probe, 'isBold') |
                            (flag(probe, 'isItalic') << 1) |
                            (flag(probe, 'isDim') << 2) |
                            (flag(probe, 'isUnderline') << 3) |
                            (flag(probe, 'isBlink') << 4) |
                            (flag(probe, 'isInverse') << 5) |
                            (flag(probe, 'isInvisible') << 6),
                    );
                }
            }
            mix(0x1e);
        }
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
            attrs: probe !== null,
            h1: h1.toString(16),
            h2: h2.toString(16),
            modes,
        };
    }, pane);

interface ReplayHeader {
    epoch: number;
    start: number;
    end: number;
    resizes: Array<[number, number, number]>;
    event_cursor: string;
    initial_cols: number;
    initial_rows: number;
}

// Pages the complete raw journal in Node, the way a client chains pages:
// from advances to the previous end and the end cursor chains as the
// paging cursor. Returns every byte plus every resize marker in order.
async function readJournal(
    url: string,
    pane: string,
    epoch: number,
): Promise<{
    bytes: Buffer;
    markers: Array<[number, number, number]>;
    init: [number, number];
}> {
    const chunks: Buffer[] = [];
    const markers: Array<[number, number, number]> = [];
    let from = 0;
    let after = '';
    let init: [number, number] = [0, 0];
    for (let page = 0; page < 100; page++) {
        const params = new URLSearchParams({
            from: String(from),
            through: 'latest',
            epoch: String(epoch),
        });
        if (after) params.set('after_event_cursor', after);
        const response = await fetch(
            `${url}/api/terminals/${pane}/replay?${params}`,
            { headers: { 'Accept-Encoding': 'identity' } },
        );
        if (!response.ok)
            throw new Error(`replay page failed: ${response.status}`);
        const body = Buffer.from(await response.arrayBuffer());
        const jsonLen = body.readUInt32BE(0);
        const hdr = JSON.parse(
            body.subarray(4, 4 + jsonLen).toString('utf8'),
        ) as ReplayHeader;
        if (page === 0) init = [hdr.initial_cols, hdr.initial_rows];
        const data = body.subarray(4 + jsonLen);
        if (data.length !== hdr.end - hdr.start)
            throw new Error('replay page body does not match its span');
        chunks.push(data);
        markers.push(...hdr.resizes);
        if (hdr.end === from) break;
        from = hdr.end;
        after = hdr.event_cursor;
    }
    return { bytes: Buffer.concat(chunks), markers, init };
}

// The uninterrupted reference: the same xterm engine in Node, fed the
// complete journal with resize markers applied at their byte positions.
async function referenceState(
    bytes: Buffer,
    markers: Array<[number, number, number]>,
    init: [number, number],
): Promise<ScreenState> {
    const { Terminal } = createHeadlessSandbox();
    const term = new Terminal({
        cols: init[0],
        rows: init[1],
        scrollback: 10000,
    }) as unknown as ReplayTerminal;
    const write = (text: string) =>
        new Promise<void>((resolve) => term.write(text, () => resolve()));
    const ordered = markers
        .map((m, i) => ({ at: m[0], cols: m[1], rows: m[2], i }))
        .sort((a, b) => a.at - b.at || a.i - b.i);
    const decoder = new TextDecoder();
    let cursor = 0;
    for (const marker of ordered) {
        if (marker.at > bytes.length)
            throw new Error('resize marker past the journal end');
        if (marker.at > cursor) {
            await write(
                decoder.decode(bytes.subarray(cursor, marker.at), {
                    stream: true,
                }),
            );
            cursor = marker.at;
        }
        term.resize(marker.cols, marker.rows);
    }
    await write(decoder.decode(bytes.subarray(cursor)));
    const buf = term.buffer.active;
    const probe = buf.getNullCell ? buf.getNullCell() : null;
    let h1 = 0x811c9dc5;
    let h2 = 0x811c9dc5;
    const mix = (n: number) => {
        h1 = Math.imul(h1 ^ (n & 0xffff), 16777619) >>> 0;
        h2 = Math.imul(h2 ^ ((n >>> 16) & 0xffff), 16777619) >>> 0;
    };
    const flag = (cell: NonNullable<typeof probe>, name: string) => {
        const fn = (cell as Record<string, unknown>)[name];
        return typeof fn === 'function'
            ? Number((fn as (this: unknown) => unknown).call(cell) ? 1 : 0)
            : 0;
    };
    for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (!line) {
            mix(0);
            continue;
        }
        const text = line.translateToString(true);
        for (let j = 0; j < text.length; j++) mix(text.charCodeAt(j));
        mix(0x1f);
        if (probe) {
            for (let x = 0; x < line.length; x++) {
                line.getCell(x, probe);
                mix(probe.getFgColor());
                mix(probe.getBgColor());
                mix(
                    flag(probe, 'isBold') |
                        (flag(probe, 'isItalic') << 1) |
                        (flag(probe, 'isDim') << 2) |
                        (flag(probe, 'isUnderline') << 3) |
                        (flag(probe, 'isBlink') << 4) |
                        (flag(probe, 'isInverse') << 5) |
                        (flag(probe, 'isInvisible') << 6),
                );
            }
        }
        mix(0x1e);
    }
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
        attrs: probe !== null,
        h1: h1.toString(16),
        h2: h2.toString(16),
        modes,
    };
}

async function spawnReplayPane(
    request: import('@playwright/test').APIRequestContext,
    url: string,
    dir: string,
): Promise<string> {
    const spawned = await request.post(`${url}/api/terminals`, {
        data: { coder: 'pi', cwd: dir, cols: 100, rows: 30 },
    });
    expect(spawned.ok()).toBe(true);
    return (await spawned.json()).pane_id as string;
}

test('raw replay matches an uninterrupted terminal past 32 MiB', async ({
    page: pageA,
    request,
    browser,
}) => {
    test.setTimeout(480_000);
    const phi = await startPhi({
        config: { pi_bridge_no_inject: true },
        setup(dir) {
            const command = join(dir, 'raw-replay-backend');
            copyFileSync(FIXTURE, command);
            chmodSync(command, 0o755);
            const backends = join(dir, 'home', '.phi', 'backends');
            mkdirSync(backends, { recursive: true });
            writeFileSync(
                join(backends, 'pi.json'),
                JSON.stringify({ id: 'pi', command }),
            );
        },
    });
    try {
        const pane = await spawnReplayPane(request, phi.url, phi.dir);
        await waitFlag(phi.dir, 'prefix-done', 30_000);

        // Viewer A attaches early and rides the live stream.
        await pageA.setViewportSize({ width: 1440, height: 900 });
        await installTermTracker(pageA);
        const seenA = watchViewer(pageA, pane);
        await pageA.goto(phi.url);
        await expect
            .poll(() => screenText(pageA, pane), { timeout: 60_000 })
            .toContain('PREFIX_READY');
        await expect
            .poll(() => seenA.attaches.length, { timeout: 30_000 })
            .toBeGreaterThan(0);
        const epoch = Number(seenA.attaches[0].epoch);

        // The journal starts at byte zero with the spawn geometry.
        const first = await readJournal(phi.url, pane, epoch);
        expect(first.init).toEqual([100, 30]);
        expect(first.bytes.length).toBeGreaterThan(0);

        // Phase 1: a multi-page burst with resizes landing mid-flow.
        writeFileSync(join(phi.dir, 'home', 'go-phase1'), 'go\n');
        await pageA.setViewportSize({ width: 1280, height: 800 });
        await new Promise((r) => setTimeout(r, 500));
        await pageA.setViewportSize({ width: 1440, height: 900 });
        await waitFlag(phi.dir, 'done-phase1', 120_000);

        // Resizes with no output between them share one byte position.
        await pageA.setViewportSize({ width: 1000, height: 700 });
        await new Promise((r) => setTimeout(r, 500));
        await pageA.setViewportSize({ width: 1100, height: 750 });
        await new Promise((r) => setTimeout(r, 500));
        await pageA.setViewportSize({ width: 1440, height: 900 });
        await new Promise((r) => setTimeout(r, 1000));

        // Phase 2: past 32 MiB, ending in prefix-dependent modes.
        writeFileSync(join(phi.dir, 'home', 'go-phase2'), 'go\n');
        await waitFlag(phi.dir, 'done-phase2', 240_000);
        await expect
            .poll(() => screenText(pageA, pane), { timeout: 120_000 })
            .toContain('END_MARK');

        // Viewer B is a fresh browser: everything arrives via replay.
        const ctxB = await browser.newContext({
            viewport: { width: 1440, height: 900 },
        });
        const pageB = await ctxB.newPage();
        try {
            await installTermTracker(pageB);
            const seenB = watchViewer(pageB, pane);
            await pageB.goto(phi.url);
            await expect
                .poll(() => screenText(pageB, pane), { timeout: 240_000 })
                .toContain('END_MARK');
            const statesMatch = async () => {
                const a = await screenState(pageA, pane);
                const b = await screenState(pageB, pane);
                return (
                    a !== null &&
                    b !== null &&
                    JSON.stringify(a) === JSON.stringify(b)
                );
            };
            await expect.poll(statesMatch, { timeout: 120_000 }).toBe(true);
            const stateB = (await screenState(pageB, pane)) as ScreenState;
            expect(stateB.attrs).toBe(true);
            // The burst saturates the default 10,000-row buffer on both.
            expect(stateB.length).toBeGreaterThan(10000);

            // The complete journal matches the fresh browser exactly.
            const journal = await readJournal(phi.url, pane, epoch);
            expect(journal.bytes.length).toBeGreaterThan(32 * 1024 * 1024);
            expect(journal.markers.length).toBeGreaterThanOrEqual(3);
            const positions = journal.markers.map((m) => m[0]);
            expect(new Set(positions).size).toBeLessThan(positions.length);
            const reference = await referenceState(
                journal.bytes,
                journal.markers,
                journal.init,
            );
            expect(reference.attrs).toBe(true);
            await expect
                .poll(
                    async () =>
                        JSON.stringify(await screenState(pageB, pane)) ===
                        JSON.stringify(reference),
                    { timeout: 60_000 },
                )
                .toBe(true);

            // A fresh attach straddling a split VT command completes
            // it from the live stream. The gate opens only after the
            // replay painted END_MARK, so the remainder provably
            // arrives live, not in the replay.
            await waitFlag(phi.dir, 'split1-ready', 60_000);
            await pageB.reload();
            await expect
                .poll(() => screenText(pageB, pane), { timeout: 240_000 })
                .toContain('END_MARK');
            writeFileSync(join(phi.dir, 'home', 'split1-go'), 'go\n');
            await expect
                .poll(() => screenText(pageB, pane), { timeout: 240_000 })
                .toContain('SPLIT_SGR_OK');
            let splitScreen = await screenText(pageB, pane);
            expect(splitScreen).not.toContain('5;0;0m');
            expect(splitScreen).not.toContain('�');
            // Same straddle for a split glyph: the replayed lead
            // bytes unite with the live tail into one emoji.
            await waitFlag(phi.dir, 'split2-ready', 60_000);
            await pageB.reload();
            await expect
                .poll(() => screenText(pageB, pane), { timeout: 240_000 })
                .toContain('SPLIT_SGR_OK');
            writeFileSync(join(phi.dir, 'home', 'split2-go'), 'go\n');
            await expect
                .poll(() => screenText(pageB, pane), { timeout: 240_000 })
                .toContain('🙂SPLIT_EMOJI_OK');
            expect(await screenText(pageB, pane)).not.toContain('�');

            // Real path: replay from byte zero, no state reads, no
            // snapshot checkpoint in any attach frame.
            const replayFromZero = seenB.replayRequests.filter((url) => {
                const from = new URL(url).searchParams.get('from');
                return from === '0';
            });
            expect(replayFromZero.length).toBeGreaterThanOrEqual(1);
            expect(seenA.stateRequests).toHaveLength(0);
            expect(seenB.stateRequests).toHaveLength(0);
            expect(seenB.attaches.length).toBeGreaterThanOrEqual(1);
            for (const attach of [...seenA.attaches, ...seenB.attaches]) {
                expect(attach.checkpoint ?? null).toBeNull();
                expect(typeof attach.initialCols).toBe('number');
                expect(typeof attach.initialRows).toBe('number');
            }
            const version = await request.get(`${phi.url}/api/version`);
            expect((await version.json()).terminal_protocol as string).toBe(
                '2',
            );

            // A same-epoch reconnect preserves the parser and decoder,
            // and settled viewers stop resizing.
            await pageA.reload();
            await expect.poll(statesMatch, { timeout: 120_000 }).toBe(true);
            const sizeBefore = await screenState(pageB, pane);
            await new Promise((r) => setTimeout(r, 2000));
            const sizeAfter = await screenState(pageB, pane);
            expect(sizeAfter?.cols).toBe(sizeBefore?.cols);
            expect(sizeAfter?.rows).toBe(sizeBefore?.rows);
            expect(seenA.problems).toEqual([]);
            expect(seenB.problems).toEqual([]);
            expect(seenA.badTerminal).toEqual([]);
            expect(seenB.badTerminal).toEqual([]);
        } finally {
            await ctxB.close();
        }
    } finally {
        await phi.stop();
    }
});

test('an exit during bootstrap retains its complete final output', async ({
    page,
    request,
}) => {
    const phi = await startPhi({
        config: { pi_bridge_no_inject: true },
        setup(dir) {
            const command = join(dir, 'raw-replay-exit-backend');
            copyFileSync(EXIT_FIXTURE, command);
            chmodSync(command, 0o755);
            const backends = join(dir, 'home', '.phi', 'backends');
            mkdirSync(backends, { recursive: true });
            writeFileSync(
                join(backends, 'pi.json'),
                JSON.stringify({ id: 'pi', command }),
            );
        },
    });
    try {
        const pane = await spawnReplayPane(request, phi.url, phi.dir);
        // Attach mid-stream: the exit lands while the viewer is live.
        await installTermTracker(page);
        const seen = watchViewer(page, pane);
        await page.goto(phi.url);
        await expect
            .poll(() => screenText(page, pane), { timeout: 60_000 })
            .toContain('EXIT_TAIL_MARK');
        expect(await screenText(page, pane)).toContain('EXIT_LINE_0001');
        expect(seen.attaches.length).toBeGreaterThanOrEqual(1);
        expect(seen.stateRequests).toHaveLength(0);
        expect(seen.problems).toEqual([]);
        expect(seen.badTerminal).toEqual([]);
    } finally {
        await phi.stop();
    }
});
