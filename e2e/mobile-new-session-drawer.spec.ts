import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    expect,
    test,
    type Browser,
    type BrowserContext,
    type Page,
    type Request,
} from '@playwright/test';
import { configToToml, startPhi, type PhiServer } from './_server.js';
import { isCancelledWorktreeRead } from './_session-requests.js';

let phi: PhiServer | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;
let releaseGate: (() => void) | undefined;
let errors: string[] = [];
let failedLaunch: Request | undefined;

async function observe(p: Page) {
    // Optional startup services are outside this Shell launch fixture.
    await p.route('**/api/update/status', (route) =>
        route.fulfill({ json: { current: 'dev', update_available: false } }),
    );
    await p.route(
        (url) =>
            url.pathname === '/api/sessions' &&
            url.searchParams.get('coder') === 'opencode',
        (route) => route.fulfill({ json: [] }),
    );
    const successfulPins = new WeakSet<Request>();
    p.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    p.on('console', (message) => {
        if (message.type() !== 'error') return;
        const expected =
            failedLaunch &&
            message.location().url === failedLaunch.url() &&
            /Failed to load resource: (net::ERR_|the server responded with a status of 503)/.test(
                message.text(),
            );
        if (!expected) errors.push(`console: ${message.text()}`);
    });
    p.on('requestfailed', (request) => {
        if (isCancelledWorktreeRead(request, p.url())) return;
        // Chromium can report successful empty pin responses as aborted.
        if (
            successfulPins.has(request) &&
            request.failure()?.errorText === 'net::ERR_ABORTED'
        )
            return;
        if (!(request === failedLaunch))
            errors.push(
                `request: ${request.url()} ${request.failure()?.errorText}`,
            );
    });
    p.on('response', (response) => {
        if (
            response.status() === 200 &&
            response.request().method() === 'POST' &&
            /^\/api\/terminals\/[^/]+\/pin$/.test(
                new URL(response.url()).pathname,
            )
        )
            successfulPins.add(response.request());
        if (
            response.status() >= 400 &&
            !(response.request() === failedLaunch && response.status() === 503)
        )
            errors.push(`response: ${response.status()} ${response.url()}`);
    });
}

async function openPage(
    browser: Browser,
    w: number,
    h: number,
    mobile: boolean,
) {
    if (!phi) throw new Error('fixture not started');
    context = await browser.newContext({
        viewport: { width: w, height: h },
        isMobile: mobile,
        hasTouch: mobile,
    });
    page = await context.newPage();
    await observe(page);
    await page.goto(phi.url);
    await expect(page.locator('#workspace-select')).toHaveValue(
        realpathSync(phi.dir),
    );
    await expect(page.locator('html')).not.toHaveAttribute(
        'data-sync',
        'stale',
    );
    await page
        .locator('#diff-term-container .xterm')
        .first()
        .waitFor({ state: 'attached' });
    if (mobile) {
        expect(
            await page.evaluate(
                () =>
                    matchMedia('(pointer: coarse)').matches &&
                    navigator.maxTouchPoints > 0,
            ),
        ).toBe(true);
    }
    const shell = page.locator('#empty-quick-launch [data-coder="bash"]');
    const [reply] = await Promise.all([
        page.waitForResponse(
            (r) =>
                r.url().endsWith('/api/terminals') &&
                r.request().method() === 'POST',
        ),
        mobile ? shell.tap() : shell.click(),
    ]);
    expect(reply.ok()).toBe(true);
    const pane = await reply.json();
    await expect(page.locator('#tabs-container .tab')).toHaveCount(1);
    await expect(page.locator('#tabs-container .tab.active')).toHaveAttribute(
        'data-pane-id',
        pane.pane_id,
    );
    await expect(page.locator(`#term-${pane.pane_id} .xterm`)).toBeVisible();
    return page;
}

async function openSessions(p: Page, compact: boolean) {
    await p.locator('#mobile-sidebar-toggle').tap();
    if (compact) await p.locator('#drawer-open-sessions').tap();
    await expect(p.locator('#sidebar-panel')).toHaveClass(/drawer-open/);
}

async function noOverflow(p: Page) {
    await expect
        .poll(() =>
            p.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth + 1,
            ),
        )
        .toBe(true);
}

