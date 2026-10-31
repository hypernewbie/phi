import {
    copyFileSync,
    mkdirSync,
    realpathSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

const SESSION_COUNT = 60;
let phi: PhiServer | undefined;
let workspace = '';

interface SmokeEvents {
    errors: string[];
    requests: string[];
    responses: string[];
    foreignOrigins: string[];
}

function observeSmoke(page: Page): SmokeEvents {
    const events: SmokeEvents = {
        errors: [],
        requests: [],
        responses: [],
        foreignOrigins: [],
    };
    page.on('pageerror', (error) => events.errors.push(error.message));
    page.on('console', (message) => {
        if (message.type() === 'error') events.errors.push(message.text());
    });
    page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.origin !== new URL(phi!.url).origin)
            events.foreignOrigins.push(url.origin);
    });
    page.on('requestfailed', (request) => {
        events.requests.push(
            `${new URL(request.url()).pathname}: ${request.failure()?.errorText}`,
        );
    });
    page.on('response', (response) => {
        if (response.status() >= 400) {
            const url = new URL(response.url());
            const coder = url.searchParams.get('coder');
            events.responses.push(
                `${response.status()} ${url.pathname}${coder ? `?coder=${coder}` : ''}`,
            );
        }
    });
    return events;
}

interface ResizeTerminal {
    element?: HTMLElement;
    rows: number;
    cols: number;
    buffer: {
        active: {
            baseY: number;
            viewportY: number;
            length: number;
            getLine(
                row: number,
            ): { translateToString(trimRight?: boolean): string } | undefined;
        };
    };
    getSelection(): string;
}

interface ResizeTerminalWindow extends Window {
    Terminal: new (options: Record<string, unknown>) => ResizeTerminal;
    resizeTerms: ResizeTerminal[];
}

async function captureTerminal(page: Page) {
    await page.addInitScript(() => {
        const win = window as unknown as ResizeTerminalWindow;
        win.resizeTerms = [];
        let NativeTerminal: ResizeTerminalWindow['Terminal'];
        Object.defineProperty(win, 'Terminal', {
            configurable: true,
            get: () => NativeTerminal,
            set: (Base: ResizeTerminalWindow['Terminal']) => {
                NativeTerminal = class extends Base {
                    constructor(options: Record<string, unknown>) {
                        super(options);
                        win.resizeTerms.push(this);
                    }
                };
            },
        });
    });
}

async function terminalSnapshot(page: Page, paneId: string) {
    return page.evaluate((id) => {
        const win = window as unknown as ResizeTerminalWindow;
        const term = win.resizeTerms.find((candidate) =>
            candidate.element?.closest(`#term-${id}`),
        );
        if (!term) return null;
        const active = term.buffer.active;
        const lines = Array.from(
            { length: active.length },
            (_, row) => active.getLine(row)?.translateToString(true) ?? '',
        );
        return {
            text: lines.join('\n'),
            selection: term.getSelection(),
            baseY: active.baseY,
            rows: term.rows,
            cols: term.cols,
        };
    }, paneId);
}

async function startResizeFixture(): Promise<PhiServer> {
    return startPhi({
        env: { PHI_SHUTDOWN_PTY_GRACE: '150ms', PHI_SHUTDOWN_GRACE: '1s' },
        setup(dir) {
            const workspaceDir = join(dir, 'workspace');
            mkdirSync(workspaceDir, { recursive: true });
            workspace = realpathSync(workspaceDir);

            const home = join(dir, 'home');
            const phiDir = join(home, '.phi');
            const backends = join(phiDir, 'backends');
            mkdirSync(backends, { recursive: true });
            writeFileSync(
                join(phiDir, 'config.json'),
                JSON.stringify({
                    workspaces: [workspace],
                    active_cwd: workspace,
                    session_list_page_size: 25,
                }),
            );

            const command = join(dir, 'fixture-bash');
            writeFileSync(
                command,
                '#!/bin/sh\nprintf "bash fixture ready\\r\\n"\nexec cat\n',
                { mode: 0o755 },
            );
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
                        title:
                            index === 0 ? 'Tab 1' : 'Long tab title '.repeat(8),
                    })),
                ),
            );

            const normalized = workspace.replaceAll('\\', '/');
            const encoded = normalized
                .replace(/^\/+|\/+$/g, '')
                .replace(/:/g, '-')
                .replace(/\//g, '-');
            const sessionsDir = join(
                home,
                '.pi',
                'agent',
                'sessions',
                `--${encoded}--`,
            );
            mkdirSync(sessionsDir, { recursive: true });
            const base = Date.UTC(2026, 9, 1, 12, 0, 0);
            for (let i = 0; i < SESSION_COUNT; i++) {
                const id = `resize-${String(i).padStart(2, '0')}`;
                const body = [
                    JSON.stringify({
                        type: 'session',
                        version: 3,
                        id,
                        cwd: workspace,
                    }),
                    JSON.stringify({
                        type: 'session_info',
                        name: `Resize session ${String(i).padStart(2, '0')}`,
                    }),
                ].join('\n');
                const file = join(
                    sessionsDir,
                    `f-${String(SESSION_COUNT - 1 - i).padStart(2, '0')}.jsonl`,
                );
                writeFileSync(file, `${body}\n`);
                const mtime = new Date(base - i * 60_000);
                utimesSync(file, mtime, mtime);
            }
        },
    });
}

test.beforeAll(async () => {
    phi = await startResizeFixture();
    const response = await fetch(`${phi.url}/healthz`, {
        signal: AbortSignal.timeout(5000),
    });
    const health = await response.text();
    console.log(
        `resize fixture ${JSON.stringify({ dir: phi.dir, url: phi.url, healthStatus: response.status, health })}`,
    );
    expect(response.ok).toBe(true);
    expect(health.trim()).toBe('ok');
});

test.afterAll(async () => {
    if (!phi) return;
    try {
        if (process.env.RESIZE_EVIDENCE) {
            copyFileSync(
                phi.logPath,
                join(process.env.RESIZE_EVIDENCE, 'implementation-fixture.log'),
            );
        }
    } finally {
        await phi.stop();
    }
});

async function openDesktopPage(
    browser: Browser,
    captureTerminalState = false,
): Promise<{
    context: Awaited<ReturnType<Browser['newContext']>>;
    page: Page;
    smoke: SmokeEvents | null;
}> {
    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
    });
    try {
        const page = await context.newPage();
        const smoke = captureTerminalState ? observeSmoke(page) : null;
        if (captureTerminalState) await captureTerminal(page);
        await page.goto(phi!.url);
        await page
            .locator('#sidebar-drawer-resizer')
            .waitFor({ state: 'attached' });
        await page
            .locator('#diff-drawer-resizer')
            .waitFor({ state: 'attached' });
        await page.evaluate(() => document.fonts.ready);
        const diffPanel = page.locator('#diff-panel');
        if (await diffPanel.evaluate((el) => el.classList.contains('hidden'))) {
            await page.locator('#header-diff-toggle-btn').click();
        }
        await expect(diffPanel).not.toHaveClass(/hidden/);
        return { context, page, smoke };
    } catch (error) {
        await context.close();
        throw error;
    }
}

