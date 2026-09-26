import { expect, test } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

let phi: PhiServer;

test.beforeAll(async () => {
    phi = await startPhi();
});

test.afterAll(async () => {
    await phi.stop();
});

test('built-in coder controls keep their pre-registry layout before and after bootstrap', async ({
    page,
}) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.route('**/api/coders', async (route) => {
        // Hold the registry request long enough to inspect initial HTML.
        await new Promise((resolve) => setTimeout(resolve, 750));
        await route.continue();
    });
    await page.goto(phi.url, { waitUntil: 'domcontentloaded' });

    const tabs = page.locator('#coder-selector .coder-tab');
    const quick = page.locator('#empty-quick-launch .empty-launch-btn');
    const tabIds = ['opencode', 'claude', 'agy', 'pi', 'bash'];
    const quickIds = ['opencode', 'claude', 'pi', 'agy', 'bash'];
    const assertControls = async () => {
        expect(
            await tabs.evaluateAll((els) =>
                els.map((el) => el.getAttribute('data-coder')),
            ),
        ).toEqual(tabIds);
        expect(
            await quick.evaluateAll((els) =>
                els.map((el) => el.getAttribute('data-coder')),
            ),
        ).toEqual(quickIds);
        expect(
            await tabs.evaluateAll((els) =>
                els.map((el) => el.getAttribute('title')),
            ),
        ).toEqual([
            'OpenCode',
            'Claude Code',
            'Antigravity / Agy',
            'Pi (term)',
            'Shell Prompt',
        ]);
        expect(await tabs.locator('img.coder-logo').count()).toBe(5);
        const widths = await tabs
            .locator('img.coder-logo')
            .evaluateAll((els) =>
                els.map((el) => Math.round(el.getBoundingClientRect().width)),
            );
        expect(widths).toEqual([16, 16, 16, 16, 16]);
    };

    await assertControls();
    await page.evaluate(() => document.fonts.ready);
    const geometry = () =>
        page.evaluate(() =>
            [...document.querySelectorAll('#coder-selector .coder-tab')].map(
                (tab) => {
                    const box = tab.getBoundingClientRect();
                    const logo = tab
                        .querySelector('.coder-logo')!
                        .getBoundingClientRect();
                    return [
                        box.x,
                        box.y,
                        box.width,
                        box.height,
                        logo.x,
                        logo.y,
                        logo.width,
                        logo.height,
                    ].map((n) => Math.round(n * 100) / 100);
                },
            ),
        );
    const before = await geometry();
    const initialTab = await tabs.first().elementHandle();
    await page.waitForFunction(
        (node) => document.querySelector('#coder-selector .coder-tab') !== node,
        initialTab,
    );
    await assertControls();
    await page.evaluate(() => document.fonts.ready);
    expect(await geometry()).toEqual(before);

    // Collapsed sidebar must keep the logo visible (the label is hidden).
    await page
        .locator('#sidebar-panel')
        .evaluate((el) => el.classList.add('sidebar-narrow'));
    await expect(tabs.first().locator('img.coder-logo')).toBeVisible();
    await expect
        .poll(async () =>
            Math.round(
                (await tabs.first().locator('img.coder-logo').boundingBox())
                    ?.width ?? 0,
            ),
        )
        .toBe(18);
    const narrowWidths = await tabs
        .locator('img.coder-logo')
        .evaluateAll((els) =>
            els.map((el) => Math.round(el.getBoundingClientRect().width)),
        );
    expect(narrowWidths).toEqual([18, 18, 18, 18, 18]);
});

test('initial coder controls remain when config cannot load', async ({
    page,
}) => {
    await page.route('**/api/config', (route) =>
        route.fulfill({ status: 503, body: 'unavailable' }),
    );
    await page.goto(phi.url);
    await expect(page.locator('#coder-selector .coder-tab')).toHaveCount(5);
    await expect(
        page.locator('#empty-quick-launch .empty-launch-btn'),
    ).toHaveCount(5);
    await expect(
        page.locator('#coder-selector img.coder-logo').first(),
    ).toBeVisible();
});
