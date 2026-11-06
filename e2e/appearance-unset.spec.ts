import { expect, test } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

// The poison vector this spec pins: a Settings save must persist only the
// fields the user actually edited. Font sizes the user never chose must
// stay UNSET on the server (0), so a future default change simply reaches
// every client — nothing stored pins an old default. The 2026-11 incident:
// a save wrote the rendered default (10) into server configs across the
// tailnet, and every later client rendered the stored 10 as a "user
// choice" while the terminal kept the real default.
let phi: PhiServer;

test.beforeAll(async () => {
    phi = await startPhi();
});
test.afterAll(async () => {
    await phi.stop();
});

test('an unrelated save never persists font sizes the user did not set', async ({
    browser,
}) => {
    const context = await browser.newContext();
    try {
        const before = await (
            await context.request.get(`${phi.url}/api/config`)
        ).json();
        expect(before.ui_font_size ?? 0).toBe(0);
        expect(before.terminal_font_size ?? 0).toBe(0);

        const page = await context.newPage();
        // The page renders its current default for unset sizes. The exact
        // number is the client's business (16px body base today); what must
        // hold is that an unrelated save neither changes it nor stores it.
        await page.goto(`${phi.url}/config.html?desktop=1`);
        const rendered = await page
            .locator('body')
            .evaluate((b) => getComputedStyle(b).fontSize);
        expect(parseInt(rendered, 10)).toBeGreaterThanOrEqual(14);

        // Edit ONLY the hostname override, then reload inside the debounce
        // window so both the pagehide flush and the timed flush run.
        await page.locator('#settings-hostname-override').fill('unset-guard');
        await page.reload();
        await page.waitForTimeout(1200);

        const after = await (
            await context.request.get(`${phi.url}/api/config`)
        ).json();
        // The one edited field landed.
        expect(after.hostname_override).toBe('unset-guard');
        // The sizes the user never touched are still unset: the save must
        // not materialize rendered defaults into stored user values.
        expect(after.ui_font_size ?? 0).toBe(0);
        expect(after.terminal_font_size ?? 0).toBe(0);

        // And a fresh boot still renders the same default, not a stored
        // old one: the save left nothing pinned.
        const page2 = await context.newPage();
        await page2.goto(`${phi.url}/config.html?desktop=1`);
        await expect(page2.locator('body')).toHaveCSS('font-size', rendered);
    } finally {
        await context.close();
    }
});
