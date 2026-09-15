import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

// 1x1 transparent PNG.
const PIXEL_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
);

const PREVIEW_JS = [
    'vendor/viewerjs/viewer.min.js',
    'vendor/plyr/plyr.polyfilled.js',
    'vendor/json-viewer/json-viewer.bundle.js',
];

let phi: PhiServer;

test.beforeAll(async () => {
    phi = await startPhi();
    writeFileSync(join(phi.dir, 'e2e.png'), PIXEL_PNG);
});

test.afterAll(async () => {
    await phi.stop();
});

test('preview vendor JS loads on first open, not on page load', async ({
    page,
}) => {
    const vendorHits: string[] = [];
    page.on('request', (req) => {
        const url = req.url();
        if (PREVIEW_JS.some((v) => url.endsWith(v))) vendorHits.push(url);
    });

    await page.goto(phi.url);
    // The file tree lives in the diff panel's files tab. The panel
    // starts open on wide viewports, so only toggle when hidden.
    const panelHidden = await page
        .locator('#diff-panel')
        .evaluate((el) => el.classList.contains('hidden'));
    if (panelHidden) await page.locator('#header-diff-toggle-btn').click();
    await page.locator('.diff-tab-btn[data-tab="files"]').click();
    const row = page.locator('#file-tree-list .md-file-row', {
        hasText: 'e2e.png',
    });
    await expect(row).toContainText('e2e.png', { timeout: 30_000 });

    // Settle: no preview vendor bundle may load just from viewing the page.
    await page.waitForTimeout(2_000);
    expect(vendorHits).toEqual([]);
    expect(
        await page.evaluate(
            () => (window as unknown as { Viewer?: unknown }).Viewer,
        ),
    ).toBeUndefined();

    const openPreview = async () => {
        await row.locator('.md-file-action-btn').click();
        await page.locator('.md-context-label', { hasText: 'Preview' }).click();
        await expect(
            page.locator('#md-modal-body img.file-viewer-image'),
        ).toBeVisible({
            timeout: 30_000,
        });
    };

    await openPreview();
    expect(vendorHits.filter((u) => u.endsWith('viewer.min.js'))).toHaveLength(
        1,
    );
    expect(
        await page.evaluate(
            () => typeof (window as unknown as { Viewer?: unknown }).Viewer,
        ),
    ).toBe('function');

    // Second open reuses the loaded bundle: still exactly one fetch.
    await page.locator('#md-modal-close').click();
    await openPreview();
    expect(vendorHits.filter((u) => u.endsWith('viewer.min.js'))).toHaveLength(
        1,
    );
});
