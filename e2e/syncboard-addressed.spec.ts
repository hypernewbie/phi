import { expect, test } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';
import { meshAddrFromLog, publishToMesh } from './_syncmesh.js';

const BODY = 'Pushed by another agent. Read the whole message here. '.repeat(8);

let phi: PhiServer;

test.beforeAll(async () => {
    phi = await startPhi({
        config: { auto_reconnect: 'off', sync_mesh: true },
    });
});

test.afterAll(async () => {
    await phi.stop();
});

for (const mobile of [false, true]) {
    test.describe(mobile ? 'mobile touch' : 'desktop keyboard', () => {
        test.use({
            viewport: mobile
                ? { width: 390, height: 844 }
                : { width: 1440, height: 900 },
            isMobile: mobile,
            hasTouch: mobile,
        });

        test('reads a real push and preserves it after an offline reload', async ({
            page,
        }, testInfo) => {
            phi.verify();
            const errors: string[] = [];
            page.on('pageerror', (error) => errors.push(error.message));
            const addr = await meshAddrFromLog(phi.logPath);
            const { message_id: id } = JSON.parse(
                publishToMesh(addr, 'pane-b', BODY),
            ) as { message_id: string };

            await page.goto(phi.url);
            await page
                .locator('#diff-term-container .xterm')
                .first()
                .waitFor({ state: 'attached' });
            if (
                await page
                    .locator('#diff-panel')
                    .evaluate((el) => el.classList.contains('hidden'))
            ) {
                await page.locator('#header-diff-toggle-btn').click();
            }
            const syncTab = page.locator('.diff-tab-btn[data-tab="sync"]');
            await syncTab.click();

            const card = page.locator(
                `.sync-card-push[data-message-id="${id}"]`,
            );
            const summary = card.locator('summary');
            await expect(card).toBeVisible();
            await expect(summary).toHaveAccessibleName(
                /^127\.0\.0\.1 → pane-b/,
            );
            await expect(summary).not.toHaveAccessibleName(
                /Pushed by another agent/,
            );
            expect(
                (await summary.boundingBox())?.height,
            ).toBeGreaterThanOrEqual(44);
            expect(
                await page.evaluate(
                    () => document.documentElement.scrollWidth <= innerWidth,
                ),
            ).toBe(true);

            if (mobile) {
                await summary.tap();
            } else {
                // Reach the disclosure with real keyboard input so the
                // browser applies :focus-visible, not just programmatic focus.
                await syncTab.focus();
                for (let i = 0; i < 12; i++) {
                    await page.keyboard.press('Tab');
                    if (
                        await summary.evaluate(
                            (el) => el === document.activeElement,
                        )
                    )
                        break;
                }
                await expect(summary).toBeFocused();
                expect(
                    await summary.evaluate(
                        (el) => getComputedStyle(el).outlineStyle,
                    ),
                ).toBe('solid');
                await page.keyboard.press('Enter');
            }
            await expect(card.locator('.sync-card-value')).toBeVisible();
            await expect(card.locator('.sync-card-value')).toHaveText(
                BODY.trim(),
            );
            await page.screenshot({
                path: testInfo.outputPath('addressed.png'),
            });

            // A background failure and reload must use the last good answer.
            await page.route('**/api/sync/pushes', (route) =>
                route.fulfill({ status: 503, body: 'unavailable' }),
            );
            await page.reload();
            if (
                await page
                    .locator('#diff-panel')
                    .evaluate((el) => el.classList.contains('hidden'))
            ) {
                await page.locator('#header-diff-toggle-btn').click();
            }
            await syncTab.click();
            await expect(card).toBeVisible();
            await expect(page.locator('.sync-push-note')).toHaveText(
                'Refresh unavailable. Showing saved addressed messages.',
            );
            expect(errors).toEqual([]);
        });
    });
}
