import { expect, test } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

let phi: PhiServer;
test.beforeAll(async () => {
    phi = await startPhi();
});
test.afterAll(async () => {
    await phi.stop();
});

test('left coder selector drops labels before wrapping and restores them when widened', async ({
    page,
}) => {
    await page.setViewportSize({ width: 1920, height: 900 });
    await page.goto(phi.url);
    const sidebar = page.locator('#sidebar-panel');
    const buttons = page.locator('#coder-selector .coder-tab');
    await expect(buttons).toHaveCount(6);
    await page.evaluate(() => document.fonts.ready);
    for (const width of [320, 260, 180, 450, 260]) {
        await sidebar.evaluate((el, w) => {
            (el as HTMLElement).style.width = `${w}px`;
        }, width);
        const labels = buttons.locator(':scope > span:not(.coder-logo)');
        if (width <= 420) {
            for (const label of await labels.all())
                await expect(label).toBeHidden();
        } else {
            for (const label of await labels.all())
                await expect(label).toBeVisible();
        }
        const tops = await buttons.evaluateAll((elements) =>
            elements.map((el) => Math.round(el.getBoundingClientRect().top)),
        );
        // Only wrap after even the icon-only buttons cannot fit.
        expect(new Set(tops).size, `panel width ${width}px`).toBe(
            width < 220 ? 2 : 1,
        );
        for (const logo of await buttons.locator('.coder-logo').all())
            await expect(logo).toBeVisible();
        expect(await buttons.first().getAttribute('title')).toBe('OpenCode');
    }
});