async function openResponsivePage(
    browser: Browser,
    width: number,
    height: number,
    touch: boolean,
    captureTerminalState = false,
    initialDrawerLeftWidth?: number,
) {
    const context = await browser.newContext({
        viewport: { width, height },
        ...(touch ? { isMobile: true, hasTouch: true } : {}),
    });
    try {
        const page = await context.newPage();
        const smoke = captureTerminalState ? observeSmoke(page) : null;
        if (captureTerminalState) await captureTerminal(page);
        if (initialDrawerLeftWidth !== undefined) {
            await page.addInitScript(
                (width) =>
                    localStorage.setItem(
                        'phi_drawer_left_width',
                        String(width),
                    ),
                initialDrawerLeftWidth,
            );
        }
        await page.goto(phi!.url);
        await page
            .locator('#sidebar-drawer-resizer')
            .waitFor({ state: 'attached' });
        await page
            .locator('#diff-drawer-resizer')
            .waitFor({ state: 'attached' });
        await page.evaluate(() => document.fonts.ready);
        expect(
            await page.evaluate(() => matchMedia('(pointer: coarse)').matches),
        ).toBe(touch);
        return { context, page, smoke };
    } catch (error) {
        await context.close();
        throw error;
    }
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

async function openDrawer(page: Page, side: 'left' | 'right') {
    const panelSelector = side === 'left' ? '#sidebar-panel' : '#diff-panel';
    const panel = page.locator(panelSelector);
    if (side === 'left') {
        if (
            !(await panel.evaluate((el) =>
                el.classList.contains('drawer-open'),
            ))
        ) {
            await page.locator('#mobile-sidebar-toggle').click();
        }
        await expect(panel).toHaveClass(/drawer-open/);
    } else {
        if (
            await panel.evaluate(
                (el) =>
                    el.classList.contains('hidden') ||
                    !el.classList.contains('mobile-open'),
            )
        ) {
            await page.locator('#header-diff-toggle-btn').click();
        }
        await expect(panel).not.toHaveClass(/hidden/);
        await expect(panel).toHaveClass(/mobile-open/);
    }
    await settlePanel(page, panelSelector);
    return panel;
}

async function closeDrawer(page: Page, side: 'left' | 'right') {
    const panelSelector = side === 'left' ? '#sidebar-panel' : '#diff-panel';
    const panel = page.locator(panelSelector);
    if (side === 'left') {
        await page.locator('#mobile-sidebar-toggle').click();
        await expect(panel).not.toHaveClass(/drawer-open/);
    } else {
        await page.locator('#header-diff-toggle-btn').click();
        await expect(panel).toHaveClass(/hidden/);
    }
    await settlePanel(page, panelSelector);
}

async function openPiSessions(page: Page) {
    const drawerLayout = await page
        .locator('#left-resize-handle')
        .evaluate((handle) => getComputedStyle(handle).display === 'none');
    const compact = await page.evaluate(
        () =>
            matchMedia(
                '(max-width: 768px), (max-height: 500px) and (orientation: landscape) and (pointer: coarse)',
            ).matches,
    );
    if (drawerLayout) await openDrawer(page, 'left');
    if (compact) await page.locator('#drawer-open-sessions').click();
    if (drawerLayout) {
        await expect(page.locator('#sidebar-panel')).toHaveAttribute(
            'data-panel-mode',
            'sessions',
        );
    }
    await page.locator('#coder-selector .coder-tab[data-coder="pi"]').click();
    const section = page.locator(
        `.worktree-section[data-worktree-path="${workspace}"]`,
    );
    await expect(section).toBeVisible({ timeout: 30_000 });
    await expect(section.locator('.session-item')).toHaveCount(25, {
        timeout: 30_000,
    });
    await expect(section.locator('.session-page-label')).toHaveText('Page 1');
    await expect(section.locator('.session-page[data-page="1"]')).toBeEnabled();
    await expect(section.locator('.session-item').first()).toContainText(
        'Resize session 00',
    );
    return section;
}

async function selectTerminal(page: Page) {
    const compact = await page.evaluate(
        () =>
            matchMedia(
                '(max-width: 768px), (max-height: 500px) and (orientation: landscape) and (pointer: coarse)',
            ).matches,
    );
    if (compact) {
        await openDrawer(page, 'left');
        await page
            .locator(
                '#drawer-tabs-body .hostname-dropdown-row[data-pane-id="t1"] .hostname-dropdown-select-btn',
            )
            .click();
        await expect(page.locator('#sidebar-panel')).not.toHaveClass(
            /drawer-open/,
        );
    } else {
        await page.locator('.tab[data-pane-id="t1"]').click();
    }
    await expect(page.locator('#tabs-container .tab.active')).toHaveAttribute(
        'data-pane-id',
        't1',
    );
    await expect(page.locator('#term-t1')).toBeVisible();
}

async function assertTerminalInputAndSelection(page: Page) {
    const ready = 'bash fixture ready';
    const snapshot = () => terminalSnapshot(page, 't1');
    await expect
        .poll(async () => (await snapshot())?.text ?? '')
        .toContain(ready);

    const marker = `RESIZE_INPUT_${Date.now()}`;
    await page.locator('#term-t1 .xterm-screen').click({
        position: { x: 12, y: 12 },
    });
    await page.keyboard.type(marker);
    await page.keyboard.press('Enter');
    await expect
        .poll(async () => (await snapshot())?.text ?? '')
        .toContain(marker);

    const selection = await page.evaluate((text) => {
        const win = window as unknown as ResizeTerminalWindow;
        const term = win.resizeTerms.find((candidate) =>
            candidate.element?.closest('#term-t1'),
        );
        if (!term) return null;
        const active = term.buffer.active;
        const visibleLines = Array.from({ length: term.rows }, (_, row) => ({
            row,
            text:
                active
                    .getLine(active.viewportY + row)
                    ?.translateToString(true) ?? '',
        }));
        const line = visibleLines.find(({ text: value }) =>
            value.includes(text),
        );
        const screen = document.querySelector('#term-t1 .xterm-screen');
        if (!line || !screen || term.cols < text.length) return null;
        const rect = screen.getBoundingClientRect();
        const cellWidth = rect.width / term.cols;
        const cellHeight = rect.height / term.rows;
        const startColumn = line.text.indexOf(text);
        return {
            startX: rect.left + (startColumn + 0.2) * cellWidth,
            endX: rect.left + (startColumn + text.length - 0.2) * cellWidth,
            y: rect.top + (line.row + 0.5) * cellHeight,
        };
    }, ready);
    expect(selection).not.toBeNull();
    await page.mouse.move(selection!.startX, selection!.y);
    await page.mouse.down();
    try {
        await page.mouse.move(selection!.endX, selection!.y, { steps: 8 });
    } finally {
        await page.mouse.up();
    }
    await expect
        .poll(async () => (await snapshot())?.selection ?? '')
        .toContain(ready);
}

async function assertSessionListScroll(page: Page, touch: boolean) {
    const scroller = page.locator('#sidebar-panel .session-list-container');
    await expect(scroller).toBeVisible();
    const dimensions = await scroller.evaluate((el) => ({
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        rect: el.getBoundingClientRect().toJSON(),
    }));
    expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
    const panel = page.locator('#sidebar-panel');
    const beforeWidth = await panel.evaluate(
        (el) => el.getBoundingClientRect().width,
    );
    await scroller.evaluate((el) => {
        el.scrollTop = 0;
    });

    if (touch) {
        const start = {
            x: dimensions.rect.x + dimensions.rect.width * 0.5,
            y: dimensions.rect.y + dimensions.rect.height * 0.8,
        };
        await dispatchTouchPath(page, [
            start,
            { x: start.x, y: start.y - 60 },
            { x: start.x, y: start.y - 130 },
            { x: start.x, y: start.y - 210 },
        ]);
    } else {
        await page.mouse.move(
            dimensions.rect.x + dimensions.rect.width * 0.5,
            dimensions.rect.y + dimensions.rect.height * 0.5,
        );
        await page.mouse.wheel(0, 420);
    }
    await expect
        .poll(() => scroller.evaluate((el) => el.scrollTop), { timeout: 5000 })
        .toBeGreaterThan(0);
    const afterWidth = await panel.evaluate(
        (el) => el.getBoundingClientRect().width,
    );
    expect(Math.abs(afterWidth - beforeWidth)).toBeLessThan(0.05);
    if (!touch) {
        const scrollerRightEdgeHitsResizeHandle = await scroller.evaluate(
            (el) => {
                const rect = el.getBoundingClientRect();
                return (
                    document
                        .elementFromPoint(
                            rect.right - 1,
                            rect.top + rect.height / 2,
                        )
                        ?.closest('.resize-handle') !== null
                );
            },
        );
        expect(scrollerRightEdgeHitsResizeHandle).toBe(false);
    }
}

async function assertClosedDrawerEdges(page: Page) {
    const hits = await page.evaluate(() => {
        const selector = '.drawer-resize-handle';
        const ys = [0.1, 0.5, 0.9].map(
            (fraction) => 48 + (innerHeight - 58) * fraction,
        );
        const xs = [
            [1, 5, 9],
            [innerWidth - 10, innerWidth - 6, innerWidth - 2],
        ];
        return ys.flatMap((y) =>
            xs.flatMap((edge) =>
                edge.map(
                    (x) =>
                        document.elementFromPoint(x, y)?.closest(selector)
                            ?.id ?? null,
                ),
            ),
        );
    });
    expect(hits).toEqual(Array(18).fill(null));
}

async function dispatchTouchPath(
    page: Page,
    points: Array<{ x: number; y: number }>,
    cancelAtEnd = false,
    moveDelayMs = 0,
) {
    const session = await page.context().newCDPSession(page);
    let active = false;
    try {
        await session.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ ...points[0], id: 1 }],
        });
        active = true;
        for (const point of points.slice(1)) {
            await session.send('Input.dispatchTouchEvent', {
                type: 'touchMove',
                touchPoints: [{ ...point, id: 1 }],
            });
            if (moveDelayMs > 0) await page.waitForTimeout(moveDelayMs);
        }
        await session.send('Input.dispatchTouchEvent', {
            type: cancelAtEnd ? 'touchCancel' : 'touchEnd',
            touchPoints: [],
        });
        active = false;
    } finally {
        if (active) {
            try {
                await session.send('Input.dispatchTouchEvent', {
                    type: 'touchCancel',
                    touchPoints: [],
                });
            } catch {
                // Preserve the original test failure if the browser context closed.
            }
        }
        await session.detach();
    }
}

