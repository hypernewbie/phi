import { execFileSync } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
    expect,
    test,
    type APIRequestContext,
    type Browser,
    type Locator,
    type Page,
    type Route,
    type TestInfo,
} from '@playwright/test';
import { TerminalClientFrame } from '../web/proto/terminal.js';
import type {
    MessageFns,
    TerminalClientFrame as TerminalClientMessage,
} from '../web-src/proto/terminal.js';
import { startPhi, type PhiServer } from './_server.js';

test.skip(
    process.platform === 'win32',
    'fixture requires a POSIX shell and stty',
);

const ClientCodec: MessageFns<TerminalClientMessage> =
    TerminalClientFrame as unknown as MessageFns<TerminalClientMessage>;

interface CapturedFit {
    proposeDimensions?(): { cols: number; rows: number } | undefined;
}

interface CapturedTerminal {
    element?: HTMLElement;
    cols: number;
    rows: number;
    fit?: CapturedFit;
    loadAddon(addon: CapturedFit): void;
    buffer: {
        active: {
            length: number;
            getLine(
                index: number,
            ): { translateToString(trim?: boolean): string } | undefined;
        };
    };
}

interface TerminalWindow extends Window {
    desktopSidebarTerms: CapturedTerminal[];
    Terminal: new (options: Record<string, unknown>) => CapturedTerminal;
}

interface PageDiagnostics {
    consoleErrors: string[];
    pageErrors: string[];
    requests: { method: string; path: string }[];
    websockets: string[];
    resizes: { paneId: string; cols: number; rows: number }[];
    responses: { method: string; path: string; status: number }[];
    httpFailures: { method: string; path: string; status: number }[];
    failedRequests: {
        method: string;
        path: string;
        origin: string;
        error: string;
    }[];
    blockedExternal: string[];
    substitutions: string[];
    classifiedPinAborts: { path: string; status: number; error: string }[];
}

async function watchPage(page: Page, origin: string): Promise<PageDiagnostics> {
    const diagnostics: PageDiagnostics = {
        consoleErrors: [],
        pageErrors: [],
        requests: [],
        websockets: [],
        resizes: [],
        responses: [],
        httpFailures: [],
        failedRequests: [],
        blockedExternal: [],
        substitutions: [],
        classifiedPinAborts: [],
    };
    page.on('console', (message) => {
        if (message.type() === 'error')
            diagnostics.consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
    page.on('request', (request) => {
        const url = new URL(request.url());
        diagnostics.requests.push({
            method: request.method(),
            path: `${url.pathname}${url.search}`,
        });
    });
    page.on('websocket', (socket) => {
        diagnostics.websockets.push(socket.url());
        const paneId = new URL(socket.url()).pathname.match(
            /^\/ws\/pane\/([^/]+)$/,
        )?.[1];
        if (!paneId) return;
        socket.on('framesent', ({ payload: frame }) => {
            if (!Buffer.isBuffer(frame)) return;
            const payload = ClientCodec.decode(new Uint8Array(frame)).payload;
            if (payload?.$case !== 'resize') return;
            const { cols, rows } = payload.value;
            if (cols !== undefined && rows !== undefined)
                diagnostics.resizes.push({ paneId, cols, rows });
        });
    });
    page.on('response', (response) => {
        const url = new URL(response.url());
        const record = {
            method: response.request().method(),
            path: `${url.pathname}${url.search}`,
            status: response.status(),
        };
        diagnostics.responses.push(record);
        if (response.status() >= 400) diagnostics.httpFailures.push(record);
    });
    page.on('requestfailed', (request) => {
        const url = new URL(request.url());
        diagnostics.failedRequests.push({
            method: request.method(),
            path: `${url.pathname}${url.search}`,
            origin: url.origin,
            error: request.failure()?.errorText ?? 'unknown',
        });
    });
    await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) {
            diagnostics.blockedExternal.push(url.href);
            await route.abort();
        } else if (url.pathname === '/api/update/status') {
            diagnostics.substitutions.push(url.pathname);
            await route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({
                    current: 'dev',
                    update_available: false,
                }),
            });
        } else if (
            url.pathname === '/api/sessions' &&
            url.searchParams.get('coder') === 'opencode'
        ) {
            diagnostics.substitutions.push(`${url.pathname}?coder=opencode`);
            await route.fulfill({
                contentType: 'application/json',
                body: '[]',
            });
        } else {
            await route.continue();
        }
    });
    return diagnostics;
}

function requireStty(): void {
    execFileSync('sh', ['-c', 'command -v stty'], { stdio: 'ignore' });
}

async function startDesktopFixture(): Promise<PhiServer> {
    requireStty();
    return startPhi({
        env: { PHI_SHUTDOWN_PTY_GRACE: '150ms', PHI_SHUTDOWN_GRACE: '1s' },
        setup(dir) {
            const workspace = realpathSync(dir);
            const home = join(dir, 'home');
            const backends = join(home, '.phi', 'backends');
            mkdirSync(backends, { recursive: true });
            const command = join(dir, 'fixture-shell');
            writeFileSync(
                command,
                `#!/bin/sh
printf 'sidebar fixture ready\\r\\n'
while IFS= read -r line; do
    printf '%s\\n' "$line" >> "$HOME/sidebar-input.log"
    size=$(stty size) || exit 1
    printf 'SIZE:%s:%s\\r\\n' "$line" "$size"
    printf 'ACK:%s\\r\\n' "$line"
done
`,
                { mode: 0o755 },
            );
            writeFileSync(
                join(backends, 'bash.json'),
                JSON.stringify({ id: 'bash', command }),
            );
            writeFileSync(
                join(home, '.phi', 'config.json'),
                JSON.stringify({ workspaces: [workspace] }),
            );
        },
    });
}

async function instrumentTerminals(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const w = window as unknown as TerminalWindow;
        w.desktopSidebarTerms = [];
        let base: typeof w.Terminal;
        Object.defineProperty(window, 'Terminal', {
            configurable: true,
            get: () => base,
            set: (TerminalClass: typeof w.Terminal) => {
                base = class extends TerminalClass {
                    constructor(options: Record<string, unknown>) {
                        super(options);
                        w.desktopSidebarTerms.push(this);
                    }
                    loadAddon(addon: CapturedFit) {
                        if (addon.proposeDimensions) this.fit = addon;
                        super.loadAddon(addon);
                    }
                };
            },
        });
    });
}

