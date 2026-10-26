import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    expect,
    test,
    type APIRequestContext,
    type Browser,
    type Locator,
    type Page,
    type Request,
} from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

// Real pinned Pi with injection disabled at startup: these panes have no
// bridge, so they exercise the saved-option fallback end to end.

// Both cases mutate the one server-side preset list, so they cannot overlap.
test.describe.configure({ mode: 'serial' });

const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

interface ObservedTerminal {
    element?: HTMLElement;
    rows: number;
    buffer: {
        active: {
            viewportY: number;
            getLine(
                i: number,
            ): { translateToString(trim?: boolean): string } | undefined;
        };
    };
}

/**
 * Capture the real xterm Terminal instances. Phi renders with the WebGL
 * addon, so there is no `.xterm-rows` DOM to read: the buffer is the only
 * honest source for what Pi printed.
 */
async function observe(page: Page) {
    await page.addInitScript(() => {
        type Constructor = new (
            opts: Record<string, unknown>,
        ) => ObservedTerminal;
        const w = window as unknown as { nativeTerms: ObservedTerminal[] };
        w.nativeTerms = [];
        let ctor: Constructor;
        Object.defineProperty(window, 'Terminal', {
            configurable: true,
            get: () => ctor,
            set: (base: Constructor) => {
                ctor = class extends base {
                    constructor(opts: Record<string, unknown>) {
                        super(opts);
                        w.nativeTerms.push(this);
                    }
                };
            },
        });
    });
}

async function terminalText(page: Page, pane: string): Promise<string> {
    return page.evaluate((id) => {
        const w = window as unknown as { nativeTerms: ObservedTerminal[] };
        const term = w.nativeTerms.find(
            (candidate) =>
                candidate.element?.closest('.term-container')?.id ===
                `term-${id}`,
        );
        if (!term) return '';
        return Array.from(
            { length: term.rows },
            (_, i) =>
                term.buffer.active
                    .getLine(term.buffer.active.viewportY + i)
                    ?.translateToString(true) || '',
        ).join('\n');
    }, pane);
}

async function spawnPane(
    request: APIRequestContext,
    url: string,
    cwd: string,
    title: string,
) {
    const response = await request.post(`${url}/api/terminals`, {
        data: { coder: 'pi', cwd, title },
    });
    expect(response.ok()).toBe(true);
    return ((await response.json()) as { pane_id: string }).pane_id;
}

const saved = (page: Page) => page.locator('.pi-thinking-saved-level');
const trigger = (page: Page) =>
    page.locator('#presets-container button.pi-rpc-thinking-trigger');

async function openMenu(page: Page) {
    const dropup = page.locator('#pi-rpc-thinking-dropup');
    if (await dropup.isHidden()) {
        await trigger(page).scrollIntoViewIfNeeded();
        await trigger(page).click({ timeout: 30_000 });
    }
    await expect(dropup).toBeVisible({ timeout: 15_000 });
    return dropup;
}

async function addLevel(page: Page, level: string) {
    await page
        .getByRole('button', { name: 'Add Thinking Option' })
        .click({ timeout: 30_000 });
    await page.locator('#config-editor-level').fill(level);
    const put = page.waitForResponse(
        (response) =>
            response.url().endsWith('/api/config/thinking-presets') &&
            response.request().method() === 'PUT',
    );
    await page
        .getByRole('button', { name: 'Add Option' })
        .click({ timeout: 30_000 });
    expect((await put).status()).toBe(200);
    await expect(page.locator('.config-editor-overlay')).toHaveCount(0);
    if (await page.locator('#pi-rpc-thinking-dropup').isHidden())
        await openMenu(page);
}

async function editLevel(page: Page, from: string, to: string) {
    await page
        .getByRole('button', { name: `Edit Thinking option ${from}` })
        .click();
    await page.locator('#config-editor-level').fill(` ${to} `);
    const put = page.waitForResponse(
        (response) =>
            response.url().endsWith('/api/config/thinking-presets') &&
            response.request().method() === 'PUT',
    );
    await page.getByRole('button', { name: 'Save Option' }).click();
    expect((await put).status()).toBe(200);
    await expect(page.locator('.config-editor-overlay')).toHaveCount(0);
    if (await page.locator('#pi-rpc-thinking-dropup').isHidden())
        await openMenu(page);
}

