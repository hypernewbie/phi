import { readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { devices, expect, test } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';
import {
    seedSyncboardPi,
    startSyncboardProvider,
    SYNCBOARD_KEY,
    SYNCBOARD_VALUE,
} from './_pi-syncboard.js';

for (const mobile of [false, true]) {
    test(`native image attachments and owner-routed Syncboard coexist on ${mobile ? 'touch' : 'desktop'} without replay`, async ({
        browser,
        request,
    }) => {
        test.setTimeout(180_000);
        const provider = await startSyncboardProvider({ expectImage: true });
        let phi: PhiServer | undefined;
        try {
            phi = await startPhi({
                config: { auto_reconnect: 'off' },
                env: { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
                setup(dir) {
                    seedSyncboardPi(dir, provider.port);
                },
            });
            const owner = phi;
            const created = await request.post(`${owner.url}/api/terminals`, {
                data: { coder: 'pi', cwd: realpathSync(owner.dir) },
            });
            expect(created.status()).toBe(200);
            const pane = ((await created.json()) as { pane_id: string })
                .pane_id;
            const bridge = async () => {
                const response = await request.get(
                    `${owner.url}/api/terminals`,
                );
                expect(response.ok()).toBe(true);
                const tabs = (await response.json()) as Array<{
                    id: string;
                    pi_bridge?: {
                        connected: boolean;
                        running?: boolean;
                        capabilities: string[];
                    };
                }>;
                return tabs.find((tab) => tab.id === pane)?.pi_bridge;
            };
            await expect.poll(bridge, { timeout: 30_000 }).toMatchObject({
                connected: true,
                capabilities: expect.arrayContaining([
                    'pi.attachments.v3',
                    'pi.state.v2',
                    'pi.syncboard.v1',
                ]),
            });
            const context = await browser.newContext(
                mobile
                    ? { ...devices['Pixel 7'], colorScheme: 'light' }
                    : {
                          viewport: { width: 1440, height: 900 },
                          colorScheme: 'dark',
                      },
            );
            try {
                const page = await context.newPage();
                const pageErrors: string[] = [];
                page.on('pageerror', (error) => pageErrors.push(error.message));
                await page.goto(owner.url);
                await expect(page.locator('.tab.active')).toHaveAttribute(
                    'data-pane-id',
                    pane,
                );
                const attach = page.locator('#attach-input-btn');
                if (mobile) await attach.tap();
                else await attach.click();
                const chooser = page.waitForEvent('filechooser');
                const source = page.getByRole('menuitem', {
                    name: mobile ? 'Files' : 'Device Files',
                    exact: true,
                });
                if (mobile) await source.tap();
                else await source.click();
                await (await chooser).setFiles(
                    join(process.cwd(), 'web', 'vendor', 'logos', 'pi.png'),
                );
                await expect(page.locator('.attachment-chip')).toContainText(
                    'Ready',
                );
                await page
                    .locator('#input-textarea')
                    .fill(
                        'Inspect this image and update the owning Syncboard once.',
                    );
                expect(provider.requestCount()).toBe(0);
                const send = page.locator('#send-input-btn');
                if (mobile) await send.tap();
                else await send.click();
                await expect(page.locator('#attachment-status')).toHaveText(
                    'Submitted to Pi.',
                );
                await expect
                    .poll(() => provider.resultChecks(), { timeout: 30_000 })
                    .toMatchObject({
                        upsert: true,
                        list: true,
                        error: '',
                    });
                await expect
                    .poll(bridge, { timeout: 30_000 })
                    .toMatchObject({ connected: true, running: false });
                expect(provider.requestCount()).toBe(3);
                const board = await request.get(
                    `${owner.url}/api/sync/messages/${SYNCBOARD_KEY}`,
                );
                expect(board.status()).toBe(200);
                expect(await board.json()).toMatchObject({
                    key: SYNCBOARD_KEY,
                    value: JSON.stringify(SYNCBOARD_VALUE),
                });
                const live = await request.get(
                    `${owner.url}/api/pi-bridge/attachments/context?pane=${pane}`,
                );
                expect(live.status()).toBe(200);
                expect(await live.json()).toMatchObject({
                    available: true,
                    idle: true,
                });
                const records = () =>
                    readdirSync(
                        join(
                            owner.dir,
                            'home',
                            '.phi',
                            'attachments-v2',
                            'sends',
                        ),
                    ).filter((name) => name.endsWith('.json'));
                expect(records()).toHaveLength(1);
                await page.reload();
                await expect(page.locator('#attach-input-btn')).toBeVisible();
                await expect(page.locator('#input-textarea')).toHaveValue('');
                expect(provider.requestCount()).toBe(3);
                expect(records()).toHaveLength(1);
                expect(
                    await page.evaluate(
                        () =>
                            document.documentElement.scrollWidth <= innerWidth,
                    ),
                ).toBe(true);
                expect(pageErrors).toEqual([]);
                await test.info().attach('attachment-syncboard-evidence.json', {
                    body: Buffer.from(
                        JSON.stringify(
                            {
                                owner: owner.identity,
                                mobile,
                                bridge: await bridge(),
                                providerCalls: provider.requestCount(),
                                toolResults: provider.resultChecks(),
                                attachmentRecords: records(),
                            },
                            null,
                            2,
                        ),
                    ),
                    contentType: 'application/json',
                });
            } finally {
                await context.close();
            }
        } finally {
            await phi?.stop();
            await provider.close();
        }
    });
}