async function newFeaturePage(
    browser: Browser,
    phi: PhiServer,
    viewport = { width: 1440, height: 900 },
    touch = false,
) {
    const context = await browser.newContext({
        viewport,
        ...(touch ? { isMobile: true, hasTouch: true } : {}),
    });
    try {
        const page = await context.newPage();
        page.setDefaultTimeout(15_000);
        const diagnostics = await watchPage(page, new URL(phi.url).origin);
        await instrumentTerminals(page);
        return { context, page, diagnostics };
    } catch (error) {
        await context.close();
        throw error;
    }
}

async function waitForAppConsole(page: Page): Promise<void> {
    await page.waitForEvent('console', {
        predicate: (message) =>
            message.text() === '[app] Phi initialized successfully',
        timeout: 30_000,
    });
}

async function waitForInitialized(page: Page, phi: PhiServer): Promise<void> {
    const initialized = waitForAppConsole(page);
    await Promise.all([page.goto(phi.url), initialized]);
    await expect(page.locator('#workspace-select')).toHaveValue(
        realpathSync(phi.dir),
    );
    await expect(page.locator('#sidebar-drawer-resizer')).toBeAttached();
}

async function closeDiffPanelForSidebarCoverage(page: Page): Promise<void> {
    const panel = page.locator('#diff-panel');
    const isHidden = await panel.evaluate((element) =>
        element.classList.contains('hidden'),
    );
    if (!isHidden) await page.locator('#header-diff-toggle-btn').click();
    await expect(panel).toHaveClass(/hidden/);
}

async function launchShell(page: Page): Promise<string> {
    const [response] = await Promise.all([
        page.waitForResponse(
            (entry) =>
                entry.url().endsWith('/api/terminals') &&
                entry.request().method() === 'POST',
            { timeout: 30_000 },
        ),
        page.locator('#empty-quick-launch [data-coder="bash"]').click(),
    ]);
    expect(response.status()).toBe(200);
    const { pane_id: paneId } = (await response.json()) as {
        pane_id: string;
    };
    await expect(page.locator(`#term-${paneId} .xterm`)).toBeVisible();
    await expect
        .poll(
            async () =>
                (await terminalState(page, paneId))?.lines.join('\n') ?? '',
            { timeout: 15_000 },
        )
        .toContain('sidebar fixture ready');
    return paneId;
}

function inputLog(phi: PhiServer): string {
    return join(phi.dir, 'home', 'sidebar-input.log');
}

function readInputLog(path: string): string {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

async function sendAndCheckMarker(
    page: Page,
    phi: PhiServer,
    paneId: string,
    marker: string,
    diagnostics: PageDiagnostics,
): Promise<void> {
    await page.locator(`#term-${paneId} .xterm-helper-textarea`).focus();
    // A queued panel fit can finish after focus; capture only the settled grid.
    await expect
        .poll(
            async () => {
                const state = await terminalState(page, paneId);
                const sent = diagnostics.resizes
                    .filter((size) => size.paneId === paneId)
                    .at(-1);
                return Boolean(
                    state &&
                        sent &&
                        state.cols === sent.cols &&
                        state.rows === sent.rows &&
                        state.proposed?.cols === sent.cols &&
                        state.proposed.rows === sent.rows,
                );
            },
            { timeout: 15_000 },
        )
        .toBe(true);
    const before = await terminalState(page, paneId);
    expect(before).not.toBeNull();
    await page.keyboard.type(marker);
    await page.keyboard.press('Enter');
    await expect
        .poll(() => readInputLog(inputLog(phi)), { timeout: 15_000 })
        .toContain(`${marker}\n`);
    await expect
        .poll(async () => (await terminalState(page, paneId))?.lines ?? [], {
            timeout: 15_000,
        })
        .toContain(`ACK:${marker}`);
    await expect
        .poll(async () => (await terminalState(page, paneId))?.lines ?? [], {
            timeout: 15_000,
        })
        .toContain(`SIZE:${marker}:${before!.rows} ${before!.cols}`);
}

function routeGate(page: Page, pathname: string) {
    let releaseGate!: () => void;
    let markStarted!: () => void;
    let markFinished!: () => void;
    const gate = new Promise<void>((resolve) => (releaseGate = resolve));
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    const finished = new Promise<void>((resolve) => (markFinished = resolve));
    let didStart = false;
    const pattern = '**/*';
    const handler = async (route: Route) => {
        if (new URL(route.request().url()).pathname !== pathname) {
            await route.fallback();
            return;
        }
        didStart = true;
        markStarted();
        try {
            await gate;
            await route.fallback();
        } finally {
            markFinished();
        }
    };
    return {
        async install() {
            await page.route(pattern, handler);
        },
        started,
        release() {
            releaseGate();
        },
        async remove() {
            releaseGate();
            if (didStart) await finished;
            await page.unroute(pattern, handler);
        },
    };
}

async function terminalState(page: Page, paneId: string) {
    return page.evaluate((id) => {
        const terms = (window as unknown as TerminalWindow).desktopSidebarTerms;
        const term = terms?.find(
            (entry) =>
                entry.element?.closest('.term-container')?.id === `term-${id}`,
        );
        if (!term) return null;
        const lines = Array.from(
            { length: term.buffer.active.length },
            (_, index) =>
                term.buffer.active.getLine(index)?.translateToString(true) ??
                '',
        );
        const tab = document.querySelector(`.tab[data-pane-id="${id}"]`);
        return {
            cols: term.cols,
            rows: term.rows,
            proposed: term.fit?.proposeDimensions?.(),
            lines,
            active: tab?.classList.contains('active') ?? false,
            dead: tab?.classList.contains('dead') ?? true,
        };
    }, paneId);
}

async function panelGeometry(page: Page, paneId: string) {
    return page.evaluate((id) => {
        const width = (selector: string) =>
            document.querySelector(selector)?.getBoundingClientRect().width ??
            -1;
        return {
            sidebar: width('#sidebar-panel'),
            handle: width('#left-resize-handle'),
            terminal: width(`#term-${id}`),
        };
    }, paneId);
}

async function dragSidebar(page: Page, width: number): Promise<void> {
    const sidebar = await page.locator('#sidebar-panel').boundingBox();
    const handle = await page.locator('#left-resize-handle').boundingBox();
    expect(sidebar).not.toBeNull();
    expect(handle).not.toBeNull();
    const x = handle!.x + 1;
    const y = handle!.y + handle!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + width - sidebar!.width, y, { steps: 5 });
    await page.mouse.up();
    await expect
        .poll(
            () =>
                page
                    .locator('#sidebar-panel')
                    .evaluate((el) => el.getBoundingClientRect().width),
            { timeout: 5_000 },
        )
        .toBeGreaterThan(width - 2);
    await expect
        .poll(
            () =>
                page
                    .locator('#sidebar-panel')
                    .evaluate((el) => el.getBoundingClientRect().width),
            { timeout: 5_000 },
        )
        .toBeLessThan(width + 2);
}

