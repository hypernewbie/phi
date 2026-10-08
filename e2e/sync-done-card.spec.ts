import { expect, test } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

let phi: PhiServer;
test.beforeAll(async () => {
    phi = await startPhi();
});
test.afterAll(async () => {
    await phi.stop();
});

test('done card stays glanceable and shows its source machine on mobile', async ({
    page,
}) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route('**/api/proxy?*', (route) =>
        route.fulfill({
            json: [
                {
                    key: 'done:JUPITER:build',
                    value: {
                        done: 'Fixed the mobile completion card layout.',
                        machine: 'JUPITER',
                    },
                    updated_at: new Date().toISOString(),
                },
            ],
        }),
    );
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
    await page.locator('.diff-tab-btn[data-tab="sync"]').click();

    const card = page.locator('.sync-card-done');
    await expect(card).toBeVisible();
    await expect(card.locator('.sync-card-key')).toHaveText('Done');
    await expect(card.locator('.sync-done-icon')).toHaveText('✅');
    await expect(card.locator('.sync-done-summary')).toHaveText(
        'Fixed the mobile completion card layout.',
    );
    await expect(card.locator('.sync-done-machine')).toContainText('JUPITER');
    expect(
        await card.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
        ),
    ).toBe(true);
});
