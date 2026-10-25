import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { startPhi } from './_server.js';

// Real pinned Pi, no model calls, no user profile. A dummy provider key
// populates the registry catalog by presence check only; PI_OFFLINE plus
// no prompts means the key is never used for a call.
const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

const KNOWN_LEVELS = [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
];

interface BridgeView {
    state: string;
    connected?: boolean;
    model?: string;
    capabilities?: string[];
    thinking_level?: string;
}

interface LevelsView {
    levels: string[];
    provider: string;
    model: string;
    unavailable: boolean;
    process_id: string;
    generation: string;
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

test('bridge thinking levels list, set and cycle; native and absent panes stay usable', async ({
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
            data: { coder: 'pi', cwd, title: 'Pi thinking' },
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
                capabilities: expect.arrayContaining([
                    'pi.thinking.v1',
                    'pi.models.v1',
                ]),
                thinking_level: expect.stringMatching(
                    /^(off|minimal|low|medium|high|xhigh|max)$/,
                ),
            });
        const start = await paneBridge(request, phi.url, livePane);
        expect(KNOWN_LEVELS).toContain(start?.thinking_level);

        // The list endpoint serves the real supported levels with the
        // answering peer's origin that a setter must echo back.
        const listResponse = await request.get(
            `${phi.url}/api/pi-bridge/thinking-levels?pane=${encodeURIComponent(livePane)}`,
        );
        expect(listResponse.ok()).toBe(true);
        expect(listResponse.headers()['cache-control']).toBe('no-store');
        const catalog = (await listResponse.json()) as LevelsView;
        expect(catalog.unavailable).toBe(false);
        expect(catalog.levels.length).toBeGreaterThan(1);
        expect(catalog.levels.length).toBeLessThanOrEqual(KNOWN_LEVELS.length);
        expect(new Set(catalog.levels).size).toBe(catalog.levels.length);
        for (const level of catalog.levels)
            expect(KNOWN_LEVELS).toContain(level);
        const [provider, model] = (start?.model || '/').split('/');
        expect(catalog.provider).toBe(provider);
        expect(catalog.model).toBe(model);
        expect(catalog.process_id.length).toBeGreaterThan(0);
        expect(catalog.generation).toMatch(/^[1-9][0-9]*$/);

        // Absent pane: disable injection, then spawn. The live pane keeps
        // its lease; only the next spawn launches unmanaged.
        const noInject = await request.post(
            `${phi.url}/api/config/pi-bridge-no-inject`,
            { data: { enabled: true } },
        );
        expect(noInject.ok()).toBe(true);
        const absentSpawn = await request.post(`${phi.url}/api/terminals`, {
            data: { coder: 'pi', cwd, title: 'Pi thinking absent' },
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
        const thinkingFailures: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        page.on('requestfailed', (req) => {
            if (req.url().includes('/api/pi-bridge/thinking'))
                thinkingFailures.push(req.url());
        });
        page.on('response', (response) => {
            if (
                response.url().includes('/api/pi-bridge/thinking') &&
                response.status() >= 400
            )
                thinkingFailures.push(`${response.status()} ${response.url()}`);
        });
        const thinkingCalls: string[] = [];
        await page.route('**/api/pi-bridge/thinking-levels?*', (route) => {
            thinkingCalls.push('levels');
            return route.continue();
        });
        await page.route('**/api/pi-bridge/thinking', (route) => {
            if (route.request().method() !== 'POST') return route.continue();
            thinkingCalls.push('set');
            return route.continue();
        });

        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(phi.url);
        await page.locator(`.tab[data-pane-id="${livePane}"]`).click();
        const dropup = page.locator('#pi-rpc-thinking-dropup');
        const trigger = page.locator(
            '#presets-container button.pi-rpc-thinking-trigger',
        );
        const cycle = page.locator('#pi-thinking-btn');
        await expect(trigger).toContainText('Thinking', { timeout: 10_000 });

        // The shared picker renders exactly the supported levels.
        await trigger.click();
        await expect(dropup).toBeVisible({ timeout: 10_000 });
        const rows = dropup.locator('.dropup-row .dropup-model-btn');
        await expect(rows).toHaveCount(catalog.levels.length, {
            timeout: 10_000,
        });
        expect(await rows.allInnerTexts()).toEqual(catalog.levels);
        await expect(dropup.locator('.dropup-header')).toContainText(
            `Thinking · ${start?.thinking_level}`,
        );

        // Selecting a supported level applies it and closes the picker
        // even though telemetry re-renders the menu while it is open.
        const target = catalog.levels.find(
            (level) => level !== start?.thinking_level,
        );
        expect(target).toBeTruthy();
        await rows.filter({ hasText: new RegExp(`^${target}$`) }).click();
        await expect(dropup).toBeHidden({ timeout: 10_000 });
        await expect
            .poll(() => paneBridge(request, phi.url, livePane), {
                timeout: 10_000,
            })
            .toMatchObject({ thinking_level: target });
        await expect(trigger).toHaveAttribute('title', `Thinking · ${target}`);

        // The cycle icon uses the advertised order and one setter call.
        const nextIndex =
            (catalog.levels.indexOf(target as string) + 1) %
            catalog.levels.length;
        const expectedNext = catalog.levels[nextIndex];
        const callsBeforeCycle = thinkingCalls.length;
        await cycle.click();
        await expect
            .poll(() => paneBridge(request, phi.url, livePane), {
                timeout: 10_000,
            })
            .toMatchObject({ thinking_level: expectedNext });
        expect(
            thinkingCalls.slice(callsBeforeCycle).filter((c) => c === 'set'),
        ).toHaveLength(1);

        // A real native cycle reaches Phi through telemetry only.
        await page.locator(`#term-${livePane} .xterm-screen`).click();
        const beforeNative = await paneBridge(request, phi.url, livePane);
        const callsBeforeNative = thinkingCalls.length;
        await page.keyboard.press('Shift+Tab');
        await expect
            .poll(() => paneBridge(request, phi.url, livePane), {
                timeout: 10_000,
            })
            .not.toMatchObject({
                thinking_level: beforeNative?.thinking_level,
            });
        expect(thinkingCalls).toHaveLength(callsBeforeNative);

        // Narrow width: the picker opens, stays usable and closes on an
        // outside click rather than needing a desktop-expanded menu.
        await page.setViewportSize({ width: 390, height: 844 });
        // The mobile Git Diff drawer covers the presets row; hide it with
        // its normal control before reaching the Thinking trigger.
        await page
            .getByRole('button', { name: 'Toggle Git Diff Panel' })
            .click({ timeout: 15_000 });
        await trigger.click({ timeout: 15_000 });
        await expect(dropup).toBeVisible({ timeout: 10_000 });
        await expect(rows.first()).toBeVisible({ timeout: 10_000 });
        const overflow = await page.evaluate(() => ({
            inner: window.innerWidth,
            scroll: document.documentElement.scrollWidth,
        }));
        expect(overflow.scroll).toBeLessThanOrEqual(overflow.inner);
        await page.locator(`#term-${livePane} .xterm-screen`).click();
        await expect(dropup).toBeHidden({ timeout: 5_000 });
        await page.setViewportSize({ width: 1440, height: 900 });

        // Absent pane: no injection means native-only controls, no bridge
        // Thinking traffic, and no guessed level.
        await page.locator(`.tab[data-pane-id="${absentPane}"]`).click();
        const absentTrigger = page.locator(
            '#presets-container button.pi-rpc-thinking-trigger',
        );
        await expect(absentTrigger).toHaveAttribute(
            'title',
            'Open Pi native Thinking picker',
            { timeout: 10_000 },
        );
        const callsBeforeAbsent = thinkingCalls.length;
        await absentTrigger.click();
        await expect(dropup).toBeHidden();
        await expect(cycle).toHaveAttribute(
            'aria-label',
            'Cycle Pi Thinking level',
        );
        await cycle.click();
        await page.waitForTimeout(1_000);
        expect(
            thinkingCalls
                .slice(callsBeforeAbsent)
                .filter((call) => call === 'set'),
        ).toEqual([]);
        await expect(
            page.locator('.toast').filter({ hasText: /Thinking/ }),
        ).toHaveCount(0);

        expect(pageErrors).toEqual([]);
        expect(thinkingFailures).toEqual([]);
        expect(proxyInterceptions).toBeGreaterThan(0);
    } finally {
        await phi.stop();
    }
});