async function verifyPinDiagnostics(
    diagnostics: PageDiagnostics,
    request: APIRequestContext,
    phi: PhiServer,
    paneId: string,
) {
    const pinPath = `/api/terminals/${paneId}/pin`;
    const pinAborts = diagnostics.failedRequests.filter(
        (failure) =>
            failure.method === 'POST' &&
            failure.path === pinPath &&
            failure.error === 'net::ERR_ABORTED',
    );
    const remainingFailures = diagnostics.failedRequests.filter(
        (failure) => !pinAborts.includes(failure),
    );
    expect(remainingFailures).toEqual([]);
    for (const failure of pinAborts) {
        expect(
            diagnostics.responses.some(
                (response) =>
                    response.method === 'POST' &&
                    response.path === pinPath &&
                    response.status === 200,
            ),
        ).toBe(true);
        const response = await request.get(`${phi.url}/api/terminals`);
        expect(response.ok()).toBe(true);
        const terminals = (await response.json()) as {
            id: string;
            pinned: boolean;
        }[];
        expect(
            terminals.find((terminal) => terminal.id === paneId)?.pinned,
        ).toBe(true);
        diagnostics.classifiedPinAborts.push({
            path: failure.path,
            status: 200,
            error: failure.error,
        });
    }
    const pinConsoleErrors = diagnostics.consoleErrors.filter((message) =>
        message.startsWith('[term] Failed to sync pin on backend:'),
    );
    const otherConsoleErrors = diagnostics.consoleErrors.filter(
        (message) => !pinConsoleErrors.includes(message),
    );
    expect(otherConsoleErrors).toEqual([]);
    if (pinConsoleErrors.length) {
        expect(pinConsoleErrors).toHaveLength(pinAborts.length);
        expect(
            pinConsoleErrors.every((message) =>
                message.includes('TypeError: Failed to fetch'),
            ),
        ).toBe(true);
    }
    expect(diagnostics.pageErrors).toEqual([]);
    expect(diagnostics.httpFailures).toEqual([]);
    expect(diagnostics.blockedExternal).toEqual([]);
}

async function attachDiagnostics(
    testInfo: TestInfo,
    diagnostics: PageDiagnostics | undefined,
    phi: PhiServer,
) {
    if (diagnostics) {
        await testInfo.attach('browser-diagnostics.json', {
            body: Buffer.from(JSON.stringify(diagnostics, null, 2)),
            contentType: 'application/json',
        });
    }
    if (existsSync(phi.logPath)) {
        await testInfo.attach('phi-server.log', {
            body: readFileSync(phi.logPath),
            contentType: 'text/plain',
        });
    }
}

async function within<T>(promise: Promise<T>, ms = 5_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`operation exceeded ${ms}ms`)),
                    ms,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer!);
    }
}

function expectCleanDiagnostics(diagnostics: PageDiagnostics): void {
    expect(diagnostics.consoleErrors).toEqual([]);
    expect(diagnostics.pageErrors).toEqual([]);
    expect(diagnostics.httpFailures).toEqual([]);
    expect(diagnostics.failedRequests).toEqual([]);
    expect(diagnostics.blockedExternal).toEqual([]);
}

async function cleanupFeatureFixture(
    context: Awaited<ReturnType<Browser['newContext']>> | undefined,
    diagnostics: PageDiagnostics | undefined,
    phi: PhiServer,
    testInfo: TestInfo,
): Promise<void> {
    try {
        if (context) await context.setOffline(false);
    } finally {
        try {
            await context?.close();
        } finally {
            try {
                await attachDiagnostics(testInfo, diagnostics, phi);
            } finally {
                await phi.stop();
            }
        }
    }
}

test('MVP desktop hides and restores a live terminal', async ({
    browser,
    request,
}, testInfo) => {
    test.setTimeout(180_000);
    const phi = await startDesktopFixture();
    let context: Awaited<ReturnType<Browser['newContext']>> | undefined;
    let diagnostics: PageDiagnostics | undefined;
    try {
        const feature = await newFeaturePage(browser, phi);
        context = feature.context;
        diagnostics = feature.diagnostics;
        const { page } = feature;
        await waitForInitialized(page, phi);
        const paneId = await launchShell(page);
        await page.evaluate(() => document.fonts.ready);

        const before = await panelGeometry(page, paneId);
        const beforeTerm = await terminalState(page, paneId);
        expect(before.sidebar).toBeGreaterThan(0);
        expect(before.handle).toBeGreaterThan(0);
        expect(beforeTerm).not.toBeNull();
        expect(beforeTerm?.active).toBe(true);
        expect(beforeTerm?.dead).toBe(false);

        await page.getByRole('button', { name: 'Hide sessions' }).click();
        await expect
            .poll(() => panelGeometry(page, paneId))
            .toMatchObject({
                sidebar: 0,
                handle: 0,
            });
        await expect
            .poll(
                async () => {
                    const geometry = await panelGeometry(page, paneId);
                    const state = await terminalState(page, paneId);
                    return (
                        Math.abs(
                            geometry.terminal -
                                (before.terminal +
                                    before.sidebar +
                                    before.handle),
                        ) <= 2 &&
                        state !== null &&
                        state.cols > beforeTerm!.cols
                    );
                },
                { timeout: 15_000 },
            )
            .toBe(true);
        const hiddenGeometry = await panelGeometry(page, paneId);
        const hiddenMarker = `sidebar-hidden-${Date.now()}`;
        await sendAndCheckMarker(page, phi, paneId, hiddenMarker, diagnostics);
        const hiddenTerm = await terminalState(page, paneId);
        expect(hiddenTerm).not.toBeNull();

        await page.getByRole('button', { name: 'Show sessions' }).click();
        await expect
            .poll(() => panelGeometry(page, paneId))
            .toMatchObject({
                sidebar: before.sidebar,
                handle: before.handle,
                terminal: before.terminal,
            });
        await expect
            .poll(
                async () => {
                    const state = await terminalState(page, paneId);
                    return (
                        state !== null &&
                        state.cols === beforeTerm!.cols &&
                        state.rows === beforeTerm!.rows
                    );
                },
                { timeout: 15_000 },
            )
            .toBe(true);
        const restoredTerm = await terminalState(page, paneId);
        expect(restoredTerm?.active).toBe(true);
        expect(restoredTerm?.dead).toBe(false);
        const restoredMarker = `sidebar-restored-${Date.now()}`;
        await sendAndCheckMarker(
            page,
            phi,
            paneId,
            restoredMarker,
            diagnostics,
        );

        await expect(page.locator('#tabs-container .tab')).toHaveCount(1);
        await expect(page.locator(`#term-${paneId}.active`)).toBeVisible();
        expect(readInputLog(inputLog(phi)).trim().split('\n')).toEqual([
            hiddenMarker,
            restoredMarker,
        ]);

        await verifyPinDiagnostics(diagnostics, request, phi, paneId);
        const finalGeometry = await panelGeometry(page, paneId);
        const evidence = {
            viewport: { width: 1440, height: 900 },
            before: { ...before, ...beforeTerm },
            hidden: { ...hiddenGeometry, ...hiddenTerm },
            restored: { ...finalGeometry, ...restoredTerm },
            markers: [hiddenMarker, restoredMarker],
            acknowledgements: [`ACK:${hiddenMarker}`, `ACK:${restoredMarker}`],
            substitutions: diagnostics.substitutions,
            classifiedPinAborts: diagnostics.classifiedPinAborts,
        };
        const evidencePath = testInfo.outputPath('terminal-geometry.json');
        mkdirSync(dirname(evidencePath), { recursive: true });
        writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
        await testInfo.attach('terminal-geometry.json', {
            body: Buffer.from(JSON.stringify(evidence, null, 2)),
            contentType: 'application/json',
        });
    } finally {
        await cleanupFeatureFixture(context, diagnostics, phi, testInfo);
    }
});