test.beforeEach(async () => {
    errors = [];
    failedLaunch = undefined;
    phi = await startPhi({
        env: { PHI_SHUTDOWN_PTY_GRACE: '150ms', PHI_SHUTDOWN_GRACE: '1s' },
        setup(dir) {
            const workspace = realpathSync(dir);
            const configDir = join(dir, 'home', '.phi');
            const backends = join(configDir, 'backends');
            mkdirSync(backends, { recursive: true });
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
                join(configDir, 'config.toml'),
                configToToml({ workspaces: [workspace] }),
            );
        },
    });
});

test.afterEach(async () => {
    releaseGate?.();
    releaseGate = undefined;
    try {
        if (page) await page.unrouteAll({ behavior: 'wait' });
    } finally {
        try {
            await context?.close();
        } finally {
            await phi?.stop();
            page = undefined;
            context = undefined;
            phi = undefined;
        }
    }
    expect(errors).toEqual([]);
});

test('phone MVP', async ({ browser }) => {
    await openPage(browser, 390, 844, true);
    if (!page) throw new Error('page not started');
    await openSessions(page, true);
    let held = false;
    let posts = 0;
    const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
    });
    await page.route('**/api/terminals', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        posts++;
        held = true;
        await gate;
        await route.continue();
    });
    const response = page.waitForResponse(
        (reply) =>
            reply.url().endsWith('/api/terminals') &&
            reply.request().method() === 'POST',
    );
    void response.catch(() => {});
    await page.locator('#new-session-btn').tap();
    await expect.poll(() => held).toBe(true);
    await expect(page.locator('#sidebar-panel')).not.toHaveClass(/drawer-open/);
    await expect(page.locator('#tabs-container .tab')).toHaveCount(1);
    await expect
        .poll(() =>
            page!
                .locator('#sidebar-panel')
                .evaluate((el) => el.getBoundingClientRect().right),
        )
        .toBeLessThanOrEqual(1);
    releaseGate?.();
    const reply = await response;
    expect(reply.ok()).toBe(true);
    const pane = await reply.json();
    expect(posts).toBe(1);
    await expect(page.locator('#tabs-container .tab.active')).toHaveAttribute(
        'data-pane-id',
        pane.pane_id,
    );
    await expect(page.locator(`#term-${pane.pane_id} .xterm`)).toBeVisible();
    await expect(page.locator('#sidebar-panel')).not.toHaveClass(/drawer-open/);
    await expect
        .poll(() =>
            page!
                .locator('#sidebar-panel')
                .evaluate((el) => el.getBoundingClientRect().right),
        )
        .toBeLessThanOrEqual(1);
    await noOverflow(page);
});

test('landscape touch closes on new session and direct Shell', async ({
    browser,
}) => {
    const p = await openPage(browser, 932, 430, true);
    await openSessions(p, true);
    let count = 0;
    p.on('request', (r) => {
        if (r.method() === 'POST' && r.url().endsWith('/api/terminals'))
            count++;
    });
    const [response] = await Promise.all([
        p.waitForResponse(
            (r) =>
                r.request().method() === 'POST' &&
                r.url().endsWith('/api/terminals'),
        ),
        p.locator('#new-session-btn').tap(),
    ]);
    expect(response.ok()).toBe(true);
    await expect(p.locator('#tabs-container .tab')).toHaveCount(2);
    await expect(p.locator('#sidebar-panel')).not.toHaveClass(/drawer-open/);
    await openSessions(p, true);
    const [shell] = await Promise.all([
        p.waitForResponse(
            (r) =>
                r.request().method() === 'POST' &&
                r.url().endsWith('/api/terminals'),
        ),
        p.locator('#coder-selector [data-coder="bash"]').tap(),
    ]);
    expect(shell.ok()).toBe(true);
    await expect(p.locator('#tabs-container .tab')).toHaveCount(3);
    await expect(p.locator('#sidebar-panel')).not.toHaveClass(/drawer-open/);
    expect(count).toBe(2);
    await noOverflow(p);
});

test('tablet drawer stays open', async ({ browser }) => {
    const p = await openPage(browser, 820, 1180, true);
    await openSessions(p, false);
    const [response] = await Promise.all([
        p.waitForResponse(
            (r) =>
                r.request().method() === 'POST' &&
                r.url().endsWith('/api/terminals'),
        ),
        p.locator('#new-session-btn').tap(),
    ]);
    expect(response.ok()).toBe(true);
    await expect(p.locator('#tabs-container .tab')).toHaveCount(2);
    await expect(p.locator('#sidebar-panel')).toHaveClass(/drawer-open/);
    await noOverflow(p);
});

