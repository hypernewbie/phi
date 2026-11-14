import { copyFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import {
    TerminalClientFrame,
    TerminalServerFrame,
} from '../web/proto/terminal.js';
import type {
    MessageFns,
    TerminalClientFrame as TerminalClientMessage,
    TerminalServerFrame as TerminalServerMessage,
} from '../web-src/proto/terminal.js';
import { startPhi, type PhiServer } from './_server.js';
import { readReplay } from './_terminal-replay.js';
import {
    isCancelledBellAudio,
    isCancelledSessionListRead,
    isCancelledTerminalReplay,
    isCancelledWorktreeRead,
} from './_session-requests.js';

interface FitAddon {
    proposeDimensions?(): { cols: number; rows: number } | undefined;
    fit?(): void;
}

interface Terminal {
    element?: HTMLElement;
    cols: number;
    rows: number;
    fit?: FitAddon;
    loadAddon(addon: FitAddon): void;
    resize(cols: number, rows: number): void;
    refresh(start: number, end: number): void;
    write(data: string | Uint8Array, callback?: () => void): void;
    buffer: {
        active: {
            baseY: number;
            viewportY: number;
            length: number;
            getLine(
                row: number,
            ): { translateToString(trim?: boolean): string } | undefined;
        };
    };
}

interface GeometryWindow extends Window {
    Terminal: new (options: Record<string, unknown>) => Terminal;
    geometryTerms: Terminal[];
    observedPanels: string[];
    geometryFits: number;
    geometryRefreshes: number;
    geometryGridEvents: { cols: number; rows: number }[];
    geometryPendingWrites: number;
    geometryWriteCompletions: number;
    geometryCompletedTexts: string[];
    geometryPanelResizes: { id: string; width: number; height: number }[];
}

interface BrowserEvents {
    pageErrors: string[];
    consoleErrors: string[];
    failedRequests: string[];
    errorResponses: string[];
    foreignOrigins: string[];
    sockets: string[];
    themePosts: number;
}

const ClientCodec: MessageFns<TerminalClientMessage> =
    TerminalClientFrame as unknown as MessageFns<TerminalClientMessage>;
const ServerCodec: MessageFns<TerminalServerMessage> =
    TerminalServerFrame as unknown as MessageFns<TerminalServerMessage>;

const fixture = `#!/usr/bin/python3
import os, signal, sys, termios

attrs = termios.tcgetattr(0)
attrs[3] &= ~termios.ECHO
termios.tcsetattr(0, termios.TCSANOW, attrs)
sequence = 0

def paint(reason):
    global sequence
    sequence += 1
    cols, rows = os.get_terminal_size(1)
    data = '\\x1b[2J\\x1b[HDRAW %d %s %dx%d\\x1b[%d;1HEDGE' % (sequence, reason, cols, rows, rows)
    os.write(1, data.encode())

def resized(_signum, _frame):
    paint('WINCH')

signal.signal(signal.SIGWINCH, resized)
paint('START')
for line in sys.stdin:
    if line.strip() == 'REPORT':
        paint('REPORT')
    elif line.strip() == 'SCROLL':
        data = ''.join('ROW %03d %s\\r\\n' % (i, 'x' * 24) for i in range(1, 201))
        os.write(1, data.encode())
        paint('SCROLLDONE')
`;

function startGeometryFixture(
    config?: Record<string, unknown>,
): Promise<PhiServer> {
    return startPhi({
        ...(config ? { config } : {}),
        env: { PHI_SHUTDOWN_PTY_GRACE: '150ms', PHI_SHUTDOWN_GRACE: '1s' },
        setup(dir) {
            const folder = join(dir, 'workspace');
            mkdirSync(folder, { recursive: true });
            const workspace = realpathSync(folder);
            const phiDir = join(dir, 'home', '.phi');
            const backends = join(phiDir, 'backends');
            mkdirSync(backends, { recursive: true });
            const command = join(dir, 'fixture-bash');
            writeFileSync(command, fixture, { mode: 0o755 });
            writeFileSync(
                join(backends, 'bash.json'),
                JSON.stringify({ id: 'bash', command }),
            );
            writeFileSync(
                join(phiDir, 'tabs.json'),
                JSON.stringify(
                    ['t1', 't2'].map((id, index) => ({
                        id,
                        coder: 'bash',
                        session_id: '',
                        cwd: workspace,
                        workspace,
                        title: `Tab ${index + 1}`,
                    })),
                ),
            );
        },
    });
}

async function captureGeometry(page: Page) {
    await page.addInitScript(() => {
        const win = window as unknown as GeometryWindow;
        win.geometryTerms = [];
        win.observedPanels = [];
        win.geometryFits = 0;
        win.geometryRefreshes = 0;
        win.geometryGridEvents = [];
        win.geometryPendingWrites = 0;
        win.geometryWriteCompletions = 0;
        win.geometryCompletedTexts = [];
        win.geometryPanelResizes = [];
        let Constructor: typeof win.Terminal;
        Object.defineProperty(window, 'Terminal', {
            configurable: true,
            get: () => Constructor,
            set: (Base: typeof win.Terminal) => {
                Constructor = class extends Base {
                    constructor(options: Record<string, unknown>) {
                        super(options);
                        win.geometryTerms.push(this);
                    }
                    loadAddon(addon: FitAddon) {
                        if (addon.proposeDimensions) {
                            this.fit = addon;
                            const fit = addon.fit?.bind(addon);
                            if (fit) {
                                addon.fit = () => {
                                    win.geometryFits++;
                                    fit();
                                };
                            }
                        }
                        super.loadAddon(addon);
                    }
                    resize(cols: number, rows: number) {
                        win.geometryGridEvents.push({ cols, rows });
                        super.resize(cols, rows);
                    }
                    refresh(start: number, end: number) {
                        if (start === 0 && end >= this.rows - 1)
                            win.geometryRefreshes++;
                        super.refresh(start, end);
                    }
                    write(data: string | Uint8Array, callback?: () => void) {
                        const text =
                            typeof data === 'string'
                                ? data
                                : new TextDecoder().decode(data);
                        win.geometryPendingWrites++;
                        super.write(data, () => {
                            win.geometryPendingWrites--;
                            win.geometryWriteCompletions++;
                            if (text.includes('DRAW'))
                                win.geometryCompletedTexts.push(text);
                            callback?.();
                        });
                    }
                };
            },
        });
        const NativeObserver = window.ResizeObserver;
        window.ResizeObserver = class extends NativeObserver {
            observe(target: Element, options?: ResizeObserverOptions) {
                if (target.id.startsWith('term-'))
                    win.observedPanels.push(target.id);
                super.observe(target, options);
            }
            constructor(callback: ResizeObserverCallback) {
                super((entries, observer) => {
                    for (const entry of entries) {
                        if (entry.target.id.startsWith('term-')) {
                            win.geometryPanelResizes.push({
                                id: entry.target.id,
                                width: entry.contentRect.width,
                                height: entry.contentRect.height,
                            });
                        }
                    }
                    callback(entries, observer);
                });
            }
        };
    });
}

function observeBrowser(page: Page, origin: string): BrowserEvents {
    const events: BrowserEvents = {
        pageErrors: [],
        consoleErrors: [],
        failedRequests: [],
        errorResponses: [],
        foreignOrigins: [],
        sockets: [],
        themePosts: 0,
    };
    page.on('pageerror', (error) => events.pageErrors.push(error.message));
    page.on('console', (message) => {
        if (message.type() === 'error')
            events.consoleErrors.push(message.text());
    });
    page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.origin !== origin) events.foreignOrigins.push(url.origin);
        if (
            url.href === `${origin}/api/config/theme` &&
            request.method() === 'POST'
        )
            events.themePosts++;
    });
    page.on('requestfailed', (request) => {
        if (
            isCancelledSessionListRead(request, origin) ||
            isCancelledWorktreeRead(request, origin) ||
            isCancelledTerminalReplay(request, origin) ||
            isCancelledBellAudio(request, origin)
        )
            return;
        const url = new URL(request.url());
        events.failedRequests.push(
            `${request.method()} ${url.pathname}${url.search}: ${request.failure()?.errorText}`,
        );
    });
    page.on('response', (response) => {
        if (response.status() < 400) return;
        const url = new URL(response.url());
        const coder = url.searchParams.get('coder');
        events.errorResponses.push(
            `${response.status()} ${url.pathname}${coder ? `?coder=${coder}` : ''}`,
        );
    });
    page.on('websocket', (socket) => {
        const url = new URL(socket.url());
        if (url.host !== new URL(origin).host)
            events.foreignOrigins.push(url.origin);
        events.sockets.push(url.pathname);
    });
    return events;
}

function assertBrowserEvents(events: BrowserEvents, themeSaveVerified = false) {
    expect(events.pageErrors).toEqual([]);
    expect(events.foreignOrigins).toEqual([]);
    expect(
        events.consoleErrors.filter(
            (message) =>
                !/^Failed to load resource: the server responded with a status of (503|500)\b/.test(
                    message,
                ),
        ),
    ).toEqual([]);
    expect(
        events.errorResponses.filter(
            (response) =>
                response !== '503 /api/update/status' &&
                response !== '500 /api/sessions?coder=opencode',
        ),
    ).toEqual([]);
    const themeAbort = 'POST /api/config/theme: net::ERR_ABORTED';
    const themeAborts = events.failedRequests.filter(
        (request) => request === themeAbort,
    );
    expect(themeAborts.length).toBeLessThanOrEqual(themeSaveVerified ? 1 : 0);
    expect(events.themePosts).toBe(themeSaveVerified ? 1 : 0);
    expect(
        events.failedRequests.filter(
            (request) =>
                !/^POST \/api\/terminals\/t[12]\/pin: net::ERR_ABORTED$/.test(
                    request,
                ) && !(themeSaveVerified && request === themeAbort),
        ),
    ).toEqual([]);
}