async function expectRightAligned(toggle: Locator) {
    const alignment = await toggle.evaluate((button) => {
        const header = button.closest('.panel-header');
        if (!header) throw new Error('Missing sessions header');
        return {
            rightInset:
                header.getBoundingClientRect().right -
                button.getBoundingClientRect().right,
            paddingRight: parseFloat(getComputedStyle(header).paddingRight),
        };
    });
    expect(
        Math.abs(alignment.rightInset - alignment.paddingRight),
    ).toBeLessThanOrEqual(1);
}

test('M2 saved visibility and widths survive reloads and rapid toggles', async ({
    browser,
    request,
}, testInfo) => {
    test.setTimeout(180_000);
    const phi = await startDesktopFixture();
    let context: Awaited<ReturnType<Browser['newContext']>> | undefined;
    let page: Page | undefined;
    let diagnostics: PageDiagnostics | undefined;
    let configGate: ReturnType<typeof routeGate> | undefined;
    let paneId = '';
    try {
        ({ context, page, diagnostics } = await newFeaturePage(browser, phi));
        await waitForInitialized(page, phi);
        paneId = await launchShell(page);
        await page.evaluate(() => document.fonts.ready);
        const original = await panelGeometry(page, paneId);

        for (const width of [300, 96]) {
            await dragSidebar(page, width);
            const accepted = await page
                .locator('#sidebar-panel')
                .evaluate((el) => el.getBoundingClientRect().width);
            await page.getByRole('button', { name: 'Hide sessions' }).click();
            await expect(page.locator('html')).toHaveClass(
                /desktop-sidebar-hidden/,
            );
            await page.getByRole('button', { name: 'Show sessions' }).click();
            await expect
                .poll(() =>
                    page!
                        .locator('#sidebar-panel')
                        .evaluate((el) => el.getBoundingClientRect().width),
                )
                .toBeGreaterThan(accepted - 2);
            await expect
                .poll(() =>
                    page!
                        .locator('#sidebar-panel')
                        .evaluate((el) => el.getBoundingClientRect().width),
                )
                .toBeLessThan(accepted + 2);
            expect(
                await page
                    .locator('#sidebar-panel')
                    .evaluate((el) => el.classList.contains('sidebar-narrow')),
            ).toBe(width < 120);
            if (width === 96) {
                const header = page.locator('#sidebar-panel .panel-header');
                await expect(header).toBeVisible();
                await expectRightAligned(
                    page.locator('#desktop-sidebar-toggle'),
                );
                await page.setViewportSize({ width: 390, height: 844 });
                await expect(header).toBeHidden();
                await page.setViewportSize({ width: 1440, height: 900 });
                await expect(header).toBeVisible();
            }
        }
        expect(original.sidebar).toBeGreaterThan(0);

        await dragSidebar(page, 96);
        const savedWidth = Number(
            await page.evaluate(() =>
                localStorage.getItem('phi_panel_left_width'),
            ),
        );
        expect(savedWidth).toBeGreaterThan(94);
        expect(savedWidth).toBeLessThan(98);
        await page.getByRole('button', { name: 'Hide sessions' }).click();
        await page.keyboard.press('Control+Alt+]');
        await expect(page.locator('html')).toHaveClass(
            /desktop-sidebar-hidden/,
        );
        expect(
            await page.evaluate(() =>
                Number(localStorage.getItem('phi_panel_left_width')),
            ),
        ).toBeGreaterThanOrEqual(118);
        expect(
            await page.evaluate(() =>
                localStorage.getItem('phi_drawer_left_width'),
            ),
        ).toBeNull();

        configGate = routeGate(page, '/api/config');
        await configGate.install();
        await Promise.all([
            page.reload({ waitUntil: 'domcontentloaded' }),
            within(configGate.started),
        ]);
        await expect(page.locator('#desktop-sidebar-toggle')).toHaveAttribute(
            'aria-expanded',
            'false',
        );
        await expect(page.locator('html')).toHaveClass(
            /desktop-sidebar-hidden/,
        );
        const readyAfterHiddenReload = waitForAppConsole(page);
        await configGate.remove();
        configGate = undefined;
        await readyAfterHiddenReload;
        await expect(page.locator('#desktop-sidebar-toggle')).toHaveAttribute(
            'aria-expanded',
            'false',
        );
        await expect
            .poll(() =>
                page!
                    .locator('#sidebar-panel')
                    .evaluate((el) => el.getBoundingClientRect().width),
            )
            .toBe(0);

        await page.getByRole('button', { name: 'Show sessions' }).click();
        await expect
            .poll(() =>
                page!
                    .locator('#sidebar-panel')
                    .evaluate((el) => el.getBoundingClientRect().width),
            )
            .toBeGreaterThan(118);
        await Promise.all([page.reload(), waitForAppConsole(page)]);
        await expect(page.locator('#desktop-sidebar-toggle')).toHaveAttribute(
            'aria-expanded',
            'true',
        );
        await expect(page.locator('html')).not.toHaveClass(
            /desktop-sidebar-hidden/,
        );
        await expect
            .poll(() =>
                page!
                    .locator('#sidebar-panel')
                    .evaluate((el) => el.getBoundingClientRect().width),
            )
            .toBeGreaterThan(118);

        await expect(page.locator('#tabs-container .tab')).toHaveCount(1);
        await expect(page.locator(`#term-${paneId}.active`)).toBeVisible();
        for (let index = 0; index < 10; index++)
            await page.locator('#desktop-sidebar-toggle').click();
        await expect(page.locator('#desktop-sidebar-toggle')).toHaveAttribute(
            'aria-expanded',
            'true',
        );
        await expect(page.locator('html')).not.toHaveClass(
            /desktop-sidebar-hidden/,
        );
        const marker = `sidebar-rapid-${Date.now()}`;
        await sendAndCheckMarker(page, phi, paneId, marker, diagnostics);
        await expect(page.locator('#tabs-container .tab')).toHaveCount(1);
        expect(readInputLog(inputLog(phi))).toBe(`${marker}\n`);
        await verifyPinDiagnostics(diagnostics, request, phi, paneId);
    } finally {
        try {
            await configGate?.remove();
        } finally {
            await cleanupFeatureFixture(context, diagnostics, phi, testInfo);
        }
    }
});

