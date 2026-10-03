import { expect, test } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

let phi: PhiServer;
test.beforeAll(async () => {
    phi = await startPhi();
});
test.afterAll(async () => {
    await phi.stop();
});

test('one Shell click opens one live session, and another click opens another', async ({
    page,
}) => {
    await page.goto(phi.url);
    await page
        .locator('#diff-term-container .xterm')
        .first()
        .waitFor({ state: 'attached' });
    const requests: unknown[] = [];
    page.on('request', (req) => {
        if (req.url().endsWith('/api/terminals') && req.method() === 'POST')
            requests.push(req.postDataJSON());
    });
    const shell = page.locator('#coder-selector .coder-tab[data-coder="bash"]');
    for (let count = 1; count <= 2; count++) {
        const response = page.waitForResponse(
            (r) =>
                r.url().endsWith('/api/terminals') &&
                r.request().method() === 'POST',
        );
        await shell.click();
        const reply = await response;
        expect(reply.ok()).toBe(true);
        expect(reply.request().postDataJSON()).toMatchObject({
            coder: 'bash',
            session_id: '',
        });
        const pane = await reply.json();
        await expect(
            page.locator(`.tab[data-pane-id="${pane.pane_id}"]`),
        ).toBeVisible();
        await expect(
            page.locator(`#term-${pane.pane_id} .xterm`),
        ).toBeVisible();
        await expect(page.locator('#tabs-container .tab')).toHaveCount(count);
        expect(requests).toHaveLength(count);
    }
});
