import { expect, test, type WebSocketRoute } from '@playwright/test';
import { TerminalClientFrame } from '../web/proto/terminal.js';
import { TerminalServerFrame } from '../web/proto/terminal.js';
import type {
    MessageFns,
    TerminalClientFrame as TerminalClientMessage,
    TerminalServerFrame as TerminalServerMessage,
} from '../web-src/proto/terminal.js';
import { startPhi, type PhiServer } from './_server.js';

// The served bundle carries no types; bind its runtime codecs to the
// generated declarations so spec-side encoding is fully checked.
const ServerCodec: MessageFns<TerminalServerMessage> =
    TerminalServerFrame as unknown as MessageFns<TerminalServerMessage>;
const ClientCodec: MessageFns<TerminalClientMessage> =
    TerminalClientFrame as unknown as MessageFns<TerminalClientMessage>;

let phi: PhiServer;
test.beforeAll(async () => {
    phi = await startPhi();
});
test.afterAll(async () => {
    await phi.stop();
});

const status = 'worker [fresh] running (openai-codex/gpt-6-luna thinking max)';
interface Fit {
    fit(): void;
    proposeDimensions?(): { cols: number; rows: number } | undefined;
}
interface Term {
    element?: HTMLElement;
    cols: number;
    rows: number;
    options: { fontSize: number; fontFamily: string };
    loadAddon(addon: Fit): void;
    open(element: HTMLElement): void;
    resize(cols: number, rows: number): void;
    write(text: string, callback?: () => void): void;
    dispose(): void;
    buffer: {
        active: {
            length: number;
            baseY: number;
            viewportY: number;
            cursorX: number;
            cursorY: number;
            getLine(
                index: number,
            ): { translateToString(trim?: boolean): string } | undefined;
        };
    };
}
interface ObservedTerm extends Term {
    initialGrid: number[];
    hiddenFits: number;
    parsedChars: number;
    fit?: Fit;
}
interface TestWindow {
    Terminal: new (options: Record<string, unknown>) => ObservedTerm;
    FitAddon: { FitAddon: new () => Fit };
    hiddenGeometryTerms: ObservedTerm[];
}

