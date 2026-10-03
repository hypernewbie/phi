import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
    'base64',
);
let phi: PhiServer;

test.beforeAll(async () => {
    phi = await startPhi();
    writeFileSync(join(phi.dir, 'diagram.png'), png);
});
test.afterAll(async () => {
    await phi.stop();
});

async function openImage(page: Page): Promise<void> {
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
    await page.locator('.diff-tab-btn[data-tab="files"]').click();
    await page
        .locator('#file-tree-list .md-file-row', { hasText: 'diagram.png' })
        .locator('.md-file-item')
        .click();
    await expect(
        page.locator('#md-modal-body img.file-viewer-image'),
    ).toBeVisible();
}

async function preserveClipboard(page: Page): Promise<void> {
    await page
        .context()
        .grantPermissions(['clipboard-read', 'clipboard-write'], {
            origin: phi.url,
        });
    await page.goto(phi.url);
    await page.evaluate(() =>
        navigator.clipboard.writeText('keep my clipboard'),
    );
}

async function checkDownload(
    page: Page,
    click: () => Promise<void>,
): Promise<void> {
    const downloading = page.waitForEvent('download');
    await click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe('diagram.png');
    expect(readFileSync((await download.path())!)).toEqual(png);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        'keep my clipboard',
    );
}

test('without image clipboard support, the primary action downloads the image and leaves the clipboard alone', async ({
    page,
}) => {
    await preserveClipboard(page);
    await page.evaluate(() => {
        Object.defineProperty(window, 'ClipboardItem', {
            configurable: true,
            value: undefined,
        });
    });
    await openImage(page);
    const primary = page.locator('#md-modal-copy-btn');
    await expect(primary).toHaveText('Download Image');
    await page.locator('#md-modal-dropdown-btn').click();
    await expect(page.locator('.md-context-action.copy-image')).toHaveCount(0);
    await expect(
        page.locator('.md-context-action.download-image'),
    ).toBeVisible();
    await page.locator('#md-modal-dropdown-btn').click();
    await checkDownload(page, () => primary.click());
});

test('a denied image copy preserves the clipboard and offers a working download button', async ({
    page,
}) => {
    await preserveClipboard(page);
    await page.evaluate(() => {
        Object.defineProperty(navigator.clipboard, 'write', {
            configurable: true,
            value: () =>
                Promise.reject(new DOMException('Denied', 'NotAllowedError')),
        });
    });
    await openImage(page);
    await expect(page.locator('#md-modal-copy-btn')).toHaveText('Copy Image');
    await page.locator('#md-modal-copy-btn').click();
    const toast = page.locator('.toast-error', { hasText: 'Image not copied' });
    await expect(toast).toBeVisible();
    await expect(toast).not.toContainText('Copied image URL');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        'keep my clipboard',
    );
    await checkDownload(page, () =>
        toast
            .getByRole('button', { name: 'Download Image', exact: true })
            .click(),
    );
});

test('Copy Image writes actual PNG data when the browser supports it', async ({
    page,
}) => {
    await preserveClipboard(page);
    await openImage(page);
    await page.locator('#md-modal-copy-btn').click();
    await expect(
        page.locator('.toast-info', { hasText: 'Copied image to clipboard' }),
    ).toBeVisible();
    expect(
        await page.evaluate(async () => {
            const items = await navigator.clipboard.read();
            const image = items.find((item) =>
                item.types.includes('image/png'),
            );
            if (!image) return false;
            const blob = await image.getType('image/png');
            return blob.type === 'image/png' && blob.size > 0;
        }),
    ).toBe(true);
});