test('M2 local toggles work while coder startup is delayed', async ({
    browser,
}, testInfo) => {
    test.setTimeout(180_000);
    const phi = await startDesktopFixture();
    let context: Awaited<ReturnType<Browser['newContext']>> | undefined;
    let page: Page | undefined;
    let diagnostics: PageDiagnostics | undefined;
    let gate: ReturnType<typeof routeGate> | undefined;
    try {
        ({ context, page, diagnostics } = await newFeaturePage(browser, phi));
        gate = routeGate(page, '/api/coders');
        await gate.install();
        await Promise.all([page.goto(phi.url), within(gate.started)]);
        await within(
            (async () => {
                const toggle = page!.locator('#desktop-sidebar-toggle');
                await expect(toggle).toBeVisible();
                await toggle.click();
                await expect(toggle).toHaveAttribute('aria-expanded', 'false');
                await expect(page!.locator('html')).toHaveClass(
                    /desktop-sidebar-hidden/,
                );
                await toggle.click();
                await expect(toggle).toHaveAttribute('aria-expanded', 'true');
                await expect(page!.locator('html')).not.toHaveClass(
                    /desktop-sidebar-hidden/,
                );
                await toggle.click();
                await expect(toggle).toHaveAttribute('aria-expanded', 'false');
                await expect(page!.locator('html')).toHaveClass(
                    /desktop-sidebar-hidden/,
                );
            })(),
        );
        const initialized = waitForAppConsole(page);
        await gate.remove();
        gate = undefined;
        await initialized;
        await expect(page.locator('html')).toHaveClass(
            /desktop-sidebar-hidden/,
        );
        expectCleanDiagnostics(diagnostics);
    } finally {
        try {
            await gate?.remove();
        } finally {
            await cleanupFeatureFixture(context, diagnostics, phi, testInfo);
        }
    }
});

test('M2 local toggles work before authentication status returns', async ({
    browser,
}, testInfo) => {
    test.setTimeout(180_000);
    const phi = await startDesktopFixture();
    let context: Awaited<ReturnType<Browser['newContext']>> | undefined;
    let page: Page | undefined;
    let diagnostics: PageDiagnostics | undefined;
    let gate: ReturnType<typeof routeGate> | undefined;
    try {
        ({ context, page, diagnostics } = await newFeaturePage(browser, phi));
        gate = routeGate(page, '/api/auth/status');
        await gate.install();
        await Promise.all([page.goto(phi.url), within(gate.started)]);
        await within(
            (async () => {
                const toggle = page!.locator('#desktop-sidebar-toggle');
                await expect(toggle).toBeVisible();
                await toggle.click();
                await expect(toggle).toHaveAttribute('aria-expanded', 'false');
                await toggle.click();
                await expect(toggle).toHaveAttribute('aria-expanded', 'true');
                await toggle.click();
                await expect(toggle).toHaveAttribute('aria-expanded', 'false');
            })(),
        );
        expect(
            diagnostics.requests.filter(
                (request) =>
                    request.path.startsWith('/api/') &&
                    request.path !== '/api/auth/status',
            ),
        ).toEqual([]);
        expect(diagnostics.websockets).toEqual([]);
        const initialized = waitForAppConsole(page);
        await gate.remove();
        gate = undefined;
        await initialized;
        await expect(page.locator('html')).toHaveClass(
            /desktop-sidebar-hidden/,
        );
        expectCleanDiagnostics(diagnostics);
    } finally {
        try {
            await gate?.remove();
        } finally {
            await cleanupFeatureFixture(context, diagnostics, phi, testInfo);
        }
    }
});

for (const viewport of [
    { width: 900, height: 900, touch: false },
    { width: 390, height: 844, touch: true },
]) {
    test(`hidden desktop sidebar recovers focus from a ${viewport.width}px drawer`, async ({
        browser,
    }, testInfo) => {
        test.setTimeout(180_000);
        const phi = await startDesktopFixture();
        let context: Awaited<ReturnType<Browser['newContext']>> | undefined;
        let diagnostics: PageDiagnostics | undefined;
        try {
            const feature = await newFeaturePage(
                browser,
                phi,
                { width: 1440, height: 900 },
                viewport.touch,
            );
            context = feature.context;
            diagnostics = feature.diagnostics;
            const { page } = feature;
            await waitForInitialized(page, phi);
            await closeDiffPanelForSidebarCoverage(page);
            const toggle = page.locator('#desktop-sidebar-toggle');
            await toggle.click();
            await page.setViewportSize(viewport);
            const mobile = page.locator('#mobile-sidebar-toggle');
            if (viewport.touch) await mobile.tap();
            else await mobile.click();
            if (viewport.touch)
                await page.locator('#drawer-open-sessions').tap();
            const inside = page.locator('#new-session-btn');
            await expect(inside).toBeVisible();
            await inside.focus();
            await expect(inside).toBeFocused();
            await page.setViewportSize({ width: 1440, height: 900 });
            await expect(page.locator('#sidebar-panel')).toBeHidden();
            await expect(toggle).toBeFocused();
            await expect(toggle).toHaveAttribute('aria-expanded', 'false');
            await page.keyboard.press('Enter');
            await expect(page.locator('#sidebar-panel')).toBeVisible();
            await expect(toggle).toHaveAttribute('aria-expanded', 'true');
            expectCleanDiagnostics(diagnostics);
        } finally {
            await cleanupFeatureFixture(context, diagnostics, phi, testInfo);
        }
    });
}

