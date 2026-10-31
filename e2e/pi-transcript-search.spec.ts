import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    expect,
    test,
    type APIRequestContext,
    type Page,
} from '@playwright/test';
import { startPhi } from './_server.js';
import { startSkillProvider } from './_pi-skill-provider.js';

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const NEEDLE = 'M3-TRANSCRIPT-NEEDLE-9c2b-ſ-ς-Kx';
const QUERY = 'M3-TRANSCRIPT-NEEDLE-9c2b-S-Σ-KX';

interface BridgeView {
    state: string;
    connected?: boolean;
    generation?: string;
    capabilities?: string[];
}

async function paneBridge(
    request: APIRequestContext,
    url: string,
    paneID: string,
): Promise<BridgeView | undefined> {
    const response = await request.get(`${url}/api/terminals`);
    if (!response.ok()) return undefined;
    const tabs = (await response.json()) as Array<{
        id: string;
        pi_bridge?: BridgeView;
    }>;
    return tabs.find((tab) => tab.id === paneID)?.pi_bridge;
}

function isSupersededTranscriptQuery(
    method: string,
    url: URL,
    body: string | null,
): boolean {
    if (
        method !== 'POST' ||
        url.pathname !== '/api/pi-bridge/transcript-search'
    )
        return false;
    try {
        const query = (JSON.parse(body ?? '') as { query?: unknown }).query;
        return (
            typeof query === 'string' &&
            query !== QUERY &&
            QUERY.startsWith(query)
        );
    } catch {
        return false;
    }
}

function monitorPage(page: Page, baseUrl: string) {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    const expectedConsoleErrors = new Map<string, number>();
    const optionalFailure = (url: URL, status?: number) =>
        (url.pathname === '/api/update/status' && status === 503) ||
        (url.pathname === '/api/sessions' &&
            url.searchParams.get('coder') === 'opencode' &&
            status === 500);
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const url = new URL(message.location().url || baseUrl);
        if (
            (url.pathname === '/api/update/status' &&
                message.text().includes('503')) ||
            (url.pathname === '/api/sessions' &&
                url.searchParams.get('coder') === 'opencode' &&
                message.text().includes('500'))
        )
            return;
        const expectedCount = expectedConsoleErrors.get(message.text()) ?? 0;
        if (expectedCount > 0) {
            expectedConsoleErrors.set(message.text(), expectedCount - 1);
            return;
        }
        consoleErrors.push(message.text());
    });
    page.on('requestfailed', (request) => {
        if (request.resourceType() === 'websocket') return;
        const url = new URL(request.url());
        const error = request.failure()?.errorText ?? 'failed';
        // The app supersedes an in-flight worktree poll with a newer poll;
        // the older GET can be aborted after the server has already answered.
        if (
            request.method() === 'GET' &&
            url.pathname === '/api/git/worktree-dirty' &&
            error === 'net::ERR_ABORTED'
        )
            return;
        if (
            error === 'net::ERR_ABORTED' &&
            isSupersededTranscriptQuery(
                request.method(),
                url,
                request.postData(),
            )
        )
            return;
        failedRequests.push(`${request.method()} ${request.url()}: ${error}`);
    });
    page.on('response', (response) => {
        if (response.status() < 400) return;
        const url = new URL(response.url());
        if (
            response.status() === 503 &&
            isSupersededTranscriptQuery(
                response.request().method(),
                url,
                response.request().postData(),
            )
        ) {
            // The previous literal query was canceled after a newer input.
            // The final query is not a strict prefix and must pass normally.
            const text =
                'Failed to load resource: the server responded with a status of 503 (Service Unavailable)';
            expectedConsoleErrors.set(
                text,
                (expectedConsoleErrors.get(text) ?? 0) + 1,
            );
            return;
        }
        if (!optionalFailure(url, response.status()))
            failedRequests.push(`${response.status()} ${response.url()}`);
    });
    return { pageErrors, consoleErrors, failedRequests };
}

