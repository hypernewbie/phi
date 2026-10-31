import { mkdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    expect,
    test,
    type BrowserContext,
    type Locator,
    type Page,
    type Request,
    type Route,
} from '@playwright/test';
import {
    isCancelledSessionListRead,
    isCancelledWorktreeRead,
} from './_session-requests.js';
import { startPhi } from './_server.js';

function piProjectDirectory(home: string, cwd: string): string {
    const normalized = realpathSync(cwd).replaceAll('\\', '/');
    const encoded = normalized
        .replace(/^\/+|\/+$/g, '')
        .replace(/:/g, '-')
        .replace(/\//g, '-');
    return join(home, '.pi', 'agent', 'sessions', `--${encoded}--`);
}

function writePiSession(
    home: string,
    cwd: string,
    id: string,
    title: string,
    time: number,
): void {
    const directory = piProjectDirectory(home, cwd);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${id}.jsonl`);
    const timestamp = new Date(time).toISOString();
    writeFileSync(
        path,
        `${[
            JSON.stringify({ type: 'session', version: 3, id, cwd, timestamp }),
            JSON.stringify({ type: 'session_info', name: title }),
        ].join('\n')}\n`,
    );
    const mtime = new Date(time);
    utimesSync(path, mtime, mtime);
}

function writeClaudeSession(
    home: string,
    cwd: string,
    id: string,
    title: string,
    time: number,
): void {
    const project = realpathSync(cwd).replace(/[^A-Za-z0-9]/g, '-');
    const directory = join(home, '.claude', 'projects', project);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${id}.jsonl`);
    writeFileSync(
        path,
        `${JSON.stringify({ type: 'user', cwd, aiTitle: title })}\n`,
    );
    const mtime = new Date(time);
    utimesSync(path, mtime, mtime);
}

async function startFixture() {
    let cwd = '';
    let home = '';
    let nextTime = Date.UTC(2026, 9, 1, 12);
    const pi = (id: string, title: string) => {
        nextTime += 1_000;
        writePiSession(home, cwd, id, title, nextTime);
    };
    const claude = (id: string, title: string) => {
        nextTime += 1_000;
        writeClaudeSession(home, cwd, id, title, nextTime);
    };
    const phi = await startPhi({
        setup(dir) {
            cwd = realpathSync(dir);
            home = join(dir, 'home');
            mkdirSync(join(home, '.phi'), { recursive: true });
            writeFileSync(
                join(home, '.phi', 'config.json'),
                JSON.stringify({
                    workspaces: [cwd],
                    active_cwd: cwd,
                    session_list_page_size: 10,
                    pi_bridge_no_inject: true,
                    opencode_legacy: true,
                }),
            );
            const agent = join(home, '.pi', 'agent');
            mkdirSync(agent, { recursive: true });
            writeFileSync(
                join(agent, 'settings.json'),
                JSON.stringify({
                    defaultProjectTrust: 'never',
                    quietStartup: true,
                    enableInstallTelemetry: false,
                    cacheWarming: 'off',
                }),
            );
            pi('pi-initial', 'Pi initial session');
            claude('claude-initial', 'Claude initial session');
        },
    });
    return { phi, cwd, pi, claude };
}

async function activate(locator: Locator, touch: boolean): Promise<void> {
    if (touch) await locator.tap({ timeout: 15_000 });
    else await locator.click({ timeout: 15_000 });
}

async function ensureActiveSection(page: Page, cwd: string, touch: boolean) {
    const section = page.locator('.worktree-section').filter({
        has: page.locator('.worktree-header'),
    });
    await expect(section).toHaveCount(1, { timeout: 30_000 });
    await expect(section).toHaveAttribute('data-worktree-path', cwd);
    if (
        !(await section.evaluate((element) =>
            element.classList.contains('expanded'),
        ))
    ) {
        await activate(section.locator('.worktree-header'), touch);
    }
    return section;
}

