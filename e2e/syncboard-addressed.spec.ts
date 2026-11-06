import { expect, test } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';
import { meshAddrFromLog, publishToMesh } from './_syncmesh.js';

const MARKER = 'PHI_ADDRESSED_PANEL_51c2';
const BODY = `Pushed by another agent. Marker ${MARKER}.`;

let phi: PhiServer;

test.beforeAll(async () => {
    phi = await startPhi({
        config: { auto_reconnect: 'off', sync_mesh: true },
    });
});

test.afterAll(async () => {
    await phi.stop();
});

test('a message pushed to this Phi shows up in the Syncboard panel', async ({
    page,
}) => {
    const addr = await meshAddrFromLog(phi.logPath);
    publishToMesh(addr, 'pane-b', BODY);

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
    await page.locator('.diff-tab-btn[data-tab="sync"]').click();

    const card = page.locator('.sync-card-push').first();
    await expect(card).toBeVisible();
    await expect(card.locator('.sync-card-key')).toContainText('→ pane-b');
    await expect(card.locator('.sync-push-preview')).toContainText(MARKER);

    // The disclosure opens the whole body, not only the clamped preview.
    await card.locator('summary').click();
    await expect(card.locator('.sync-card-value')).toContainText(MARKER);
});
