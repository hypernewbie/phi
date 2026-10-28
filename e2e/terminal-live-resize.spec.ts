import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { TerminalClientFrame } from '../web/proto/terminal.js';
import { TerminalServerFrame } from '../web/proto/terminal.js';
import type {
    MessageFns,
    TerminalClientFrame as TerminalClientMessage,
    TerminalServerFrame as TerminalServerMessage,
} from '../web-src/proto/terminal.js';
import { startPhi, type PhiServer } from './_server.js';

const ServerCodec: MessageFns<TerminalServerMessage> =
    TerminalServerFrame as unknown as MessageFns<TerminalServerMessage>;
const ClientCodec: MessageFns<TerminalClientMessage> =
    TerminalClientFrame as unknown as MessageFns<TerminalClientMessage>;

let phi: PhiServer;
const payloadPath = () => join(phi.dir, 'home', 'resize-payload.bin');
const startPath = () => join(phi.dir, 'home', 'resize-start');
const sizePath = () => join(phi.dir, 'home', 'resize-size');

const fixture = `#!/usr/bin/env python3
import fcntl
import os
import signal
import struct
import sys
import termios
import time

home = os.environ['HOME']
payload_path = os.path.join(home, 'resize-payload.bin')
start_path = os.path.join(home, 'resize-start')
size_path = os.path.join(home, 'resize-size')
def on_resize(_signum, _frame):
    try:
        rows, cols, _, _ = struct.unpack('HHHH', fcntl.ioctl(1, termios.TIOCGWINSZ, b'\\0' * 8))
        with open(size_path, 'w') as out:
            out.write(f'{cols} {rows}')
    except OSError:
        pass

signal.signal(signal.SIGWINCH, on_resize)
attrs = termios.tcgetattr(1)
attrs[1] &= ~termios.OPOST
termios.tcsetattr(1, termios.TCSANOW, attrs)
while not os.path.exists(start_path):
    time.sleep(0.01)
with open(payload_path, 'rb') as source:
    payload = source.read()
offset = 0
while offset < len(payload):
    offset += os.write(1, payload[offset:])
while True:
    line = sys.stdin.buffer.readline()
    if line.strip() == b'PING':
        os.write(1, b'INPUT_OK\\r\\n')
        break
`;

interface WriteBufferProbe {
    _bufferOffset: number;
    _writeBuffer: (string | Uint8Array)[];
    _pendingData: number;
    _action(data: string | Uint8Array, promiseResult?: boolean): unknown;
    _scheduleInnerWrite(lastTime?: number, promiseResult?: boolean): void;
}
interface LiveTerm {
    _core: { _writeBuffer: WriteBufferProbe };
    element?: HTMLElement;
    cols: number;
    rows: number;
    write(data: string | Uint8Array, callback?: () => void): void;
    resize(cols: number, rows: number): void;
    open(parent: HTMLElement): void;
    onWriteParsed(callback: () => void): { dispose(): void };
    buffer: {
        active: {
            length: number;
            getLine(
                row: number,
            ): { translateToString(trimRight?: boolean): string } | undefined;
        };
    };
}
interface ResizeHarness {
    armed: boolean;
    capture: boolean;
    forceSliceClock: boolean;
    initialTimerHeld: boolean;
    initialReleased: boolean;
    fitRequested: boolean;
    didHoldContinuation: boolean;
    fitDeferredBeforeRelease?: boolean;
    geometryAtFitRequest?: number;
    releaseInitial?: () => void;
    releaseContinuation?: () => void;
    sliceState?: {
        offset: number;
        queued: number;
        writeCalls: number;
        writtenChars: number;
        pendingCallbacks: number;
    };
    heldState?: { offset: number; queued: number; pendingCallbacks: number };
    terms: LiveTerm[];
    term?: LiveTerm;
    parsed: string[];
    order: {
        kind: string;
        cols?: number;
        rows?: number;
        frameIndex?: number;
    }[];
    clientFrames: number[][];
    writeCalls: number;
    writtenChars: number;
    pendingCallbacks: number;
    initialGrid?: { cols: number; rows: number };
    geometry: { cols: number; rows: number }[];
}
interface ResizeWindow extends Window {
    resizeHarness: ResizeHarness;
    Terminal: new (options: Record<string, unknown>) => LiveTerm;
}

