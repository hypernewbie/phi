import { mkdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    expect,
    test,
    type BrowserContext,
    type Locator,
    type Page,
    type Route,
} from '@playwright/test';
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
        [
            JSON.stringify({ type: 'session', version: 3, id, cwd, timestamp }),
            JSON.stringify({ type: 'session_info', name: title }),
        ].join('\n') + '\n',
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
    const pi = (id: string, title: string) =>
        writePiSession(home, cwd, id, title, (nextTime += 1_000));
    const claude = (id: string, title: string) =>
        writeClaudeSession(home, cwd, id, title, (nextTime += 1_000));
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
    if (touch) await locator.tap();
    else await locator.click();
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
): string[] {
    const errors: string[] = [];
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

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
    const widths = await page.evaluate(() => {
        const panel = document
            .getElementById('sidebar-panel')!
            .getBoundingClientRect();
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
}

for (const mode of ['desktop', 'touch'] as const) {
    test(`refreshes Pi and Claude sessions on ${mode} without reloading`, async ({
        browser,
    }) => {
        test.setTimeout(300_000);
        const touch = mode === 'touch';
        const fixture = await startFixture();
        const { phi, cwd } = fixture;
        let context: BrowserContext | null = null;
        let gates: Awaited<ReturnType<typeof installSessionGates>> | null =
            null;
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
            const errors = collectBrowserErrors(page, injected503);
            const navigations: string[] = [];
            const sessionRequests: string[] = [];
            const statePosts: string[] = [];
            page.on('framenavigated', (frame) => {
                if (frame === page.mainFrame()) navigations.push(frame.url());
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
                await expect(page.locator('#drawer-tabs-body')).toBeVisible();
                await expect(refresh).toBeHidden();
                await page.locator('#drawer-open-sessions').tap();
                await expect(page.locator('#drawer-panel-title')).toHaveText(
                    'SESSIONS',
                );
            }
            await activate(
                page.locator('#coder-selector .coder-tab[data-coder="pi"]'),
                touch,
            );
            const piSection = await ensureActiveSection(page, cwd, touch);
            const piRows = piSection.locator('.session-item');
            const status = page.locator('#session-refresh-status');
            await expect(piRows).toHaveCount(1);
            await expect(piRows.first()).toContainText('Pi initial session');
            await expect(refresh).toBeVisible();

            fixture.pi('pi-new', `Pi ${mode} refresh`);
            await expect(piRows).toHaveCount(1);
            await expect(piSection).not.toContainText(`Pi ${mode} refresh`);
            if (touch) await refresh.tap();
            else {
                await refresh.focus();
                await page.keyboard.press('Enter');
            }
            await expect(piRows.first()).toContainText(`Pi ${mode} refresh`);
            await expect(status).toHaveText('Sessions refreshed.');
            const params = new URL(sessionRequests.at(-1)!).searchParams;
            expect(Object.fromEntries(params)).toEqual({
                coder: 'pi',
                cwd,
                limit: '10',
                offset: '0',
            });
            if (!touch) {
                fixture.pi('pi-pointer', 'Pi pointer refresh');
                await expect(piSection).not.toContainText('Pi pointer refresh');
                await refresh.click();
                await expect(piRows.first()).toContainText(
                    'Pi pointer refresh',
                );
                await expect(status).toHaveText('Sessions refreshed.');
            }
            expect(statePosts).toEqual([]);

            gates = await installSessionGates(page, injected503);
            const previousTitle = await piRows.first().textContent();
            fixture.pi('pi-delayed', 'Pi delayed refresh');
            const delayedStarted = gates.holdNextSession();
            await activate(refresh, touch);
            await delayedStarted;
            await expect(piRows.first()).toHaveText(previousTitle!);
            await expect(refresh).toBeEnabled();
            await expect(
                page.locator('#coder-selector .coder-tab[data-coder="pi"]'),
            ).toBeEnabled();
            gates.releaseHeldSession();
            await expect(piRows.first()).toContainText('Pi delayed refresh');
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
            await expect(piRows.first()).toContainText('Pi delayed refresh');
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
            await expect(piRows.first()).toContainText('Pi delayed refresh');
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
            await expect(piSection.locator('.error-sessions')).toHaveCount(0);

            await activate(
                page.locator('#coder-selector .coder-tab[data-coder="claude"]'),
                touch,
            );
            const claudeSection = await ensureActiveSection(page, cwd, touch);
            const claudeRows = claudeSection.locator('.session-item');
            await expect(claudeRows).toHaveCount(1);
            await expect(claudeRows.first()).toContainText(
                'Claude initial session',
            );
            fixture.claude('claude-new', `Claude ${mode} refresh`);
            await expect(claudeSection).not.toContainText(
                `Claude ${mode} refresh`,
            );
            await activate(refresh, touch);
            await expect(claudeRows.first()).toContainText(
                `Claude ${mode} refresh`,
            );
            await expect(status).toHaveText('Sessions refreshed.');
            if (touch)
                await expect(page.locator('#sidebar-panel')).toHaveClass(
                    /drawer-open/,
                );
            await assertNoHorizontalOverflow(page);
            expect(page.url()).toBe(pageURL);
            expect(navigations).toEqual([]);
            expect(errors).toEqual([]);
        } finally {
            gates?.releaseHeldSession();
            gates?.releaseStateSaves();
            if (context) await context.close();
            await phi.stop();
        }
    });
}
