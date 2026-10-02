import { expect, test } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

let phi: PhiServer;
test.beforeAll(async () => {
    phi = await startPhi();
});
test.afterAll(async () => {
    await phi.stop();
});

for (const width of [1400, 420]) {
    test(`diff maximise fills the viewport and restores the dialog (${width}px)`, async ({
        page,
    }) => {
        await page.setViewportSize({ width, height: 850 });
        await page.route('**/api/git/raw-diff?*', (route) =>
            route.fulfill({
                contentType: 'text/plain',
                body: 'diff --git a/a.cpp b/a.cpp\n--- a/a.cpp\n+++ b/a.cpp\n@@ -1 +1 @@\n-int old_value;\n+int new_value;\n',
            }),
        );
        await page.goto(phi.url);
        await page
            .locator('#diff-term-container .xterm')
            .first()
            .waitFor({ state: 'attached' });
        const panel = page.locator('#diff-panel');
        const closed = await panel.evaluate(
            (el, mobile) =>
                mobile
                    ? !el.classList.contains('mobile-open')
                    : el.classList.contains('hidden'),
            width < 768,
        );
        if (closed) await page.locator('#header-diff-toggle-btn').click();
        await page.locator('.diff-tab-btn[data-tab="diff"]').click();
        await page.locator('#rich-diff-btn').click();
        const content = page.locator('#diff-modal .md-modal-content');
        const size = page.locator('#diff-modal-size-btn');
        await expect(
            page.locator('#diff-modal .d2h-code-line-ctn', {
                hasText: 'int new_value;',
            }),
        ).toBeVisible();
        const before = (await content.boundingBox())!;
        await size.click();
        await expect(size).toHaveAttribute('aria-pressed', 'true');
        await expect(size).toHaveAccessibleName('Restore diff viewer size');
        const box = (await content.boundingBox())!;
        expect(box.x).toBeCloseTo(0, 0);
        expect(box.y).toBeCloseTo(0, 0);
        expect(box.width).toBeCloseTo(width, 0);
        expect(box.height).toBeCloseTo(850, 0);
        expect(
            await page.evaluate(() => document.fullscreenElement),
        ).toBeNull();
        await expect(page.locator('#diff-modal-close')).toBeVisible();
        await size.click();
        await expect(size).toHaveAttribute('aria-pressed', 'false');
        const restored = (await content.boundingBox())!;
        expect(restored.width).toBeCloseTo(before.width, 0);
        expect(restored.height).toBeCloseTo(before.height, 0);
        await page.keyboard.press('Escape');
        await expect(page.locator('#diff-modal')).toBeHidden();
    });
}