function writeFixturePayload(payload: string): void {
    writeFileSync(payloadPath(), Buffer.from(payload, 'ascii'));
    rmSync(startPath(), { force: true });
    rmSync(sizePath(), { force: true });
}

async function terminalState(
    page: import('@playwright/test').Page,
    pane: string,
) {
    const state = await page.evaluate((id) => {
        const w = window as unknown as ResizeWindow;
        const h = w.resizeHarness;
        const term = h.term;
        if (!term) return null;
        const text = Array.from(
            { length: term.buffer.active.length },
            (_, row) =>
                term.buffer.active.getLine(row)?.translateToString(true) ?? '',
        ).join('\n');
        return {
            text,
            parsed: h.parsed.join(''),
            fitRequested: h.fitRequested,
            sliceState: h.sliceState,
            heldState: h.heldState,
            initialTimerHeld: h.initialTimerHeld,
            initialReleased: h.initialReleased,
            releaseContinuation: Boolean(h.releaseContinuation),
            fitDeferredBeforeRelease: h.fitDeferredBeforeRelease,
            geometryAtFitRequest: h.geometryAtFitRequest,
            geometry: h.geometry,
            clientFrames: h.clientFrames,
            order: h.order,
            writeCalls: h.writeCalls,
            writtenChars: h.writtenChars,
            pendingCallbacks: h.pendingCallbacks,
            initialGrid: h.initialGrid,
            termId: term.element?.closest('.term-container')?.id,
        };
    }, pane);
    if (!state) return null;

    const resizeFrames: { cols: number; rows: number }[] = [];
    const order = state.order.map((entry) => {
        if (entry.kind !== 'client-frame' || entry.frameIndex === undefined)
            return entry;
        const payload = ClientCodec.decode(
            Uint8Array.from(state.clientFrames[entry.frameIndex]),
        ).payload;
        if (payload?.$case !== 'resize') return entry;
        const frame = {
            cols: payload.value.cols ?? 0,
            rows: payload.value.rows ?? 0,
        };
        resizeFrames.push(frame);
        return { kind: 'resize-frame', ...frame };
    });
    return { ...state, resizeFrames, order };
}

test.beforeAll(async () => {
    phi = await startPhi({
        setup(dir) {
            const command = join(dir, 'resize-fixture');
            writeFileSync(command, fixture, { mode: 0o755 });
            const backends = join(dir, 'home', '.phi', 'backends');
            mkdirSync(backends, { recursive: true });
            writeFileSync(
                join(backends, 'pi.json'),
                JSON.stringify({ id: 'pi', command }),
            );
        },
    });
});
test.afterAll(async () => {
    if (existsSync(phi.logPath)) {
        console.info('[resize fixture log]', readFileSync(phi.logPath, 'utf8'));
    }
    await phi.stop();
});

const surfaces = [
    {
        name: 'desktop',
        viewport: { width: 1440, height: 900 },
        isMobile: false,
        hasTouch: false,
    },
    {
        name: 'mobile',
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
    },
] as const;