test('M2 coder 503 does not block local visibility toggles', async ({
    browser,
}, testInfo) => {
    test.setTimeout(180_000);
    const phi = await startDesktopFixture();
    let context: Awaited<ReturnType<Browser['newContext']>> | undefined;
    let page: Page | undefined;
    let diagnostics: PageDiagnostics | undefined;
    try {
        ({ context, page, diagnostics } = await newFeaturePage(browser, phi));
        await page.route('**/api/coders', (route) =>
            route.fulfill({
                status: 503,
                contentType: 'text/plain',
                body: 'intentional local test failure',
            }),
        );
        await waitForInitialized(page, phi);
        const toggle = page.locator('#desktop-sidebar-toggle');
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');

        expect(diagnostics.httpFailures.length).toBeGreaterThan(0);
        expect(
            diagnostics.httpFailures.every(
                (failure) =>
                    failure.path === '/api/coders' && failure.status === 503,
            ),
        ).toBe(true);
        const expectedConsole = diagnostics.consoleErrors.filter(
            (message) =>
                (message.startsWith('[app] Failed to fetch coder presets:') &&
                    message.includes('503')) ||
                message.includes(
                    'Failed to load resource: the server responded with a status of 503',
                ),
        );
        expect(expectedConsole.length).toBeGreaterThan(0);
        expect(expectedConsole).toHaveLength(diagnostics.consoleErrors.length);
        expect(diagnostics.pageErrors).toEqual([]);
        expect(diagnostics.failedRequests).toEqual([]);
        expect(diagnostics.blockedExternal).toEqual([]);
    } finally {
        await cleanupFeatureFixture(context, diagnostics, phi, testInfo);
    }
});

test('M2 local toggles work when the visibility preference read throws', async ({
    browser,
}, testInfo) => {
    test.setTimeout(180_000);
    const phi = await startDesktopFixture();
    let context: Awaited<ReturnType<Browser['newContext']>> | undefined;
    let page: Page | undefined;
    let diagnostics: PageDiagnostics | undefined;
    try {
        ({ context, page, diagnostics } = await newFeaturePage(browser, phi));
        await page.addInitScript(() => {
            const getItem = Storage.prototype.getItem;
            Storage.prototype.getItem = function (key) {
                if (key === 'phi_sidebar_hidden')
                    throw new DOMException('blocked', 'SecurityError');
                return getItem.call(this, key);
            };
        });
        await waitForInitialized(page, phi);
        const toggle = page.locator('#desktop-sidebar-toggle');
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        expectCleanDiagnostics(diagnostics);
    } finally {
        await cleanupFeatureFixture(context, diagnostics, phi, testInfo);
    }
});

test('M2 local toggles work when the visibility preference write throws', async ({
    browser,
}, testInfo) => {
    test.setTimeout(180_000);
    const phi = await startDesktopFixture();
    let context: Awaited<ReturnType<Browser['newContext']>> | undefined;
    let page: Page | undefined;
    let diagnostics: PageDiagnostics | undefined;
    try {
        ({ context, page, diagnostics } = await newFeaturePage(browser, phi));
        await page.addInitScript(() => {
            const setItem = Storage.prototype.setItem;
            Storage.prototype.setItem = function (key, value) {
                if (key === 'phi_sidebar_hidden')
                    throw new DOMException('full', 'QuotaExceededError');
                return setItem.call(this, key, value);
            };
        });
        await waitForInitialized(page, phi);
        const toggle = page.locator('#desktop-sidebar-toggle');
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        expectCleanDiagnostics(diagnostics);
    } finally {
        await cleanupFeatureFixture(context, diagnostics, phi, testInfo);
    }
});

test('M2 offline visibility changes preserve a staged draft', async ({
    browser,
    request,
}, testInfo) => {
    test.setTimeout(180_000);
    const phi = await startDesktopFixture();
    let context: Awaited<ReturnType<Browser['newContext']>> | undefined;
    let page: Page | undefined;
    let diagnostics: PageDiagnostics | undefined;
    try {
        ({ context, page, diagnostics } = await newFeaturePage(browser, phi));
        await waitForInitialized(page, phi);
        const paneId = await launchShell(page);
        const marker = `sidebar-online-${Date.now()}`;
        await sendAndCheckMarker(page, phi, paneId, marker, diagnostics);
        await page.locator('#direct-mode-toggle').click();
        const textarea = page.locator('#input-textarea');
        await expect(textarea).toBeVisible();
        const draft = `unsent-sidebar-draft-${Date.now()}`;
        await textarea.fill(draft);
        await verifyPinDiagnostics(diagnostics, request, phi, paneId);

        const apiPostsBefore = diagnostics.requests.filter(
            (entry) =>
                entry.method === 'POST' && entry.path === '/api/terminals',
        ).length;
        const failedBefore = diagnostics.failedRequests.length;
        await context.setOffline(true);
        await page.getByRole('button', { name: 'Hide sessions' }).click();
        await textarea.fill(`${draft}-edited`);
        const offlineFetch = await page.evaluate(async () => {
            try {
                await fetch('/api/config?desktop-sidebar-offline-probe=1', {
                    cache: 'no-store',
                });
                return 'unexpected response';
            } catch (error) {
                return String(error);
            }
        });
        expect(offlineFetch).toContain('TypeError');
        await expect
            .poll(() => diagnostics!.failedRequests.length, { timeout: 5_000 })
            .toBeGreaterThan(failedBefore);
        const offlineFailures = diagnostics.failedRequests.slice(failedBefore);
        expect(
            offlineFailures.every(
                (failure) =>
                    failure.origin === new URL(phi.url).origin &&
                    failure.error === 'net::ERR_INTERNET_DISCONNECTED',
            ),
        ).toBe(true);
        await context.setOffline(false);
        await expect(textarea).toHaveValue(`${draft}-edited`);
        await expect(page.locator('html')).toHaveClass(
            /desktop-sidebar-hidden/,
        );
        expect(
            diagnostics.requests.filter(
                (entry) =>
                    entry.method === 'POST' && entry.path === '/api/terminals',
            ),
        ).toHaveLength(apiPostsBefore);
        expect(readInputLog(inputLog(phi))).toBe(`${marker}\n`);
        expect(diagnostics.pageErrors).toEqual([]);
        expect(diagnostics.blockedExternal).toEqual([]);
    } finally {
        await cleanupFeatureFixture(context, diagnostics, phi, testInfo);
    }
});