for (const route of ['bootstrap', 'live-gap', 'font-size', 'font-family']) {
    test(`hidden ${route} preserves cursor-addressed output through activation`, async ({
        page,
    }) => {
        await page.route('**/api/terminals', (r) => r.fulfill({ json: [] }));
        await page.goto(phi.url);
        const result = await page.evaluate(
            async ({ route, status }) => {
                const modulePath = '/terminal.js';
                const { TabManager } = await import(modulePath);
                const w = window as unknown as TestWindow;
                await document.fonts.ready;
                const wrapper = document.createElement('div');
                wrapper.style.cssText =
                    'position:fixed;left:0;top:0;width:1000px;height:600px';
                const panel = document.createElement('div');
                panel.className = 'term-container active';
                wrapper.append(panel);
                document.body.append(wrapper);
                const term = new w.Terminal({
                    cols: 80,
                    rows: 24,
                    fontSize: 14,
                    fontFamily: 'monospace',
                    scrollback: 10000,
                });
                const fitAddon = new w.FitAddon.FitAddon();
                term.loadAddon(fitAddon);
                term.open(panel);
                fitAddon.fit();
                const initial = [term.cols, term.rows];
                const reference = new w.Terminal({
                    cols: term.cols,
                    rows: term.rows,
                    scrollback: 10000,
                });
                const resizes: number[][] = [];
                const manager = Object.assign(
                    Object.create(TabManager.prototype),
                    {
                        app: { config: {}, terminalFontSize: 14 },
                        tabs: new Map(),
                        activePaneId: 'hidden-probe',
                        updateDocumentTitle() {},
                        _scheduleCheckpointUpload() {},
                    },
                );
                const tab = {
                    paneId: 'hidden-probe',
                    paneEpoch: 7,
                    term,
                    fitAddon,
                    termContainer: panel,
                    writeBuffer: '',
                    writePending: false,
                    isBusy: true,
                    userFollowBottom: false,
                    queuedSeq: 0,
                    drainedSeq: 0,
                    _panelFitRAF: null as number | null,
                    _pendingPanelFit: false,
                    _pendingForceResize: false,
                    ws: {
                        mode: 'hot',
                        liveSeq: 0,
                        lastFrameEnd: 0,
                        sendResize(cols: number, rows: number) {
                            resizes.push([cols, rows]);
                            return true;
                        },
                        hold() {},
                        release() {},
                        applyGapPatch(bytes: Uint8Array) {
                            this.liveSeq += bytes.length;
                            this.lastFrameEnd = this.liveSeq;
                            manager._paneData(
                                tab,
                                new TextDecoder().decode(bytes),
                            );
                        },
                    },
                };
                manager.tabs.set(tab.paneId, tab);
                const write = (t: Term, text: string) =>
                    new Promise<void>((resolve) => t.write(text, resolve));
                const snapshot = (t: Term) => {
                    const b = t.buffer.active;
                    return {
                        cols: t.cols,
                        rows: t.rows,
                        baseY: b.baseY,
                        cursor: [b.cursorX, b.cursorY],
                        lines: Array.from(
                            { length: b.length },
                            (_, i) =>
                                b.getLine(i)?.translateToString(true) ?? '',
                        ),
                    };
                };
                try {
                    panel.classList.remove('active');
                    const rect = panel.getBoundingClientRect();
                    if (route === 'bootstrap')
                        await manager._bootstrapDelta(tab, 0, 0);
                    if (route === 'live-gap') {
                        manager._fetchRecordingRange = async () => ({
                            start: 0,
                            end: 1,
                            byteLength: 1,
                            bytes: new Uint8Array([32]),
                            resizes: [],
                        });
                        await manager._onLiveGap(tab, 0, 1);
                        await write(reference, ' ');
                    }
                    if (route === 'font-size') {
                        manager.app.terminalFontSize = 18;
                        manager.applyTerminalFontSizeToAll(18);
                    }
                    if (route === 'font-family')
                        manager.applyFontToAllActiveTerminals(
                            'Courier New, monospace',
                        );
                    const hidden = {
                        rect: [rect.width, rect.height],
                        grid: [term.cols, term.rows],
                        resizes: resizes.slice(),
                        pending: [
                            tab._pendingPanelFit,
                            tab._pendingForceResize,
                        ],
                    };
                    for (let i = 0; i < 6; i++) {
                        const text = `${i ? '\x1b[1A\r\x1b[2K' : ''}${status}\r\n`;
                        manager.writeToTerminal(tab, text);
                        await manager._drainSettled(tab);
                        await write(reference, text);
                    }
                    panel.classList.add('active');
                    manager.activateTabViewport(tab, {
                        scrollToBottom: false,
                        autoReconnect: false,
                    });
                    await new Promise<void>((resolve) =>
                        requestAnimationFrame(() => resolve()),
                    );
                    await manager._drainSettled(tab);
                    reference.resize(term.cols, term.rows);
                    return {
                        initial,
                        hidden,
                        actual: snapshot(term),
                        expected: snapshot(reference),
                        resizes,
                        pending: [
                            tab._pendingPanelFit,
                            tab._pendingForceResize,
                        ],
                        fontSize: term.options.fontSize,
                        fontFamily: term.options.fontFamily,
                    };
                } finally {
                    if (tab._panelFitRAF !== null)
                        cancelAnimationFrame(tab._panelFitRAF);
                    manager._cancelScrollFollowForUserScroll(tab);
                    term.dispose();
                    reference.dispose();
                    wrapper.remove();
                }
            },
            { route, status },
        );
        expect(result.hidden.rect).toEqual([0, 0]);
        expect(result.hidden.grid).toEqual(result.initial);
        expect(result.hidden.resizes).toEqual([]);
        expect(result.hidden.pending).toEqual([true, true]);
        expect(result.actual).toEqual(result.expected);
        expect(result.actual.lines.filter(Boolean)).toEqual([status]);
        expect(result.pending).toEqual([false, false]);
        expect(result.resizes.at(-1)).toEqual([
            result.actual.cols,
            result.actual.rows,
        ]);
        if (route === 'font-size') expect(result.fontSize).toBe(18);
        if (route === 'font-family')
            expect(result.fontFamily).toBe('Courier New, monospace');
    });
}

