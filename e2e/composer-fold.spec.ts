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

        test('keeps only Interrupt, touch Search, and Expand, preserves drafts, and works offline', async ({
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
            ).toHaveCount(mobile ? 3 : 2);
            await expect(interrupt).toBeVisible();
            const collapsed = await page
                .locator('.presets-toolbar')
                .boundingBox();
            expect(collapsed!.height).toBeLessThan(mobile ? 60 : 40);
            if (mobile) {
                const search = page.locator('#session-search-btn');
                await expect(search).toBeVisible();
                for (const control of [toggle, interrupt, search]) {
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

const IPHONE_UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

test('mobile composer rows share the font-relative control size', async ({
    browser,
}) => {
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        userAgent: IPHONE_UA,
    });
    try {
        const page = await context.newPage();
        const client = await context.newCDPSession(page);
        await client.send('Emulation.setEmulatedMedia', {
            features: [
                { name: 'pointer', value: 'coarse' },
                { name: 'any-pointer', value: 'coarse' },
                { name: 'hover', value: 'none' },
                { name: 'any-hover', value: 'none' },
            ],
        });
        phi.verify();
        await page.goto(phi.url);
        await page
            .locator('#diff-term-container .xterm')
            .first()
            .waitFor({ state: 'attached' });
        await expect(page.locator('.tab.active')).toBeAttached();

        const composer = page.locator('#input-bar-container');
        const toggle = page.locator('#direct-mode-toggle');
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await toggle.tap();
        await expect(composer).toBeVisible();

        await expect(
            page.locator('.input-actions button:visible').first(),
        ).toBeVisible();
        await expect(
            page.locator('.presets-container button:visible').first(),
        ).toBeVisible();

        const controls = page.locator(
            '#input-bar-container button:visible, .presets-toolbar button:visible',
        );
        const readControls = () =>
            controls.evaluateAll((els) =>
                els.map((el) => {
                    const box = el.getBoundingClientRect();
                    return {
                        id: el.id || el.className,
                        width: box.width,
                        height: box.height,
                        square: el.matches(
                            '#session-search-btn, #cancel-input-btn, .btn-icon, .mobile-nav-btn, .keys-trigger-btn, .input-mode-toggle',
                        ),
                    };
                }),
            );

        const root = await page.evaluate(() =>
            parseFloat(getComputedStyle(document.documentElement).fontSize),
        );
        expect(root).toBe(17);
        const expected = 2 * root;
        const assertUniform = (
            metrics: Awaited<ReturnType<typeof readControls>>,
            label: string,
        ) => {
            expect(metrics.length, label).toBeGreaterThanOrEqual(10);
            for (const control of metrics) {
                expect(control.height, `${label}: ${control.id}`).toBeCloseTo(
                    expected,
                    0,
                );
            }
            for (const control of metrics.filter((item) => item.square)) {
                expect(
                    control.width,
                    `${label} square: ${control.id}`,
                ).toBeCloseTo(expected, 0);
            }
        };

        assertUniform(await readControls(), 'expanded 390');

        await page.setViewportSize({ width: 320, height: 844 });
        assertUniform(await readControls(), 'expanded 320');
        expect(
            await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
            ),
        ).toBe(true);

        await toggle.tap();
        await expect(composer).toBeHidden();
        const collapsed = await page
            .locator('.presets-toolbar button:visible')
            .evaluateAll((els) =>
                els.map((el) => {
                    const box = el.getBoundingClientRect();
                    return { width: box.width, height: box.height };
                }),
            );
        expect(collapsed).toHaveLength(3);
        for (const control of collapsed) {
            expect(control.width).toBeGreaterThanOrEqual(48);
            expect(control.height).toBeGreaterThanOrEqual(48);
        }
    } finally {
        await context.close();
    }
});