// The handle's inner strip overlaps drawer content, and a 1px test touch
// directly over an underlying button (e.g. a tab close button) can be
// retargeted to that button instead of starting a drag. Scan the handle
// for the y with the most clearance from drawer clickables.
async function drawerTouchPoint(
    page: Page,
    handleId: string,
    xFraction: number,
) {
    return page.locator(`#${handleId}`).evaluate((handle, fraction) => {
        const rect = handle.getBoundingClientRect();
        const x = rect.x + rect.width * fraction;
        const panel = handle.closest('.sidebar-panel, .diff-panel');
        const obstacles: {
            left: number;
            right: number;
            top: number;
            bottom: number;
        }[] = [];
        if (panel) {
            for (const el of panel.querySelectorAll(
                'button, a[href], input, select, textarea, .hostname-dropdown-row, .session-item',
            )) {
                const r = el.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) obstacles.push(r);
            }
        }
        const clearance = (y: number) => {
            let best = Infinity;
            for (const r of obstacles) {
                const dx = Math.max(r.left - x, 0, x - r.right);
                const dy = Math.max(r.top - y, 0, y - r.bottom);
                best = Math.min(best, Math.hypot(dx, dy));
            }
            return best;
        };
        let point = {
            x,
            y: rect.y + rect.height / 2,
            clearance: -1,
            width: rect.width,
        };
        for (let f = 0.05; f <= 0.95; f += 0.05) {
            const y = rect.y + rect.height * f;
            const c = clearance(y);
            if (c > point.clearance)
                point = { x, y, clearance: c, width: rect.width };
        }
        return point;
    }, xFraction);
}

async function dragDrawerAndCheck(
    page: Page,
    side: 'left' | 'right',
    touch: boolean,
    xFraction: number,
    delta: number,
) {
    const handleId =
        side === 'left' ? 'sidebar-drawer-resizer' : 'diff-drawer-resizer';
    const panelId = side === 'left' ? 'sidebar-panel' : 'diff-panel';
    const preferenceKey =
        side === 'left' ? 'phi_drawer_left_width' : 'phi_drawer_right_width';
    const handle = page.locator(`#${handleId}`);
    const rect = await handle.boundingBox();
    if (!rect) throw new Error(`${handleId} has no rendered bounds`);
    const touchStart = touch
        ? await drawerTouchPoint(page, handleId, xFraction)
        : null;
    const start = touchStart ?? {
        x: rect.x + rect.width * xFraction,
        y: rect.y + rect.height / 2,
    };
    const before = await page
        .locator(`#${panelId}`)
        .evaluate((panel) => panel.getBoundingClientRect().width);
    const end = { x: start.x + delta, y: start.y };

    if (touch) {
        const points = Array.from({ length: 5 }, (_, index) => ({
            x: start.x + ((end.x - start.x) * (index + 1)) / 5,
            y: start.y,
        }));
        await dispatchTouchPath(page, [start, ...points]);
    } else {
        await page.mouse.move(start.x, start.y);
        await expect
            .poll(() =>
                handle.evaluate((el) => {
                    const grip = getComputedStyle(el, '::after');
                    return { width: grip.width, opacity: grip.opacity };
                }),
            )
            .toEqual({ width: '1px', opacity: '1' });
        await page.mouse.down();
        try {
            await page.mouse.move(end.x, end.y, { steps: 5 });
        } finally {
            await page.mouse.up();
        }
    }

    const after = await page
        .locator(`#${panelId}`)
        .evaluate((panel) => panel.getBoundingClientRect().width);
    const expectedDelta = side === 'left' ? delta : -delta;
    const error = Math.abs(after - before - expectedDelta);
    if (process.env.RESIZE_EVIDENCE)
        console.log(
            `drawer ${side} ${touch ? 'touch' : 'mouse'} ${JSON.stringify(page.viewportSize())}: hit ${rect.width}px, x=${xFraction}, delta=${delta}px, error=${error}px${touchStart ? `, clearance=${touchStart.clearance.toFixed(1)}px` : ''}`,
        );
    expect(error).toBeLessThan(1.5);
    const saved = await page.evaluate(
        (key) => localStorage.getItem(key),
        preferenceKey,
    );
    expect(saved).not.toBeNull();
    expect(Math.abs(Number(saved) - after)).toBeLessThan(0.05);
    return after;
}

async function dismissDrawerAndCheckRestore(
    page: Page,
    side: 'left' | 'right',
    touch: boolean,
) {
    const handleId =
        side === 'left' ? 'sidebar-drawer-resizer' : 'diff-drawer-resizer';
    const panelId = side === 'left' ? 'sidebar-panel' : 'diff-panel';
    const preferenceKey =
        side === 'left' ? 'phi_drawer_left_width' : 'phi_drawer_right_width';
    const handle = page.locator(`#${handleId}`);
    const rect = await handle.boundingBox();
    if (!rect) throw new Error(`${handleId} has no rendered bounds`);
    const touchStart = touch
        ? await drawerTouchPoint(page, handleId, 0.5)
        : null;
    const start = touchStart ?? {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
    };
    const end = {
        x: side === 'left' ? 50 : (await page.evaluate(() => innerWidth)) - 100,
        y: start.y,
    };
    const accepted = await page.evaluate(
        (key) => localStorage.getItem(key),
        preferenceKey,
    );
    expect(accepted).not.toBeNull();

    if (touch) {
        await dispatchTouchPath(page, [start, end]);
    } else {
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        try {
            // Jump directly into the dismissal preview so accepted width stays
            // the value captured above; intermediate moves are accepted resizes.
            await page.mouse.move(end.x, end.y);
            expect(
                await page.evaluate(
                    (key) => localStorage.getItem(key),
                    preferenceKey,
                ),
            ).toBe(accepted);
        } finally {
            await page.mouse.up();
        }
    }

    const panel = page.locator(`#${panelId}`);
    if (side === 'left') await expect(panel).not.toHaveClass(/drawer-open/);
    else await expect(panel).toHaveClass(/hidden/);
    await settlePanel(page, `#${panelId}`);
    await assertClosedDrawerEdges(page);
    expect(
        Math.abs(
            (await panel.evaluate((el) => el.getBoundingClientRect().width)) -
                Number(accepted),
        ),
    ).toBeLessThan(0.05);

    await openDrawer(page, side);
    expect(
        Math.abs(
            (await panel.evaluate((el) => el.getBoundingClientRect().width)) -
                Number(accepted),
        ),
    ).toBeLessThan(0.05);
    expect(
        await page.evaluate((key) => localStorage.getItem(key), preferenceKey),
    ).toBe(accepted);
    await closeDrawer(page, side);
}

async function cancelDrawerPreview(page: Page, side: 'left' | 'right') {
    const handleId =
        side === 'left' ? 'sidebar-drawer-resizer' : 'diff-drawer-resizer';
    const panelId = side === 'left' ? 'sidebar-panel' : 'diff-panel';
    const preferenceKey =
        side === 'left' ? 'phi_drawer_left_width' : 'phi_drawer_right_width';
    const handle = page.locator(`#${handleId}`);
    const rect = await handle.boundingBox();
    if (!rect) throw new Error(`${handleId} has no rendered bounds`);
    const start = await drawerTouchPoint(page, handleId, 0.5);
    const end = {
        x: side === 'left' ? 50 : (await page.evaluate(() => innerWidth)) - 100,
        y: start.y,
    };
    const accepted = await page.evaluate(
        (key) => localStorage.getItem(key),
        preferenceKey,
    );
    expect(accepted).not.toBeNull();

    await dispatchTouchPath(page, [start, end], true);

    const panel = page.locator(`#${panelId}`);
    if (side === 'left') await expect(panel).toHaveClass(/drawer-open/);
    else {
        await expect(panel).not.toHaveClass(/hidden/);
        await expect(panel).toHaveClass(/mobile-open/);
    }
    expect(
        Math.abs(
            (await panel.evaluate((el) => el.getBoundingClientRect().width)) -
                Number(accepted),
        ),
    ).toBeLessThan(0.05);
    expect(
        await page.evaluate((key) => localStorage.getItem(key), preferenceKey),
    ).toBe(accepted);
}

async function handleGeometry(page: Page, handleId: string) {
    return page.locator(`#${handleId}`).evaluate((handle) => {
        const rect = handle.getBoundingClientRect();
        const selector = '.resize-handle, .drawer-resize-handle';
        const hitId = (x: number, y: number) =>
            document.elementFromPoint(x, y)?.closest(selector)?.id ?? null;
        const samples = [];
        for (const xFraction of [0.05, 0.5, 0.95]) {
            for (const yFraction of [0.1, 0.5, 0.9]) {
                samples.push({
                    xFraction,
                    yFraction,
                    id: hitId(
                        rect.left + rect.width * xFraction,
                        rect.top + rect.height * yFraction,
                    ),
                });
            }
        }
        const outside = [];
        for (const yFraction of [0.1, 0.5, 0.9]) {
            const y = rect.top + rect.height * yFraction;
            outside.push(hitId(rect.left - 2, y), hitId(rect.right + 2, y));
        }
        return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            samples,
            outside,
        };
    });
}

