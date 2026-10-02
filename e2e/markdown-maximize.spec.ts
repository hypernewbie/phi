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
    test(`Markdown preview maximizes, keeps its scroll position, and restores (${width}px)`, async ({
        page,
    }) => {
        await page.setViewportSize({ width, height: 850 });
        await page.route('**/api/markdown/files?*', (route) =>
            route.fulfill({
                json: [{ name: 'Guide.md', path: 'Guide.md', dir: '.' }],
            }),
        );
        await page.route('**/api/markdown/file?*', (route) =>
            route.fulfill({
                contentType: 'text/plain',
                body:
                    '# Guide\n\n' +
                    'A paragraph for checking scrolling.\n\n'.repeat(100),
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
        await page.locator('.diff-tab-btn[data-tab="markdown"]').click();
        await page
            .locator('#markdown-file-list .md-file-item', {
                hasText: 'Guide.md',
            })
            .click();
        const modal = page.locator('#md-modal');
        const content = modal.locator('.md-modal-content');
        const body = page.locator('#md-modal-body');
        await expect(body.locator('h1')).toHaveText('Guide');
        const before = (await content.boundingBox())!;
        await body.evaluate((element) => {
            element.scrollTop = 200;
        });
        const button = page.locator('#md-modal-size-btn');
        await button.click();
        await expect(button).toHaveAccessibleName('Restore preview size');
        await expect(button).toHaveAttribute('aria-pressed', 'true');
        const box = (await content.boundingBox())!;
        expect(box.x).toBeCloseTo(0, 0);
        expect(box.y).toBeCloseTo(0, 0);
        expect(box.width).toBeCloseTo(width, 0);
        expect(box.height).toBeCloseTo(850, 0);
        expect(await body.evaluate((element) => element.scrollTop)).toBe(200);
        expect(
            await page.evaluate(() => document.fullscreenElement),
        ).toBeNull();
        await expect(page.locator('#md-modal-close')).toBeVisible();
        await button.click();
        await expect(button).toHaveAccessibleName('Maximize preview');
        const restored = (await content.boundingBox())!;
        expect(restored.width).toBeCloseTo(before.width, 0);
        expect(restored.height).toBeCloseTo(before.height, 0);
        await page.keyboard.press('Escape');
        await expect(modal).toBeHidden();
    });
}