async function grid(page: Page) {
    return page.evaluate(() => {
        const win = window as unknown as GeometryWindow;
        const term = win.geometryTerms.find((candidate) =>
            candidate.element?.closest('#term-t1'),
        );
        if (!term) return null;
        const active = term.buffer.active;
        const first =
            active.getLine(active.baseY)?.translateToString(true) ?? '';
        const match = /^DRAW (\d+) (START|WINCH|REPORT) (\d+)x(\d+)/.exec(
            first,
        );
        return {
            cols: term.cols,
            rows: term.rows,
            proposed: term.fit?.proposeDimensions?.(),
            seq: match ? Number(match[1]) : 0,
            reason: match?.[2] ?? '',
            ptyCols: match ? Number(match[3]) : 0,
            ptyRows: match ? Number(match[4]) : 0,
            edge:
                active
                    .getLine(active.baseY + term.rows - 1)
                    ?.translateToString(true) ?? '',
            first,
        };
    });
}

async function waitForGrid(
    page: Page,
    label: string,
    after = 0,
    reason?: 'WINCH' | 'REPORT',
    previousCols?: number,
) {
    await expect
        .poll(
            async () => {
                const state = await grid(page);
                return (
                    !!state &&
                    state.seq > after &&
                    (!reason || state.reason === reason) &&
                    (previousCols === undefined ||
                        state.cols !== previousCols) &&
                    state.cols === state.ptyCols &&
                    state.rows === state.ptyRows &&
                    state.proposed?.cols === state.cols &&
                    state.proposed.rows === state.rows &&
                    state.edge === 'EDGE'
                );
            },
            {
                message: `${label}: fresh matching real PTY grid`,
                timeout: 15_000,
            },
        )
        .toBe(true);
    const state = await grid(page);
    if (!state) throw new Error(`${label}: missing terminal`);
    console.log(`${label}: ${JSON.stringify(state)}`);
    return state;
}

async function selectDesktop(page: Page) {
    await page.locator('.tab[data-pane-id="t1"]').click();
    await expect(page.locator('#tabs-container .tab.active')).toHaveAttribute(
        'data-pane-id',
        't1',
    );
}

async function selectMobile(page: Page) {
    await page.locator('#mobile-sidebar-toggle').click();
    await page
        .locator(
            '#drawer-tabs-body .hostname-dropdown-row[data-pane-id="t1"] .hostname-dropdown-select-btn',
        )
        .click();
    await expect(page.locator('#sidebar-panel')).not.toHaveClass(/drawer-open/);
    await expect(page.locator('#tabs-container .tab.active')).toHaveAttribute(
        'data-pane-id',
        't1',
    );
}

async function report(page: Page, label: string) {
    const before = await grid(page);
    await page.locator('#term-t1 .xterm-screen').click({
        position: { x: 12, y: 12 },
    });
    await page.keyboard.type('REPORT');
    await page.keyboard.press('Enter');
    return waitForGrid(page, label, before?.seq ?? 0, 'REPORT');
}

interface WireCounters {
    resize: { cols: number; rows: number }[];
    input: string[];
}

function watchPaneWire(page: Page): WireCounters {
    const counters: WireCounters = { resize: [], input: [] };
    page.on('websocket', (socket) => {
        if (new URL(socket.url()).pathname !== '/ws/pane/t1') return;
        socket.on('framesent', (event) => {
            if (typeof event.payload === 'string') return;
            try {
                const frame = ClientCodec.decode(new Uint8Array(event.payload));
                const payload = frame.payload;
                if (payload?.$case === 'resize') {
                    counters.resize.push({
                        cols: payload.value.cols ?? 0,
                        rows: payload.value.rows ?? 0,
                    });
                } else if (payload?.$case === 'input') {
                    counters.input.push(
                        Buffer.from(payload.value).toString('utf8'),
                    );
                }
            } catch {
                /* non-terminal frames are not counted */
            }
        });
    });
    return counters;
}

async function installVisualViewport(page: Page) {
    await page.addInitScript(() => {
        const listeners = new Set<EventListenerOrEventListenerObject>();
        const viewport = {
            width: window.innerWidth,
            height: window.innerHeight,
            offsetTop: 0,
            offsetLeft: 0,
            pageTop: 0,
            pageLeft: 0,
            scale: 1,
            addEventListener(
                type: string,
                listener: EventListenerOrEventListenerObject,
            ) {
                if (type === 'resize' || type === 'scroll')
                    listeners.add(listener);
            },
            removeEventListener(
                type: string,
                listener: EventListenerOrEventListenerObject,
            ) {
                if (type === 'resize' || type === 'scroll')
                    listeners.delete(listener);
            },
            dispatchEvent() {
                return true;
            },
        };
        Object.defineProperty(window, 'visualViewport', {
            configurable: true,
            get: () => viewport,
        });
        const control = window as unknown as {
            __setVisualViewportHeight: (height: number) => void;
            __visualViewportListenerCount: () => number;
        };
        control.__setVisualViewportHeight = (height: number) => {
            viewport.height = height;
            for (const listener of listeners) {
                if (typeof listener === 'function')
                    listener(new Event('resize'));
                else listener.handleEvent(new Event('resize'));
            }
        };
        control.__visualViewportListenerCount = () => listeners.size;
    });
}

async function composerState(page: Page) {
    return page.evaluate(() => {
        const win = window as unknown as GeometryWindow;
        const textarea = document.getElementById(
            'input-textarea',
        ) as HTMLTextAreaElement | null;
        const panel = document.getElementById('term-t1');
        const bar = document.getElementById('input-bar-container');
        const term = win.geometryTerms.find((candidate) =>
            candidate.element?.closest('#term-t1'),
        );
        if (!textarea || !panel || !bar || !term) return null;
        const textBox = textarea.getBoundingClientRect();
        const panelBox = panel.getBoundingClientRect();
        const barBox = bar.getBoundingClientRect();
        const buffer = term.buffer.active;
        return {
            textareaHeight: Math.round(textBox.height * 100) / 100,
            panelHeight: Math.round(panelBox.height * 100) / 100,
            composerTop: Math.round(barBox.top * 100) / 100,
            textareaTop: Math.round(textBox.top * 100) / 100,
            cols: term.cols,
            rows: term.rows,
            viewportY: buffer.viewportY,
            baseY: buffer.baseY,
            scrollY: window.scrollY,
            styleHeight: textarea.style.height,
            cssHeight: getComputedStyle(textarea).height,
            cssMin: getComputedStyle(textarea).minHeight,
            cssMax: getComputedStyle(textarea).maxHeight,
            scrollHeight: textarea.scrollHeight,
            clientHeight: textarea.clientHeight,
            scrollTop: textarea.scrollTop,
            vvHeight:
                document.documentElement.style.getPropertyValue('--vv-height'),
            fits: win.geometryFits,
            refreshes: win.geometryRefreshes,
            gridEvents: win.geometryGridEvents.length,
            panelResizes: win.geometryPanelResizes.filter(
                (entry) => entry.id === 'term-t1',
            ).length,
            pendingWrites: win.geometryPendingWrites,
            completedWrites: win.geometryWriteCompletions,
            value: textarea.value,
        };
    });
}

async function settleComposer(page: Page) {
    await expect
        .poll(
            () =>
                page.evaluate(
                    () =>
                        (window as unknown as GeometryWindow)
                            .geometryPendingWrites,
                ),
            { timeout: 10_000 },
        )
        .toBe(0);
    for (let i = 0; i < 2; i++) {
        await page.evaluate(
            () =>
                new Promise<void>((resolve) =>
                    requestAnimationFrame(() =>
                        requestAnimationFrame(() => resolve()),
                    ),
                ),
        );
    }
}

async function desktopDrag(
    page: Page,
    handleId: string,
    panelId: string,
    fraction: number,
    delta: number,
) {
    const beforeGrid = await waitForGrid(page, `before ${handleId}`);
    const handle = await page.locator(`#${handleId}`).boundingBox();
    if (!handle) throw new Error(`${handleId} has no bounds`);
    expect(handle.width).toBe(8);
    const beforeWidth = await page
        .locator(`#${panelId}`)
        .evaluate((element) => element.getBoundingClientRect().width);
    const x = handle.x + handle.width * fraction;
    const y = handle.y + handle.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    try {
        await page.mouse.move(x + delta, y);
    } finally {
        await page.mouse.up();
    }
    const afterWidth = await page
        .locator(`#${panelId}`)
        .evaluate((element) => element.getBoundingClientRect().width);
    const expected = handleId === 'left-resize-handle' ? delta : -delta;
    const error = Math.abs(afterWidth - beforeWidth - expected);
    console.log(`${handleId} edge=${fraction} delta=${delta} error=${error}px`);
    expect(error).toBeLessThan(1.5);
    await waitForGrid(
        page,
        `${handleId} edge=${fraction} delta=${delta}`,
        beforeGrid.seq,
        'WINCH',
        beforeGrid.cols,
    );
}

async function settlePanel(page: Page, selector: string) {
    await page.locator(selector).evaluate(async (panel) => {
        await Promise.all(
            panel
                .getAnimations()
                .map((animation) => animation.finished.catch(() => undefined)),
        );
    });
}

