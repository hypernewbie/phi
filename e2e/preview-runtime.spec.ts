import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

const PIXEL_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
);

function onePagePdf(): Buffer {
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        '<< /Length 39 >>\nstream\nBT /F1 18 Tf 20 100 Td (Phi PDF) Tj ET\nendstream',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let text = '%PDF-1.4\n%\xFF\xFF\xFF\xFF\n';
    const offsets = [0];
    for (let index = 0; index < objects.length; index += 1) {
        offsets.push(Buffer.byteLength(text, 'latin1'));
        text += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
    }
    const xrefOffset = Buffer.byteLength(text, 'latin1');
    text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets.slice(1)) {
        text += `${String(offset).padStart(10, '0')} 00000 n \n`;
    }
    text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    return Buffer.from(text, 'binary');
}

let phi: PhiServer;

test.beforeAll(async () => {
    phi = await startPhi();
    writeFileSync(join(phi.dir, 'preview.png'), PIXEL_PNG);
    writeFileSync(join(phi.dir, 'preview.json'), '{"name":"phi","ok":true}');
    writeFileSync(join(phi.dir, 'preview.pdf'), onePagePdf());
});

test.afterAll(async () => {
    await phi.stop();
});

async function openFilesTab(page: Page) {
    await page.goto(phi.url);
    const panelHidden = await page
        .locator('#diff-panel')
        .evaluate((el) => el.classList.contains('hidden'));
    if (panelHidden) await page.locator('#header-diff-toggle-btn').click();
    await page.locator('.diff-tab-btn[data-tab="files"]').click();
}

async function openPreview(page: Page, name: string) {
    const row = page.locator('#file-tree-list .md-file-row', { hasText: name });
    await expect(row).toContainText(name, { timeout: 30_000 });
    await row.locator('.md-file-action-btn').click();
    await page.locator('.md-context-label', { hasText: 'Preview' }).click();
}

test('image, JSON, and PDF previews use local runtime vendors', async ({
    page,
}) => {
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await openFilesTab(page);

    await openPreview(page, 'preview.png');
    await expect(
        page.locator('#md-modal-body img.file-viewer-image'),
    ).toBeVisible();
    await page.locator('#md-modal-close').click();

    await openPreview(page, 'preview.json');
    await expect(page.locator('#md-modal-body json-viewer')).toBeVisible();
    await expect(page.locator('#md-modal-body')).toContainText('phi');
    await page.locator('#md-modal-close').click();

    await openPreview(page, 'preview.pdf');
    const pdfFrame = page.frameLocator('iframe.file-viewer-pdf');
    await expect(pdfFrame.locator('#numPages')).toHaveText('/ 1', {
        timeout: 60_000,
    });
    await expect(pdfFrame.locator('.pdfViewer .page')).toBeVisible({
        timeout: 60_000,
    });

    expect(requests.some((url) => url.includes('cdn.'))).toBe(false);
    expect(
        requests.some((url) => url.includes('vendor/pdfjs/pdf.worker.min.mjs')),
    ).toBe(true);
});

test('reopening a JSON preview reuses its loaded bundle', async ({ page }) => {
    const bundleRequests: string[] = [];
    page.on('request', (request) => {
        if (
            request.url().endsWith('/vendor/json-viewer/json-viewer.bundle.js')
        ) {
            bundleRequests.push(request.url());
        }
    });
    await openFilesTab(page);
    await openPreview(page, 'preview.json');
    await expect(page.locator('#md-modal-body json-viewer')).toBeVisible();
    await page.locator('#md-modal-close').click();
    await openPreview(page, 'preview.json');
    await expect(page.locator('#md-modal-body json-viewer')).toBeVisible();
    expect(bundleRequests).toHaveLength(1);
});