test('M2 locked authentication still blocks protected APIs and the toggle', async ({
    browser,
}, testInfo) => {
    test.setTimeout(180_000);
    const phi = await startDesktopFixture();
    let context: Awaited<ReturnType<Browser['newContext']>> | undefined;
    let page: Page | undefined;
    let diagnostics: PageDiagnostics | undefined;
    try {
        ({ context, page, diagnostics } = await newFeaturePage(browser, phi));
        await page.route('**/api/auth/status', (route) =>
            route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({
                    enabled: true,
                    authenticated: false,
                    version: 'v1',
                    algorithm: 'pbkdf2-sha256',
                    iterations: 600000,
                    salt: 'EREREREREREREREREREREQ',
                    challenge: 'one-time-challenge',
                }),
            }),
        );
        await page.goto(phi.url);
        await expect(page.locator('.access-auth-overlay')).toBeVisible();
        const hitTarget = await page
            .locator('#desktop-sidebar-toggle')
            .evaluate((button) => {
                const rect = button.getBoundingClientRect();
                return Boolean(
                    document
                        .elementFromPoint(
                            rect.x + rect.width / 2,
                            rect.y + rect.height / 2,
                        )
                        ?.closest('.access-auth-overlay'),
                );
            });
        expect(hitTarget).toBe(true);
        expect(
            diagnostics.requests.filter(
                (entry) =>
                    entry.path.startsWith('/api/') &&
                    entry.path !== '/api/auth/status',
            ),
        ).toEqual([]);
        expect(diagnostics.websockets).toEqual([]);
        expect(diagnostics.pageErrors).toEqual([]);
        expect(diagnostics.httpFailures).toEqual([]);
        expect(diagnostics.failedRequests).toEqual([]);
        expect(diagnostics.blockedExternal).toEqual([]);
    } finally {
        await cleanupFeatureFixture(context, diagnostics, phi, testInfo);
    }
});