async function touchDrag(page: Page, side: 'left' | 'right') {
    const left = side === 'left';
    const panel = left ? '#sidebar-panel' : '#diff-panel';
    const handle = left ? '#sidebar-drawer-resizer' : '#diff-drawer-resizer';
    const toggle = left ? '#mobile-sidebar-toggle' : '#header-diff-toggle-btn';
    await page.locator(toggle).click();
    await expect(page.locator(panel)).toHaveClass(
        left ? /drawer-open/ : /mobile-open/,
    );
    await settlePanel(page, panel);
    const box = await page.locator(handle).boundingBox();
    if (!box) throw new Error(`${handle} has no bounds`);
    expect(box.width).toBe(24);
    const seam = await page.locator(handle).evaluate((element, left) => {
        const panel = element.parentElement;
        if (!panel) throw new Error('drawer resize target has no panel');
        const panelBox = panel.getBoundingClientRect();
        const handleBox = element.getBoundingClientRect();
        const border = getComputedStyle(panel);
        const grip = getComputedStyle(element, '::after');
        const borderWidth = Number.parseFloat(
            left ? border.borderRightWidth : border.borderLeftWidth,
        );
        const gripWidth = Number.parseFloat(grip.width);
        const gripLeft = left
            ? handleBox.left + Number.parseFloat(grip.left)
            : handleBox.right - Number.parseFloat(grip.right) - gripWidth;
        return {
            borderWidth,
            gripWidth,
            opacity: Number(grip.opacity),
            edgeError: Math.abs(
                gripLeft -
                    (left ? panelBox.right - borderWidth : panelBox.left),
            ),
        };
    }, left);
    expect(seam).toEqual({
        borderWidth: 1,
        gripWidth: 1,
        opacity: 0,
        edgeError: 0,
    });
    const before = await page
        .locator(panel)
        .evaluate((element) => element.getBoundingClientRect().width);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const delta = left ? -24 : 24;
    const cdp = await page.context().newCDPSession(page);
    let active = false;
    try {
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ x, y, id: 1 }],
        });
        active = true;
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: x + delta, y, id: 1 }],
        });
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchEnd',
            touchPoints: [],
        });
        active = false;
    } finally {
        try {
            if (active)
                await cdp.send('Input.dispatchTouchEvent', {
                    type: 'touchCancel',
                    touchPoints: [],
                });
        } finally {
            await cdp.detach();
        }
    }
    const after = await page
        .locator(panel)
        .evaluate((element) => element.getBoundingClientRect().width);
    const error = Math.abs(after - before + 24);
    console.log(
        `touch ${side}: hit=${box.width}px delta=${delta}px error=${error}px`,
    );
    expect(error).toBeLessThan(1.5);
    await page.locator(toggle).click();
    await expect(page.locator(panel)).not.toHaveClass(
        left ? /drawer-open/ : /mobile-open/,
    );
    await settlePanel(page, panel);
    await report(page, `touch ${side} REPORT`);
}

async function contrast(page: Page, events: BrowserEvents) {
    const measure = (id: string) =>
        page.locator(`#${id}`).evaluate((handle) => {
            const bar = getComputedStyle(handle, '::before');
            const gutter = getComputedStyle(handle);
            const color = (value: string) => {
                const parts = value.match(/[\d.]+/g)?.map(Number) ?? [];
                if (parts.length < 3)
                    throw new Error(`unexpected color ${value}`);
                return {
                    rgb: parts.slice(0, 3),
                    alpha: parts.length > 3 ? parts[3] : 1,
                };
            };
            const luminance = (rgb: number[]) => {
                const [r, g, b] = rgb.map((channel) => {
                    const value = channel / 255;
                    return value <= 0.04045
                        ? value / 12.92
                        : ((value + 0.055) / 1.055) ** 2.4;
                });
                return 0.2126 * r + 0.7152 * g + 0.0722 * b;
            };
            const ratio = (a: number[], b: number[]) => {
                const values = [luminance(a), luminance(b)].sort(
                    (x, y) => x - y,
                );
                return (values[1] + 0.05) / (values[0] + 0.05);
            };
            const foreground = color(bar.backgroundColor);
            const background = color(gutter.backgroundColor);
            // A transparent gutter exposes its ancestors, not RGB(0, 0, 0).
            // Composite both the backdrop and grip opacity before measuring.
            const layers = [];
            for (
                let node: Element | null = handle;
                node;
                node = node.parentElement
            )
                layers.unshift(color(getComputedStyle(node).backgroundColor));
            const backdrop = layers.reduce(
                (rgb, layer) =>
                    rgb.map(
                        (channel, i) =>
                            layer.rgb[i] * layer.alpha +
                            channel * (1 - layer.alpha),
                    ),
                [255, 255, 255],
            );
            const alpha = foreground.alpha * Number(bar.opacity);
            const painted = foreground.rgb.map(
                (channel, i) => channel * alpha + backdrop[i] * (1 - alpha),
            );
            const left = handle.id === 'left-resize-handle';
            const panel = document.getElementById(
                left ? 'sidebar-panel' : 'diff-panel',
            );
            const terminal = document.querySelector('.terminal-panel');
            if (!panel || !terminal) throw new Error('panel layout is missing');
            const panelBox = panel.getBoundingClientRect();
            const terminalBox = terminal.getBoundingClientRect();
            const border = getComputedStyle(panel);
            const borderWidth = Number.parseFloat(
                left ? border.borderRightWidth : border.borderLeftWidth,
            );
            const lineLeft =
                handle.getBoundingClientRect().left +
                Number.parseFloat(bar.left);
            return {
                foreground,
                background,
                gap: left
                    ? terminalBox.left - panelBox.right
                    : panelBox.left - terminalBox.right,
                borderWidth,
                edgeError: Math.abs(
                    lineLeft -
                        (left ? panelBox.right - borderWidth : panelBox.left),
                ),
                shadow: bar.boxShadow,
                panelShadow: border.boxShadow,
                barOpacity: Number(bar.opacity),
                gutterOpacity: Number(gutter.opacity),
                width: bar.width,
                contrast: ratio(painted, backdrop),
                selfCheck: ratio([0, 0, 0], [255, 255, 255]),
            };
        });
    const check = async (id: string, state: string) => {
        const hovered = state !== 'idle';
        await expect
            .poll(async () => (await measure(id)).barOpacity)
            .toBe(hovered ? 1 : 0);
        const result = await measure(id);
        console.log(`contrast ${state} ${id}: ${JSON.stringify(result)}`);
        expect(result.selfCheck).toBeCloseTo(21, 5);
        expect(result.foreground.alpha).toBe(1);
        expect(result.background.alpha).toBe(0);
        expect(result.barOpacity).toBe(hovered ? 1 : 0);
        expect(result.gutterOpacity).toBe(1);
        expect(result.width).toBe('1px');
        expect(result.borderWidth).toBe(1);
        expect(result.gap).toBe(0);
        expect(result.edgeError).toBe(0);
        expect(result.shadow).toBe('none');
        expect(result.panelShadow).toBe('none');
        // Idle uses only the panel border; hover highlights that same pixel.
        if (hovered) expect(result.contrast).toBeGreaterThanOrEqual(3);
    };
    await page.mouse.move(0, 0);
    for (const id of ['left-resize-handle', 'right-resize-handle'])
        await check(id, 'idle');
    await page.locator('#header-config-pill .pill-label').click();
    const savedTheme = page.waitForResponse(
        (response) =>
            response.url() ===
                `${new URL(page.url()).origin}/api/config/theme` &&
            response.request().method() === 'POST',
        { timeout: 5_000 },
    );
    await page.locator('.settings-swatch[data-color="arc"]').click();
    const themeResponse = await savedTheme;
    expect(themeResponse.status()).toBe(200);
    // Exactly one POST correlates the known baseline abort with this response.
    expect(events.themePosts).toBe(1);
    const config = await page.request.get(
        `${new URL(page.url()).origin}/api/config`,
        { timeout: 5_000 },
    );
    expect(config.status()).toBe(200);
    const savedColor = (await config.json()).theme_color;
    expect(savedColor).toBe('arc');
    console.log(
        `theme readback: status=${config.status()} theme_color=${savedColor}`,
    );
    await expect(page.locator('html')).toHaveAttribute(
        'data-theme-color',
        'arc',
    );
    await page.locator('.settings-overlay .modal-close-btn').click();
    for (const id of ['left-resize-handle', 'right-resize-handle']) {
        await page.locator(`#${id}`).hover();
        await check(id, 'hover arc');
    }
}