async function dragAndCheck(
    page: Page,
    handleId: string,
    panelId: string,
    preferenceKey: string,
    xFraction: number,
    delta: number,
) {
    const handle = page.locator(`#${handleId}`);
    const rect = await handle.boundingBox();
    if (!rect) throw new Error(`${handleId} has no rendered bounds`);
    const startX = rect.x + rect.width * xFraction;
    const startY = rect.y + rect.height / 2;
    const before = await page
        .locator(`#${panelId}`)
        .evaluate((panel) => panel.getBoundingClientRect().width);

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    try {
        await page.mouse.move(startX + delta, startY, { steps: 4 });
    } finally {
        await page.mouse.up();
    }

    const after = await page
        .locator(`#${panelId}`)
        .evaluate((panel) => panel.getBoundingClientRect().width);
    const expectedDelta = handleId === 'left-resize-handle' ? delta : -delta;
    const error = Math.abs(after - before - expectedDelta);
    if (process.env.RESIZE_EVIDENCE)
        console.log(
            `docked ${handleId} ${JSON.stringify(page.viewportSize())}: hit ${rect.width}px, x=${xFraction}, delta=${delta}px, error=${error}px`,
        );
    expect(error).toBeLessThan(1.5);
    const widths = await page.evaluate(
        ({ key, id }) => ({
            saved: localStorage.getItem(key),
            inline: Number.parseFloat(document.getElementById(id)!.style.width),
        }),
        { key: preferenceKey, id: panelId },
    );
    expect(Math.abs(Number(widths.saved) - widths.inline)).toBeLessThan(0.05);
    return after;
}