for (const surface of surfaces) {
    test.describe(`live resize on ${surface.name}`, () => {
        test.use({
            viewport: surface.viewport,
            isMobile: surface.isMobile,
            hasTouch: surface.hasTouch,
        });

        for (const synchronized of [false, true]) {
            test(`preserves output exactly once (synchronized=${synchronized})`, async ({
                page,
                request,
            }) => {
                const pane = `live-resize-${surface.name}-${synchronized ? 'sync' : 'plain'}`;
                const rows = Array.from(
                    { length: 1900 },
                    (_, index) =>
                        `ROW-${String(index).padStart(4, '0')}-${'x'.repeat(68)}`,
                ).join('\r\n');
                const start = synchronized ? '\x1b[?2026h' : '';
                const end = synchronized ? '\x1b[?2026l' : '';
                const payload = `${start}BURST_START\r\n${rows}\r\nBURST_END\r\n${end}`;
                expect(Buffer.byteLength(payload)).toBeGreaterThan(
                    2 * 64 * 1024,
                );
                await writeFixturePayload(payload);

                const spawned = await request.post(`${phi.url}/api/terminals`, {
                    data: { coder: 'pi', cwd: phi.dir },
                });
                expect(spawned.ok()).toBe(true);
                const { pane_id: paneId } = (await spawned.json()) as {
                    pane_id: string;
                };
                let receivedBytes = 0;
                page.on('websocket', (socket) => {
                    if (!socket.url().includes(`/ws/pane/${paneId}?`)) return;
                    socket.on('framereceived', ({ payload: frame }) => {
                        if (!Buffer.isBuffer(frame)) return;
                        const payload = ServerCodec.decode(
                            new Uint8Array(frame),
                        ).payload;
                        if (payload?.$case === 'output')
                            receivedBytes += payload.value.data.length;
                    });
                });

                await page.addInitScript((id) => {
                    const w = window as unknown as ResizeWindow;
                    const h: ResizeHarness = {
                        armed: false,
                        capture: false,
                        forceSliceClock: false,
                        initialTimerHeld: false,
                        initialReleased: false,
                        fitRequested: false,
                        didHoldContinuation: false,
                        terms: [],
                        parsed: [],
                        order: [],
                        clientFrames: [],
                        writeCalls: 0,
                        writtenChars: 0,
                        pendingCallbacks: 0,
                        geometry: [],
                    };
                    w.resizeHarness = h;
                    const realNow = performance.now.bind(performance);
                    Object.defineProperty(performance, 'now', {
                        configurable: true,
                        value: () =>
                            h.forceSliceClock ? realNow() + 13 : realNow(),
                    });

                    const nativeSend = WebSocket.prototype.send;
                    WebSocket.prototype.send = function (data) {
                        if (this.url.includes(`/ws/pane/${id}?`)) {
                            let bytes: Uint8Array | null = null;
                            if (data instanceof ArrayBuffer)
                                bytes = new Uint8Array(data);
                            else if (ArrayBuffer.isView(data)) {
                                bytes = new Uint8Array(
                                    data.buffer,
                                    data.byteOffset,
                                    data.byteLength,
                                );
                            }
                            if (bytes && h.capture) {
                                const frameIndex = h.clientFrames.length;
                                h.clientFrames.push(Array.from(bytes));
                                h.order.push({
                                    kind: 'client-frame',
                                    frameIndex,
                                });
                            }
                        }
                        return nativeSend.call(this, data);
                    };

                    const NativeResizeObserver = window.ResizeObserver;
                    window.ResizeObserver = class extends NativeResizeObserver {
                        constructor(callback: ResizeObserverCallback) {
                            super((entries, observer) => {
                                callback(entries, observer);
                                if (
                                    h.fitRequested &&
                                    h.releaseContinuation &&
                                    entries.some(
                                        (entry) =>
                                            entry.target.id === `term-${id}`,
                                    )
                                ) {
                                    requestAnimationFrame(() => {
                                        h.fitDeferredBeforeRelease =
                                            h.geometry.length ===
                                            h.geometryAtFitRequest;
                                        h.releaseContinuation?.();
                                    });
                                }
                            });
                        }
                    };

                    let Base: ResizeWindow['Terminal'];
                    Object.defineProperty(window, 'Terminal', {
                        configurable: true,
                        get: () => Base,
                        set: (Original: ResizeWindow['Terminal']) => {
                            Base = class extends Original {
                                constructor(options: Record<string, unknown>) {
                                    super({ ...options, scrollback: 5000 });
                                    h.terms.push(this);
                                    const term = this;
                                    const buffer = this._core._writeBuffer;
                                    const parse = buffer._action;
                                    buffer._action = function (
                                        data,
                                        promiseResult,
                                    ) {
                                        if (h.capture && h.term === term) {
                                            h.parsed.push(
                                                typeof data === 'string'
                                                    ? data
                                                    : new TextDecoder().decode(
                                                          data,
                                                      ),
                                            );
                                        }
                                        return parse.call(
                                            this,
                                            data,
                                            promiseResult,
                                        );
                                    };
                                    const schedule =
                                        buffer._scheduleInnerWrite.bind(buffer);
                                    buffer._scheduleInnerWrite = function (
                                        lastTime = 0,
                                        promiseResult = true,
                                    ) {
                                        if (
                                            h.armed &&
                                            h.term === term &&
                                            !h.initialTimerHeld &&
                                            !h.initialReleased &&
                                            this._bufferOffset === 0 &&
                                            this._writeBuffer.length === 0
                                        ) {
                                            h.initialTimerHeld = true;
                                            h.releaseInitial = () => {
                                                h.initialReleased = true;
                                                const release =
                                                    h.releaseInitial;
                                                h.releaseInitial = undefined;
                                                if (release)
                                                    schedule(
                                                        lastTime,
                                                        promiseResult,
                                                    );
                                            };
                                            return;
                                        }
                                        if (
                                            h.armed &&
                                            h.term === term &&
                                            h.initialReleased &&
                                            h.pendingCallbacks > 0 &&
                                            !h.didHoldContinuation &&
                                            h.parsed
                                                .join('')
                                                .includes('BURST_START')
                                        ) {
                                            h.didHoldContinuation = true;
                                            h.heldState = {
                                                offset: this._bufferOffset,
                                                queued: this._writeBuffer
                                                    .length,
                                                pendingCallbacks:
                                                    h.pendingCallbacks,
                                            };
                                            h.releaseContinuation = () => {
                                                const release =
                                                    h.releaseContinuation;
                                                h.releaseContinuation =
                                                    undefined;
                                                if (release)
                                                    schedule(
                                                        lastTime,
                                                        promiseResult,
                                                    );
                                            };
                                            // Request the fit from the held
                                            // continuation. Asking at a parsed
                                            // boundary raced the batch
                                            // callback: on a quiet instant
                                            // nothing was in flight, so the fit
                                            // ran at once and the deferral under
                                            // test could not be observed.
                                            if (!h.fitRequested) {
                                                h.sliceState = {
                                                    offset: this._bufferOffset,
                                                    queued: this._writeBuffer
                                                        .length,
                                                    writeCalls: h.writeCalls,
                                                    writtenChars:
                                                        h.writtenChars,
                                                    pendingCallbacks:
                                                        h.pendingCallbacks,
                                                };
                                                h.fitRequested = true;
                                                h.geometryAtFitRequest =
                                                    h.geometry.length;
                                                h.order.push({
                                                    kind: 'fit-request',
                                                });
                                                const panel =
                                                    document.getElementById(
                                                        `term-${id}`,
                                                    );
                                                panel?.style.setProperty(
                                                    'width',
                                                    '520px',
                                                    'important',
                                                );
                                                panel?.style.setProperty(
                                                    'height',
                                                    '360px',
                                                    'important',
                                                );
                                            }
                                            return;
                                        }
                                        schedule(lastTime, promiseResult);
                                    };
                                    this.onWriteParsed(() => {
                                        if (h.forceSliceClock)
                                            h.forceSliceClock = false;
                                    });
                                }

                                open(parent: HTMLElement) {
                                    super.open(parent);
                                    if (
                                        parent.closest('.term-container')
                                            ?.id === `term-${id}`
                                    ) {
                                        h.term = this;
                                    }
                                }

                                write(
                                    data: string | Uint8Array,
                                    callback?: () => void,
                                ) {
                                    const isTarget = h.term === this;
                                    if (h.armed && isTarget) {
                                        h.writeCalls++;
                                        h.writtenChars += data.length;
                                        h.order.push({ kind: 'write' });
                                    }
                                    if (callback) h.pendingCallbacks++;
                                    const wrapped = callback
                                        ? () => {
                                              h.pendingCallbacks--;
                                              if (h.armed && isTarget)
                                                  h.forceSliceClock = true;
                                              callback();
                                          }
                                        : undefined;
                                    super.write(data, wrapped);
                                }

                                resize(cols: number, rows: number) {
                                    const changed =
                                        cols !== this.cols ||
                                        rows !== this.rows;
                                    super.resize(cols, rows);
                                    if (h.armed && h.term === this && changed) {
                                        h.geometry.push({ cols, rows });
                                        h.order.push({
                                            kind: 'term-resize',
                                            cols,
                                            rows,
                                        });
                                    }
                                }
                            };
                        },
                    });
                }, paneId);

                try {
                    await page.goto(phi.url);
                    if (surface.isMobile) {
                        await page.locator('#hostname-display').click();
                        await page
                            .locator(
                                `#hostname-tabs-dropdown [data-pane-id="${paneId}"] .hostname-dropdown-select-btn`,
                            )
                            .click();
                    } else {
                        await page
                            .locator(`.tab[data-pane-id="${paneId}"]`)
                            .click();
                    }
                    console.info(
                        '[terminal debug]',
                        await page.evaluate((id) => {
                            const h = (window as unknown as ResizeWindow)
                                .resizeHarness;
                            const term = h.term;
                            return {
                                terms: h.terms.length,
                                pendingCallbacks: h.pendingCallbacks,
                                element: term?.element?.outerHTML.slice(0, 100),
                                container:
                                    term?.element?.closest('.term-container')
                                        ?.id,
                                target: document
                                    .getElementById(`term-${id}`)
                                    ?.outerHTML.slice(0, 100),
                                tab: Boolean(
                                    document.querySelector(
                                        `.tab[data-pane-id="${id}"]`,
                                    ),
                                ),
                            };
                        }, paneId),
                    );
                    await expect
                        .poll(() =>
                            page.evaluate((id) => {
                                const h = (window as unknown as ResizeWindow)
                                    .resizeHarness;
                                return Boolean(
                                    h.term?.element?.closest('.term-container')
                                        ?.id === `term-${id}` &&
                                        h.pendingCallbacks === 0,
                                );
                            }, paneId),
                        )
                        .toBe(true);
                    await page.evaluate(() => {
                        const h = (window as unknown as ResizeWindow)
                            .resizeHarness;
                        h.initialGrid = {
                            cols: h.term!.cols,
                            rows: h.term!.rows,
                        };
                        h.parsed.length = 0;
                        h.order.length = 0;
                        h.clientFrames.length = 0;
                        h.geometry.length = 0;
                        h.writeCalls = 0;
                        h.writtenChars = 0;
                        h.armed = true;
                        h.capture = true;
                    });
                    writeFileSync(startPath(), 'go');

                    await expect
                        .poll(() => receivedBytes, { timeout: 15_000 })
                        .toBe(Buffer.byteLength(payload));
                    const initialHeld = await page.evaluate(() => {
                        const h = (window as unknown as ResizeWindow)
                            .resizeHarness;
                        return h.initialTimerHeld;
                    });
                    expect(initialHeld).toBe(true);
                    await page.evaluate(() => {
                        const h = (window as unknown as ResizeWindow)
                            .resizeHarness;
                        h.releaseInitial?.();
                    });

                    try {
                        await expect
                            .poll(
                                async () => {
                                    const state = await terminalState(
                                        page,
                                        paneId,
                                    );
                                    return Boolean(
                                        state?.fitRequested &&
                                            state.heldState &&
                                            state.releaseContinuation ===
                                                false &&
                                            state.fitDeferredBeforeRelease !==
                                                undefined &&
                                            state.geometry.length > 0 &&
                                            state.text.includes('BURST_END'),
                                    );
                                },
                                { timeout: 15_000 },
                            )
                            .toBe(true);
                    } catch (error) {
                        console.info(
                            '[resize state on timeout]',
                            await terminalState(page, paneId),
                        );
                        throw error;
                    }
                    const state = await terminalState(page, paneId);
                    expect(state?.termId).toBe(`term-${paneId}`);
                    expect(state?.sliceState).not.toBeUndefined();
                    expect(state?.heldState).not.toBeUndefined();
                    expect(state?.sliceState?.writtenChars).toBeLessThan(
                        payload.length,
                    );
                    expect(state?.heldState?.pendingCallbacks).toBeGreaterThan(
                        0,
                    );
                    expect(state?.initialGrid).not.toEqual(
                        state?.geometry.at(-1),
                    );
                    expect(state?.writeCalls).toBeGreaterThan(1);
                    const payloadMarker = `${start}BURST_START\r\n`;
                    const payloadIndex =
                        state?.parsed.indexOf(payloadMarker) ?? -1;
                    expect(payloadIndex).toBeGreaterThanOrEqual(0);
                    expect(state?.parsed.slice(payloadIndex)).toBe(payload);
                    expect(state?.text.match(/BURST_START/g)).toHaveLength(1);
                    expect(state?.text.match(/BURST_END/g)).toHaveLength(1);
                    expect(
                        state?.fitDeferredBeforeRelease,
                        JSON.stringify({
                            geometryAtFitRequest: state?.geometryAtFitRequest,
                            geometry: state?.geometry,
                            sliceState: state?.sliceState,
                            heldState: state?.heldState,
                            order: state?.order.map((entry) => entry.kind),
                        }),
                    ).toBe(true);
                    expect(state?.resizeFrames.length).toBeGreaterThan(0);
                    const finalFrame = state?.resizeFrames.at(-1);
                    expect(state?.geometry.at(-1)).toEqual(finalFrame);
                    const fitIndex =
                        state?.order.findIndex(
                            (entry) => entry.kind === 'fit-request',
                        ) ?? -1;
                    const resizeIndex =
                        state?.order.findIndex(
                            (entry, index) =>
                                index > fitIndex &&
                                entry.kind === 'term-resize',
                        ) ?? -1;
                    const frameIndex =
                        state?.order.findIndex(
                            (entry, index) =>
                                index > resizeIndex &&
                                entry.kind === 'resize-frame',
                        ) ?? -1;
                    const nextWriteIndex =
                        state?.order.findIndex(
                            (entry, index) =>
                                index > resizeIndex && entry.kind === 'write',
                        ) ?? -1;
                    expect(fitIndex).toBeGreaterThanOrEqual(0);
                    expect(resizeIndex).toBeGreaterThan(fitIndex);
                    expect(frameIndex).toBeGreaterThan(resizeIndex);
                    expect(nextWriteIndex).toBeGreaterThan(frameIndex);

                    await expect
                        .poll(() => {
                            if (!existsSync(sizePath())) return null;
                            const [cols, rows] = readFileSync(
                                sizePath(),
                                'utf8',
                            )
                                .trim()
                                .split(/\s+/)
                                .map(Number);
                            return { cols, rows };
                        })
                        .toEqual(finalFrame);

                    await page.evaluate(() => {
                        (
                            window as unknown as ResizeWindow
                        ).resizeHarness.capture = false;
                    });
                    await page.locator(`#term-${paneId}`).click();
                    await page.keyboard.type('PING');
                    await page.keyboard.press('Enter');
                    await expect
                        .poll(
                            async () =>
                                (await terminalState(page, paneId))?.text ?? '',
                        )
                        .toContain('INPUT_OK');
                    if (surface.isMobile) {
                        const { documentWidth, viewportWidth } =
                            await page.evaluate(() => ({
                                documentWidth:
                                    document.documentElement.scrollWidth,
                                viewportWidth: window.innerWidth,
                            }));
                        expect(documentWidth).toBeLessThanOrEqual(
                            viewportWidth,
                        );
                    }
                } finally {
                    await request.delete(`${phi.url}/api/terminals/${paneId}`);
                }
            });
        }
    });
}