test('real PTY follows desktop and touch panel geometry', async ({
    browser,
    request,
}) => {
    test.setTimeout(240_000);
    let phi: PhiServer | undefined;
    try {
        phi = await startGeometryFixture();
        const health = await request.get(`${phi.url}/healthz`);
        expect(health.ok()).toBe(true);
        const healthText = await health.text();
        expect(healthText.trim()).toBe('ok');
        console.log(
            `fixture dir=${phi.dir} url=${phi.url} health=${healthText.trim()}`,
        );

        const desktop = await browser.newContext({
            viewport: { width: 1440, height: 900 },
        });
        try {
            const page = await desktop.newPage();
            const events = observeBrowser(page, phi.url);
            try {
                await captureGeometry(page);
                await page.goto(phi.url);
                await page.evaluate(() => document.fonts.ready);
                if (
                    await page
                        .locator('#diff-panel')
                        .evaluate((el) => el.classList.contains('hidden'))
                )
                    await page.locator('#header-diff-toggle-btn').click();
                await expect(page.locator('#diff-panel')).not.toHaveClass(
                    /hidden/,
                );
                await selectDesktop(page);
                await waitForGrid(page, 'desktop initial');
                await report(page, 'desktop foreground REPORT');
                for (const fraction of [0.05, 0.95]) {
                    await desktopDrag(
                        page,
                        'left-resize-handle',
                        'sidebar-panel',
                        fraction,
                        80,
                    );
                    await desktopDrag(
                        page,
                        'left-resize-handle',
                        'sidebar-panel',
                        fraction,
                        -80,
                    );
                    await desktopDrag(
                        page,
                        'right-resize-handle',
                        'diff-panel',
                        fraction,
                        80,
                    );
                    await desktopDrag(
                        page,
                        'right-resize-handle',
                        'diff-panel',
                        fraction,
                        -80,
                    );
                }
                await expect
                    .poll(() =>
                        page.evaluate(() =>
                            (
                                window as unknown as GeometryWindow
                            ).observedPanels.includes('term-t1'),
                        ),
                    )
                    .toBe(true);
                const beforeBox = await waitForGrid(
                    page,
                    'before content-box resize',
                );
                await page.locator('.tab[data-pane-id="t2"]').click();
                await selectDesktop(page);
                await page.waitForTimeout(500);
                const afterSwitch = await waitForGrid(page, 'warm activation');
                expect(afterSwitch.seq).toBe(beforeBox.seq);
                await page.locator('#term-t1').evaluate((node) => {
                    node.style.setProperty('width', '520px', 'important');
                    node.style.setProperty('height', '360px', 'important');
                });
                const resized = await waitForGrid(
                    page,
                    'content-box resize',
                    beforeBox.seq,
                    'WINCH',
                    beforeBox.cols,
                );
                // Restore normal layout before testing activation independently.
                await page.locator('#term-t1').evaluate((node) => {
                    node.style.removeProperty('width');
                    node.style.removeProperty('height');
                });
                await waitForGrid(
                    page,
                    'restored layout',
                    resized.seq,
                    'WINCH',
                    resized.cols,
                );
                await page.locator('.tab[data-pane-id="t2"]').click();
                await expect(
                    page.locator('#tabs-container .tab.active'),
                ).toHaveAttribute('data-pane-id', 't2');
                await selectDesktop(page);
                await waitForGrid(page, 'foreground activation');
                await report(page, 'foreground activation REPORT');
                const selectedSockets = events.sockets.filter(
                    (path) => path === '/ws/pane/t1',
                ).length;
                const backgroundSockets = events.sockets.filter(
                    (path) => path === '/ws/pane/t2',
                ).length;
                const beforeRefresh = await waitForGrid(page, 'before refresh');
                await page.locator('#refresh-console-btn').click();
                await expect
                    .poll(
                        () =>
                            events.sockets.filter(
                                (path) => path === '/ws/pane/t1',
                            ).length,
                    )
                    .toBe(selectedSockets + 1);
                expect(
                    events.sockets.filter((path) => path === '/ws/pane/t2')
                        .length,
                ).toBe(backgroundSockets);
                await waitForGrid(
                    page,
                    'foreground refresh',
                    beforeRefresh.seq,
                    'WINCH',
                );
                await contrast(page, events);
                assertBrowserEvents(events, true);
            } finally {
                console.log(
                    `desktop browser events: ${JSON.stringify(events)}`,
                );
            }
        } finally {
            await desktop.close();
        }

        const mobile = await browser.newContext({
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
        });
        try {
            const page = await mobile.newPage();
            const events = observeBrowser(page, phi.url);
            try {
                await captureGeometry(page);
                await page.goto(phi.url);
                await page.evaluate(() => document.fonts.ready);
                expect(
                    await page.evaluate(
                        () => matchMedia('(pointer: coarse)').matches,
                    ),
                ).toBe(true);
                await selectMobile(page);
                await waitForGrid(page, 'mobile initial');
                await report(page, 'mobile foreground REPORT');
                await touchDrag(page, 'left');
                await touchDrag(page, 'right');
                assertBrowserEvents(events);
            } finally {
                console.log(`mobile browser events: ${JSON.stringify(events)}`);
            }
        } finally {
            await mobile.close();
        }
    } finally {
        if (phi) {
            try {
                if (process.env.TMPDIR)
                    copyFileSync(
                        phi.logPath,
                        join(process.env.TMPDIR, 'geometry-fixture.log'),
                    );
            } finally {
                await phi.stop();
            }
        }
    }
});

test('composer keyboard baseline', async ({ browser, request }) => {
    test.setTimeout(120_000);
    let phi: PhiServer | undefined;
    const samples: Record<string, unknown> = {};
    try {
        phi = await startGeometryFixture();
        const health = await request.get(`${phi.url}/healthz`);
        expect(health.ok()).toBe(true);
        const mobile = await browser.newContext({
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
        });
        try {
            const page = await mobile.newPage();
            await installVisualViewport(page);
            await captureGeometry(page);
            const wire = watchPaneWire(page);
            await page.goto(phi.url);
            await page.evaluate(() => document.fonts.ready);
            expect(
                await page.evaluate(
                    () => matchMedia('(pointer: coarse)').matches,
                ),
            ).toBe(true);
            await selectMobile(page);
            await waitForGrid(page, 'keyboard baseline initial');
            const bar = page.locator('#input-bar-container');
            if (!(await bar.isVisible())) {
                await page.locator('#direct-mode-toggle').click();
                await expect(bar).toBeVisible();
            }
            await expect(page.locator('#input-textarea')).toBeVisible();
            await settleComposer(page);
            const before = await composerState(page);
            expect(before).not.toBeNull();
            expect(
                await page.evaluate(() =>
                    (
                        window as unknown as {
                            __visualViewportListenerCount: () => number;
                        }
                    ).__visualViewportListenerCount(),
                ),
            ).toBeGreaterThan(0);
            const resizeBase = wire.resize.length;
            const inputBase = wire.input.length;

            await page.locator('#input-textarea').focus();
            await page.evaluate(() =>
                (
                    window as unknown as {
                        __setVisualViewportHeight: (height: number) => void;
                    }
                ).__setVisualViewportHeight(500),
            );
            await expect
                .poll(
                    () =>
                        page.evaluate(() =>
                            document.documentElement.style.getPropertyValue(
                                '--vv-height',
                            ),
                        ),
                    { timeout: 5_000 },
                )
                .toBe('500px');
            await settleComposer(page);
            const opened = await composerState(page);

            await page.evaluate(() =>
                (
                    window as unknown as {
                        __setVisualViewportHeight: (height: number) => void;
                    }
                ).__setVisualViewportHeight(844),
            );
            await expect
                .poll(
                    () =>
                        page.evaluate(() =>
                            document.documentElement.style.getPropertyValue(
                                '--vv-height',
                            ),
                        ),
                    { timeout: 5_000 },
                )
                .toBe('844px');
            await settleComposer(page);
            const closed = await composerState(page);

            samples.wire = {
                resizes: wire.resize.slice(resizeBase),
                inputs: wire.input.slice(inputBase),
            };
            samples.before = before;
            samples.opened = opened;
            samples.closed = closed;
            console.log(
                `composer keyboard baseline: ${JSON.stringify(samples)}`,
            );

            // Opening or closing the soft keyboard must not fit the grid,
            // resize the backend, or move the viewport. The composer moves
            // with the visible viewport; the terminal rows stay frozen.
            for (const [label, state] of [
                ['open', opened],
                ['close', closed],
            ] as const) {
                expect(state, `${label}: composer state`).not.toBeNull();
                expect(state?.fits, `${label}: fits`).toBe(before?.fits);
                expect(state?.gridEvents, `${label}: grid events`).toBe(
                    before?.gridEvents,
                );
                expect(state?.viewportY, `${label}: viewport`).toBe(
                    before?.viewportY,
                );
                expect(state?.scrollY, `${label}: scroll`).toBe(0);
                expect(state?.textareaHeight, `${label}: composer height`).toBe(
                    before?.textareaHeight,
                );
            }
            expect(opened?.composerTop).toBeLessThan(before?.composerTop ?? 0);
            expect(closed?.composerTop).toBe(before?.composerTop);
            expect(samples.wire).toEqual({ resizes: [], inputs: [] });
        } finally {
            await mobile.close();
        }
    } finally {
        await test.info().attach('composer-keyboard-baseline', {
            body: JSON.stringify(samples, null, 2),
            contentType: 'application/json',
        });
        if (phi) await phi.stop();
    }
});