function collectBrowserErrors(
    page: Page,
    injected503: Map<string, number>,
    origin: string,
): string[] {
    const errors: string[] = [];
    const successfulEmptyThemeSaves = new WeakSet<Request>();
    page.on('response', (response) => {
        const request = response.request();
        if (
            response.status() === 200 &&
            response.headers()['content-length'] === '0' &&
            request.method() === 'POST' &&
            new URL(request.url()).pathname === '/api/config/theme'
        ) {
            successfulEmptyThemeSaves.add(request);
        }
    });
    page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
    page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const url = message.location().url;
        const expected = injected503.get(url) ?? 0;
        if (
            expected > 0 &&
            /^Failed to load resource:.*\b503\b/.test(message.text())
        ) {
            injected503.set(url, expected - 1);
            return;
        }
        errors.push(`console: ${url} ${message.text()}`);
    });
    page.on('requestfailed', (request) => {
        // Chromium can flag a successful empty POST body as aborted after headers.
        if (
            successfulEmptyThemeSaves.has(request) &&
            request.failure()?.errorText === 'net::ERR_ABORTED'
        )
            return;
        if (isCancelledSessionListRead(request, origin)) return;
        if (isCancelledWorktreeRead(request, origin)) return;
        errors.push(
            `request: ${request.method()} ${request.url()} ${request.failure()?.errorText}`,
        );
    });
    return errors;
}

async function installSessionGates(
    page: Page,
    injected503: Map<string, number>,
) {
    let holdNext = false;
    let failNext = false;
    let releaseHeld: (() => void) | null = null;
    let signalHeld: (() => void) | null = null;
    let savePostCount = 0;
    const saveReleases: Array<() => void> = [];
    await page.route('**/api/sessions?*', async (route: Route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get('coder') !== 'pi') {
            await route.continue();
            return;
        }
        if (holdNext) {
            holdNext = false;
            signalHeld?.();
            await new Promise<void>((resolve) => {
                releaseHeld = resolve;
            });
        }
        if (failNext) {
            failNext = false;
            const requestUrl = route.request().url();
            injected503.set(requestUrl, (injected503.get(requestUrl) ?? 0) + 1);
            await route.fulfill({ status: 503, body: 'offline' });
            return;
        }
        await route.continue();
    });
    await page.route('**/api/config/worktree-state', async (route) => {
        if (route.request().method() !== 'POST') {
            await route.continue();
            return;
        }
        savePostCount++;
        await new Promise<void>((resolve) => saveReleases.push(resolve));
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: '{}',
        });
    });
    return {
        holdNextSession(): Promise<void> {
            holdNext = true;
            return new Promise<void>((resolve) => {
                signalHeld = resolve;
            });
        },
        releaseHeldSession() {
            releaseHeld?.();
            releaseHeld = null;
        },
        failNextSession() {
            failNext = true;
        },
        get savePostCount() {
            return savePostCount;
        },
        releaseStateSaves() {
            for (const release of saveReleases.splice(0)) release();
        },
    };
}

async function assertSidebarBounds(page: Page): Promise<void> {
    const widths = await page.evaluate(() => {
        const panelElement = document.getElementById('sidebar-panel');
        if (!panelElement) throw new Error('Sidebar panel is missing');
        const panel = panelElement.getBoundingClientRect();
        // The existing resize handle intentionally protrudes 10px beyond the drawer.
        return [
            document.documentElement,
            ...Array.from(
                document.querySelectorAll<HTMLElement>(
                    '#sidebar-panel > :not(.drawer-resize-handle)',
                ),
            ),
        ].map((element) => {
            const rect = element.getBoundingClientRect();
            return {
                name: element.id || element.className || element.tagName,
                scroll: element.scrollWidth,
                client: element.clientWidth,
                insidePanel:
                    element === document.documentElement ||
                    rect.width === 0 ||
                    (rect.left >= panel.left - 1 &&
                        rect.right <= panel.right + 1),
            };
        });
    });
    for (const width of widths) {
        expect(
            width.scroll,
            `${width.name} horizontal overflow`,
        ).toBeLessThanOrEqual(width.client + 1);
        expect(width.insidePanel, `${width.name} stays inside the drawer`).toBe(
            true,
        );
    }
    const controls = await page
        .locator('#sidebar-panel .panel-header')
        .evaluate((header) => {
            const bounds = header.getBoundingClientRect();
            return Array.from(header.querySelectorAll('button')).map(
                (button) => {
                    const rect = button.getBoundingClientRect();
                    return {
                        id: button.id,
                        fits:
                            rect.width === 0 ||
                            (rect.top >= bounds.top - 1 &&
                                rect.bottom <= bounds.bottom + 1 &&
                                rect.left >= bounds.left - 1 &&
                                rect.right <= bounds.right + 1),
                    };
                },
            );
        });
    for (const control of controls)
        expect(control.fits, `${control.id} fits its header`).toBe(true);
}

