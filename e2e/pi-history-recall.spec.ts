import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { startPhi } from './_server.js';

// Real pinned Pi, no model calls, no user profile. Bang commands seed
// actual editor history without provider auth.
const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

interface BridgeView {
    state: string;
    connected?: boolean;
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

async function piHistory(
    request: APIRequestContext,
    url: string,
    paneID: string,
): Promise<string[]> {
    const response = await request.get(
        `${url}/api/pi-history?pane=${encodeURIComponent(paneID)}`,
    );
    if (!response.ok()) return [];
    const body = (await response.json()) as {
        entries?: unknown;
        unavailable?: boolean;
    };
    if (body.unavailable || !Array.isArray(body.entries)) return [];
    return body.entries.filter(
        (entry): entry is string => typeof entry === 'string',
    );
}

test('bridge-live Pi history recalls, bridge-absent falls back', async ({
    page,
    request,
}) => {
    test.setTimeout(180_000);
    const phi = await startPhi({
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
            const command = join(dir, 'native-pi');
            const binary = join(process.cwd(), 'node_modules', '.bin', 'pi');
            // --no-extensions blocks user extensions; Phi still appends
            // its explicit --extension bundle for managed panes.
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

    try {
        const cwd = realpathSync(phi.dir);
        const staged = page.locator('#input-textarea');

        // Live pane first: injection is on by default.
        const liveSpawn = await request.post(`${phi.url}/api/terminals`, {
            data: { coder: 'pi', cwd, title: 'Pi live' },
        });
        expect(liveSpawn.ok()).toBe(true);
        const livePane = ((await liveSpawn.json()) as { pane_id: string })
            .pane_id;
        await expect
            .poll(() => paneBridge(request, phi.url, livePane), {
                timeout: 20_000,
            })
            .toMatchObject({
                state: 'managed',
                connected: true,
                capabilities: expect.arrayContaining(['pi.history.v1']),
            });

        // Absent pane: disable injection, then spawn. The live pane
        // keeps its lease; only the next spawn launches unmanaged.
        const noInject = await request.post(
            `${phi.url}/api/config/pi-bridge-no-inject`,
            { data: { enabled: true } },
        );
        expect(noInject.ok()).toBe(true);
        const absentSpawn = await request.post(`${phi.url}/api/terminals`, {
            data: { coder: 'pi', cwd, title: 'Pi absent' },
        });
        expect(absentSpawn.ok()).toBe(true);
        const absentPane = ((await absentSpawn.json()) as { pane_id: string })
            .pane_id;
        await expect
            .poll(() => paneBridge(request, phi.url, absentPane), {
                timeout: 10_000,
            })
            .toMatchObject({ connected: false });

        // Point the sync coordinator at this fixture before the page
        // loads. Any 7070 proxy after this is a live leak, not setup.
        const coord = await request.post(
            `${phi.url}/api/config/sync-coordinator`,
            { data: { sync_coordinator: phi.url } },
        );
        expect(coord.ok()).toBe(true);
        // Contain the sync poll locally: the first refresh races
        // config load and still targets the default coordinator.
        // Fulfillment guarantees no request leaves the browser.
        let proxyInterceptions = 0;
        await page.route('**/api/proxy?*', (route) => {
            proxyInterceptions++;
            return route.fulfill({ json: [] });
        });
        const historyFetches: string[] = [];
        await page.route('**/api/pi-history?*', (route) => {
            historyFetches.push(route.request().url());
            return route.continue();
        });

        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(phi.url);
        await page.locator(`.tab[data-pane-id="${livePane}"]`).click();
        await expect(staged).toBeVisible({ timeout: 10_000 });

        // Seed real Pi history through the staged box.
        for (const cmd of ['!echo phi-history-one', '!echo phi-history-two']) {
            await staged.fill(cmd);
            await staged.press('Enter');
            await expect(staged).toHaveValue('', { timeout: 5_000 });
        }
        await expect
            .poll(() => piHistory(request, phi.url, livePane), {
                timeout: 20_000,
            })
            .toEqual(['!echo phi-history-two', '!echo phi-history-one']);

        // Plain arrows recall newest, then older, then walk back to
        // the empty draft.
        await staged.press('ArrowUp');
        await expect(staged).toHaveValue('!echo phi-history-two', {
            timeout: 5_000,
        });
        await staged.press('ArrowUp');
        await expect(staged).toHaveValue('!echo phi-history-one', {
            timeout: 5_000,
        });
        await staged.press('ArrowDown');
        await expect(staged).toHaveValue('!echo phi-history-two', {
            timeout: 5_000,
        });
        await staged.press('ArrowDown');
        await expect(staged).toHaveValue('', { timeout: 5_000 });

        // A nonempty draft survives one recall cycle.
        await staged.fill('unsent draft');
        await staged.press('ArrowUp');
        await expect(staged).toHaveValue('!echo phi-history-two', {
            timeout: 5_000,
        });
        await staged.press('ArrowDown');
        await expect(staged).toHaveValue('unsent draft', { timeout: 5_000 });
        await staged.fill('');

        // Narrow layout keeps recall with no horizontal overflow.
        await page.setViewportSize({ width: 390, height: 844 });
        const overflow = await page.evaluate(() => ({
            inner: window.innerWidth,
            scroll: document.documentElement.scrollWidth,
        }));
        expect(overflow.scroll).toBeLessThanOrEqual(overflow.inner);
        await staged.press('ArrowUp');
        await expect(staged).toHaveValue('!echo phi-history-two', {
            timeout: 5_000,
        });
        await staged.press('ArrowDown');
        await expect(staged).toHaveValue('', { timeout: 5_000 });
        await page.setViewportSize({ width: 1440, height: 900 });

        // Bridge-absent pane: plain Up stays out of the Phi box and
        // makes no history fetch; Alt arrows keep local fallback.
        await page.locator(`.tab[data-pane-id="${absentPane}"]`).click();
        await staged.fill('!echo phi-history-fallback');
        await staged.press('Enter');
        await expect(staged).toHaveValue('', { timeout: 5_000 });
        const fetchesBefore = historyFetches.length;
        await staged.press('ArrowUp');
        await page.waitForTimeout(1_500);
        await expect(staged).toHaveValue('', { timeout: 5_000 });
        expect(
            historyFetches
                .slice(fetchesBefore)
                .filter((url) => url.includes(absentPane)),
        ).toEqual([]);
        await staged.press('Alt+ArrowUp');
        await expect(staged).toHaveValue('!echo phi-history-fallback', {
            timeout: 5_000,
        });
        await staged.press('Alt+ArrowDown');
        await expect(staged).toHaveValue('', { timeout: 5_000 });

        expect(proxyInterceptions).toBeGreaterThan(0);
    } finally {
        await phi.stop();
    }
});