test('composer MVP', async ({ browser, request }) => {
    test.setTimeout(120_000);
    let phi: PhiServer | undefined;
    const samples: Record<string, unknown> = {};
    try {
        phi = await startGeometryFixture();
        const health = await request.get(`${phi.url}/healthz`);
        expect(health.ok()).toBe(true);
        const desktop = await browser.newContext({
            viewport: { width: 1440, height: 900 },
        });
        try {
            const page = await desktop.newPage();
            await captureGeometry(page);
            const wire = watchPaneWire(page);
            await page.goto(phi.url);
            await page.evaluate(() => document.fonts.ready);
            await selectDesktop(page);
            await waitForGrid(page, 'composer initial');
            const bar = page.locator('#input-bar-container');
            if (!(await bar.isVisible())) {
                await page.locator('#direct-mode-toggle').click();
                await expect(bar).toBeVisible();
            }
            await expect(page.locator('#input-textarea')).toBeVisible();
            await settleComposer(page);
            const baseline = await composerState(page);
            expect(baseline).not.toBeNull();
            samples.baseline = baseline;
            const resizeBase = wire.resize.length;
            const inputBase = wire.input.length;

            const checkStable = async (label: string) => {
                await settleComposer(page);
                const state = await composerState(page);
                expect(state, `${label}: state`).not.toBeNull();
                samples[label] = state;
                expect(state?.textareaHeight, `${label}: composer height`).toBe(
                    baseline?.textareaHeight,
                );
                expect(state?.panelHeight, `${label}: panel height`).toBe(
                    baseline?.panelHeight,
                );
                expect(state?.cols, `${label}: cols`).toBe(baseline?.cols);
                expect(state?.rows, `${label}: rows`).toBe(baseline?.rows);
                expect(state?.fits, `${label}: fits`).toBe(baseline?.fits);
                expect(state?.refreshes, `${label}: refreshes`).toBe(
                    baseline?.refreshes,
                );
                expect(state?.gridEvents, `${label}: grid events`).toBe(
                    baseline?.gridEvents,
                );
                expect(state?.panelResizes, `${label}: panel resizes`).toBe(
                    baseline?.panelResizes,
                );
                expect(state?.viewportY, `${label}: viewport`).toBe(
                    baseline?.viewportY,
                );
                expect(state?.scrollY, `${label}: page scroll`).toBe(0);
                expect(wire.resize.slice(resizeBase), `${label}: wire`).toEqual(
                    [],
                );
                return state;
            };

            await page.locator('#input-textarea').click();
            await page.keyboard.type('  hi  ');
            const typed = await checkStable('typed short');
            expect(typed?.value).toBe('  hi  ');

            await page.locator('#send-input-btn').click();
            const sentShort = await checkStable('sent short');
            expect(sentShort?.value).toBe('');
            expect(wire.input.slice(inputBase)).toEqual(['hi\r']);

            await page.locator('#input-textarea').fill('  alpha\nbeta  ');
            const typedMulti = await checkStable('typed multiline');
            expect(typedMulti?.value).toBe('  alpha\nbeta  ');

            await page.locator('#send-input-btn').click();
            const sentMulti = await checkStable('sent multiline');
            expect(sentMulti?.value).toBe('');
            expect(wire.input.slice(inputBase)).toEqual([
                'hi\r',
                '\x1b[200~alpha\nbeta\x1b[201~\r',
            ]);

            await page.locator('#input-textarea').fill('again');
            await checkStable('retyped');
            await page.locator('#input-textarea').fill('');
            await checkStable('cleared');

            const reported = await report(page, 'composer REPORT');
            expect(reported.edge).toBe('EDGE');
            samples.report = reported;
            console.log(`composer MVP: ${JSON.stringify(samples)}`);
        } finally {
            await desktop.close();
        }
    } finally {
        await test.info().attach('composer-mvp', {
            body: JSON.stringify(samples, null, 2),
            contentType: 'application/json',
        });
        if (phi) await phi.stop();
    }
});

async function dragComposer(page: Page, deltaY: number) {
    const handle = page.locator('#terminal-input-resize-handle');
    const box = await handle.boundingBox();
    if (!box) throw new Error('composer resize handle is not visible');
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + deltaY, { steps: 8 });
    await page.mouse.up();
}

async function touchDragComposer(page: Page, deltaY: number) {
    const box = await page
        .locator('#terminal-input-resize-handle')
        .boundingBox();
    if (!box) throw new Error('composer resize handle is not visible');
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const cdp = await page.context().newCDPSession(page);
    let active = false;
    try {
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ x, y, id: 1 }],
        });
        active = true;
        for (let step = 1; step <= 8; step++) {
            await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchMove',
                touchPoints: [{ x, y: y + (deltaY * step) / 8, id: 1 }],
            });
        }
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchEnd',
            touchPoints: [],
        });
        active = false;
    } finally {
        try {
            if (active)
                await cdp.send('Input.dispatchTouchEvent', {
                    type: 'touchCancel',
                    touchPoints: [],
                });
        } finally {
            await cdp.detach();
        }
    }
}

test('composer drag desktop', async ({ browser, request }) => {
    test.setTimeout(120_000);
    let phi: PhiServer | undefined;
    const samples: Record<string, unknown> = {};
    try {
        phi = await startGeometryFixture();
        expect((await request.get(`${phi.url}/healthz`)).ok()).toBe(true);
        const desktop = await browser.newContext({
            viewport: { width: 1440, height: 900 },
        });
        try {
            const page = await desktop.newPage();
            await captureGeometry(page);
            const wire = watchPaneWire(page);
            await page.goto(phi.url);
            await page.evaluate(() => document.fonts.ready);
            await selectDesktop(page);
            await waitForGrid(page, 'drag initial');
            const bar = page.locator('#input-bar-container');
            if (!(await bar.isVisible()))
                await page.locator('#direct-mode-toggle').click();
            await settleComposer(page);
            const baseline = await composerState(page);
            expect(baseline).not.toBeNull();
            samples.baseline = baseline;

            const handle = page.locator('#terminal-input-resize-handle');
            await expect(handle).toBeVisible();
            await expect(handle).toHaveAttribute('role', 'separator');
            await expect(handle).toHaveAttribute(
                'aria-orientation',
                'horizontal',
            );
            await expect(handle).toHaveAttribute('tabindex', '0');
            await handle.focus();
            expect(
                Number(await handle.getAttribute('aria-valuenow')),
            ).toBeGreaterThan(0);
            expect(
                Number(await handle.getAttribute('aria-valuemin')),
            ).toBeGreaterThan(0);
            expect(Number(await handle.getAttribute('aria-valuemax'))).toBe(
                160,
            );

            const growBase = await grid(page);
            const growResizeBase = wire.resize.length;
            await dragComposer(page, -40);
            await waitForGrid(page, 'drag grow', growBase?.seq ?? 0, 'WINCH');
            await settleComposer(page);
            const grown = await composerState(page);
            samples.grown = grown;
            expect(grown).not.toBeNull();
            expect(grown?.textareaHeight).toBeGreaterThan(
                baseline?.textareaHeight ?? 0,
            );
            expect(grown?.panelHeight).toBeLessThan(baseline?.panelHeight ?? 0);
            expect(grown?.rows).toBeLessThan(baseline?.rows ?? 0);
            expect(wire.resize.at(-1)).toEqual({
                cols: grown?.cols,
                rows: grown?.rows,
            });
            expect(wire.resize.length).toBeGreaterThan(growResizeBase);

            const quiet = grown;
            await page.locator('#input-textarea').fill('clear me');
            await settleComposer(page);
            await page.locator('#input-textarea').fill('');
            await settleComposer(page);
            const cleared = await composerState(page);
            samples.cleared = cleared;
            expect(cleared?.textareaHeight).toBe(quiet?.textareaHeight);
            expect(cleared?.panelHeight).toBe(quiet?.panelHeight);
            expect(cleared?.rows).toBe(quiet?.rows);
            const quietFits = quiet?.fits ?? 0;
            const quietRefreshes = quiet?.refreshes ?? 0;
            const quietGrid = quiet?.gridEvents ?? 0;
            const quietResize = wire.resize.length;
            const quietInput = wire.input.length;
            await page.locator('#input-textarea').fill('  alpha\nbeta  ');
            await settleComposer(page);
            const typed = await composerState(page);
            samples.typed = typed;
            expect(typed?.textareaHeight).toBe(quiet?.textareaHeight);
            expect(typed?.panelHeight).toBe(quiet?.panelHeight);
            expect(typed?.cols).toBe(quiet?.cols);
            expect(typed?.rows).toBe(quiet?.rows);
            expect(typed?.fits).toBe(quietFits);
            expect(typed?.refreshes).toBe(quietRefreshes);
            expect(typed?.gridEvents).toBe(quietGrid);
            expect(wire.resize.length).toBe(quietResize);
            await page.locator('#send-input-btn').click();
            await settleComposer(page);
            const sent = await composerState(page);
            samples.sent = sent;
            expect(sent?.value).toBe('');
            expect(sent?.textareaHeight).toBe(quiet?.textareaHeight);
            expect(sent?.panelHeight).toBe(quiet?.panelHeight);
            expect(sent?.rows).toBe(quiet?.rows);
            expect(wire.input.slice(quietInput)).toEqual([
                '\x1b[200~alpha\nbeta\x1b[201~\r',
            ]);

            const shrinkBase = await grid(page);
            await dragComposer(page, 40);
            await waitForGrid(
                page,
                'drag shrink',
                shrinkBase?.seq ?? 0,
                'WINCH',
            );
            await settleComposer(page);
            const shrunk = await composerState(page);
            samples.shrunk = shrunk;
            expect(shrunk?.textareaHeight).toBe(baseline?.textareaHeight);
            expect(shrunk?.panelHeight).toBe(baseline?.panelHeight);
            expect(shrunk?.rows).toBe(baseline?.rows);

            await handle.focus();
            await page.keyboard.press('End');
            await settleComposer(page);
            const atEnd = await composerState(page);
            samples.atEnd = atEnd;
            expect(atEnd?.textareaHeight).toBeGreaterThan(
                baseline?.textareaHeight ?? 0,
            );
            expect(atEnd?.textareaHeight).toBeLessThanOrEqual(
                parseFloat(atEnd?.cssMax ?? '0'),
            );
            const inputsBeforeKeys = wire.input.length;

            await page.keyboard.press('Home');
            await settleComposer(page);
            const atHome = await composerState(page);
            samples.atHome = atHome;
            expect(atHome?.textareaHeight).toBe(
                Math.ceil(parseFloat(atHome?.cssMin ?? '0')),
            );
            await page.keyboard.press('ArrowUp');
            await settleComposer(page);
            const afterUp = await composerState(page);
            samples.afterUp = afterUp;
            expect(afterUp?.textareaHeight).toBeCloseTo(
                (atHome?.textareaHeight ?? 0) + 24,
                0,
            );
            expect(wire.input.length).toBe(inputsBeforeKeys);

            await page
                .locator('#input-textarea')
                .fill(
                    Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join(
                        '\n',
                    ),
                );
            await settleComposer(page);
            const longDraft = await composerState(page);
            samples.longDraft = longDraft;
            expect(longDraft?.scrollHeight).toBeGreaterThan(
                longDraft?.clientHeight ?? 0,
            );
            await page.evaluate(() => {
                const textarea = document.getElementById(
                    'input-textarea',
                ) as HTMLTextAreaElement;
                textarea.scrollTop = textarea.scrollHeight;
            });
            expect(
                await page.evaluate(
                    () =>
                        (
                            document.getElementById(
                                'input-textarea',
                            ) as HTMLTextAreaElement
                        ).scrollTop,
                ),
            ).toBeGreaterThan(0);
            await page.locator('#input-textarea').fill('');
            await settleComposer(page);

            await page.locator('#direct-mode-toggle').click();
            await expect(handle).toBeHidden();
            await page.locator('#direct-mode-toggle').click();
            await expect(handle).toBeVisible();
            await settleComposer(page);
            const unfolded = await composerState(page);
            samples.unfolded = unfolded;
            expect(unfolded?.textareaHeight).toBe(afterUp?.textareaHeight);
            console.log(`composer drag desktop: ${JSON.stringify(samples)}`);
        } finally {
            await desktop.close();
        }
    } finally {
        await test.info().attach('composer-drag-desktop', {
            body: JSON.stringify(samples, null, 2),
            contentType: 'application/json',
        });
        if (phi) await phi.stop();
    }
});