async function deleteLevel(page: Page, level: string) {
    const put = page.waitForResponse(
        (response) =>
            response.url().endsWith('/api/config/thinking-presets') &&
            response.request().method() === 'PUT',
    );
    await page
        .getByRole('button', { name: `Delete Thinking option ${level}` })
        .click();
    expect((await put).status()).toBe(200);
}

/**
 * Mobile layouts can leave an overlay on top of the presets row. Toggle the
 * Git Diff drawer until the add row is the element that receives the tap.
 */
async function revealAddRow(page: Page, dropup: Locator) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const covered = await page.evaluate(() => {
            const button = document.querySelector(
                '#pi-rpc-thinking-dropup .dropup-add-btn',
            );
            if (!button) return true;
            const rect = button.getBoundingClientRect();
            const hit = document.elementFromPoint(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
            );
            return !(hit === button || button.contains(hit));
        });
        if (!covered) return;
        await page
            .getByRole('button', { name: 'Toggle Git Diff Panel' })
            .click({ timeout: 15_000 });
        if (await dropup.isHidden()) dropup = await openMenu(page);
    }
}

let phi: PhiServer;

test.beforeAll(async () => {
    phi = await startPhi({
        config: { auto_reconnect: 'off', pi_bridge_no_inject: true },
        env: {
            PI_OFFLINE: '1',
            PI_SKIP_VERSION_CHECK: '1',
        },
        setup(dir) {
            const agent = join(dir, 'home', '.pi', 'agent');
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
            const command = join(dir, 'native-pi');
            const binary = join(process.cwd(), 'node_modules', '.bin', 'pi');
            writeFileSync(
                command,
                `#!/bin/sh\nexec ${shellQuote(binary)} --no-extensions --no-skills --no-prompt-templates --no-context-files --no-approve --model anthropic/claude-sonnet-4-5 "$@"\n`,
                { mode: 0o755 },
            );
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
    await phi?.stop();
});

test('saved Thinking options drive real Pi from an uninjected pane', async ({
    page,
    request,
}) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    const httpFailures: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
        if (response.status() >= 400)
            httpFailures.push(
                `${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`,
            );
    });
    await page.route('**/api/proxy?*', (route) => route.fulfill({ json: [] }));
    await observe(page);

    const pane = await spawnPane(
        request,
        phi.url,
        realpathSync(phi.dir),
        'Saved',
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    const initialRead = page.waitForResponse(
        (response) =>
            response.url().endsWith('/api/config/thinking-presets') &&
            response.request().method() === 'GET',
    );
    await page.goto(phi.url);
    await page.locator(`.tab[data-pane-id="${pane}"]`).click();

    // The duplicate Send-side control is gone; the bottom bar keeps one.
    await expect(page.locator('#pi-thinking-btn')).toHaveCount(0);
    await expect(trigger(page)).toBeVisible({ timeout: 30_000 });
    await expect(trigger(page)).toHaveAttribute(
        'title',
        'Thinking · saved options',
    );

    // Opening the menu sends nothing to Pi.
    let dropup = await openMenu(page);
    await initialRead;
    await expect(dropup).toContainText('No saved Thinking options yet');
    expect(await terminalText(page, pane)).not.toContain('Thinking level');

    // Add through the real editor; the server is the source of truth.
    await addLevel(page, 'high');
    dropup = await openMenu(page);
    await expect(saved(page)).toHaveText('high');

    // Edit accepts surrounding input whitespace and persists the trimmed token.
    await editLevel(page, 'high', 'low');
    await expect(saved(page)).toHaveText('low');
    await editLevel(page, 'low', 'high');
    await expect(saved(page)).toHaveText('high');

    // Selecting dispatches /thinking <level> for real and keeps the draft.
    await page.locator('#input-textarea').fill('keep this draft');
    await expect(saved(page)).toBeEnabled();
    await saved(page).click();
    await expect(dropup).toBeHidden();
    await expect(page.locator('#input-textarea')).toHaveValue(
        'keep this draft',
    );
    await expect
        .poll(() => terminalText(page, pane), { timeout: 30_000 })
        .toContain('Thinking level: high');

    // Cached state paints before a deliberately held server response arrives.
    let releaseCachedGet!: () => void;
    let reachedCachedGet!: () => void;
    const cachedGetStarted = new Promise<void>((resolve) => {
        reachedCachedGet = resolve;
    });
    let heldCachedGet = false;
    await page.route('**/api/config/thinking-presets', async (route) => {
        if (route.request().method() === 'GET' && !heldCachedGet) {
            heldCachedGet = true;
            reachedCachedGet();
            await new Promise<void>((resolve) => {
                releaseCachedGet = resolve;
            });
        }
        await route.continue();
    });
    await page.reload();
    await page.locator(`.tab[data-pane-id="${pane}"]`).click();
    await cachedGetStarted;
    dropup = await openMenu(page);
    await expect(saved(page)).toHaveText('high');
    expect(typeof releaseCachedGet).toBe('function');
    const cachedResponse = page.waitForResponse(
        (response) =>
            response.url().endsWith('/api/config/thinking-presets') &&
            response.request().method() === 'GET',
    );
    releaseCachedGet();
    await cachedResponse;
    await page.unroute('**/api/config/thinking-presets');
    await expect(saved(page)).toHaveText('high');

    // Never-submitted offline work stays cached across reload and flushes
    // after an online probe without an attempted/aborted PUT.
    await page.locator('#input-textarea').fill('');
    dropup = await openMenu(page);
    let offlinePuts = 0;
    const countOfflinePuts = (request: Request) => {
        if (
            request.url().endsWith('/api/config/thinking-presets') &&
            request.method() === 'PUT'
        )
            offlinePuts++;
    };
    page.on('request', countOfflinePuts);
    await page.route('**/api/config/thinking-presets', async (route) => {
        if (route.request().method() === 'GET') await route.abort('failed');
        else await route.continue();
    });
    await page.getByRole('button', { name: 'Add Thinking Option' }).click();
    await page.locator('#config-editor-level').fill('xhigh');
    await page.getByRole('button', { name: 'Add Option' }).click();
    await expect(page.locator('.config-editor-overlay')).toHaveCount(0);
    if (await page.locator('#pi-rpc-thinking-dropup').isHidden())
        dropup = await openMenu(page);
    await expect(saved(page)).toHaveText(['high', 'xhigh']);
    await page.reload();
    await page.locator(`.tab[data-pane-id="${pane}"]`).click();
    dropup = await openMenu(page);
    await expect(saved(page)).toHaveText(['high', 'xhigh']);
    await page.waitForTimeout(100);
    expect(offlinePuts).toBe(0);
    await page.unroute('**/api/config/thinking-presets');
    const offlineFlush = page.waitForResponse(
        (response) =>
            response.url().endsWith('/api/config/thinking-presets') &&
            response.request().method() === 'PUT',
    );
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    expect((await offlineFlush).status()).toBe(200);
    page.off('request', countOfflinePuts);

    // A lost write stays visible and is not replayed on its own.
    await page.locator('#input-textarea').fill('');
    dropup = await openMenu(page);
    await page.getByRole('button', { name: 'Add Thinking Option' }).click();
    await page.locator('#config-editor-level').fill('low');
    await page.route('**/api/config/thinking-presets', (route) =>
        route.request().method() === 'PUT'
            ? route.abort('failed')
            : route.continue(),
    );
    await page.getByRole('button', { name: 'Add Option' }).click();
    dropup = await openMenu(page);
    await expect(saved(page)).toHaveCount(3);
    await expect(dropup).toContainText('Save again');

    // Reconnect: only an explicit Save again retries the settled attempt.
    await page.unroute('**/api/config/thinking-presets');
    const retry = page.waitForResponse(
        (response) =>
            response.url().endsWith('/api/config/thinking-presets') &&
            response.request().method() === 'PUT',
    );
    await page.locator('.pi-thinking-save-again').click();
    expect((await retry).status()).toBe(200);
    await expect(dropup.locator('.pi-thinking-save-again')).toHaveCount(0);

    const finalConfig = await request.get(
        `${phi.url}/api/config/thinking-presets`,
    );
    expect((await finalConfig.json()).thinking_presets).toEqual([
        'high',
        'xhigh',
        'low',
    ]);

    // Deleting the remaining rows reaches the intentional clear-to-empty state.
    await deleteLevel(page, 'high');
    await deleteLevel(page, 'xhigh');
    await deleteLevel(page, 'low');
    const cleared = await request.get(`${phi.url}/api/config/thinking-presets`);
    expect((await cleared.json()).thinking_presets).toEqual([]);

    // Accepted failures: the deliberately aborted PUT above, plus the
    // fixture's offline update check and its empty session directory.
    const baseline = ['503 GET /api/update/status', '500 GET /api/sessions'];
    const unexpected = httpFailures.filter(
        (failure) =>
            !failure.startsWith('PUT /api/config/thinking-presets') &&
            !baseline.includes(failure),
    );
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
});

test('mobile and touch: the menu fits and its controls are reachable', async ({
    browser,
    request,
}: {
    browser: Browser;
    request: APIRequestContext;
}) => {
    test.setTimeout(180_000);
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
    });
    const page = await context.newPage();
    const errors: string[] = [];
    const httpFailures: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
        if (response.status() >= 400)
            httpFailures.push(
                `${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`,
            );
    });
    try {
        await page.route('**/api/proxy?*', (route) =>
            route.fulfill({ json: [] }),
        );
        await observe(page);
        const pane = await spawnPane(
            request,
            phi.url,
            realpathSync(phi.dir),
            'Saved mobile',
        );
        await page.goto(phi.url);
        // Compact layout selects tabs through the hostname dropdown.
        await page.locator('#hostname-display').click({ timeout: 30_000 });
        const dropdown = page.locator('#hostname-tabs-dropdown');
        await expect(dropdown).toBeVisible({ timeout: 30_000 });
        await dropdown
            .locator(
                `.hostname-dropdown-row[data-pane-id="${pane}"] .hostname-dropdown-select-btn`,
            )
            .click({ timeout: 30_000 });
        await expect(page.locator('.tab.active')).toHaveAttribute(
            'data-pane-id',
            pane,
        );
        await expect(page.locator(`#term-${pane}`)).toBeVisible({
            timeout: 30_000,
        });
        await expect(trigger(page)).toBeEnabled({ timeout: 30_000 });

        let dropup = await openMenu(page);
        await expect(dropup).toBeVisible();
        const overflow = await page.evaluate(() => ({
            inner: window.innerWidth,
            scroll: document.documentElement.scrollWidth,
        }));
        expect(overflow.scroll).toBeLessThanOrEqual(overflow.inner + 1);

        await revealAddRow(page, dropup);
        if (await dropup.isHidden()) dropup = await openMenu(page);
        await addLevel(page, 'medium');
        dropup = await openMenu(page);
        const medium = saved(page).filter({ hasText: /^medium$/ });
        await expect(medium).toHaveCount(1);
        await medium.tap();
        await expect(dropup).toBeHidden();
        await expect
            .poll(() => terminalText(page, pane), { timeout: 30_000 })
            .toContain('Thinking level: medium');
        const baseline = [
            '503 GET /api/update/status',
            '500 GET /api/sessions',
        ];
        expect(
            httpFailures.filter((failure) => !baseline.includes(failure)),
        ).toEqual([]);
        expect(errors).toEqual([]);
    } finally {
        await context.close();
    }
});