test('refreshes Pi and Claude sessions across desktop and touch without reloading', async ({
    browser,
}) => {
    test.setTimeout(300_000);
    const fixture = await startFixture();
    const { phi, cwd } = fixture;
    try {
        for (const mode of ['desktop', 'touch'] as const) {
            const touch = mode === 'touch';
            let context: BrowserContext | null = null;
            let gates: Awaited<ReturnType<typeof installSessionGates>> | null =
                null;
            let releaseWorktrees: (() => void) | undefined;
            try {
                context = await browser.newContext({
                    viewport: touch
                        ? { width: 390, height: 844 }
                        : { width: 1440, height: 900 },
                    isMobile: touch,
                    hasTouch: touch,
                });
                const page = await context.newPage();
                await page.route('**/api/update/status', (route) =>
                    route.request().method() === 'GET'
                        ? route.fulfill({
                              json: { current: 'dev', update_available: false },
                          })
                        : route.continue(),
                );
                const injected503 = new Map<string, number>();
                const errors = collectBrowserErrors(page, injected503, phi.url);
                const navigations: string[] = [];
                const sessionRequests: string[] = [];
                const statePosts: string[] = [];
                page.on('framenavigated', (frame) => {
                    if (frame === page.mainFrame())
                        navigations.push(frame.url());
                });
                page.on('request', (request) => {
                    const url = new URL(request.url());
                    if (url.pathname === '/api/sessions')
                        sessionRequests.push(request.url());
                    if (
                        url.pathname === '/api/config/worktree-state' &&
                        request.method() === 'POST'
                    ) {
                        statePosts.push(request.url());
                    }
                });
                await page.goto(phi.url);
                navigations.length = 0;
                const pageURL = page.url();
                const refresh = page.locator('#refresh-sessions-btn');
                if (touch) {
                    await page.locator('#mobile-sidebar-toggle').tap();
                    await expect(
                        page.locator('#drawer-tabs-body'),
                    ).toBeVisible();
                    await expect(refresh).toBeHidden();
                    await page.locator('#drawer-open-sessions').tap();
                    await expect(
                        page.locator('#drawer-panel-title'),
                    ).toHaveText('SESSIONS');
                }
                await activate(
                    page.locator('#coder-selector .coder-tab[data-coder="pi"]'),
                    touch,
                );
                const piSection = await ensureActiveSection(page, cwd, touch);
                const piRows = piSection.locator('.session-item');
                const piTitles = piSection.locator('.session-title');
                const status = page.locator('#session-refresh-status');
                const priorPiTitles = touch
                    ? [
                          'Pi delayed refresh',
                          'Pi pointer refresh',
                          'Pi desktop refresh',
                          'Pi initial session',
                      ]
                    : ['Pi initial session'];
                await expect(piTitles).toHaveText(priorPiTitles);
                await expect(refresh).toBeVisible();
                const placement = await refresh.evaluate((button) => {
                    const title = document.getElementById('drawer-panel-title');
                    if (!title) throw new Error('Missing sessions heading');
                    const bounds = button.getBoundingClientRect();
                    return {
                        followsTitle: button.previousElementSibling === title,
                        gap: bounds.left - title.getBoundingClientRect().right,
                        border: getComputedStyle(button).borderWidth,
                        width: bounds.width,
                        height: bounds.height,
                    };
                });
                expect(placement).toMatchObject({
                    followsTitle: true,
                    border: '0px',
                    width: 24,
                    height: 24,
                });
                expect(placement.gap).toBeGreaterThanOrEqual(0);
                expect(placement.gap).toBeLessThanOrEqual(8);

                fixture.pi('pi-new', `Pi ${mode} refresh`);
                await expect(piTitles).toHaveText(priorPiTitles);
                await expect(piSection).not.toContainText(`Pi ${mode} refresh`);
                if (touch) await refresh.tap();
                else {
                    await refresh.focus();
                    await page.keyboard.press('Enter');
                }
                await expect(piRows.first()).toContainText(
                    `Pi ${mode} refresh`,
                );
                await expect(status).toHaveText('Sessions refreshed.');
                const lastSessionRequest = sessionRequests.at(-1);
                if (!lastSessionRequest) {
                    throw new Error('Expected a session list request');
                }
                const params = new URL(lastSessionRequest).searchParams;
                expect(Object.fromEntries(params)).toEqual({
                    coder: 'pi',
                    cwd,
                    limit: '10',
                    offset: '0',
                });
                if (!touch) {
                    fixture.pi('pi-pointer', 'Pi pointer refresh');
                    await expect(piSection).not.toContainText(
                        'Pi pointer refresh',
                    );
                    await refresh.click();
                    await expect(piRows.first()).toContainText(
                        'Pi pointer refresh',
                    );
                    await expect(status).toHaveText('Sessions refreshed.');
                }
                expect(statePosts).toEqual([]);

                gates = await installSessionGates(page, injected503);
                const previousTitle = await piRows.first().textContent();
                if (previousTitle === null) {
                    throw new Error('Expected a previous Pi session title');
                }
                fixture.pi('pi-delayed', 'Pi delayed refresh');
                const delayedStarted = gates.holdNextSession();
                await activate(refresh, touch);
                await delayedStarted;
                await expect(piRows.first()).toHaveText(previousTitle);
                await expect(refresh).toBeEnabled();
                await expect(
                    page.locator('#coder-selector .coder-tab[data-coder="pi"]'),
                ).toBeEnabled();
                gates.releaseHeldSession();
                await expect(piRows.first()).toContainText(
                    'Pi delayed refresh',
                );
                await expect(status).toHaveText('Sessions refreshed.');

                gates.failNextSession();
                const failedResponse = page.waitForResponse(
                    (response) =>
                        new URL(response.url()).pathname === '/api/sessions' &&
                        response.status() === 503,
                );
                await activate(refresh, touch);
                expect((await failedResponse).status()).toBe(503);
                await expect(status).toContainText('Refresh failed');
                await expect(piRows.first()).toContainText(
                    'Pi delayed refresh',
                );
                await activate(refresh, touch);
                await expect(status).toHaveText('Sessions refreshed.');
                expect(gates.savePostCount).toBe(0);

                const piHeader = piSection.locator('.worktree-header');
                await activate(piHeader, touch);
                await expect(piSection).not.toHaveClass(/expanded/);
                await expect.poll(() => gates?.savePostCount ?? 0).toBe(1);
                const revalidation = gates.holdNextSession();
                await activate(piHeader, touch);
                await expect(piSection).toHaveClass(/expanded/);
                await revalidation;
                await expect(piRows.first()).toContainText(
                    'Pi delayed refresh',
                );
                await expect.poll(() => gates?.savePostCount ?? 0).toBe(2);
                const revalidationFinished = page.waitForEvent(
                    'requestfinished',
                    (request) => {
                        const url = new URL(request.url());
                        return (
                            url.pathname === '/api/sessions' &&
                            url.searchParams.get('coder') === 'pi'
                        );
                    },
                );
                gates.releaseHeldSession();
                gates.releaseStateSaves();
                await revalidationFinished;
                await expect(piSection.locator('.error-sessions')).toHaveCount(
                    0,
                );

                await activate(
                    page.locator(
                        '#coder-selector .coder-tab[data-coder="claude"]',
                    ),
                    touch,
                );
                const claudeSection = await ensureActiveSection(
                    page,
                    cwd,
                    touch,
                );
                const claudeRows = claudeSection.locator('.session-item');
                const priorClaudeTitles = touch
                    ? ['Claude desktop refresh', 'Claude initial session']
                    : ['Claude initial session'];
                await expect(
                    claudeSection.locator('.session-title'),
                ).toHaveText(priorClaudeTitles);
                fixture.claude('claude-new', `Claude ${mode} refresh`);
                await expect(claudeSection).not.toContainText(
                    `Claude ${mode} refresh`,
                );
                await activate(refresh, touch);
                await expect(claudeRows.first()).toContainText(
                    `Claude ${mode} refresh`,
                );
                await expect(status).toHaveText('Sessions refreshed.');
                const editSideEffects: string[] = [];
                page.on('request', (request) => {
                    if (
                        request.method() === 'POST' &&
                        ['/api/session-meta', '/api/terminals'].includes(
                            new URL(request.url()).pathname,
                        )
                    ) {
                        editSideEffects.push(request.url());
                    }
                });
                // The legacy hover-only rename opener is inaccessible to touch.
                // Only edit setup uses a DOM click; refresh itself stays a real activation.
                await claudeRows
                    .first()
                    .locator('.rename-btn')
                    .evaluate((button: HTMLButtonElement) => button.click());
                const rename = claudeSection.locator('.rename-input');
                await rename.fill('Unsaved rename');
                await activate(refresh, touch);
                await expect(status).toHaveText(
                    'Finish or cancel the edit, then refresh.',
                );
                await expect(rename).toHaveValue('Unsaved rename');
                if (!touch) {
                    await refresh.focus();
                    await page.keyboard.press('Enter');
                    await expect(rename).toHaveValue('Unsaved rename');
                }
                let holdWorktrees = true;
                let worktreesStarted!: () => void;
                const worktreesHeld = new Promise<void>((resolve) => {
                    worktreesStarted = resolve;
                });
                await page.route('**/api/git/worktrees?*', async (route) => {
                    if (holdWorktrees) {
                        holdWorktrees = false;
                        worktreesStarted();
                        await new Promise<void>((resolve) => {
                            releaseWorktrees = resolve;
                        });
                    }
                    await route.continue();
                });
                await rename.press('Escape');
                await worktreesHeld;
                await expect(rename).toHaveCount(0);
                await expect(claudeRows.first()).toContainText(
                    `Claude ${mode} refresh`,
                );
                await claudeRows.first().dispatchEvent('contextmenu', {
                    clientX: 80,
                    clientY: 250,
                });
                // Legacy context menus can be offscreen and bubble an outside click
                // that closes the touch drawer. Only this edit opener bypasses it.
                await page
                    .getByText('⚙ Launch with args…', { exact: true })
                    .evaluate((item) =>
                        item.dispatchEvent(
                            new MouseEvent('click', { bubbles: false }),
                        ),
                    );
                const args = claudeSection.locator('.args-input');
                await args.fill('--unsaved-argument');
                const worktreesFinished = page.waitForEvent(
                    'requestfinished',
                    (request) =>
                        new URL(request.url()).pathname ===
                        '/api/git/worktrees',
                );
                releaseWorktrees?.();
                await worktreesFinished;
                await expect(args).toHaveValue('--unsaved-argument');
                await activate(refresh, touch);
                await expect(status).toHaveText(
                    'Finish or cancel the edit, then refresh.',
                );
                await expect(args).toHaveValue('--unsaved-argument');
                await args.press('Escape');
                await expect(args).toHaveCount(0);
                expect(editSideEffects).toEqual([]);
                await activate(refresh, touch);
                await expect(status).toHaveText('Sessions refreshed.');
                if (touch)
                    await expect(page.locator('#sidebar-panel')).toHaveClass(
                        /drawer-open/,
                    );
                await assertSidebarBounds(page);
                if (!touch) {
                    for (const color of ['amber', 'purple']) {
                        await page
                            .locator('#header-config-pill .pill-label')
                            .click();
                        const savedTheme = page.waitForResponse(
                            (response) =>
                                new URL(response.url()).pathname ===
                                    '/api/config/theme' &&
                                response.request().method() === 'POST',
                        );
                        await page
                            .locator(`.settings-swatch[data-color="${color}"]`)
                            .click();
                        expect((await savedTheme).ok()).toBe(true);
                        await expect(page.locator('html')).toHaveAttribute(
                            'data-theme-color',
                            color,
                        );
                        await page
                            .locator('.settings-overlay .modal-close-btn')
                            .click();
                        await refresh.click();
                        await expect(status).toHaveText('Sessions refreshed.');
                        await assertSidebarBounds(page);
                    }
                }
                expect(page.url()).toBe(pageURL);
                expect(navigations).toEqual([]);
                expect(errors).toEqual([]);
            } finally {
                releaseWorktrees?.();
                gates?.releaseHeldSession();
                gates?.releaseStateSaves();
                if (context) {
                    await context.unrouteAll({ behavior: 'wait' });
                    await context.close();
                }
            }
        }
    } finally {
        await phi.stop();
    }
});