test('composer drag compact', async ({ browser, request }) => {
    test.setTimeout(120_000);
    let phi: PhiServer | undefined;
    const samples: Record<string, unknown> = {};
    try {
        phi = await startGeometryFixture();
        expect((await request.get(`${phi.url}/healthz`)).ok()).toBe(true);
        const mobile = await browser.newContext({
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
        });
        try {
            const page = await mobile.newPage();
            await installVisualViewport(page);
            await captureGeometry(page);
            const wire = watchPaneWire(page);
            await page.goto(phi.url);
            await page.evaluate(() => document.fonts.ready);
            expect(
                await page.evaluate(
                    () => matchMedia('(pointer: coarse)').matches,
                ),
            ).toBe(true);
            await selectMobile(page);
            await waitForGrid(page, 'drag compact initial');
            const bar = page.locator('#input-bar-container');
            if (!(await bar.isVisible()))
                await page.locator('#direct-mode-toggle').click();
            await settleComposer(page);
            const baseline = await composerState(page);
            expect(baseline).not.toBeNull();
            samples.baseline = baseline;
            const handle = page.locator('#terminal-input-resize-handle');
            await expect(handle).toBeVisible();
            await handle.focus();
            expect(Number(await handle.getAttribute('aria-valuemax'))).toBe(80);

            const growBase = await grid(page);
            await touchDragComposer(page, -30);
            await waitForGrid(page, 'drag compact grow', growBase?.seq ?? 0);
            await settleComposer(page);
            const grown = await composerState(page);
            samples.grown = grown;
            expect(grown?.textareaHeight).toBe(66);
            expect(grown?.rows).toBeLessThan(baseline?.rows ?? 0);

            const clampBase = await grid(page);
            await touchDragComposer(page, -40);
            await waitForGrid(page, 'drag compact clamp', clampBase?.seq ?? 0);
            await settleComposer(page);
            const clamped = await composerState(page);
            samples.clamped = clamped;
            expect(clamped?.textareaHeight).toBe(80);

            const keyboardBefore = clamped;
            const fitsBefore = keyboardBefore?.fits ?? 0;
            const rowsBefore = keyboardBefore?.rows ?? 0;
            const viewportBefore = keyboardBefore?.viewportY ?? 0;
            const resizeBefore = wire.resize.length;
            await page.locator('#input-textarea').focus();
            await page.evaluate(() =>
                (
                    window as unknown as {
                        __setVisualViewportHeight: (height: number) => void;
                    }
                ).__setVisualViewportHeight(500),
            );
            await expect
                .poll(
                    () =>
                        page.evaluate(() =>
                            document.documentElement.style.getPropertyValue(
                                '--vv-height',
                            ),
                        ),
                    { timeout: 5_000 },
                )
                .toBe('500px');
            await settleComposer(page);
            const open = await composerState(page);
            samples.keyboardOpen = open;
            expect(open?.textareaHeight).toBe(80);
            expect(open?.fits).toBe(fitsBefore);
            expect(open?.rows).toBe(rowsBefore);
            expect(open?.viewportY).toBe(viewportBefore);
            expect(wire.resize.length).toBe(resizeBefore);
            await page.evaluate(() =>
                (
                    window as unknown as {
                        __setVisualViewportHeight: (height: number) => void;
                    }
                ).__setVisualViewportHeight(844),
            );
            await expect
                .poll(
                    () =>
                        page.evaluate(() =>
                            document.documentElement.style.getPropertyValue(
                                '--vv-height',
                            ),
                        ),
                    { timeout: 5_000 },
                )
                .toBe('844px');
            await settleComposer(page);
            const closed = await composerState(page);
            samples.keyboardClosed = closed;
            expect(closed?.textareaHeight).toBe(80);
            expect(closed?.fits).toBe(fitsBefore);
            expect(closed?.rows).toBe(rowsBefore);
            expect(closed?.viewportY).toBe(viewportBefore);
            expect(wire.resize.length).toBe(resizeBefore);

            const shrinkBase = await grid(page);
            await touchDragComposer(page, 100);
            await waitForGrid(
                page,
                'drag compact shrink',
                shrinkBase?.seq ?? 0,
            );
            await settleComposer(page);
            const shrunk = await composerState(page);
            samples.shrunk = shrunk;
            expect(shrunk?.textareaHeight).toBe(36);
            console.log(`composer drag compact: ${JSON.stringify(samples)}`);
        } finally {
            await mobile.close();
        }
    } finally {
        await test.info().attach('composer-drag-compact', {
            body: JSON.stringify(samples, null, 2),
            contentType: 'application/json',
        });
        if (phi) await phi.stop();
    }
});

async function waitForBufferMarker(page: Page, marker: string) {
    await expect
        .poll(
            () =>
                page.evaluate((needle) => {
                    const win = window as unknown as GeometryWindow;
                    const term = win.geometryTerms.find((candidate) =>
                        candidate.element?.closest('#term-t1'),
                    );
                    if (!term) return false;
                    const buffer = term.buffer.active;
                    for (let i = 0; i < buffer.length; i++) {
                        if (
                            buffer
                                .getLine(i)
                                ?.translateToString(true)
                                .includes(needle)
                        )
                            return true;
                    }
                    return false;
                }, marker),
            { timeout: 30_000, message: `buffer marker ${marker}` },
        )
        .toBe(true);
}

async function scrollToHistory(page: Page) {
    await page.locator('#term-t1 .xterm-screen').hover();
    await page.mouse.wheel(0, -800);
    await expect
        .poll(
            () =>
                page.evaluate(() => {
                    const win = window as unknown as GeometryWindow;
                    const term = win.geometryTerms.find((candidate) =>
                        candidate.element?.closest('#term-t1'),
                    );
                    if (!term) return false;
                    const buffer = term.buffer.active;
                    return (
                        buffer.viewportY > 0 && buffer.viewportY < buffer.baseY
                    );
                }),
            {
                timeout: 10_000,
                message: 'terminal reader is off the live tail',
            },
        )
        .toBe(true);
}

async function anchoredNumberedRow(page: Page) {
    return page.evaluate(() => {
        const win = window as unknown as GeometryWindow;
        const term = win.geometryTerms.find((candidate) =>
            candidate.element?.closest('#term-t1'),
        );
        if (!term) return null;
        const buffer = term.buffer.active;
        for (let offset = 0; offset < term.rows; offset++) {
            const text =
                buffer
                    .getLine(buffer.viewportY + offset)
                    ?.translateToString(true) ?? '';
            if (/^ROW \d{3} /.test(text)) {
                return {
                    text,
                    offset,
                    viewportY: buffer.viewportY,
                    baseY: buffer.baseY,
                };
            }
        }
        return null;
    });
}

async function rowAtOffset(page: Page, offset: number) {
    return page.evaluate((rowOffset) => {
        const win = window as unknown as GeometryWindow;
        const term = win.geometryTerms.find((candidate) =>
            candidate.element?.closest('#term-t1'),
        );
        if (!term) return null;
        const buffer = term.buffer.active;
        return {
            text:
                buffer
                    .getLine(buffer.viewportY + rowOffset)
                    ?.translateToString(true) ?? '',
            viewportY: buffer.viewportY,
            baseY: buffer.baseY,
        };
    }, offset);
}

async function expectRetainedRow(
    page: Page,
    anchor: { text: string; offset: number },
) {
    await expect
        .poll(() => rowAtOffset(page, anchor.offset), {
            timeout: 10_000,
            message: 'retained reader row',
        })
        .toMatchObject({ text: anchor.text });
    const row = await rowAtOffset(page, anchor.offset);
    expect(row?.viewportY).toBeLessThan(row?.baseY ?? 0);
}

