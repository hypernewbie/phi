import { expect, test } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

let phi: PhiServer;
test.beforeAll(async () => {
    phi = await startPhi({ config: { auto_reconnect: 'off' } });
    const created = await fetch(`${phi.url}/api/terminals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            coder: 'bash',
            cwd: phi.dir,
            title: 'Composer',
        }),
    });
    expect(created.ok).toBe(true);
});
test.afterAll(async () => {
    await phi.stop();
});

for (const mobile of [false, true]) {
    test.describe(`composer folding on ${mobile ? 'touch' : 'desktop'}`, () => {
        test.use({
            viewport: mobile
                ? { width: 390, height: 844 }
                : { width: 1440, height: 900 },
            isMobile: mobile,
            hasTouch: mobile,
        });

        test('keeps only Interrupt and Expand, preserves drafts, and works offline', async ({
            page,
            context,
        }) => {
            phi.verify();
            const errors: string[] = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await page.goto(phi.url);
            await page
                .locator('#diff-term-container .xterm')
                .first()
                .waitFor({ state: 'attached' });
            await expect(page.locator('.tab.active')).toBeAttached();

            const composer = page.locator('#input-bar-container');
            const toggle = page.locator('#direct-mode-toggle');
            const interrupt = page.locator('#cancel-input-btn');
            const draft = page.locator('#input-textarea');
            await expect(toggle).toHaveAttribute('aria-expanded', 'false');
            if (mobile) await toggle.tap();
            else await toggle.click();
            await expect(composer).toBeVisible();
            await draft.fill('unsent draft survives folding');
            const expanded = await composer.boundingBox();
            expect(expanded!.height).toBeGreaterThan(0);
            await context.setOffline(true);

            if (mobile) await toggle.tap();
            else await toggle.click();
            await expect(composer).toBeHidden();
            await expect(toggle).toHaveAttribute('aria-expanded', 'false');
            await expect(toggle).toHaveAccessibleName(/expand/);
            await expect(
                page.locator('.presets-toolbar button:visible'),
            ).toHaveCount(2);
            await expect(interrupt).toBeVisible();
            const collapsed = await page
                .locator('.presets-toolbar')
                .boundingBox();
            expect(collapsed!.height).toBeLessThan(mobile ? 60 : 40);
            if (mobile) {
                for (const control of [toggle, interrupt]) {
                    const bounds = await control.boundingBox();
                    expect(bounds!.width).toBeGreaterThanOrEqual(48);
                    expect(bounds!.height).toBeGreaterThanOrEqual(48);
                }
            }

            if (mobile) await interrupt.tap();
            else await interrupt.click();
            await expect(composer).toBeHidden();
            await toggle.focus();
            await page.keyboard.press('Enter');
            await expect(composer).toBeVisible();
            await expect(toggle).toHaveAttribute('aria-expanded', 'true');
            await expect(draft).toHaveValue('unsent draft survives folding');
            await expect(draft).toBeFocused();
            await expect(
                page.locator('.input-actions #cancel-input-btn'),
            ).toBeVisible();
            await expect(page.locator('#cancel-input-btn')).toHaveCount(1);
            if (mobile) await page.setViewportSize({ width: 320, height: 844 });
            expect(
                await page.evaluate(
                    () => document.documentElement.scrollWidth <= innerWidth,
                ),
            ).toBe(true);
            expect(errors).toEqual([]);
            await context.setOffline(false);
        });
    });
}