for (const mode of ['desktop', 'touch'] as const) {
    test(`restores saved Pi pages on ${mode} while list requests fail`, async ({
        browser,
    }) => {
        test.setTimeout(300_000);
        const touch = mode === 'touch';
        const fixture = await startFixture();
        const { phi, cwd } = fixture;
        let context: BrowserContext | undefined;
        try {
            for (let i = 0; i < 11; i++)
                fixture.pi(`saved-${i}`, `Saved session ${i}`);
            context = await browser.newContext({
                viewport: touch
                    ? { width: 390, height: 844 }
                    : { width: 1440, height: 900 },
                isMobile: touch,
                hasTouch: touch,
            });
            const page = await context.newPage();
            await page.route('**/api/update/status', (route) =>
                route.fulfill({
                    json: { current: 'dev', update_available: false },
                }),
            );
            const injected503 = new Map<string, number>();
            const errors = collectBrowserErrors(page, injected503, phi.url);
            const openPi = async () => {
                // The static toggle exists before initOnce wires its click handler.
                await expect(page.locator('.worktree-section')).toHaveCount(1);
                await expect(page.locator('html')).not.toHaveAttribute(
                    'data-sync',
                    'stale',
                );
                if (touch) {
                    await page.locator('#mobile-sidebar-toggle').tap();
                    await page.locator('#drawer-open-sessions').tap();
                }
                await activate(
                    page.locator('#coder-selector .coder-tab[data-coder="pi"]'),
                    touch,
                );
                return await ensureActiveSection(page, cwd, touch);
            };
            await page.goto(phi.url);
            let section = await openPi();
            await expect(section.locator('.session-item')).toHaveCount(10);
            await activate(
                section.locator('.session-page[data-page="1"]'),
                touch,
            );
            await expect(section.locator('.session-page-label')).toHaveText(
                'Page 2',
            );
            const savedTitles = await section
                .locator('.session-title')
                .allTextContents();
            expect(savedTitles).toHaveLength(2);
            const pageTwoURL = `/api/sessions?coder=pi&cwd=${encodeURIComponent(cwd)}&limit=10&offset=10`;
            const pageTwoKey = `phi_session_cache_v1:${encodeURIComponent(phi.url)}:${encodeURIComponent(pageTwoURL)}:`;
            await page.waitForFunction(
                (key) => localStorage.getItem(key) !== null,
                pageTwoKey,
                { timeout: 15_000 },
            );
            const blockList = async (route: Route) => {
                const url = route.request().url();
                injected503.set(url, (injected503.get(url) ?? 0) + 1);
                await route.fulfill({ status: 503, body: 'fixture offline' });
            };
            await page.route('**/api/sessions?*', blockList);
            await page.route('**/api/git/worktrees?*', blockList);
            // Auth/bootstrap remain online. Only the two list endpoints fail.
            await page.reload();
            // Background revalidation finishes while the touch drawer is still closed.
            await expect(
                page.locator('#session-list > .error-sessions'),
            ).toBeAttached();
            section = await openPi();
            await expect(section.locator('.session-item')).toHaveCount(10);
            await activate(
                section.locator('.session-page[data-page="1"]'),
                touch,
            );
            await expect(section.locator('.session-page-label')).toHaveText(
                'Page 2',
            );
            await expect(section.locator('.session-title')).toHaveText(
                savedTitles,
            );
            await expect(section.locator('.session-cache-note')).toContainText(
                'out of date',
            );
            await expect(section.locator('.error-sessions')).toBeVisible();
            await activate(page.locator('#refresh-sessions-btn'), touch);
            await expect(page.locator('#session-refresh-status')).toContainText(
                'Refresh failed',
            );
            await expect(section.locator('.session-title')).toHaveText(
                savedTitles,
            );
            await expect(section.locator('.session-page-label')).toHaveText(
                'Page 2',
            );
            await page.unroute('**/api/sessions?*', blockList);
            fixture.pi('after-reconnect', 'Pi after reconnect');
            await activate(page.locator('#refresh-sessions-btn'), touch);
            await expect(section.locator('.session-title').first()).toHaveText(
                'Pi after reconnect',
            );
            await expect(section.locator('.session-page-label')).toHaveText(
                'Page 1',
            );
            await expect(section.locator('.session-cache-note')).toHaveCount(0);
            await page.route('**/api/sessions?*', blockList);
            await activate(
                section.locator('.session-page[data-page="1"]'),
                touch,
            );
            await expect(section.locator('.session-page-label')).toHaveText(
                'Page 2',
            );
            await expect(section.locator('.session-title')).toHaveText(
                savedTitles,
            );
            await expect(section.locator('.session-cache-note')).toContainText(
                'out of date',
            );
            await expect(section.locator('.error-sessions')).toBeVisible();
            await assertSidebarBounds(page);
            if (touch)
                await expect(page.locator('#sidebar-panel')).toHaveClass(
                    /drawer-open/,
                );
            expect(errors).toEqual([]);
        } finally {
            try {
                await context?.unrouteAll({ behavior: 'wait' });
                await context?.close();
            } finally {
                await phi.stop();
            }
        }
    });
}