test('composer drag scroll', async ({ browser, request }) => {
    test.setTimeout(120_000);
    let phi: PhiServer | undefined;
    const samples: Record<string, unknown> = {};
    try {
        phi = await startGeometryFixture();
        expect((await request.get(`${phi.url}/healthz`)).ok()).toBe(true);
        const desktop = await browser.newContext({
            viewport: { width: 1440, height: 900 },
        });
        try {
            const page = await desktop.newPage();
            await captureGeometry(page);
            await page.goto(phi.url);
            await page.evaluate(() => document.fonts.ready);
            await selectDesktop(page);
            await waitForGrid(page, 'scroll initial');
            const bar = page.locator('#input-bar-container');
            if (!(await bar.isVisible()))
                await page.locator('#direct-mode-toggle').click();
            await settleComposer(page);

            await page.locator('#term-t1 .xterm-screen').click({
                position: { x: 12, y: 12 },
            });
            await page.keyboard.type('SCROLL');
            await page.keyboard.press('Enter');
            await waitForBufferMarker(page, 'SCROLLDONE');
            await scrollToHistory(page);
            const anchor = await anchoredNumberedRow(page);
            samples.anchor = anchor;
            expect(anchor).not.toBeNull();
            expect(anchor?.viewportY).toBeGreaterThan(0);
            expect(anchor?.viewportY).toBeLessThan(anchor?.baseY ?? 0);

            const growBase = await grid(page);
            await dragComposer(page, -30);
            await waitForGrid(page, 'scroll drag grow', growBase?.seq ?? 0);
            await settleComposer(page);
            await expectRetainedRow(page, anchor!);
            samples.afterDrag = await rowAtOffset(page, anchor!.offset);

            const handle = page.locator('#terminal-input-resize-handle');
            await handle.focus();
            const keyBase = await grid(page);
            await page.keyboard.press('Home');
            await waitForGrid(page, 'scroll key home', keyBase?.seq ?? 0);
            await settleComposer(page);
            await expectRetainedRow(page, anchor!);
            samples.afterKey = await rowAtOffset(page, anchor!.offset);

            await page.locator('#term-t1 .scroll-to-bottom-btn').click();
            await expect
                .poll(
                    () =>
                        page.evaluate(() => {
                            const win = window as unknown as GeometryWindow;
                            const term = win.geometryTerms.find((candidate) =>
                                candidate.element?.closest('#term-t1'),
                            );
                            if (!term) return false;
                            const buffer = term.buffer.active;
                            return buffer.viewportY === buffer.baseY;
                        }),
                    {
                        timeout: 10_000,
                        message: 'terminal returned to live tail',
                    },
                )
                .toBe(true);
            const followBase = await grid(page);
            await dragComposer(page, -24);
            await waitForGrid(page, 'scroll follow grow', followBase?.seq ?? 0);
            await settleComposer(page);
            const followed = await page.evaluate(() => {
                const win = window as unknown as GeometryWindow;
                const term = win.geometryTerms.find((candidate) =>
                    candidate.element?.closest('#term-t1'),
                );
                if (!term) return null;
                const buffer = term.buffer.active;
                return {
                    viewportY: buffer.viewportY,
                    baseY: buffer.baseY,
                    atBottom: buffer.viewportY === buffer.baseY,
                };
            });
            samples.followed = followed;
            expect(followed?.atBottom).toBe(true);

            const reported = await report(page, 'scroll REPORT');
            expect(reported.edge).toBe('EDGE');
            samples.report = reported;
            console.log(`composer drag scroll: ${JSON.stringify(samples)}`);
        } finally {
            await desktop.close();
        }
    } finally {
        await test.info().attach('composer-drag-scroll', {
            body: JSON.stringify(samples, null, 2),
            contentType: 'application/json',
        });
        if (phi) await phi.stop();
    }
});

test('composer persistence', async ({ browser, request }) => {
    test.setTimeout(120_000);
    let phi: PhiServer | undefined;
    const key = 'phi_terminal_input_height';
    const samples: Record<string, unknown> = {};
    try {
        phi = await startGeometryFixture();
        expect((await request.get(`${phi.url}/healthz`)).ok()).toBe(true);
        const desktop = await browser.newContext({
            viewport: { width: 1440, height: 900 },
        });
        try {
            const page = await desktop.newPage();
            await captureGeometry(page);
            const wire = watchPaneWire(page);
            await page.goto(phi.url);
            await page.evaluate(() => document.fonts.ready);
            await selectDesktop(page);
            await waitForGrid(page, 'persistence initial');
            const bar = page.locator('#input-bar-container');
            if (!(await bar.isVisible()))
                await page.locator('#direct-mode-toggle').click();
            await settleComposer(page);

            await dragComposer(page, -60);
            await settleComposer(page);
            const chosen = await composerState(page);
            samples.chosen = chosen;
            expect(chosen?.textareaHeight).toBe(100);
            expect(
                await page.evaluate(
                    (storageKey) => localStorage.getItem(storageKey),
                    key,
                ),
            ).toBe('100');

            await page.reload();
            await page.evaluate(() => document.fonts.ready);
            await selectDesktop(page);
            await waitForGrid(page, 'persistence reload');
            if (!(await bar.isVisible()))
                await page.locator('#direct-mode-toggle').click();
            await settleComposer(page);
            const reloaded = await composerState(page);
            samples.reloaded = reloaded;
            expect(reloaded?.textareaHeight).toBe(100);
            expect(
                await page.evaluate(
                    (storageKey) => localStorage.getItem(storageKey),
                    key,
                ),
            ).toBe('100');

            await page.locator('.tab[data-pane-id="t2"]').click();
            await expect(
                page.locator('#tabs-container .tab.active'),
            ).toHaveAttribute('data-pane-id', 't2');
            await settleComposer(page);
            await page.locator('.tab[data-pane-id="t1"]').click();
            await expect(
                page.locator('#tabs-container .tab.active'),
            ).toHaveAttribute('data-pane-id', 't1');
            await settleComposer(page);
            const afterTabs = await composerState(page);
            samples.afterTabs = afterTabs;
            expect(afterTabs?.textareaHeight).toBe(100);

            const handle = page.locator('#terminal-input-resize-handle');
            await page.locator('#direct-mode-toggle').click();
            await expect(handle).toBeHidden();
            await page.locator('#direct-mode-toggle').click();
            await expect(handle).toBeVisible();
            await settleComposer(page);
            const afterFold = await composerState(page);
            samples.afterFold = afterFold;
            expect(afterFold?.textareaHeight).toBe(100);

            const desktopBase = await grid(page);
            await page.setViewportSize({ width: 390, height: 844 });
            await waitForGrid(
                page,
                'persistence compact',
                desktopBase?.seq ?? 0,
                'WINCH',
                desktopBase?.cols,
            );
            await settleComposer(page);
            const compact = await composerState(page);
            samples.compact = compact;
            expect(compact?.textareaHeight).toBe(80);
            expect(compact?.cssMax).toBe('80px');
            expect(
                await page.evaluate(
                    (storageKey) => localStorage.getItem(storageKey),
                    key,
                ),
            ).toBe('100');

            const compactBase = await grid(page);
            await page.setViewportSize({ width: 1440, height: 900 });
            await waitForGrid(
                page,
                'persistence desktop',
                compactBase?.seq ?? 0,
                'WINCH',
                compactBase?.cols,
            );
            await settleComposer(page);
            const back = await composerState(page);
            samples.back = back;
            expect(back?.textareaHeight).toBe(100);

            const quiet = back;
            const quietFits = quiet?.fits ?? 0;
            const quietRefreshes = quiet?.refreshes ?? 0;
            const quietGrid = quiet?.gridEvents ?? 0;
            const quietResize = wire.resize.length;
            const quietInput = wire.input.length;
            await page.locator('#input-textarea').fill('  alpha\nbeta  ');
            await settleComposer(page);
            const typed = await composerState(page);
            samples.typed = typed;
            expect(typed?.textareaHeight).toBe(100);
            expect(typed?.panelHeight).toBe(quiet?.panelHeight);
            expect(typed?.rows).toBe(quiet?.rows);
            expect(typed?.fits).toBe(quietFits);
            expect(typed?.refreshes).toBe(quietRefreshes);
            expect(typed?.gridEvents).toBe(quietGrid);
            expect(wire.resize.length).toBe(quietResize);
            await page.locator('#send-input-btn').click();
            await settleComposer(page);
            const sent = await composerState(page);
            samples.sent = sent;
            expect(sent?.textareaHeight).toBe(100);
            expect(sent?.value).toBe('');
            expect(wire.input.slice(quietInput)).toEqual([
                '\x1b[200~alpha\nbeta\x1b[201~\r',
            ]);

            await page.evaluate(
                (storageKey) => localStorage.setItem(storageKey, '80px'),
                key,
            );
            await page.reload();
            await page.evaluate(() => document.fonts.ready);
            await selectDesktop(page);
            await waitForGrid(page, 'persistence invalid');
            if (!(await bar.isVisible()))
                await page.locator('#direct-mode-toggle').click();
            await settleComposer(page);
            const invalid = await composerState(page);
            samples.invalid = invalid;
            expect(invalid?.textareaHeight).toBe(40);
            console.log(`composer persistence: ${JSON.stringify(samples)}`);
        } finally {
            await desktop.close();
        }
    } finally {
        await test.info().attach('composer-persistence', {
            body: JSON.stringify(samples, null, 2),
            contentType: 'application/json',
        });
        if (phi) await phi.stop();
    }
});

