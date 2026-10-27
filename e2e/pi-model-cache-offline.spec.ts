import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { startPhi } from './_server.js';

// The model picker must open from local state, with no round trip in the
// path. This proves the cached catalog renders when the catalog request
// fails, and that the failed refresh is a note, not an empty menu.
const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

async function paneBridge(
    request: APIRequestContext,
    url: string,
    paneID: string,
): Promise<{ state?: string; connected?: boolean } | undefined> {
    const response = await request.get(`${url}/api/terminals`);
    if (!response.ok()) return undefined;
    const tabs = (await response.json()) as Array<{
        id: string;
        pi_bridge?: { state?: string; connected?: boolean };
    }>;
    return tabs.find((tab) => tab.id === paneID)?.pi_bridge;
}

test('model picker opens from cache when the catalog request fails', async ({
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
        const spawn = await request.post(`${phi.url}/api/terminals`, {
            data: { coder: 'pi', cwd, title: 'Pi cache' },
        });
        expect(spawn.ok()).toBe(true);
        const paneId = ((await spawn.json()) as { pane_id: string }).pane_id;
        await expect
            .poll(() => paneBridge(request, phi.url, paneId), {
                timeout: 20_000,
            })
            .toMatchObject({ state: 'managed', connected: true });

        const pageErrors: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));

        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(phi.url);
        await page.locator(`.tab[data-pane-id="${paneId}"]`).click();
        const dropup = page.locator('#pi-rpc-model-dropup');
        const trigger = page.locator(
            '#presets-container button.pi-rpc-model-trigger',
        );
        const firstRow = dropup.locator('.pi-rpc-model-row').first();
        const refreshNote = dropup.locator('.pi-rpc-dropup-message', {
            hasText: 'Could not refresh',
        });

        // One successful open fills the local cache.
        await expect(trigger).toContainText('Model', { timeout: 10_000 });
        await trigger.click();
        await expect(firstRow).toBeVisible({ timeout: 10_000 });
        await trigger.click();
        await expect(dropup).toBeHidden({ timeout: 5_000 });
        expect(
            await page.evaluate(
                (id) =>
                    window.localStorage.getItem(`phi.piRpc.models.pi:${id}`),
                paneId,
            ),
        ).toContain('"models"');

        // Catalog request fails: the cached rows render on the click, with
        // no round trip in the path, and the failure stays a note.
        await page.route('**/api/pi-bridge/models?*', (route) =>
            route.abort('failed'),
        );
        const started = Date.now();
        await trigger.click();
        await expect(firstRow).toBeVisible({ timeout: 2_000 });
        expect(Date.now() - started).toBeLessThan(1_000);
        await expect(refreshNote).toContainText('Could not refresh', {
            timeout: 10_000,
        });
        await expect(firstRow).toBeVisible();

        // Narrow layout keeps the open picker without horizontal overflow.
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(dropup).toBeVisible();
        await expect(firstRow).toBeVisible();
        const overflow = await page.evaluate(() => ({
            inner: window.innerWidth,
            scroll: document.documentElement.scrollWidth,
        }));
        expect(overflow.scroll).toBeLessThanOrEqual(overflow.inner);

        // Back to a working catalog: the refresh replaces rows in place and
        // clears the note.
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.unroute('**/api/pi-bridge/models?*');
        await trigger.click();
        await expect(dropup).toBeHidden({ timeout: 5_000 });
        await trigger.click();
        await expect(firstRow).toBeVisible({ timeout: 10_000 });
        await expect(refreshNote).toHaveCount(0, { timeout: 15_000 });

        expect(pageErrors).toEqual([]);
    } finally {
        await phi.stop();
    }
});
