import { expect, test } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

let phi: PhiServer;
test.beforeAll(async () => {
    phi = await startPhi();
});
test.afterAll(async () => {
    await phi.stop();
});

test('Pretty Diff commit selector changes the modal diff and follows the panel selector', async ({
    page,
}) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.route('**/api/git/commits?*', (route) =>
        route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify([
                { hash: 'a111111', subject: 'First change' },
                { hash: 'b222222', subject: 'Second change' },
            ]),
        }),
    );
    await page.route('**/api/git/raw-diff?*', (route) => {
        const commit = new URL(route.request().url()).searchParams.get(
            'commit',
        );
        const value = commit === 'b222222' ? 'second_value' : 'first_value';
        return route.fulfill({
            contentType: 'text/plain',
            body: `diff --git a/main.go b/main.go\n--- a/main.go\n+++ b/main.go\n@@ -1 +1 @@\n-old_value\n+${value}\n`,
        });
    });
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
    await page.locator('.diff-tab-btn[data-tab="diff"]').click();
    await page.locator('#rich-diff-btn').click();

    const modalSelect = page.locator('#diff-modal-commit-select');
    await expect(modalSelect.locator('option')).toHaveCount(4);
    await expect(
        page.locator('#diff-modal .d2h-code-line-ctn', {
            hasText: 'first_value',
        }),
    ).toBeVisible();
    await expect(modalSelect).toHaveValue('unstaged');

    await modalSelect.selectOption('b222222');
    await expect(page.locator('#diff-commit-select')).toHaveValue('b222222');
    await expect(
        page.locator('#diff-modal .d2h-code-line-ctn', {
            hasText: 'second_value',
        }),
    ).toBeVisible();
    await page.locator('#diff-commit-select').selectOption('a111111');
    await expect(modalSelect).toHaveValue('a111111');
    await expect(
        page.locator('#diff-modal .d2h-code-line-ctn', {
            hasText: 'first_value',
        }),
    ).toBeVisible();
});