test('M2 responsive mouse and touch layouts preserve desktop state and keyboard input', async ({
    browser,
    request,
}, testInfo) => {
    test.setTimeout(180_000);
    const phi = await startDesktopFixture();
    const contexts: Awaited<ReturnType<Browser['newContext']>>[] = [];
    const diagnosticsList: PageDiagnostics[] = [];
    let paneId = '';
    try {
        const desktop = await newFeaturePage(browser, phi);
        contexts.push(desktop.context);
        diagnosticsList.push(desktop.diagnostics);
        await waitForInitialized(desktop.page, phi);
        paneId = await launchShell(desktop.page);
        await closeDiffPanelForSidebarCoverage(desktop.page);
        const desktopToggle = desktop.page.locator('#desktop-sidebar-toggle');
        const mobileToggle = desktop.page.locator('#mobile-sidebar-toggle');
        await expect(desktopToggle).toHaveText('<<');
        await expectRightAligned(desktopToggle);
        await desktopToggle.hover();
        await desktopToggle.focus();
        await expect(desktop.page.locator('#self-hud-popover')).toBeHidden();

        for (const scheme of ['light', 'dark'] as const) {
            await desktop.page.emulateMedia({ colorScheme: scheme });
            for (const accent of ['purple', 'white'] as const) {
                const resolved = await desktop.page.evaluate(async (color) => {
                    const { applyThemeTokens } = await import(
                        new URL('/theme.js', location.href).href
                    );
                    return applyThemeTokens(color).accent;
                }, accent);
                expect(
                    await desktop.page.evaluate(() =>
                        getComputedStyle(document.documentElement)
                            .getPropertyValue('--accent')
                            .trim(),
                    ),
                ).toBe(resolved);
                const radii = await desktop.page.evaluate(() => ({
                    toggle: getComputedStyle(
                        document.querySelector('#desktop-sidebar-toggle')!,
                    ).borderRadius,
                    peer: getComputedStyle(
                        document.querySelector('#header-clipboard-btn')!,
                    ).borderRadius,
                }));
                expect(radii.toggle).toBe(radii.peer);
            }
        }

        await desktopToggle.click();
        await expect(desktop.page.locator('html')).toHaveClass(
            /desktop-sidebar-hidden/,
        );
        await expect(desktopToggle).toHaveText('>>');
        const restoreGap = await desktopToggle.evaluate((button) => {
            const tabs = document.querySelector('#tabs-container');
            if (!tabs) throw new Error('Missing terminal tabs');
            return (
                tabs.getBoundingClientRect().left -
                button.getBoundingClientRect().right
            );
        });
        expect(restoreGap).toBeGreaterThanOrEqual(0);
        expect(restoreGap).toBeLessThanOrEqual(12);
        for (const viewport of [
            { width: 1023, height: 800 },
            { width: 1024, height: 800 },
            { width: 1200, height: 1500 },
            { width: 1440, height: 900 },
        ]) {
            await desktop.page.setViewportSize(viewport);
            const drawer =
                viewport.width <= 1023 ||
                viewport.height / viewport.width >= 1.1;
            if (drawer) {
                await expect(desktopToggle).toBeHidden();
                await expect(mobileToggle).toBeVisible();
                await expect(desktop.page.locator('html')).not.toHaveClass(
                    /desktop-sidebar-hidden/,
                );
                await expect(
                    desktop.page.locator('#sidebar-panel'),
                ).not.toHaveClass(/drawer-open/);
                await expect
                    .poll(
                        () =>
                            desktop.page
                                .locator('#sidebar-panel')
                                .evaluate(
                                    (el) => el.getBoundingClientRect().right,
                                ),
                        { timeout: 5_000 },
                    )
                    .toBeLessThanOrEqual(1);
                await mobileToggle.click();
                await expect(
                    desktop.page.locator('#sidebar-panel'),
                ).toHaveClass(/drawer-open/);
                await expect(
                    desktop.page.locator('#sidebar-panel'),
                ).toHaveAttribute('data-panel-mode', 'sessions');
                await mobileToggle.click();
                await expect
                    .poll(
                        () =>
                            desktop.page
                                .locator('#sidebar-panel')
                                .evaluate(
                                    (el) => el.getBoundingClientRect().right,
                                ),
                        { timeout: 5_000 },
                    )
                    .toBeLessThanOrEqual(1);
            } else {
                await expect(desktopToggle).toBeVisible();
                await expect(mobileToggle).toBeHidden();
                await expect(desktop.page.locator('html')).toHaveClass(
                    /desktop-sidebar-hidden/,
                );
                await expect(
                    desktop.page.locator('#sidebar-panel'),
                ).not.toHaveClass(/drawer-open/);
            }
            const overflow = await desktop.page.evaluate(
                () =>
                    document.documentElement.scrollWidth -
                    document.documentElement.clientWidth,
            );
            expect(overflow).toBeLessThanOrEqual(1);
        }
        await verifyPinDiagnostics(desktop.diagnostics, request, phi, paneId);
        contexts.splice(contexts.indexOf(desktop.context), 1);
        await desktop.context.close();

        const touch = await newFeaturePage(
            browser,
            phi,
            { width: 1440, height: 900 },
            true,
        );
        contexts.push(touch.context);
        diagnosticsList.push(touch.diagnostics);
        await waitForInitialized(touch.page, phi);
        await closeDiffPanelForSidebarCoverage(touch.page);
        expect(
            await touch.page.evaluate(
                () => matchMedia('(pointer: coarse)').matches,
            ),
        ).toBe(true);
        const activePaneId = await touch.page
            .locator('#tabs-container .tab.active')
            .getAttribute('data-pane-id');
        expect(activePaneId).not.toBeNull();
        const touchPaneId = activePaneId!;
        expect(touchPaneId).toBe(paneId);
        await expect(
            touch.page.locator(`#term-${touchPaneId} .xterm`),
        ).toBeVisible();
        await expect
            .poll(
                async () =>
                    (await terminalState(touch.page, touchPaneId))?.lines.join(
                        '\n',
                    ) ?? '',
                { timeout: 15_000 },
            )
            .toContain('sidebar fixture ready');
        const touchDesktopToggle = touch.page.locator(
            '#desktop-sidebar-toggle',
        );
        const touchMobileToggle = touch.page.locator('#mobile-sidebar-toggle');
        await touchDesktopToggle.click();
        await expect(touch.page.locator('html')).toHaveClass(
            /desktop-sidebar-hidden/,
        );

        for (const viewport of [
            { width: 390, height: 844 },
            { width: 1360, height: 400 },
        ]) {
            await touch.page.setViewportSize(viewport);
            await expect(touchDesktopToggle).toBeHidden();
            await expect(touchMobileToggle).toBeVisible();
            await expect(touch.page.locator('html')).not.toHaveClass(
                /desktop-sidebar-hidden/,
            );
            await expect
                .poll(
                    () =>
                        touch.page
                            .locator('#sidebar-panel')
                            .evaluate((el) => el.getBoundingClientRect().right),
                    { timeout: 5_000 },
                )
                .toBeLessThanOrEqual(1);
            await touchMobileToggle.tap();
            await expect(touch.page.locator('#sidebar-panel')).toHaveClass(
                /drawer-open/,
            );
            await expect(touch.page.locator('#drawer-panel-title')).toHaveText(
                'TABS',
            );
            await touch.page.locator('#drawer-open-sessions').tap();
            await expect(touch.page.locator('#drawer-panel-title')).toHaveText(
                'SESSIONS',
            );
            await touch.page.locator('#drawer-back-to-tabs').tap();
            await expect(touch.page.locator('#drawer-panel-title')).toHaveText(
                'TABS',
            );
            await touchMobileToggle.tap();
            await expect
                .poll(
                    () =>
                        touch.page
                            .locator('#sidebar-panel')
                            .evaluate((el) => el.getBoundingClientRect().right),
                    { timeout: 5_000 },
                )
                .toBeLessThanOrEqual(1);
            const overflow = await touch.page.evaluate(
                () =>
                    document.documentElement.scrollWidth -
                    document.documentElement.clientWidth,
            );
            expect(overflow).toBeLessThanOrEqual(1);
        }

        await touch.page.setViewportSize({ width: 1440, height: 900 });
        await expect(touchDesktopToggle).toBeVisible();
        await expect(touchDesktopToggle).toHaveAttribute(
            'aria-expanded',
            'false',
        );
        await expect(touch.page.locator('html')).toHaveClass(
            /desktop-sidebar-hidden/,
        );
        expect(
            await touch.page.evaluate(
                () =>
                    (
                        document.querySelector(
                            '#input-textarea',
                        ) as HTMLTextAreaElement
                    ).value,
            ),
        ).toBe('');
        const input = inputLog(phi);
        expect(readInputLog(input)).toBe('');

        await touchDesktopToggle.focus();
        await touch.page.keyboard.press('Enter');
        await expect(touchDesktopToggle).toHaveAttribute(
            'aria-expanded',
            'true',
        );
        await expectRightAligned(touchDesktopToggle);
        expect(
            await touchDesktopToggle.evaluate((button) =>
                button.matches(':focus-visible'),
            ),
        ).toBe(true);
        await touchDesktopToggle.focus();
        await touch.page.keyboard.press('Space');
        await expect(touchDesktopToggle).toHaveAttribute(
            'aria-expanded',
            'false',
        );
        await touchDesktopToggle.focus();
        await touch.page.keyboard.press('Tab');
        expect(
            await touch.page.evaluate(() => document.activeElement?.id),
        ).not.toBe('desktop-sidebar-toggle');
        await touchDesktopToggle.focus();
        await touch.page.keyboard.press('Shift+Tab');
        expect(
            await touch.page.evaluate(() => document.activeElement?.id),
        ).not.toBe('desktop-sidebar-toggle');
        expect(readInputLog(input)).toBe('');
        const keyboardMarker = `sidebar-keyboard-${Date.now()}`;
        await sendAndCheckMarker(
            touch.page,
            phi,
            touchPaneId,
            keyboardMarker,
            touch.diagnostics,
        );
        expect(readInputLog(input)).toBe(`${keyboardMarker}\n`);
        const evidence = {
            marker: keyboardMarker,
            terminal: await terminalState(touch.page, touchPaneId),
            lastResize: touch.diagnostics.resizes
                .filter((size) => size.paneId === touchPaneId)
                .at(-1),
            inputLog: readInputLog(input),
        };
        await testInfo.attach('responsive-terminal.json', {
            body: Buffer.from(JSON.stringify(evidence, null, 2)),
            contentType: 'application/json',
        });
        await verifyPinDiagnostics(
            touch.diagnostics,
            request,
            phi,
            touchPaneId,
        );
    } finally {
        try {
            for (const context of contexts) await context.setOffline(false);
        } finally {
            try {
                for (const context of contexts) await context.close();
            } finally {
                try {
                    for (const [
                        index,
                        diagnostics,
                    ] of diagnosticsList.entries())
                        await testInfo.attach(
                            `browser-diagnostics-${index + 1}.json`,
                            {
                                body: Buffer.from(
                                    JSON.stringify(diagnostics, null, 2),
                                ),
                                contentType: 'application/json',
                            },
                        );
                    if (existsSync(phi.logPath))
                        await testInfo.attach('phi-server.log', {
                            body: readFileSync(phi.logPath),
                            contentType: 'text/plain',
                        });
                } finally {
                    await phi.stop();
                }
            }
        }
    }
});
