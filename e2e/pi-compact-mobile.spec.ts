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

// Real pinned Pi TUI + localhost stub, 390px mobile emulation. The
// actual mobile slash menu entry fires native Compact via keyboard
// activation; pending/disabled states, draft + attachment
// preservation, mobile blur, and overflow are asserted on visible UI.
interface BridgeView {
    state: string;
    connected?: boolean;
    model?: string;
    capabilities?: string[];
    context_tokens?: number;
    context_window?: number;
    compact_idle?: boolean;
    compact_queued?: boolean;
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

// 1x1 transparent PNG: synthetic paste bytes only.
const PIXEL_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('native mobile compact: slash entry, keyboard, pending, preserved draft', async ({
    browser,
    request,
}) => {
    test.setTimeout(180_000);
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
        expect(stub.count()).toBe(0);
        expect(compactionEntries(sessionFile)).toBe(0);

        // Hold the summary so the pending control state is observable.
        stub.holdNext();

        const context = await browser.newContext({
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
        });
        closers.push(() => context.close());
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        const overflow = () =>
            page.evaluate(() => ({
                inner: window.innerWidth,
                scroll: document.documentElement.scrollWidth,
            }));
        await page.goto(phi.url);
        // Compact layout selects tabs through the hostname dropdown;
        // rows carry the pane id (titles may retitle from content).
        await page.locator('#hostname-display').click();
        const dropdown = page.locator('#hostname-tabs-dropdown');
        await expect(dropdown).toBeVisible({ timeout: 10_000 });
        await dropdown
            .locator(
                `.hostname-dropdown-row[data-pane-id="${livePane}"] .hostname-dropdown-select-btn`,
            )
            .click();
        await expect(page.locator('.tab.active')).toHaveAttribute(
            'data-pane-id',
            livePane,
        );
        const meter = page.locator(
            '#pi-rpc-status-bar .pi-rpc-context-meter-text',
        );
        await expect(meter).toHaveText('1K / 8.2K', { timeout: 15_000 });
        await expect(
            page.locator('#pi-rpc-status-bar .pi-rpc-context-meter-fill'),
        ).toHaveClass(/pi-rpc-context-meter-fill--low/);
        await expect(meter.locator('xpath=..')).toHaveAttribute(
            'aria-valuenow',
            '12.3',
        );
        expect((await overflow()).scroll).toBeLessThanOrEqual(
            (await overflow()).inner,
        );

        await page.locator('#input-textarea').fill('MOBILE DRAFT HELD');
        // A real paste event through the real handler stages one
        // synthetic image via the real upload endpoint.
        await page.evaluate(
            ([pixels]) => {
                const bytes = Uint8Array.from(atob(pixels), (c) =>
                    c.charCodeAt(0),
                );
                const file = new File([bytes], 'compact-fixture.png', {
                    type: 'image/png',
                });
                const data = new DataTransfer();
                data.items.add(file);
                const event = new Event('paste', {
                    bubbles: true,
                    cancelable: true,
                });
                Object.defineProperty(event, 'clipboardData', { value: data });
                document.getElementById('input-textarea')?.dispatchEvent(event);
            },
            [PIXEL_PNG_BASE64],
        );
        await expect(
            page.locator('#attachment-strip .attachment-chip'),
        ).toHaveCount(1, {
            timeout: 10_000,
        });

        // The actual mobile slash menu and its actual /compact entry.
        await page.locator('#presets-container .slash-trigger-btn').click();
        const slashDropup = page.locator('#slash-presets-dropup');
        await expect(slashDropup).toBeVisible({ timeout: 10_000 });
        const compactEntry = slashDropup.locator('button.pi-compact-btn');
        await expect(compactEntry).toBeEnabled({ timeout: 10_000 });
        await expect(compactEntry).toHaveAttribute(
            'title',
            'Compact via bridge',
        );
        // Native keyboard activation: focus plus a trusted Enter key.
        await compactEntry.focus();
        await page.keyboard.press('Enter');
        await expect(slashDropup).toBeHidden({ timeout: 10_000 });
        // Dispatched but held: one provider hit, authoritative pending.
        await expect.poll(() => stub.count(), { timeout: 10_000 }).toBe(1);
        expect(stub.heldCount()).toBe(1);
        await expect
            .poll(() => paneBridge(request, phi.url, livePane), {
                timeout: 10_000,
            })
            .toMatchObject({ compact_pending: true });
        // Mobile dispatch blurs the staged input (focusInputOnMobile:false).
        expect(await page.evaluate(() => document.activeElement?.id)).not.toBe(
            'input-textarea',
        );
        // Pending disables the entry while the op is in flight.
        await page.locator('#presets-container .slash-trigger-btn').click();
        await expect(slashDropup).toBeVisible({ timeout: 10_000 });
        await expect(compactEntry).toBeDisabled({ timeout: 10_000 });
        await expect(compactEntry).toHaveAttribute('title', 'Compacting…');
        await page.keyboard.press('Escape');

        stub.release();
        await expect(
            page.locator('.toast', { hasText: 'Compaction complete' }),
        ).toBeVisible({ timeout: 60_000 });
        expect(stub.count()).toBe(1);
        expect(compactionEntries(sessionFile)).toBe(1);
        await expect(meter).toHaveText('— / 8.2K', { timeout: 15_000 });
        await expect(page.locator('#input-textarea')).toHaveValue(
            'MOBILE DRAFT HELD',
        );
        await expect(
            page.locator('#attachment-strip .attachment-chip'),
        ).toHaveCount(1);
        expect((await overflow()).scroll).toBeLessThanOrEqual(
            (await overflow()).inner,
        );

        // A later normal turn through the browser Send button recovers.
        await page.locator('#input-textarea').fill('MOBILE FOLLOWUP');
        await page.locator('#send-input-btn').click();
        await expect(meter).toHaveText(`${COMPACT_FOLLOWUP_TOKENS} / 8.2K`, {
            timeout: 60_000,
        });
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