test('initial background attachment never fits the hidden panel, including its open fallback', async ({
    page,
}) => {
    const one = 'hidden-one',
        two = 'hidden-two';
    const sockets = new Map<string, WebSocketRoute>();
    const firstSizes: number[][] = [];
    const sizes = new Map<string, number[][]>([
        [one, firstSizes],
        [two, []],
    ]);
    await page.addInitScript((active) => {
        localStorage.setItem('phi_active_pane', active);
        const w = window as unknown as TestWindow;
        w.hiddenGeometryTerms = [];
        let ctor: typeof w.Terminal;
        Object.defineProperty(window, 'Terminal', {
            configurable: true,
            get: () => ctor,
            set: (base: typeof w.Terminal) => {
                ctor = class extends base {
                    constructor(options: Record<string, unknown>) {
                        super(options);
                        this.initialGrid = [this.cols, this.rows];
                        this.hiddenFits = 0;
                        this.parsedChars = 0;
                        w.hiddenGeometryTerms.push(this);
                    }
                    loadAddon(addon: Fit) {
                        if (addon.proposeDimensions) {
                            this.fit = addon;
                            const nativeFit = addon.fit.bind(addon);
                            addon.fit = () => {
                                const panel =
                                    this.element?.closest('.term-container');
                                const rect = panel?.getBoundingClientRect();
                                if (
                                    rect &&
                                    (!rect.width ||
                                        !rect.height ||
                                        document.hidden)
                                )
                                    this.hiddenFits++;
                                nativeFit();
                            };
                        }
                        super.loadAddon(addon);
                    }
                    write(text: string, callback?: () => void) {
                        super.write(text, () => {
                            this.parsedChars += text.length;
                            callback?.();
                        });
                    }
                };
            },
        });
    }, two);
    await page.route('**/api/terminals', (r) =>
        r.fulfill({
            json: [one, two].map((id) => ({
                id,
                title: id,
                coder: 'bash',
                cwd: phi.dir,
                workspace: phi.dir,
                session_id: '',
                pinned: false,
            })),
        }),
    );
    await page.route('**/api/terminals/hidden-*/**', (r) =>
        r.fulfill({ json: {} }),
    );
    await page.routeWebSocket('**/ws/pane/hidden-*?*', (socket) => {
        const id = new URL(socket.url()).pathname.split('/').at(-1) ?? '';
        const sent = sizes.get(id);
        if (!sent) throw new Error(`Unexpected pane: ${id}`);
        sockets.set(id, socket);
        socket.onMessage((message) => {
            if (!Buffer.isBuffer(message)) return;
            const payload = ClientCodec.decode(new Uint8Array(message)).payload;
            if (payload?.$case !== 'resize') return;
            const { cols, rows } = payload.value;
            if (cols === undefined || rows === undefined) return;
            sent.push([cols, rows]);
        });
    });
    await page.goto(phi.url);
    await expect(page.locator(`.tab[data-pane-id="${two}"]`)).toHaveClass(
        /active/,
    );
    await expect.poll(() => sockets.size).toBe(2);
    const panel = page.locator(`#term-${one}`);
    expect(
        await panel.evaluate((p) => [
            p.getBoundingClientRect().width,
            p.getBoundingClientRect().height,
        ]),
    ).toEqual([0, 0]);
    const resizeCount = firstSizes.length;
    await expect.poll(() => panel.locator('.xterm').count()).toBe(1);
    const probe = () =>
        page.evaluate((id) => {
            const w = window as unknown as TestWindow;
            const t = w.hiddenGeometryTerms.find(
                (term) =>
                    term.element?.closest('.term-container')?.id ===
                    `term-${id}`,
            );
            if (!t) return null;
            const b = t.buffer.active;
            return {
                grid: [t.cols, t.rows],
                initial: t.initialGrid,
                hiddenFits: t.hiddenFits,
                parsedChars: t.parsedChars,
                proposed: t.fit?.proposeDimensions?.(),
                cursor: [b.cursorX, b.cursorY],
                lines: Array.from(
                    { length: b.length },
                    (_, i) => b.getLine(i)?.translateToString(true) ?? '',
                ).filter(Boolean),
            };
        }, one);
    const before = await probe();
    expect(before?.grid).toEqual(before?.initial);
    expect(before?.hiddenFits).toBe(0);
    expect(sizes.get(one)).toHaveLength(resizeCount);
    const head = (id: string, bytes?: Buffer) => {
        const through = bytes?.length ?? 0;
        const socket = sockets.get(id);
        if (!socket) throw new Error(`Missing attach socket: ${id}`);
        socket.send(
            Buffer.from(
                ServerCodec.encode(
                    ServerCodec.fromPartial({
                        payload: {
                            $case: 'attach',
                            value: {
                                epoch: BigInt(7),
                                oldest: BigInt(0),
                                head: BigInt(through),
                                ...(bytes
                                    ? {
                                          checkpoint: {
                                              kind: 'ansi-v1',
                                              through: BigInt(through),
                                              cols: 80,
                                              rows: 24,
                                              data: new Uint8Array(bytes),
                                          },
                                      }
                                    : {}),
                            },
                        },
                    }),
                ).finish(),
            ),
        );
    };
    const checkpoint = Buffer.from(`${status}\r\n`);
    head(one, checkpoint);
    head(two);
    await expect
        .poll(async () => (await probe())?.parsedChars)
        .toBe(checkpoint.length);
    expect((await probe())?.grid).toEqual([80, 24]);
    expect((await probe())?.hiddenFits).toBe(0);
    expect(sizes.get(one)).toHaveLength(resizeCount);
    const update = Buffer.from(`\x1b[1A\r\x1b[2K${status}\r\n`);
    const firstSocket = sockets.get(one);
    if (!firstSocket) throw new Error('Missing background socket');
    let frontier = checkpoint.length;
    for (let i = 0; i < 5; i++) {
        firstSocket.send(
            Buffer.from(
                ServerCodec.encode(
                    ServerCodec.fromPartial({
                        payload: {
                            $case: 'output',
                            value: {
                                start: BigInt(frontier),
                                data: new Uint8Array(update),
                            },
                        },
                    }),
                ).finish(),
            ),
        );
        frontier += update.length;
    }
    await expect.poll(async () => (await probe())?.parsedChars).toBe(frontier);
    expect((await probe())?.lines).toEqual([status]);
    expect((await probe())?.grid).toEqual([80, 24]);
    expect((await probe())?.hiddenFits).toBe(0);
    expect(sizes.get(one)).toHaveLength(resizeCount);
    await page.locator(`.tab[data-pane-id="${one}"]`).click();
    await expect
        .poll(async () => {
            const state = await probe();
            return (
                !!state &&
                firstSizes.length > resizeCount &&
                JSON.stringify(firstSizes.at(-1)) ===
                    JSON.stringify(state.grid) &&
                state.proposed?.cols === state.grid[0] &&
                state.proposed.rows === state.grid[1]
            );
        })
        .toBe(true);
    expect((await probe())?.lines).toEqual([status]);
});