test('managed Pi transcript search works through the find bar on desktop and touch', async ({
    browser,
    page,
    request,
}) => {
    test.setTimeout(240_000);
    page.setDefaultTimeout(30_000);
    const provider = await startSkillProvider();
    const phi = await startPhi({
        config: { auto_reconnect: 'off' },
        env: { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
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
            writeFileSync(
                join(agent, 'models.json'),
                JSON.stringify({
                    providers: {
                        'phi-fixture': {
                            baseUrl: `http://127.0.0.1:${provider.port}`,
                            api: 'anthropic-messages',
                            apiKey: 'fixture-key',
                            models: [{ id: 'fixture-model' }],
                        },
                    },
                }),
            );
            const command = join(dir, 'native-pi');
            const binary = join(process.cwd(), 'node_modules', '.bin', 'pi');
            writeFileSync(
                command,
                `#!/bin/sh\nexec ${shellQuote(binary)} --no-extensions --no-skills --no-prompt-templates --no-context-files --no-approve --model phi-fixture/fixture-model "$@"\n`,
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

    let mobileContext:
        | Awaited<ReturnType<typeof browser.newContext>>
        | undefined;
    try {
        phi.verify();
        const cwd = realpathSync(phi.dir);
        const spawn = await request.post(`${phi.url}/api/terminals`, {
            data: { coder: 'pi', cwd, title: 'Transcript search' },
        });
        expect(spawn.ok()).toBe(true);
        const pane = ((await spawn.json()) as { pane_id: string }).pane_id;
        await expect
            .poll(() => paneBridge(request, phi.url, pane), { timeout: 30_000 })
            .toMatchObject({
                state: 'managed',
                connected: true,
                capabilities: expect.arrayContaining([
                    'pi.transcript-search.v1',
                ]),
            });
        const bridge = await paneBridge(request, phi.url, pane);
        const generation = bridge?.generation;
        expect(generation).toBeTruthy();
        if (!generation) throw new Error('managed Pi bridge has no generation');

        const prompt = await request.post(
            `${phi.url}/api/terminals/${pane}/input`,
            { data: { text: `Please repeat ${NEEDLE} exactly.` } },
        );
        expect(prompt.ok()).toBe(true);
        const [providerRequest] = await provider.waitForRequests(1);
        expect(providerRequest).toContain(NEEDLE);
        await expect
            .poll(
                async () => {
                    const recording = await request.get(
                        `${phi.url}/api/terminals/${pane}/recording?from=0&through=2097152`,
                    );
                    return recording.ok() ? recording.text() : '';
                },
                { timeout: 30_000 },
            )
            .toContain('fixture ok');

        const apiSearch = await request.post(
            `${phi.url}/api/pi-bridge/transcript-search`,
            {
                data: {
                    pane,
                    query: QUERY,
                    generation,
                    initial: true,
                },
            },
        );
        expect(apiSearch.ok()).toBe(true);
        const apiPage = (await apiSearch.json()) as {
            matches: Array<{ role: string; snippet: string }>;
            complete: boolean;
            unavailable: boolean;
        };
        expect(apiPage).toMatchObject({ complete: true, unavailable: false });
        expect(apiPage.matches).toHaveLength(1);
        expect(apiPage.matches[0]).toMatchObject({
            role: 'user',
            snippet: expect.stringContaining(NEEDLE),
        });

        const desktopMonitor = monitorPage(page, phi.url);
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(phi.url);
        await page.locator(`.tab[data-pane-id="${pane}"]`).click();
        await page.locator(`#term-${pane} .xterm-screen`).click();
        await page.keyboard.press('Control+f');
        const desktopBar = page.locator(`#term-${pane} .find-bar`);
        await expect(desktopBar).toBeVisible();
        const desktopSource = desktopBar.locator('.find-source-select');
        await expect(desktopSource).toHaveValue('transcript');
        const desktopInput = desktopBar.locator('.find-input');
        await desktopInput.fill(QUERY);
        await expect(desktopBar.locator('.find-status')).toContainText(
            '1 matches in Pi transcript',
            { timeout: 15_000 },
        );
        await desktopBar.locator('.find-next').click();
        await expect(desktopBar.locator('.find-preview')).toContainText(NEEDLE);
        await desktopSource.selectOption('terminal');
        await expect(desktopSource).toHaveValue('terminal');
        await expect(desktopBar.locator('.find-preview')).toBeHidden();
        await desktopSource.selectOption('transcript');
        await expect(desktopBar.locator('.find-status')).toContainText(
            '1 matches in Pi transcript',
            { timeout: 15_000 },
        );
        expect(
            await page.evaluate(
                () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
        ).toBe(true);
        await desktopBar.locator('.find-close').click();
        await expect(desktopBar).toHaveCount(0);

        mobileContext = await browser.newContext({
            viewport: { width: 390, height: 844 },
            deviceScaleFactor: 2,
            isMobile: true,
            hasTouch: true,
            colorScheme: 'dark',
        });
        const mobilePage = await mobileContext.newPage();
        mobilePage.setDefaultTimeout(30_000);
        const mobileMonitor = monitorPage(mobilePage, phi.url);
        await mobilePage.goto(phi.url);
        await mobilePage.locator('#mobile-sidebar-toggle').tap();
        await expect(mobilePage.locator('#sidebar-panel')).toHaveClass(
            /drawer-open/,
        );
        await mobilePage
            .locator(
                `#drawer-tabs-body .hostname-dropdown-row[data-pane-id="${pane}"] .hostname-dropdown-select-btn`,
            )
            .tap();
        await mobilePage.locator(`#term-${pane} .xterm-screen`).tap();
        await mobilePage.keyboard.press('Control+f');
        const mobileBar = mobilePage.locator(`#term-${pane} .find-bar`);
        await expect(mobileBar).toBeVisible();
        const mobileInput = mobileBar.locator('.find-input');
        await mobileInput.tap();
        await mobilePage.keyboard.type(QUERY);
        await expect(mobileBar.locator('.find-status')).toContainText(
            '1 matches in Pi transcript',
            { timeout: 15_000 },
        );
        await mobileBar.locator('.find-next').tap();
        await expect(mobileBar.locator('.find-preview')).toContainText(NEEDLE);
        const bounds = await mobileBar.boundingBox();
        if (!bounds)
            throw new Error('mobile transcript search bar has no layout box');
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
        expect(
            await mobileInput.evaluate((element) =>
                Number.parseFloat(getComputedStyle(element).fontSize),
            ),
        ).toBeGreaterThanOrEqual(16);
        expect(
            await mobilePage.evaluate(
                () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
        ).toBe(true);
        await mobileBar.locator('.find-close').tap();
        expect(provider.requests).toHaveLength(1);
        expect(desktopMonitor.pageErrors).toEqual([]);
        expect(desktopMonitor.consoleErrors).toEqual([]);
        expect(desktopMonitor.failedRequests).toEqual([]);
        expect(mobileMonitor.pageErrors).toEqual([]);
        expect(mobileMonitor.consoleErrors).toEqual([]);
        expect(mobileMonitor.failedRequests).toEqual([]);
    } finally {
        await mobileContext?.close();
        await phi.stop();
        await provider.close();
    }
});