for (const mobile of [true, false]) {
    test(`${mobile ? 'mobile' : 'desktop'} Enter starts one session`, async ({
        browser,
    }) => {
        const p = await openPage(
            browser,
            mobile ? 390 : 1440,
            mobile ? 844 : 900,
            mobile,
        );
        if (mobile) await openSessions(p, true);
        let count = 0;
        p.on('request', (r) => {
            if (r.method() === 'POST' && r.url().endsWith('/api/terminals'))
                count++;
        });
        await p.locator('#new-session-btn').focus();
        const [response] = await Promise.all([
            p.waitForResponse(
                (r) =>
                    r.request().method() === 'POST' &&
                    r.url().endsWith('/api/terminals'),
            ),
            p.keyboard.press('Enter'),
        ]);
        expect(response.ok()).toBe(true);
        await expect(p.locator('#tabs-container .tab')).toHaveCount(2);
        expect(count).toBe(1);
        if (mobile)
            await expect(p.locator('#sidebar-panel')).not.toHaveClass(
                /drawer-open/,
            );
        else await expect(p.locator('#sidebar-panel')).toBeVisible();
        await noOverflow(p);
    });
}

test('reopened drawer remains open after held response', async ({
    browser,
}) => {
    const p = await openPage(browser, 390, 844, true);
    await openSessions(p, true);
    let held = false;
    const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
    });
    await p.route('**/api/terminals', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        held = true;
        await gate;
        await route.continue();
    });
    const response = p.waitForResponse(
        (r) =>
            r.request().method() === 'POST' &&
            r.url().endsWith('/api/terminals'),
    );
    void response.catch(() => {});
    await p.locator('#new-session-btn').tap();
    await expect.poll(() => held).toBe(true);
    await expect(p.locator('#sidebar-panel')).not.toHaveClass(/drawer-open/);
    await p.locator('#mobile-sidebar-toggle').tap();
    await expect(p.locator('#sidebar-panel')).toHaveClass(/drawer-open/);
    releaseGate?.();
    expect((await response).ok()).toBe(true);
    await expect(p.locator('#tabs-container .tab')).toHaveCount(2);
    await expect(p.locator('#sidebar-panel')).toHaveClass(/drawer-open/);
    await noOverflow(p);
});

for (const failure of ['http', 'offline', 'lost'] as const) {
    test(`${failure} launch does not retry`, async ({ browser }) => {
        const p = await openPage(browser, 390, 844, true);
        await openSessions(p, true);
        let posts = 0;
        let upstreamPane = '';
        await p.route('**/api/terminals', async (route) => {
            if (route.request().method() !== 'POST') return route.continue();
            posts++;
            if (posts === 1) failedLaunch = route.request();
            if (failure === 'http')
                return route.fulfill({ status: 503, body: 'unavailable' });
            if (failure === 'offline')
                return route.abort('internetdisconnected');
            const result = await route.fetch({ maxRetries: 0 });
            expect(result.ok()).toBe(true);
            upstreamPane = (await result.json()).pane_id;
            expect(upstreamPane).toBeTruthy();
            await route.abort('failed');
        });
        await p.locator('#new-session-btn').tap();
        await expect(p.locator('#sidebar-panel')).not.toHaveClass(
            /drawer-open/,
        );
        await expect
            .poll(() =>
                p
                    .locator('#sidebar-panel')
                    .evaluate((el) => el.getBoundingClientRect().right),
            )
            .toBeLessThanOrEqual(1);
        await expect(p.locator('.toast-error')).toBeVisible();
        await expect(p.locator('#tabs-container .tab')).toHaveCount(1);
        expect(posts).toBe(1);
        if (failure === 'lost') {
            expect(upstreamPane).toBeTruthy();
            await expect(
                p.locator(`.tab[data-pane-id="${upstreamPane}"]`),
            ).toHaveCount(0);
        } else {
            await p.unroute('**/api/terminals');
            failedLaunch = undefined;
            await openSessions(p, true);
            const [response] = await Promise.all([
                p.waitForResponse(
                    (r) =>
                        r.request().method() === 'POST' &&
                        r.url().endsWith('/api/terminals'),
                ),
                p.locator('#new-session-btn').tap(),
            ]);
            expect(response.ok()).toBe(true);
            await expect(p.locator('#tabs-container .tab')).toHaveCount(2);
        }
        await noOverflow(p);
    });
}
