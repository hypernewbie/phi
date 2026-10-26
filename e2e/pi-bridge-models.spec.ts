import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    expect,
    test,
    type APIRequestContext,
    type WebSocketRoute,
} from '@playwright/test';
import { startPhi } from './_server.js';

// Real pinned Pi, no model calls, no user profile. A dummy provider key
// populates the registry catalog by presence check only; PI_OFFLINE plus
// no prompts means the key is never used for a call.
const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

interface BridgeView {
    state: string;
    connected?: boolean;
    model?: string;
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

test('bridge-live Pi models picker lists and switches, bridge-absent keeps legacy', async ({
    page,
    request,
}) => {
    test.setTimeout(180_000);
    const phi = await startPhi({
        config: { auto_reconnect: 'off' },
        env: {
            PI_OFFLINE: '1',
            PI_SKIP_VERSION_CHECK: '1',
            ANTHROPIC_API_KEY: 'dummy-sentry-key-never-used',
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
                capabilities: expect.arrayContaining(['pi.models.v1']),
            });

        // The list endpoint serves the real registry catalog.
        const listResponse = await request.get(
            `${phi.url}/api/pi-bridge/models?pane=${encodeURIComponent(livePane)}`,
        );
        expect(listResponse.ok()).toBe(true);
        const catalog = (await listResponse.json()) as {
            models: Array<{ provider: string; id: string }>;
            truncated: boolean;
            unavailable: boolean;
        };
        expect(catalog.unavailable).toBe(false);
        expect(catalog.models.length).toBeGreaterThan(1);
        for (const entry of catalog.models) {
            expect(typeof entry.provider).toBe('string');
            expect(typeof entry.id).toBe('string');
        }

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
        let proxyInterceptions = 0;
        await page.route('**/api/proxy?*', (route) => {
            proxyInterceptions++;
            return route.fulfill({ json: [] });
        });
        const pageErrors: string[] = [];
        const modelFailures: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        page.on('requestfailed', (req) => {
            if (req.url().includes('/api/pi-bridge/'))
                modelFailures.push(req.url());
        });
        page.on('response', (response) => {
            if (
                response.url().includes('/api/pi-bridge/') &&
                response.status() >= 400
            )
                modelFailures.push(`${response.status()} ${response.url()}`);
        });
        const liveSockets: WebSocketRoute[] = [];
        await page.routeWebSocket(`**/ws/pane/${livePane}?*`, (socket) => {
            liveSockets.push(socket);
            socket.connectToServer();
        });
        const modelsFetches: string[] = [];
        await page.route('**/api/pi-bridge/models?*', (route) => {
            modelsFetches.push(route.request().url());
            return route.continue();
        });

        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(phi.url);
        await page.locator(`.tab[data-pane-id="${livePane}"]`).click();
        const dropup = page.locator('#pi-rpc-model-dropup');
        const trigger = page.locator(
            '#presets-container button.pi-rpc-model-trigger',
        );
        await expect(trigger).toContainText('Model:', { timeout: 10_000 });

        // The shared picker renders real catalog rows.
        await trigger.click();
        await expect(dropup).toBeVisible({ timeout: 10_000 });
        await expect(dropup.locator('.pi-rpc-model-row').first()).toBeVisible({
            timeout: 10_000,
        });
        await expect(
            dropup.locator('.pi-rpc-dropup-meta').first(),
        ).toContainText('/');

        // Favorites are shared with the Pi RPC picker surface.
        await dropup.locator('.pi-rpc-model-star').first().click();
        await expect(dropup.getByText('Favorites')).toBeVisible({
            timeout: 5_000,
        });

        // Switching a non-active row closes the picker and the bridge
        // snapshot follows the session without an explicit publish.
        const before = await paneBridge(request, phi.url, livePane);
        await dropup
            .locator('.pi-rpc-model-row:not(.is-active) .dropup-model-btn')
            .first()
            .click();
        await expect(dropup).toBeHidden({ timeout: 10_000 });
        await expect
            .poll(() => paneBridge(request, phi.url, livePane), {
                timeout: 10_000,
            })
            .toMatchObject({
                model: expect.not.stringMatching(
                    `^${before?.model?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
                ),
            });

        // A browser transport loss is separate from Pi peer loss.
        // Reattaching the same still-live Pi must re-enable the picker,
        // even when the retained bridge snapshot has not changed.
        await trigger.click();
        await expect(dropup.locator('.pi-rpc-model-row').first()).toBeVisible();
        expect(liveSockets).toHaveLength(1);
        const fetchesAtDisconnect = modelsFetches.length;
        await liveSockets[0].close();
        await expect(dropup).toBeHidden();
        await expect(
            page.locator('#presets-container .model-trigger-btn', {
                hasText: '🤖 Models',
            }),
        ).not.toHaveClass(/pi-rpc-model-trigger/);
        expect(modelsFetches).toHaveLength(fetchesAtDisconnect);
        await page.locator(`#term-${livePane} .reconnect-btn`).click();
        await expect(trigger).toBeEnabled({ timeout: 10_000 });
        await trigger.click();
        await expect(dropup.locator('.pi-rpc-model-row').first()).toBeVisible();
        await trigger.click();

        // Narrow layout keeps the open picker with no horizontal
        // overflow. The picker opens at desktop width because the
        // mobile diff panel overlays the presets row at 390px.
        await trigger.click({ timeout: 15_000 });
        await expect(dropup).toBeVisible({ timeout: 10_000 });
        await expect(dropup.locator('.pi-rpc-model-row').first()).toBeVisible({
            timeout: 10_000,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        const overflow = await page.evaluate(() => ({
            inner: window.innerWidth,
            scroll: document.documentElement.scrollWidth,
        }));
        expect(overflow.scroll).toBeLessThanOrEqual(overflow.inner);
        await page.setViewportSize({ width: 1440, height: 900 });
        await trigger.click({ timeout: 15_000 });
        await expect(dropup).toBeHidden({ timeout: 5_000 });
        await page.setViewportSize({ width: 1440, height: 900 });

        // Bridge-absent pane: the legacy static list opens instead and
        // no bridge list fetch fires for that pane.
        await page.locator(`.tab[data-pane-id="${absentPane}"]`).click();
        const legacyTrigger = page.locator(
            '#presets-container button.model-trigger-btn',
            { hasText: '🤖 Models' },
        );
        await expect(legacyTrigger).toBeVisible({ timeout: 10_000 });
        await expect(legacyTrigger).not.toHaveClass(/pi-rpc-model-trigger/);
        const fetchesBefore = modelsFetches.length;
        await legacyTrigger.click();
        await expect(page.locator('#model-presets-dropup')).toBeVisible({
            timeout: 10_000,
        });
        expect(
            modelsFetches
                .slice(fetchesBefore)
                .filter((url) => url.includes(absentPane)),
        ).toEqual([]);

        // A real peer exit while the picker is open must also restore
        // the legacy control, without another bridge fetch or an error.
        await page.locator(`.tab[data-pane-id="${livePane}"]`).click();
        await trigger.click();
        await expect(dropup.locator('.pi-rpc-model-row').first()).toBeVisible();
        const fetchesAtLoss = modelsFetches.length;
        const quit = await request.post(
            `${phi.url}/api/terminals/${livePane}/input`,
            { data: { text: '/quit' } },
        );
        expect(quit.ok()).toBe(true);
        await expect(dropup).toBeHidden({ timeout: 10_000 });
        await expect(legacyTrigger).not.toHaveClass(/pi-rpc-model-trigger/);
        await legacyTrigger.click();
        await expect(page.locator('#model-presets-dropup')).toBeVisible();
        expect(modelsFetches).toHaveLength(fetchesAtLoss);
        await expect(
            page.locator('.toast').filter({ hasText: /Pi models|Pi model/ }),
        ).toHaveCount(0);
        expect(pageErrors).toEqual([]);
        expect(modelFailures).toEqual([]);
        expect(proxyInterceptions).toBeGreaterThan(0);
    } finally {
        await phi.stop();
    }
});