function serverOutput(frames: Buffer[]) {
    const chunks: string[] = [];
    for (const frame of frames) {
        try {
            const decoded = ServerCodec.decode(new Uint8Array(frame));
            if (decoded.payload?.$case === 'output') {
                chunks.push(
                    Buffer.from(decoded.payload.value.data).toString('utf8'),
                );
            }
        } catch {
            /* non-terminal frame */
        }
    }
    return chunks.join('');
}

function latestReportSeq(text: string) {
    let latest = 0;
    for (const match of text.matchAll(/DRAW (\d+) REPORT /g))
        latest = Math.max(latest, Number(match[1]));
    return latest;
}

test('composer recovery', async ({ browser, request }) => {
    test.setTimeout(120_000);
    let phi: PhiServer | undefined;
    const samples: Record<string, unknown> = {};
    try {
        phi = await startGeometryFixture({ auto_reconnect: 'off' });
        const baseUrl = phi.url;
        expect((await request.get(`${baseUrl}/healthz`)).ok()).toBe(true);
        const context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
        });
        const latch: { release: (() => void) | null } = { release: null };
        const routes: {
            page: WebSocketRoute | null;
            server: WebSocketRoute | null;
        } = { page: null, server: null };
        let latchTimer: ReturnType<typeof setTimeout> | null = null;
        let latchTimedOut = false;
        let replayCaptured = false;
        let replayFulfilled = false;
        let replayBodyLength = 0;
        let socketCount = 0;
        const clientFrames: Buffer[] = [];
        const serverFrames: Buffer[] = [];
        try {
            const page = await context.newPage();
            const historyRequests: string[] = [];
            page.on('request', (req) => {
                if (req.url().includes('/api/prompt-history/append'))
                    historyRequests.push(req.url());
            });
            await page.routeWebSocket(
                (url) => url.pathname === '/ws/pane/t1',
                (route) => {
                    socketCount++;
                    routes.page = route;
                    const server = route.connectToServer();
                    routes.server = server;
                    if (socketCount > 1) {
                        clientFrames.length = 0;
                        serverFrames.length = 0;
                    }
                    route.onMessage((message) => {
                        if (typeof message !== 'string')
                            clientFrames.push(Buffer.from(message));
                        server.send(message);
                    });
                    server.onMessage((message) => {
                        if (typeof message !== 'string')
                            serverFrames.push(Buffer.from(message));
                        route.send(message);
                    });
                },
            );
            await captureGeometry(page);
            const wire = watchPaneWire(page);
            await page.goto(baseUrl);
            await page.evaluate(() => document.fonts.ready);
            await selectDesktop(page);
            const initial = await waitForGrid(page, 'recovery initial');
            const initialSeq = initial.seq;
            const bar = page.locator('#input-bar-container');
            if (!(await bar.isVisible()))
                await page.locator('#direct-mode-toggle').click();
            await settleComposer(page);
            expect(socketCount).toBe(1);

            await context.setOffline(true);
            await routes.page?.close().catch(() => {});
            await routes.server?.close().catch(() => {});
            await expect(page.locator('#term-t1 .reconnect-btn')).toBeVisible({
                timeout: 10_000,
            });
            samples.disconnected = true;

            const historyBefore = historyRequests.length;
            const framesBefore = clientFrames.length;
            await page.locator('#input-textarea').fill('offline draft');
            await page.locator('#send-input-btn').click();
            await expect(page.locator('#input-textarea')).toHaveValue(
                'offline draft',
            );
            expect(historyRequests.length).toBe(historyBefore);
            expect(clientFrames.length).toBe(framesBefore);

            const beforeResize = await composerState(page);
            await dragComposer(page, -24);
            await settleComposer(page);
            const afterResize = await composerState(page);
            samples.offlineResize = { beforeResize, afterResize };
            expect(afterResize?.textareaHeight).toBeGreaterThan(
                beforeResize?.textareaHeight ?? 0,
            );

            const offline = await request.post(
                `${baseUrl}/api/terminals/t1/input`,
                { data: { text: 'REPORT' } },
            );
            expect(offline.status()).toBe(204);
            let offlineSeq = 0;
            await expect
                .poll(
                    async () => {
                        const replay = await readReplay(baseUrl, 't1');
                        offlineSeq = latestReportSeq(
                            replay.data.toString('utf8'),
                        );
                        return offlineSeq;
                    },
                    { timeout: 15_000, message: 'offline REPORT in replay' },
                )
                .toBeGreaterThan(initialSeq);
            samples.offlineSeq = offlineSeq;

            await page.route(
                (url) => url.pathname === '/api/terminals/t1/replay',
                async (route) => {
                    if (replayCaptured) {
                        await route.fallback();
                        return;
                    }
                    replayCaptured = true;
                    const response = await route.fetch();
                    const body = await response.body();
                    replayBodyLength = body.length;
                    expect(body.length).toBeGreaterThan(0);
                    latchTimer = setTimeout(() => {
                        latchTimedOut = true;
                        latch.release?.();
                    }, 10_000);
                    await new Promise<void>((resolve) => {
                        latch.release = resolve;
                    });
                    await route.fulfill({ response });
                    replayFulfilled = true;
                },
            );
            await context.setOffline(false);
            await page.locator('#term-t1 .reconnect-btn').click();
            await expect
                .poll(() => socketCount, { timeout: 10_000 })
                .toBeGreaterThan(1);
            await expect
                .poll(() => replayCaptured, { timeout: 10_000 })
                .toBe(true);
            expect(replayBodyLength).toBeGreaterThan(0);

            await page.locator('#input-textarea').fill('held draft');
            const beforeHeldResize = await composerState(page);
            await dragComposer(page, -24);
            await settleComposer(page);
            const held = await composerState(page);
            samples.held = {
                before: beforeHeldResize,
                after: held,
                value: await page.locator('#input-textarea').inputValue(),
            };
            expect(held?.textareaHeight).toBeGreaterThan(
                beforeHeldResize?.textareaHeight ?? 0,
            );
            expect(await page.locator('#input-textarea').inputValue()).toBe(
                'held draft',
            );

            const live = await request.post(
                `${baseUrl}/api/terminals/t1/input`,
                { data: { text: 'REPORT' } },
            );
            expect(live.status()).toBe(204);
            let liveSeq = 0;
            await expect
                .poll(
                    () => {
                        const text = serverOutput(serverFrames);
                        const match = /DRAW (\d+) REPORT /.exec(text);
                        liveSeq = match ? Number(match[1]) : 0;
                        return liveSeq;
                    },
                    { timeout: 10_000, message: 'live REPORT frame' },
                )
                .toBeGreaterThan(offlineSeq);
            samples.liveSeq = liveSeq;

            expect(latchTimedOut).toBe(false);
            latch.release?.();
            latch.release = null;
            await expect
                .poll(() => replayFulfilled, { timeout: 10_000 })
                .toBe(true);
            for (const marker of [
                `DRAW ${offlineSeq} REPORT`,
                `DRAW ${liveSeq} REPORT`,
            ]) {
                await expect
                    .poll(
                        () =>
                            page.evaluate((needle) => {
                                const win = window as unknown as GeometryWindow;
                                return win.geometryCompletedTexts.some((text) =>
                                    text.includes(needle),
                                );
                            }, marker),
                        {
                            timeout: 10_000,
                            message: `completed xterm write ${marker}`,
                        },
                    )
                    .toBe(true);
            }
            await settleComposer(page);
            expect((await composerState(page))?.pendingWrites).toBe(0);

            const resume = page.locator('#term-t1 .scroll-to-bottom-btn');
            if (await resume.isVisible()) await resume.click();
            await page.locator('#input-textarea').fill('');
            await settleComposer(page);
            const reportBase = await grid(page);
            await page.locator('#input-textarea').fill('REPORT');
            await page.locator('#send-input-btn').click();
            const reported = await waitForGrid(
                page,
                'recovery REPORT',
                reportBase?.seq ?? 0,
                'REPORT',
            );
            expect(reported.edge).toBe('EDGE');
            samples.report = reported;

            const quiet = await composerState(page);
            const quietFits = quiet?.fits ?? 0;
            const quietRefreshes = quiet?.refreshes ?? 0;
            const quietGrid = quiet?.gridEvents ?? 0;
            const quietResize = wire.resize.length;
            const quietInput = wire.input.length;
            await page.locator('#input-textarea').fill('  alpha\nbeta  ');
            await settleComposer(page);
            const typed = await composerState(page);
            samples.typed = typed;
            expect(typed?.textareaHeight).toBe(quiet?.textareaHeight);
            expect(typed?.panelHeight).toBe(quiet?.panelHeight);
            expect(typed?.rows).toBe(quiet?.rows);
            expect(typed?.fits).toBe(quietFits);
            expect(typed?.refreshes).toBe(quietRefreshes);
            expect(typed?.gridEvents).toBe(quietGrid);
            expect(wire.resize.length).toBe(quietResize);
            await page.locator('#send-input-btn').click();
            await settleComposer(page);
            const sent = await composerState(page);
            samples.sent = sent;
            expect(sent?.value).toBe('');
            expect(wire.input.slice(quietInput)).toEqual([
                '\x1b[200~alpha\nbeta\x1b[201~\r',
            ]);
            console.log(`composer recovery: ${JSON.stringify(samples)}`);
        } finally {
            latch.release?.();
            if (latchTimer) clearTimeout(latchTimer);
            try {
                await routes.page?.close();
            } catch {}
            try {
                await routes.server?.close();
            } catch {}
            await context.close();
        }
    } finally {
        await test.info().attach('composer-recovery', {
            body: JSON.stringify(samples, null, 2),
            contentType: 'application/json',
        });
        if (phi) await phi.stop();
    }
});
