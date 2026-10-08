import { expect, test } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

let phi: PhiServer;
test.beforeAll(async () => {
    phi = await startPhi();
});
test.afterAll(async () => {
    await phi.stop();
});

test('Markdown and diff modals sit above open mobile navigation drawers', async ({
    page,
}) => {
    // This compact tablet geometry uses both fixed drawers; its sidebar
    // previously had a higher stacking layer than the modal overlays.
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto(phi.url);
    await page.locator('#sidebar-panel').waitFor();
    await page
        .locator('#sidebar-panel')
        .evaluate((el) => el.classList.add('drawer-open'));
    await page.locator('#diff-panel').evaluate((el) => {
        el.classList.remove('hidden');
        el.classList.add('mobile-open');
    });

    for (const id of ['diff-modal', 'md-modal']) {
        const modal = page.locator(`#${id}`);
        await modal.evaluate((el) => el.classList.remove('hidden'));
        const state = await page.evaluate((modalId) => {
            const element = document.elementFromPoint(8, 100);
            const modal = document.getElementById(modalId)!;
            return {
                topModal: element?.closest(`#${modalId}`)?.id ?? null,
                modalZ: getComputedStyle(modal).zIndex,
            };
        }, id);
        expect(
            state,
            `${id} should shield the drawers from hit testing`,
        ).toMatchObject({
            modalZ: '1300',
            topModal: id,
        });
        await modal.evaluate((el) => el.classList.add('hidden'));
    }
});
