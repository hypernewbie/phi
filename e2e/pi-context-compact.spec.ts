import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { startPhi } from './_server.js';
import {
    COMPACT_FOLLOWUP_TOKENS,
    COMPACT_MODEL,
    COMPACT_PROVIDER,
    COMPACT_SEED_TOKENS,
    COMPACT_SESSION_ID,
    COMPACT_WINDOW,
    seedCompactFixture,
    startCompactStub,
    type CompactSeed,
} from './_pi-context-compact.js';

// Real pinned Pi TUI, successful localhost provider stub, synthetic
// session. Desktop core only: known meter, one native Compact via the
// existing button, unknown occupancy with known window, and meter
// recovery after a later assistant turn. No summary overrides.
interface BridgeView {
    state: string;
    connected?: boolean;
    model?: string;
    capabilities?: string[];
    context_tokens?: number;
    context_window?: number;
    context_percent?: number;
    compact_idle?: boolean;
    compact_queued?: boolean;
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

function compactionEntries(sessionFile: string): number {
    return readFileSync(sessionFile, 'utf8')
        .split('\n')
        .filter((line) => line.includes('"type":"compaction"')).length;
}

test('native desktop compact: known meter, one entry, unknown, recovery', async ({
    page,
    request,
}) => {
    test.setTimeout(180_000);
    const stubTmp = mkdtempSync(join(tmpdir(), 'cc-stub-'));
    // Cleanup from the first owned resource: every failure below
    // still stops what started and removes the owned tmp.
    const closers: Array<() => Promise<unknown>> = [];
    let cleanupError: unknown = null;
    try {
        const stub = await startCompactStub(
            join(stubTmp, 'provider-count.json'),
        );
        closers.push(() => stub.close());
        let seed: CompactSeed | undefined;
        const phi = await startPhi({
            config: { auto_reconnect: 'off' },
            env: { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
            setup(dir) {
                seed = seedCompactFixture(dir, stub.port);
            },
        });
        closers.push(() => phi.stop());
        if (!seed) throw new Error('fixture seed missing');
        const { cwd, sessionFile } = seed;

        const liveSpawn = await request.post(`${phi.url}/api/terminals`, {
            data: {
                coder: 'pi',
                cwd,
                title: 'Pi compact',
                session_id: COMPACT_SESSION_ID,
            },
        });
        expect(liveSpawn.ok()).toBe(true);
        const livePane = ((await liveSpawn.json()) as { pane_id: string })
            .pane_id;
        await expect
            .poll(() => paneBridge(request, phi.url, livePane), {
                timeout: 30_000,
            })
            .toMatchObject({
                state: 'managed',
                connected: true,
                model: `${COMPACT_PROVIDER}/${COMPACT_MODEL}`,
                capabilities: expect.arrayContaining([
                    'pi.context.v1',
                    'pi.compact.v1',
                ]),
                context_tokens: COMPACT_SEED_TOKENS,
                context_window: COMPACT_WINDOW,
                compact_idle: true,
                compact_queued: false,
            });
        // Absent-bridge pane spawns before page load so its tab is
        // present at hydration, matching the accepted models pattern.
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
        // Resume alone issues no provider calls and writes no entries.
        expect(stub.count()).toBe(0);
        expect(compactionEntries(sessionFile)).toBe(0);

        const pageErrors: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(phi.url);
        await page.locator(`.tab[data-pane-id="${livePane}"]`).click();
        const meter = page.locator(
            '#pi-rpc-status-bar .pi-rpc-context-meter-text',
        );
        await expect(meter).toHaveText('1K / 8.2K', { timeout: 15_000 });
        const compactBtn = page.locator('#presets-container .preset-btn', {
            hasText: '/compact',
        });
        await expect(compactBtn).toBeEnabled({ timeout: 15_000 });

        // A staged draft must survive the native dispatch.
        await page.locator('#input-textarea').fill('COMPACT DRAFT HELD');
        await compactBtn.click();
        await expect(
            page.locator('.toast', { hasText: 'Compaction complete' }),
        ).toBeVisible({ timeout: 60_000 });
        // Exactly one provider summary and one native entry; the meter
        // keeps its known window with unknown occupancy.
        expect(stub.count()).toBe(1);
        expect(compactionEntries(sessionFile)).toBe(1);
        await expect(meter).toHaveText('— / 8.2K', { timeout: 15_000 });
        await expect(page.locator('#input-textarea')).toHaveValue(
            'COMPACT DRAFT HELD',
        );

        // A later normal turn re-establishes a known measurement.
        const followup = await request.post(
            `${phi.url}/api/terminals/${livePane}/input`,
            { data: { text: 'COMPACT FIXTURE FOLLOWUP' } },
        );
        expect(followup.status()).toBe(204);
        await expect(meter).toHaveText(`${COMPACT_FOLLOWUP_TOKENS} / 8.2K`, {
            timeout: 60_000,
        });
        expect(stub.count()).toBe(2);
        expect(pageErrors).toEqual([]);

        // Absent-bridge pane: legacy control stays enabled and types
        // through the PTY; no bridge toast, no provider call.
        await page
            .locator(`.tab[data-pane-id="${absentPane}"]`)
            .click({ timeout: 15_000 });
        const legacyBtn = page.locator('#presets-container .preset-btn', {
            hasText: '/compact',
        });
        await expect(legacyBtn).toBeEnabled({ timeout: 15_000 });
        const toastsBefore = await page
            .locator('.toast', { hasText: 'Compaction' })
            .count();
        await legacyBtn.click();
        await expect
            .poll(
                async () => {
                    const rec = await request.get(
                        `${phi.url}/api/terminals/${absentPane}/recording?from=0&through=2097152`,
                    );
                    return rec.ok()
                        ? (await rec.body()).toString('utf8').toLowerCase()
                        : '';
                },
                { timeout: 20_000 },
            )
            .toContain('compact');
        expect(
            await page.locator('.toast', { hasText: 'Compaction' }).count(),
        ).toBe(toastsBefore);
        expect(stub.count()).toBe(2);
        expect(pageErrors).toEqual([]);
    } finally {
        for (const close of closers.reverse()) {
            try {
                await close();
            } catch (err) {
                cleanupError ??= err;
            }
        }
        rmSync(stubTmp, { recursive: true, force: true });
        expect(cleanupError, 'fixture cleanup failed').toBeNull();
    }
});
