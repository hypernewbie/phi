import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { startPhi } from './_server.js';
import { startBridgeProxy } from './_pi-bridge-proxy.js';
import {
    COMPACT_FOLLOWUP_TOKENS,
    COMPACT_MODEL,
    COMPACT_PROVIDER,
    COMPACT_PROXY_NAME,
    COMPACT_SEED_TOKENS,
    COMPACT_SESSION_ID,
    COMPACT_WINDOW,
    seedCompactFixture,
    startCompactStub,
    type CompactSeed,
} from './_pi-context-compact.js';

// Real pinned Pi TUI behind a test-only byte-blind IPC proxy. A held
// summary lets the spec drop ONLY the bridge stream mid-compaction:
// the caller goes unknown, the meter hides, Pi and the PTY stay
// alive, and release-while-down plus reconnect completes exactly one
// native compaction with no replay.
interface BridgeView {
    state: string;
    connected?: boolean;
    capabilities?: string[];
    context_tokens?: number;
    context_window?: number;
    compact_pending?: boolean;
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

async function recordingText(
    request: APIRequestContext,
    url: string,
    paneID: string,
): Promise<string> {
    const rec = await request.get(
        `${url}/api/terminals/${paneID}/recording?from=0&through=2097152`,
    );
    if (!rec.ok()) return '';
    return (await rec.body()).toString('utf8');
}

test('bridge-only peer loss: unknown caller, live Pi, no replay on reconnect', async ({
    page,
    request,
}) => {
    test.setTimeout(240_000);
    const stubTmp = mkdtempSync(join(tmpdir(), 'cc-stub-'));
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
                seed = seedCompactFixture(dir, stub.port, { viaProxy: true });
            },
        });
        closers.push(() => phi.stop());
        if (!seed) throw new Error('fixture seed missing');
        const { cwd, sessionFile } = seed;

        // Discover Phi's real private socket inside the owned tmp.
        const runTmp = join(phi.dir, 't');
        const upstreams = readdirSync(runTmp, { withFileTypes: true })
            .filter(
                (entry) =>
                    entry.isDirectory() && entry.name.startsWith('phi-pi-'),
            )
            .map((entry) => join(runTmp, entry.name, 'bridge.sock'));
        expect(upstreams).toHaveLength(1);
        const proxy = await startBridgeProxy(
            phi.dir,
            upstreams[0] as string,
            join(runTmp, COMPACT_PROXY_NAME),
        );
        closers.push(() => proxy.close());

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
                capabilities: expect.arrayContaining([
                    'pi.context.v1',
                    'pi.compact.v1',
                ]),
                context_tokens: COMPACT_SEED_TOKENS,
                context_window: COMPACT_WINDOW,
            });
        expect(proxy.forwarded()).toBeGreaterThanOrEqual(1);
        expect(stub.count()).toBe(0);
        expect(compactionEntries(sessionFile)).toBe(0);
        const recordingBaseline = (
            await recordingText(request, phi.url, livePane)
        ).length;

        const pageErrors: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(phi.url);
        await page.locator(`.tab[data-pane-id="${livePane}"]`).click();
        const meter = page.locator(
            '#pi-rpc-status-bar .pi-rpc-context-meter-text',
        );
        await expect(meter).toHaveText('1K / 8.2K', { timeout: 15_000 });
        await page.locator('#input-textarea').fill('PEERLOSS DRAFT HELD');

        // Hold the summary; the click dispatches through the live bridge.
        stub.holdNext();
        await page
            .locator('#presets-container .preset-btn', { hasText: '/compact' })
            .click();
        await expect.poll(() => stub.count(), { timeout: 10_000 }).toBe(1);
        expect(stub.heldCount()).toBe(1);
        await expect
            .poll(() => paneBridge(request, phi.url, livePane), {
                timeout: 10_000,
            })
            .toMatchObject({ compact_pending: true });

        // While live and held, lifecycle/history/model reads still flow.
        const terms = await request.get(`${phi.url}/api/terminals`);
        expect(terms.ok()).toBe(true);
        expect(
            ((await terms.json()) as Array<{ id: string }>).some(
                (tab) => tab.id === livePane,
            ),
        ).toBe(true);
        const history = await request.get(
            `${phi.url}/api/pi-history?pane=${livePane}`,
        );
        expect(history.ok()).toBe(true);
        expect(await history.json()).toMatchObject({
            entries: expect.any(Array),
        });
        const models = await request.get(
            `${phi.url}/api/pi-bridge/models?pane=${livePane}`,
        );
        expect(models.ok()).toBe(true);
        expect(await models.json()).toMatchObject({
            models: expect.arrayContaining([
                { provider: COMPACT_PROVIDER, id: COMPACT_MODEL },
            ]),
        });

        // Drop ONLY the bridge stream. The caller goes unknown (not
        // silent success), the meter hides, the control falls back to
        // legacy-enabled, and nothing auto-sends through the PTY.
        await proxy.drop();
        await expect
            .poll(() => paneBridge(request, phi.url, livePane), {
                timeout: 10_000,
            })
            .toMatchObject({ connected: false });
        await expect(page.locator('#pi-rpc-status-bar')).toHaveClass(/hidden/, {
            timeout: 10_000,
        });
        const unknownToast = page.locator('.toast', {
            hasText: 'Compaction outcome unknown',
        });
        await expect(unknownToast).toBeVisible({ timeout: 30_000 });
        await page.waitForTimeout(2_000);
        expect(await unknownToast.count()).toBeLessThanOrEqual(1);
        expect(
            await page
                .locator('.toast', { hasText: 'Compaction complete' })
                .count(),
        ).toBe(0);
        const legacyBtn = page.locator('#presets-container .preset-btn', {
            hasText: '/compact',
        });
        await expect(legacyBtn).toBeEnabled({ timeout: 10_000 });
        // The bridge is gone, so the chip degrades to the plain PTY send
        // and says so in its tooltip.
        expect(
            await legacyBtn.evaluate((el) => (el as HTMLButtonElement).title),
        ).toBe('Send /compact to the terminal');
        expect(stub.count()).toBe(1);
        expect(compactionEntries(sessionFile)).toBe(0);
        expect(
            (await recordingText(request, phi.url, livePane)).slice(
                recordingBaseline,
            ),
        ).not.toContain('/compact');

        // Release while disconnected: native work completes with no
        // bridge to report through. Exactly one request, one entry.
        stub.release();
        expect(stub.heldCount()).toBe(0);
        await expect
            .poll(() => compactionEntries(sessionFile), { timeout: 30_000 })
            .toBe(1);
        expect(stub.count()).toBe(1);

        // Same pane/Pi/PTY stays alive: direct mode is the normal
        // control that hands the keyboard to the terminal (the staged
        // input hides and xterm takes focus through the real focus
        // path). Typed-but-unsubmitted text renders on Pi's input
        // line with no prompt execution and no provider call.
        await page.locator('#direct-mode-toggle').click();
        await expect(page.locator('#input-textarea')).toBeHidden({
            timeout: 10_000,
        });
        await page.keyboard.type('HARMLESS-NOOP-TEXT');
        await expect
            .poll(() => recordingText(request, phi.url, livePane), {
                timeout: 15_000,
            })
            .toContain('HARMLESS-NOOP-TEXT');
        expect(stub.count()).toBe(1);
        const termsAfter = await request.get(`${phi.url}/api/terminals`);
        expect(
            ((await termsAfter.json()) as Array<{ id: string }>).some(
                (tab) => tab.id === livePane,
            ),
        ).toBe(true);
        // Restore the staged UI; the draft survives the round trip.
        await page.locator('#direct-mode-toggle').click();
        await expect(page.locator('#input-textarea')).toHaveValue(
            'PEERLOSS DRAFT HELD',
            { timeout: 10_000 },
        );

        // Reconnect on the same socket: fresh baseline, unknown usage
        // with known window, pending cleared by the actual release, no
        // replay of the native work.
        await proxy.resume();
        await expect
            .poll(
                async () => {
                    const view = await paneBridge(request, phi.url, livePane);
                    return (
                        view?.connected === true &&
                        view.compact_pending === false &&
                        view.context_tokens === undefined &&
                        view.context_window === COMPACT_WINDOW &&
                        (view.capabilities ?? []).includes('pi.compact.v1')
                    );
                },
                { timeout: 30_000 },
            )
            .toBe(true);
        expect(proxy.forwarded()).toBeGreaterThanOrEqual(2);
        expect(stub.count()).toBe(1);
        expect(compactionEntries(sessionFile)).toBe(1);
        await expect(meter).toHaveText('— / 8.2K', { timeout: 15_000 });
        await expect(page.locator('#input-textarea')).toHaveValue(
            'PEERLOSS DRAFT HELD',
        );

        // A later normal turn recovers a known measurement.
        const followup = await request.post(
            `${phi.url}/api/terminals/${livePane}/input`,
            { data: { text: 'PEERLOSS FOLLOWUP' } },
        );
        expect(followup.status()).toBe(204);
        await expect(meter).toHaveText(`${COMPACT_FOLLOWUP_TOKENS} / 8.2K`, {
            timeout: 60_000,
        });
        expect(stub.count()).toBe(2);
        expect(compactionEntries(sessionFile)).toBe(1);
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
