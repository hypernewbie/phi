import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

const release = JSON.parse(
    readFileSync(new URL('../npm/package.json', import.meta.url), 'utf8'),
).version as string;
let phi: PhiServer;

test.beforeAll(async () => {
    phi = await startPhi();
});
test.afterAll(async () => {
    await phi.stop();
});

test('source builds show the current version in the sidebar and changelog title', async ({
    page,
}) => {
    const versionResponse = page.waitForResponse((response) =>
        response.url().endsWith('/api/version'),
    );
    await page.goto(phi.url);
    expect((await (await versionResponse).json()).version).toBe('dev');
    const badge = page.locator('#phi-changelog-btn');
    await expect(badge).toHaveText(`v${release}`);
    await badge.click();
    await expect(page.locator('#md-modal-title')).toContainText(
        `Changelog — v${release}`,
    );
    await expect(page.locator('#md-modal-body h2').first()).toContainText(
        `v${release} —`,
    );
});

test('the server release stamp overrides the source UI fallback', async ({
    page,
}) => {
    await page.route('**/api/version', (route) =>
        route.fulfill({
            json: {
                version: '0.22.0',
                build_source: 'release',
                install_method: 'standalone',
            },
        }),
    );
    await page.goto(phi.url);
    const badge = page.locator('#phi-changelog-btn');
    await expect(badge).toHaveText('v0.22.0');
    await badge.click();
    await expect(page.locator('#md-modal-title')).toContainText(
        'Changelog — v0.22.0',
    );
});