async function assertOverlayCoversHandle(page: Page, handleId: string) {
    const box = await page.locator(`#${handleId}`).boundingBox();
    if (!box) throw new Error(`${handleId} has no rendered bounds`);
    const hit = await page.evaluate(
        ({ x, y }) => {
            const target = document.elementFromPoint(x, y);
            return {
                resizeHandle:
                    target?.closest('.resize-handle, .drawer-resize-handle')
                        ?.id ?? null,
                settingsOverlay: !!target?.closest('.settings-overlay'),
            };
        },
        { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    );
    expect(hit.settingsOverlay).toBe(true);
    expect(hit.resizeHandle).toBeNull();
}

async function assertResponsiveTopology(
    page: Page,
    sessionsDrawer: boolean,
    diffDrawer: boolean,
) {
    const leftDocked = page.locator('#left-resize-handle');
    const leftDrawer = page.locator('#sidebar-drawer-resizer');
    const rightDocked = page.locator('#right-resize-handle');
    const rightDrawer = page.locator('#diff-drawer-resizer');

    if (
        await page
            .locator('#sidebar-panel')
            .evaluate((el) => el.classList.contains('drawer-open'))
    ) {
        await closeDrawer(page, 'left');
    }
    if (
        !(await page
            .locator('#diff-panel')
            .evaluate((el) => el.classList.contains('hidden')))
    ) {
        await closeDrawer(page, 'right');
    }

    if (sessionsDrawer) {
        await expect(leftDocked).toHaveCSS('display', 'none');
        await expect(leftDrawer).not.toHaveCSS('display', 'none');
        await expect(leftDrawer).toHaveCSS('visibility', 'hidden');
        await expect(leftDrawer).toHaveCSS('pointer-events', 'none');
        await openDrawer(page, 'left');
        await expect(leftDrawer).toHaveCSS('visibility', 'visible');
        await expect(leftDrawer).not.toHaveCSS('pointer-events', 'none');
        await closeDrawer(page, 'left');
    } else {
        await expect(leftDocked).not.toHaveCSS('display', 'none');
        await expect(leftDrawer).toHaveCSS('display', 'none');
    }

    if (diffDrawer) {
        await expect(rightDocked).toHaveCSS('display', 'none');
        await expect(rightDrawer).not.toHaveCSS('display', 'none');
        await expect(rightDrawer).toHaveCSS('visibility', 'hidden');
        await expect(rightDrawer).toHaveCSS('pointer-events', 'none');
        await openDrawer(page, 'right');
        await expect(rightDrawer).toHaveCSS('visibility', 'visible');
        await expect(rightDrawer).not.toHaveCSS('pointer-events', 'none');
        await closeDrawer(page, 'right');
    } else {
        await openDrawer(page, 'right');
        await expect(rightDocked).not.toHaveCSS('display', 'none');
        await expect(rightDrawer).toHaveCSS('display', 'none');
    }

    const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
}

function isPageOneSessionsRequest(request: {
    method(): string;
    url(): string;
}) {
    const url = new URL(request.url());
    return (
        request.method() === 'GET' &&
        url.origin === new URL(phi!.url).origin &&
        url.pathname === '/api/sessions' &&
        url.searchParams.get('coder') === 'pi' &&
        url.searchParams.get('cwd') === workspace &&
        url.searchParams.get('limit') === '25' &&
        url.searchParams.get('offset') === '0'
    );
}

async function resizeBothPanels(page: Page, touch: boolean) {
    if (touch) {
        await openDrawer(page, 'left');
        await dragDrawerAndCheck(page, 'left', true, 0.5, 10);
        await closeDrawer(page, 'left');
        await openDrawer(page, 'right');
        await dragDrawerAndCheck(page, 'right', true, 0.5, -10);
        await closeDrawer(page, 'right');
    } else {
        await dragAndCheck(
            page,
            'left-resize-handle',
            'sidebar-panel',
            'phi_panel_left_width',
            0.5,
            10,
        );
        await dragAndCheck(
            page,
            'right-resize-handle',
            'diff-panel',
            'phi_panel_right_width',
            0.5,
            -10,
        );
    }
}

async function assertDrawerEdgeTouch(
    page: Page,
    side: 'left' | 'right',
    controlSelector: string,
    xFraction: number,
    delta: number,
    expectedWidthDelta?: number,
    expectedSaved?: string | null,
) {
    const handleId =
        side === 'left' ? 'sidebar-drawer-resizer' : 'diff-drawer-resizer';
    const panelId = side === 'left' ? 'sidebar-panel' : 'diff-panel';
    const preferenceKey =
        side === 'left' ? 'phi_drawer_left_width' : 'phi_drawer_right_width';
    const control = page.locator(controlSelector).first();
    await expect(control).toBeVisible();
    await control.scrollIntoViewIfNeeded();

    const start = await page.evaluate(
        ({
            handleId: id,
            side: drawerSide,
            selector,
            fraction,
            preference,
        }) => {
            const handle = document.getElementById(id);
            const panel = document.getElementById(
                drawerSide === 'left' ? 'sidebar-panel' : 'diff-panel',
            );
            const controlElement = document.querySelector(selector);
            if (!handle || !panel || !controlElement)
                throw new Error(`Missing drawer edge target: ${selector}`);

            const handleRect = handle.getBoundingClientRect();
            const controlRect = controlElement.getBoundingClientRect();
            const state = window as unknown as {
                __drawerEdgeEvents?: {
                    type: string;
                    target: string;
                    pointerType: string;
                }[];
                __drawerEdgeEventsBound?: boolean;
            };
            if (!state.__drawerEdgeEventsBound) {
                state.__drawerEdgeEventsBound = true;
                state.__drawerEdgeEvents = [];
                for (const type of [
                    'pointerdown',
                    'pointerup',
                    'pointercancel',
                    'click',
                ]) {
                    document.addEventListener(
                        type,
                        (event) => {
                            const target = event.target as Element | null;
                            const targetHandle = target?.closest(
                                '.drawer-resize-handle',
                            );
                            const targetName =
                                targetHandle?.id ||
                                target?.id ||
                                (typeof target?.className === 'string'
                                    ? target.className
                                    : target?.tagName || 'unknown');
                            state.__drawerEdgeEvents?.push({
                                type: event.type,
                                target: targetName,
                                pointerType:
                                    'pointerType' in event
                                        ? String(event.pointerType)
                                        : '',
                            });
                        },
                        true,
                    );
                }
            }
            state.__drawerEdgeEvents = [];

            const snapshot = () => {
                const currentControl = document.querySelector(selector);
                const details = currentControl?.closest('details');
                return {
                    mode: panel.dataset.panelMode ?? null,
                    panelOpen:
                        drawerSide === 'left'
                            ? panel.classList.contains('drawer-open')
                            : !panel.classList.contains('hidden') &&
                              panel.classList.contains('mobile-open'),
                    selectedPane:
                        document
                            .querySelector('#tabs-container .tab.active')
                            ?.getAttribute('data-pane-id') ?? null,
                    activeDrawerPane:
                        document
                            .querySelector(
                                '#drawer-tabs-body .hostname-dropdown-row.active',
                            )
                            ?.getAttribute('data-pane-id') ?? null,
                    rows: Array.from(
                        document.querySelectorAll(
                            '#drawer-tabs-body .hostname-dropdown-row',
                        ),
                        (row) => ({
                            paneId: (row as HTMLElement).dataset.paneId,
                            closing: row.classList.contains(
                                'tab-overflow-closing-row',
                            ),
                        }),
                    ),
                    detailsOpen: details?.open ?? null,
                    activeDiffTab:
                        document
                            .querySelector('#diff-panel .diff-tab-btn.active')
                            ?.getAttribute('data-tab') ?? null,
                    sessionPage:
                        document
                            .querySelector('.session-page-label')
                            ?.textContent?.trim() ?? null,
                    toasts: Array.from(
                        document.querySelectorAll('.toast-title'),
                        (toast) => toast.textContent?.trim(),
                    ).filter(Boolean),
                };
            };

            return {
                x: handleRect.left + handleRect.width * fraction,
                y: controlRect.top + controlRect.height / 2,
                handleLeft: handleRect.left,
                handleRight: handleRect.right,
                handleWidth: handleRect.width,
                handleTop: handleRect.top,
                handleBottom: handleRect.bottom,
                controlLeft: controlRect.left,
                controlRight: controlRect.right,
                before: snapshot(),
                saved: localStorage.getItem(preference),
                width: panel.getBoundingClientRect().width,
            };
        },
        {
            handleId,
            side,
            selector: controlSelector,
            fraction: xFraction,
            preference: preferenceKey,
        },
    );
    expect(start.handleWidth).toBe(24);
    expect(start.x).toBeGreaterThanOrEqual(start.handleLeft);
    expect(start.x).toBeLessThan(start.handleRight);
    expect(start.y).toBeGreaterThanOrEqual(start.handleTop);
    expect(start.y).toBeLessThan(start.handleBottom);
    const points = Array.from({ length: delta === 0 ? 0 : 5 }, (_, index) => ({
        x: start.x + (delta * (index + 1)) / 5,
        y: start.y,
    }));
    const gap =
        side === 'left'
            ? start.handleLeft - start.controlRight
            : start.controlLeft - start.handleRight;
    console.log(
        `drawer edge touch input ${JSON.stringify({ side, viewport: page.viewportSize(), controlSelector, xFraction, gap, start: { x: start.x, y: start.y }, delta })}`,
    );
    await dispatchTouchPath(page, [{ x: start.x, y: start.y }, ...points]);

    const result = await page.evaluate(
        ({
            panelId: id,
            handleId: resizeId,
            side: drawerSide,
            selector,
            preference,
        }) => {
            const panel = document.getElementById(id)!;
            const handle = document.getElementById(resizeId)!;
            const controlElement = document.querySelector(selector);
            const state = window as unknown as {
                __drawerEdgeEvents: {
                    type: string;
                    target: string;
                    pointerType: string;
                }[];
            };
            const details = controlElement?.closest('details');
            return {
                events: state.__drawerEdgeEvents,
                snapshot: {
                    mode: panel.dataset.panelMode ?? null,
                    panelOpen:
                        drawerSide === 'left'
                            ? panel.classList.contains('drawer-open')
                            : !panel.classList.contains('hidden') &&
                              panel.classList.contains('mobile-open'),
                    selectedPane:
                        document
                            .querySelector('#tabs-container .tab.active')
                            ?.getAttribute('data-pane-id') ?? null,
                    activeDrawerPane:
                        document
                            .querySelector(
                                '#drawer-tabs-body .hostname-dropdown-row.active',
                            )
                            ?.getAttribute('data-pane-id') ?? null,
                    rows: Array.from(
                        document.querySelectorAll(
                            '#drawer-tabs-body .hostname-dropdown-row',
                        ),
                        (row) => ({
                            paneId: (row as HTMLElement).dataset.paneId,
                            closing: row.classList.contains(
                                'tab-overflow-closing-row',
                            ),
                        }),
                    ),
                    detailsOpen: details?.open ?? null,
                    activeDiffTab:
                        document
                            .querySelector('#diff-panel .diff-tab-btn.active')
                            ?.getAttribute('data-tab') ?? null,
                    sessionPage:
                        document
                            .querySelector('.session-page-label')
                            ?.textContent?.trim() ?? null,
                    toasts: Array.from(
                        document.querySelectorAll('.toast-title'),
                        (toast) => toast.textContent?.trim(),
                    ).filter(Boolean),
                },
                saved: localStorage.getItem(preference),
                width: panel.getBoundingClientRect().width,
                dragging: handle.classList.contains('dragging'),
                resizing: panel.classList.contains('resizing'),
            };
        },
        {
            panelId,
            handleId,
            side,
            selector: controlSelector,
            preference: preferenceKey,
        },
    );
    const pointerDown = result.events.find(
        (event) => event.type === 'pointerdown',
    );
    expect(pointerDown?.target).toBe(handleId);
    expect(pointerDown?.pointerType).toBe('touch');
    expect(result.snapshot).toEqual(start.before);
    expect(result.snapshot.panelOpen).toBe(true);
    expect(result.dragging).toBe(false);
    expect(result.resizing).toBe(false);

    const expectedDelta =
        expectedWidthDelta ?? (side === 'left' ? delta : -delta);
    const error = Math.abs(result.width - start.width - expectedDelta);
    console.log(
        `drawer edge touch result ${JSON.stringify({ side, controlSelector, xFraction, delta, width: result.width, saved: result.saved, error, pointerDown })}`,
    );
    if (expectedDelta === 0) {
        expect(error).toBeLessThan(0.05);
        expect(result.saved).toBe(expectedSaved ?? start.saved);
    } else {
        expect(error).toBeLessThan(1.5);
        expect(result.saved).not.toBeNull();
        expect(Math.abs(Number(result.saved) - result.width)).toBeLessThan(
            0.05,
        );
    }
}

test('desktop 8px resize targets work from both edges without blocking scrollbars', async ({
    browser,
}) => {
    const { context, page } = await openDesktopPage(browser);
    try {
        for (const [handleId, panelId, key] of [
            ['left-resize-handle', 'sidebar-panel', 'phi_panel_left_width'],
            ['right-resize-handle', 'diff-panel', 'phi_panel_right_width'],
        ]) {
            const geometry = await handleGeometry(page, handleId);
            expect(geometry.width).toBeCloseTo(8, 5);
            expect(geometry.samples).toHaveLength(9);
            for (const sample of geometry.samples) {
                expect(sample.id).toBe(handleId);
            }
            for (const hit of geometry.outside) expect(hit).toBeNull();

            for (const xFraction of [0.05, 0.95]) {
                for (const delta of [-10, 10]) {
                    await dragAndCheck(
                        page,
                        handleId,
                        panelId,
                        key,
                        xFraction,
                        delta,
                    );
                }
            }
        }

        await selectTerminal(page);
        await openPiSessions(page);
        for (const selector of [
            '.session-list-container',
            '#term-t1 .xterm-scrollable-element',
        ]) {
            await expect(page.locator(selector)).toBeVisible();
            // Resize targets must not intercept clicks on either scrollbar.
            expect(
                await page.locator(selector).evaluate((element) => {
                    const box = element.getBoundingClientRect();
                    return element.contains(
                        document.elementFromPoint(
                            box.right - 3,
                            box.top + box.height / 2,
                        ),
                    );
                }),
            ).toBe(true);
        }
        const sessions = page.locator('.session-list-container');
        const scroll = await sessions.boundingBox();
        if (!scroll) throw new Error('session scrollbar has no bounds');
        await page.mouse.move(
            scroll.x + scroll.width - 3,
            scroll.y + scroll.height * 0.75,
        );
        await page.mouse.wheel(0, 400);
        await expect
            .poll(() => sessions.evaluate((element) => element.scrollTop))
            .toBeGreaterThan(0);

        const savedWidths = await page.evaluate(() => ({
            left: Number(localStorage.getItem('phi_panel_left_width')),
            right: Number(localStorage.getItem('phi_panel_right_width')),
        }));
        await page.reload();
        await expect
            .poll(() =>
                page.evaluate((saved) => {
                    const left = document
                        .getElementById('sidebar-panel')!
                        .getBoundingClientRect().width;
                    const right = document
                        .getElementById('diff-panel')!
                        .getBoundingClientRect().width;
                    return Math.max(
                        Math.abs(left - saved.left),
                        Math.abs(right - saved.right),
                    );
                }, savedWidths),
            )
            .toBeLessThan(0.05);

        await page.locator('#header-diff-toggle-btn').click();
        await expect
            .poll(() =>
                page
                    .locator('#right-resize-handle')
                    .evaluate((handle) => getComputedStyle(handle).display),
            )
            .toBe('none');
    } finally {
        await context.close();
    }
});

test('drawer edge touch MVP does not close a tab', async ({ browser }) => {
    test.setTimeout(180_000);
    const gestures = [
        { name: 'tap', delta: 0, moves: 0, delay: 0 },
        { name: 'micro-drag', delta: -10, moves: 5, delay: 0 },
        { name: 'slow-drag', delta: -100, moves: 20, delay: 30 },
    ];

    for (const gesture of gestures) {
        const { context, page } = await openResponsivePage(
            browser,
            1360,
            400,
            true,
        );
        try {
            await openDrawer(page, 'left');
            const panel = page.locator('#sidebar-panel');
            await expect(panel).toHaveAttribute('data-panel-mode', 'tabs');
            const rows = page.locator(
                '#drawer-tabs-body .hostname-dropdown-row',
            );
            await expect(rows).toHaveCount(2);
            const closeButton = page
                .locator('#drawer-tabs-body .hostname-dropdown-close-btn')
                .first();
            await expect(closeButton).toBeVisible();

            const start = await page.evaluate(() => {
                const handle = document.getElementById(
                    'sidebar-drawer-resizer',
                )!;
                const button = document.querySelector(
                    '#drawer-tabs-body .hostname-dropdown-close-btn',
                )!;
                const handleRect = handle.getBoundingClientRect();
                const buttonRect = button.getBoundingClientRect();
                const x = handleRect.left + handleRect.width * 0.05;
                const y = buttonRect.top + buttonRect.height / 2;
                const state = window as unknown as {
                    __drawerEdgeEvents: { type: string; target: string }[];
                };
                state.__drawerEdgeEvents = [];
                for (const type of [
                    'pointerdown',
                    'pointercancel',
                    'pointerup',
                    'click',
                ]) {
                    document.addEventListener(
                        type,
                        (event) => {
                            const target = event.target as Element;
                            state.__drawerEdgeEvents.push({
                                type,
                                target:
                                    target.id ||
                                    (typeof target.className === 'string'
                                        ? target.className
                                        : target.tagName),
                            });
                        },
                        true,
                    );
                }
                return {
                    x,
                    y,
                    handleWidth: handleRect.width,
                    buttonRight: buttonRect.right,
                    handleLeft: handleRect.left,
                    panelWidth: document
                        .getElementById('sidebar-panel')!
                        .getBoundingClientRect().width,
                    saved: localStorage.getItem('phi_drawer_left_width'),
                };
            });
            expect(start.handleWidth).toBe(24);
            expect(start.x).toBeGreaterThanOrEqual(start.handleLeft);
            expect(start.x).toBeLessThan(start.handleLeft + start.handleWidth);
            const gap = start.handleLeft - start.buttonRight;
            const points = Array.from(
                { length: gesture.moves },
                (_, index) => ({
                    x: start.x + (gesture.delta * (index + 1)) / gesture.moves,
                    y: start.y,
                }),
            );
            console.log(
                `drawer edge touch MVP ${JSON.stringify({
                    gesture: gesture.name,
                    viewport: page.viewportSize(),
                    handleWidth: start.handleWidth,
                    buttonHandleGap: gap,
                    start: { x: start.x, y: start.y },
                    pointerDelta: gesture.delta,
                })}`,
            );
            await dispatchTouchPath(
                page,
                [{ x: start.x, y: start.y }, ...points],
                false,
                gesture.delay,
            );

            const result = await page.evaluate(() => {
                const state = window as unknown as {
                    __drawerEdgeEvents: { type: string; target: string }[];
                };
                const panel = document.getElementById('sidebar-panel')!;
                const handle = document.getElementById(
                    'sidebar-drawer-resizer',
                )!;
                return {
                    events: state.__drawerEdgeEvents,
                    panelWidth: panel.getBoundingClientRect().width,
                    saved: localStorage.getItem('phi_drawer_left_width'),
                    rows: Array.from(
                        document.querySelectorAll(
                            '#drawer-tabs-body .hostname-dropdown-row',
                        ),
                        (element) => ({
                            paneId: (element as HTMLElement).dataset.paneId,
                            closing: element.classList.contains(
                                'tab-overflow-closing-row',
                            ),
                        }),
                    ),
                    closedTabToasts: Array.from(
                        document.querySelectorAll('.toast-title'),
                        (element) => element.textContent?.trim(),
                    ).filter((title) => title === 'Tab closed'),
                    drawerOpen: panel.classList.contains('drawer-open'),
                    dragging: handle.classList.contains('dragging'),
                    resizing: panel.classList.contains('resizing'),
                };
            });
            console.log(
                `drawer edge touch MVP result ${JSON.stringify({
                    gesture: gesture.name,
                    result,
                    widthError:
                        result.panelWidth - start.panelWidth - gesture.delta,
                })}`,
            );
            expect(
                result.events.find((event) => event.type === 'pointerdown')
                    ?.target,
            ).toBe('sidebar-drawer-resizer');
            expect(result.rows.map((item) => item.paneId).sort()).toEqual([
                't1',
                't2',
            ]);
            expect(result.rows.some((item) => item.closing)).toBe(false);
            expect(result.closedTabToasts).toEqual([]);
            expect(result.drawerOpen).toBe(true);
            expect(result.dragging).toBe(false);
            expect(result.resizing).toBe(false);

            if (gesture.delta === 0) {
                expect(
                    Math.abs(result.panelWidth - start.panelWidth),
                ).toBeLessThan(0.05);
                expect(result.saved).toBe(start.saved);
            } else {
                const error = Math.abs(
                    result.panelWidth - start.panelWidth - gesture.delta,
                );
                expect(error).toBeLessThan(1.5);
                expect(result.saved).not.toBeNull();
                expect(
                    Math.abs(Number(result.saved) - result.panelWidth),
                ).toBeLessThan(0.05);
            }
        } finally {
            await context.close();
        }
    }
});

test('drawer edge touch keeps tab-close targets usable across the handle', async ({
    browser,
}) => {
    test.setTimeout(240_000);
    for (const [width, height] of [
        [1360, 400],
        [390, 844],
    ] as const) {
        for (const xFraction of [0.05, 0.5, 0.95]) {
            const { context, page } = await openResponsivePage(
                browser,
                width,
                height,
                true,
            );
            try {
                await openDrawer(page, 'left');
                await expect(page.locator('#sidebar-panel')).toHaveAttribute(
                    'data-panel-mode',
                    'tabs',
                );
                await expect(
                    page.locator('#drawer-tabs-body .hostname-dropdown-row'),
                ).toHaveCount(2);
                const closeButton = page
                    .locator('#drawer-tabs-body .hostname-dropdown-close-btn')
                    .first();
                await expect(closeButton).toBeVisible();

                for (const delta of [0, -10, 10]) {
                    await assertDrawerEdgeTouch(
                        page,
                        'left',
                        '#drawer-tabs-body .hostname-dropdown-close-btn',
                        xFraction,
                        delta,
                    );
                }
            } finally {
                await context.close();
            }
        }
    }
});

test('drawer edge touch leaves nearby controls and modes unchanged', async ({
    browser,
}) => {
    test.setTimeout(240_000);
    for (const [width, height] of [
        [1360, 400],
        [390, 844],
    ] as const) {
        const { context, page } = await openResponsivePage(
            browser,
            width,
            height,
            true,
        );
        try {
            const panel = await openDrawer(page, 'left');
            await expect(panel).toHaveAttribute('data-panel-mode', 'tabs');
            await expect(page.locator('#drawer-back-to-tabs')).toBeHidden();

            for (const selector of [
                '#drawer-tabs-body .hostname-dropdown-row[data-pane-id="t1"] .hostname-dropdown-close-btn',
                '#drawer-tabs-body .hostname-dropdown-row[data-pane-id="t2"] .hostname-dropdown-close-btn',
                '#drawer-tabs-body .tab-overflow-workspace > summary',
                '#drawer-tabs-body .tab-overflow-worktree > summary',
                '#drawer-open-sessions',
            ]) {
                await assertDrawerEdgeTouch(page, 'left', selector, 0.05, 0);
                await assertDrawerEdgeTouch(page, 'left', selector, 0.05, -10);
                await assertDrawerEdgeTouch(page, 'left', selector, 0.05, 10);
            }

            await page.locator('#drawer-open-sessions').click();
            await expect(panel).toHaveAttribute('data-panel-mode', 'sessions');
            const backButton = page.locator('#drawer-back-to-tabs');
            await expect(backButton).toBeVisible();
            await assertDrawerEdgeTouch(
                page,
                'left',
                '#drawer-back-to-tabs',
                0.05,
                0,
            );
            await assertDrawerEdgeTouch(
                page,
                'left',
                '#drawer-back-to-tabs',
                0.05,
                -10,
            );
        } finally {
            await context.close();
        }
    }
});

test('drawer edge touch respects minimum width and keeps tab controls usable', async ({
    browser,
}) => {
    for (const [width, height, savedWidth, expectedWidth] of [
        [390, 400, 160, 180],
        [274, 400, 226, 226],
        [390, 844, undefined, 342],
    ] as const) {
        const { context, page } = await openResponsivePage(
            browser,
            width,
            height,
            true,
            false,
            savedWidth,
        );
        try {
            const panel = await openDrawer(page, 'left');
            await expect(panel).toHaveAttribute('data-panel-mode', 'tabs');
            expect(
                await panel.evaluate((el) => el.getBoundingClientRect().width),
            ).toBeCloseTo(expectedWidth, 1);
            const layout = await page.evaluate(() => {
                const body = document.getElementById('drawer-tabs-body')!;
                const rect = body.getBoundingClientRect();
                const contentRight =
                    rect.right -
                    Number.parseFloat(getComputedStyle(body).paddingRight);
                return {
                    overflow: document.documentElement.scrollWidth - innerWidth,
                    contentRight,
                    scrollHeight: body.scrollHeight,
                    clientHeight: body.clientHeight,
                    controls: Array.from(
                        body.querySelectorAll(
                            '.hostname-dropdown-select-btn, .hostname-dropdown-close-btn, .tab-overflow-workspace > summary, .tab-overflow-worktree > summary',
                        ),
                        (element) => ({
                            right: element.getBoundingClientRect().right,
                            visible:
                                getComputedStyle(element).display !== 'none',
                        }),
                    ).filter((control) => control.visible),
                    titles: Array.from(
                        body.querySelectorAll('.hostname-dropdown-title'),
                        (title) => ({
                            width: (title as HTMLElement).clientWidth,
                            scrollWidth: (title as HTMLElement).scrollWidth,
                        }),
                    ),
                };
            });
            expect(layout.overflow).toBeLessThanOrEqual(0);
            expect(
                layout.controls.every(
                    (control) => control.right <= layout.contentRight + 1,
                ),
            ).toBe(true);
            expect(
                layout.titles.every(
                    (title) => title.scrollWidth <= title.width + 1,
                ),
            ).toBe(true);

            if (savedWidth === 160) {
                expect(layout.scrollHeight).toBeGreaterThan(
                    layout.clientHeight,
                );
                const body = page.locator('#drawer-tabs-body');
                const beforeWidth = await panel.evaluate(
                    (el) => el.getBoundingClientRect().width,
                );
                const beforeActive = await page
                    .locator('#tabs-container .tab.active')
                    .getAttribute('data-pane-id');
                const rect = await body.boundingBox();
                expect(rect).not.toBeNull();
                await body.evaluate((el) => {
                    el.scrollTop = 0;
                });
                await dispatchTouchPath(page, [
                    {
                        x: rect!.x + rect!.width * 0.45,
                        y: rect!.y + rect!.height * 0.8,
                    },
                    {
                        x: rect!.x + rect!.width * 0.45,
                        y: rect!.y + rect!.height * 0.55,
                    },
                    {
                        x: rect!.x + rect!.width * 0.45,
                        y: rect!.y + rect!.height * 0.3,
                    },
                ]);
                await expect
                    .poll(() => body.evaluate((el) => el.scrollTop))
                    .toBeGreaterThan(0);
                expect(
                    await panel.evaluate(
                        (el) => el.getBoundingClientRect().width,
                    ),
                ).toBe(beforeWidth);
                await expect(
                    page.locator('#tabs-container .tab.active'),
                ).toHaveAttribute('data-pane-id', beforeActive!);
                await assertDrawerEdgeTouch(
                    page,
                    'left',
                    '#drawer-tabs-body .hostname-dropdown-close-btn',
                    0.05,
                    -10,
                    0,
                    '170',
                );
                await assertDrawerEdgeTouch(
                    page,
                    'left',
                    '#drawer-tabs-body .hostname-dropdown-close-btn',
                    0.05,
                    10,
                );
            }

            if (savedWidth === undefined) {
                const t2 = page.locator(
                    '#drawer-tabs-body .hostname-dropdown-row[data-pane-id="t2"]',
                );
                await t2.locator('.hostname-dropdown-close-btn').click();
                await expect(t2).toHaveClass(/tab-overflow-closing-row/);
                await expect(
                    page.locator(
                        '#drawer-tabs-body .hostname-dropdown-row.tab-overflow-closing-row',
                    ),
                ).toHaveCount(1);
                const undo = t2.locator('.hostname-dropdown-close-btn');
                await expect(undo).toHaveAttribute('title', 'Undo close');
                await undo.click();
                await expect(t2).not.toHaveClass(/tab-overflow-closing-row/);
                await openDrawer(page, 'left');
                await t2.locator('.hostname-dropdown-select-btn').click();
                await expect(
                    page.locator('#tabs-container .tab.active'),
                ).toHaveAttribute('data-pane-id', 't2');
            }
        } finally {
            await context.close();
        }
    }
});

test('drawer handles resize with touch and mouse without stealing closed-edge input', async ({
    browser,
}) => {
    for (const [width, height, touch] of [
        [390, 844, true],
        [820, 1180, true],
        [1360, 400, true],
        [1200, 1500, false],
    ] as const) {
        const { context, page } = await openResponsivePage(
            browser,
            width,
            height,
            touch,
        );
        try {
            await assertClosedDrawerEdges(page);
            for (const side of ['left', 'right'] as const) {
                const handleId =
                    side === 'left'
                        ? 'sidebar-drawer-resizer'
                        : 'diff-drawer-resizer';
                await openDrawer(page, side);
                const geometry = await handleGeometry(page, handleId);
                expect(geometry.width).toBeCloseTo(24, 5);
                expect(geometry.samples).toHaveLength(9);
                for (const sample of geometry.samples) {
                    expect(sample.id).toBe(handleId);
                }
                for (const hit of geometry.outside) expect(hit).toBeNull();
                const grip = await page
                    .locator(`#${handleId}`)
                    .evaluate((el) => {
                        const style = getComputedStyle(el, '::after');
                        return {
                            width: style.width,
                            height: style.height,
                            opacity: style.opacity,
                        };
                    });
                expect(grip).toEqual({
                    width: '1px',
                    height: '40px',
                    opacity: '0',
                });

                for (const xFraction of [0.05, 0.95]) {
                    for (const delta of [-10, 10]) {
                        await dragDrawerAndCheck(
                            page,
                            side,
                            touch,
                            xFraction,
                            delta,
                        );
                    }
                }

                if (touch && width === 390) {
                    await cancelDrawerPreview(page, side);
                }
                await dismissDrawerAndCheckRestore(page, side, touch);
                await assertClosedDrawerEdges(page);
            }
            const saved = await page.evaluate(() => ({
                left: Number(localStorage.getItem('phi_drawer_left_width')),
                right: Number(localStorage.getItem('phi_drawer_right_width')),
            }));
            await page.reload();
            await page
                .locator('#sidebar-drawer-resizer')
                .waitFor({ state: 'attached' });
            await page
                .locator('#diff-drawer-resizer')
                .waitFor({ state: 'attached' });
            for (const side of ['left', 'right'] as const) {
                const panel = await openDrawer(page, side);
                const expected = Math.min(saved[side], width - 24);
                await expect
                    .poll(() =>
                        panel.evaluate(
                            (el) => el.getBoundingClientRect().width,
                        ),
                    )
                    .toBeCloseTo(expected, 1);
                await closeDrawer(page, side);
            }
            const overflow = await page.evaluate(
                () => document.documentElement.scrollWidth - innerWidth,
            );
            expect(overflow).toBeLessThanOrEqual(0);
        } finally {
            await context.close();
        }
    }
});

for (const touch of [false, true]) {
    const label = touch ? 'phone touch' : 'desktop';
    test(`${label}: resizing preserves terminal, scrolling and nearby controls`, async ({
        browser,
    }) => {
        const { context, page, smoke } = touch
            ? await openResponsivePage(browser, 390, 844, true, true)
            : await openDesktopPage(browser, true);
        try {
            await selectTerminal(page);
            await expect
                .poll(
                    async () =>
                        (await terminalSnapshot(page, 't1'))?.text ?? '',
                )
                .toContain('bash fixture ready');
            await openPiSessions(page);
            await assertSessionListScroll(page, touch);
            await resizeBothPanels(page, touch);
            if (process.env.RESIZE_EVIDENCE) {
                if (touch) await openDrawer(page, 'left');
                await page.screenshot({
                    path: join(
                        process.env.RESIZE_EVIDENCE,
                        touch
                            ? 'implementation-touch.png'
                            : 'implementation-desktop.png',
                    ),
                });
            }
            await selectTerminal(page);
            await assertTerminalInputAndSelection(page);

            if (touch) {
                await expect(page.locator('#tab-overflow-btn')).toBeHidden();
                await expect(page.locator('#header-config-pill')).toBeHidden();
            } else {
                await page.locator('#tab-overflow-btn').click();
                await expect(
                    page.locator('#tab-overflow-dropdown'),
                ).toBeVisible();
                await page.locator('#tab-overflow-btn').click();
                await expect(
                    page.locator('#tab-overflow-dropdown'),
                ).toBeHidden();
                await page.locator('#header-config-pill .pill-label').click();
                await expect(page.locator('.settings-overlay')).toBeVisible();
                await assertOverlayCoversHandle(page, 'left-resize-handle');
                await page
                    .locator('.settings-overlay .modal-close-btn')
                    .click();
                await expect(page.locator('.settings-overlay')).toBeHidden();
            }
            await openDrawer(page, 'right');
            await page.locator('#close-diff-btn').click();
            await expect(page.locator('#diff-panel')).toHaveClass(/hidden/);
            const overflow = await page.evaluate(
                () => document.documentElement.scrollWidth - innerWidth,
            );
            expect(overflow).toBeLessThanOrEqual(0);
            console.log(`${label} browser events: ${JSON.stringify(smoke)}`);
            expect(smoke!.foreignOrigins).toEqual([]);
            expect(
                smoke!.errors.filter((error) => /resiz/i.test(error)),
            ).toEqual([]);
            expect(
                smoke!.requests.filter((error) => /resiz/i.test(error)),
            ).toEqual([]);
            expect(
                smoke!.responses.filter((error) => /resiz/i.test(error)),
            ).toEqual([]);
        } finally {
            await context.close();
        }
    });

    test(`${label}: both panels resize while offline`, async ({ browser }) => {
        const { context, page } = touch
            ? await openResponsivePage(browser, 390, 844, true)
            : await openDesktopPage(browser);
        try {
            await openPiSessions(page);
            if (touch) {
                await page.locator('#drawer-back-to-tabs').click();
                await expect(page.locator('#sidebar-panel')).toHaveAttribute(
                    'data-panel-mode',
                    'tabs',
                );
            }
            await context.setOffline(true);
            try {
                if (touch) {
                    await assertDrawerEdgeTouch(
                        page,
                        'left',
                        '#drawer-tabs-body .hostname-dropdown-close-btn',
                        0.05,
                        -10,
                    );
                }
                await resizeBothPanels(page, touch);
                expect(
                    await page.evaluate(async () => {
                        try {
                            await fetch(`/healthz?offline=${Date.now()}`, {
                                cache: 'no-store',
                            });
                            return false;
                        } catch {
                            return true;
                        }
                    }),
                ).toBe(true);
            } finally {
                await context.setOffline(false);
            }
        } finally {
            await context.close();
        }
    });

    test(`${label}: cached sessions stay usable while refresh is pending`, async ({
        browser,
    }) => {
        const { context, page } = touch
            ? await openResponsivePage(browser, 390, 844, true)
            : await openDesktopPage(browser);
        let release = () => {};
        let finish = () => {};
        let entered = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const heldRequest = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const finished = new Promise<void>((resolve) => {
            finish = resolve;
        });
        let held = false;
        const pattern = '**/api/sessions?*';
        try {
            const section = await openPiSessions(page);
            await section.locator('.session-page[data-page="1"]').click();
            await expect(section.locator('.session-page-label')).toHaveText(
                'Page 2',
            );
            await expect(section.locator('.session-item')).toHaveCount(25);
            await expect(
                section.locator('.session-item').first(),
            ).toContainText('Resize session 25');
            await context.route(pattern, async (route) => {
                if (!held && isPageOneSessionsRequest(route.request())) {
                    held = true;
                    entered();
                    try {
                        await gate;
                        await route.continue();
                    } finally {
                        finish();
                    }
                } else {
                    await route.continue();
                }
            });
            await section.locator('.session-page[data-page="-1"]').click();
            await Promise.race([
                heldRequest,
                new Promise<never>((_, reject) =>
                    setTimeout(
                        () =>
                            reject(
                                new Error('Page 1 request not held within 5s'),
                            ),
                        5000,
                    ),
                ),
            ]);
            await expect(section.locator('.session-item')).toHaveCount(25, {
                timeout: 5000,
            });
            await expect(
                section.locator('.session-item').first(),
            ).toContainText('Resize session 00', { timeout: 5000 });
            const start = Date.now();
            await resizeBothPanels(page, touch);
            expect(Date.now() - start).toBeLessThan(5000);
        } finally {
            release();
            try {
                if (held) {
                    await Promise.race([
                        finished,
                        new Promise<never>((_, reject) =>
                            setTimeout(
                                () =>
                                    reject(
                                        new Error(
                                            'Held request did not finish within 5s',
                                        ),
                                    ),
                                5000,
                            ),
                        ),
                    ]);
                }
            } finally {
                await context.unroute(pattern);
                await context.close();
            }
        }
    });
}

for (const [width, height, touch, sessionsDrawer, diffDrawer] of [
    [768, 900, false, true, true],
    [769, 900, false, true, true],
    [1023, 900, false, true, true],
    [1024, 900, false, false, true],
    [1279, 900, false, false, true],
    [1280, 900, false, false, false],
    [1360, 500, true, true, true],
    [1360, 501, true, false, false],
    [1400, 1539, false, false, false],
    [1400, 1540, false, true, false],
    [1400, 1541, false, true, false],
] as const) {
    test(`responsive ${width}x${height} ${touch ? 'touch' : 'mouse'}`, async ({
        browser,
    }) => {
        const { context, page } = await openResponsivePage(
            browser,
            width,
            height,
            touch,
        );
        try {
            await assertResponsiveTopology(page, sessionsDrawer, diffDrawer);
        } finally {
            await context.close();
        }
    });
}

test('same page restores separate docked and drawer width preferences', async ({
    browser,
}) => {
    const { context, page } = await openDesktopPage(browser);
    try {
        await resizeBothPanels(page, false);
        const docked = await page.evaluate(() => [
            Number(localStorage.getItem('phi_panel_left_width')),
            Number(localStorage.getItem('phi_panel_right_width')),
        ]);
        await page.setViewportSize({ width: 800, height: 900 });
        await closeDrawer(page, 'right');
        await openDrawer(page, 'left');
        await dragDrawerAndCheck(page, 'left', false, 0.5, 10);
        await closeDrawer(page, 'left');
        await openDrawer(page, 'right');
        await dragDrawerAndCheck(page, 'right', false, 0.5, -10);
        await closeDrawer(page, 'right');
        const drawer = await page.evaluate(() => [
            Number(localStorage.getItem('phi_drawer_left_width')),
            Number(localStorage.getItem('phi_drawer_right_width')),
        ]);
        await page.setViewportSize({ width: 1440, height: 900 });
        await openDrawer(page, 'right');
        for (const [id, value] of [
            ['sidebar-panel', docked[0]],
            ['diff-panel', docked[1]],
        ] as const) {
            await expect
                .poll(() =>
                    page
                        .locator(`#${id}`)
                        .evaluate((el) => el.getBoundingClientRect().width),
                )
                .toBeCloseTo(value, 1);
        }
        await page.setViewportSize({ width: 800, height: 900 });
        await closeDrawer(page, 'right');
        for (const [side, value] of [
            ['left', drawer[0]],
            ['right', drawer[1]],
        ] as const) {
            const panel = await openDrawer(page, side);
            await expect
                .poll(() =>
                    panel.evaluate((el) => el.getBoundingClientRect().width),
                )
                .toBeCloseTo(value, 1);
            await closeDrawer(page, side);
        }
    } finally {
        await context.close();
    }
});

test('touch settings overlay receives input above an open drawer', async ({
    browser,
}) => {
    const { context, page } = await openResponsivePage(
        browser,
        820,
        1180,
        true,
    );
    try {
        await openDrawer(page, 'left');
        await page.locator('#header-config-pill .pill-label').tap();
        await expect(page.locator('.settings-overlay')).toBeVisible();
        await assertOverlayCoversHandle(page, 'sidebar-drawer-resizer');
        await page.locator('.settings-overlay .modal-close-btn').tap();
        await expect(page.locator('.settings-overlay')).toBeHidden();
    } finally {
        await context.close();
    }
});

test('closed phone drawer allows the left-edge touch swipe', async ({
    browser,
}) => {
    const { context, page } = await openResponsivePage(browser, 390, 844, true);
    try {
        await assertClosedDrawerEdges(page);
        await page.evaluate(() => {
            for (const type of ['touchstart', 'touchend', 'touchcancel']) {
                document.addEventListener(
                    type,
                    (event) => {
                        const touch = (event as TouchEvent).changedTouches[0];
                        document.documentElement.dataset.touchTrace += `${event.type}:${touch?.clientX};`;
                    },
                    { passive: true },
                );
            }
            document.documentElement.dataset.touchTrace = '';
        });
        await page.waitForTimeout(60);
        // The terminal canvas keeps its own touch stream; use the input-bar edge
        // to exercise the document-level drawer gesture.
        await dispatchTouchPath(page, [
            { x: 10, y: 820 },
            { x: 70, y: 820 },
            { x: 140, y: 820 },
        ]);
        await expect
            .poll(
                () =>
                    page.evaluate(
                        () => document.documentElement.dataset.touchTrace,
                    ),
                { message: 'real touch sequence' },
            )
            .toContain('touchend:140');
        await expect(page.locator('#sidebar-panel')).toHaveClass(/drawer-open/);
    } finally {
        await context.close();
    }
});
