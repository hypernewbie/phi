import { copyFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';
import {
    isCancelledSessionListRead,
    isCancelledWorktreeRead,
} from './_session-requests.js';

interface FitAddon {
    proposeDimensions?(): { cols: number; rows: number } | undefined;
}

interface Terminal {
    element?: HTMLElement;
    cols: number;
    rows: number;
    fit?: FitAddon;
    loadAddon(addon: FitAddon): void;
    buffer: {
        active: {
            baseY: number;
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
`;

function startGeometryFixture(): Promise<PhiServer> {
    return startPhi({
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
                        if (addon.proposeDimensions) this.fit = addon;
                        super.loadAddon(addon);
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
            isCancelledWorktreeRead(request, origin)
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
                await page.locator('#term-t1').evaluate((node) => {
                    node.style.setProperty('width', '520px', 'important');
                    node.style.setProperty('height', '360px', 'important');
                });
                await waitForGrid(
                    page,
                    'content-box resize',
                    beforeBox.seq,
                    'WINCH',
                    beforeBox.cols,
                );
                await page.locator('.tab[data-pane-id="t2"]').click();
                await expect(
                    page.locator('#tabs-container .tab.active'),
                ).toHaveAttribute('data-pane-id', 't2');
                const beforeActivate = await grid(page);
                await selectDesktop(page);
                await waitForGrid(
                    page,
                    'foreground activation',
                    beforeActivate?.seq ?? 0,
                    'WINCH',
                );
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
