// Carrier plumbing only: an owned DSH stub, never a provider or real DSH.
// Official-application acceptance is recorded separately in the M1/M2 passes.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

test.use({ trace: 'off' });
test.skip(
    process.platform === 'win32',
    'the fixture launcher is a POSIX shell script',
);
let phi: PhiServer;

test.beforeAll(async () => {
    phi = await startPhi({
        configAfterPort: (dir, port) => ({
            dsh_preview_enabled: true,
            dsh_preview_command: join(dir, 'dsh-launcher'),
            dsh_preview_origin: `http://127.0.0.1:${port}`,
        }),
        setup: (dir) => {
            const script = join(dir, 'dsh-web-stub.mjs');
            writeFileSync(
                script,
                readFileSync(
                    join(process.cwd(), 'e2e', 'fixtures', 'dsh-web-stub.mjs'),
                ),
            );
            writeFileSync(
                join(dir, 'dsh-launcher'),
                `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
                { mode: 0o700 },
            );
        },
    });
});
test.beforeEach(() => phi.verify());
test.afterAll(async () => {
    await phi?.stop();
});

test('launcher opens the carrier without creating a terminal', async ({
    page,
}) => {
    await page.goto(phi.url);
    const launcher = page.locator('#dsh-preview-btn');
    await expect(launcher).toBeVisible({ timeout: 60_000 });
    const terminalWrites: string[] = [];
    page.on('request', (request) => {
        if (
            new URL(request.url()).pathname.startsWith('/api/terminals') &&
            request.method() !== 'GET'
        ) {
            terminalWrites.push(request.method());
        }
    });
    await launcher.click();
    await expect(page.locator('.dsh-notice')).toContainText('Not isolated');
    await expect(page.locator('.tab.active .tab-pin')).toBeHidden();
    await expect(page.locator('#refresh-console-btn')).toBeHidden();
    await expect(page.locator('#mobile-refresh-console-btn')).toBeHidden();
    await expect(page.locator('iframe.dsh-frame')).toHaveAttribute(
        'src',
        /^\/api\/dsh\/[A-Za-z0-9_-]{22}\/$/,
    );
    await expect(
        page
            .frameLocator('iframe.dsh-frame')
            .locator('[data-stub="dsh-carrier-ok"]'),
    ).toBeVisible({ timeout: 30_000 });
    expect(terminalWrites).toEqual([]);
});

test('mobile DSH tab hides PTY controls without horizontal overflow', async ({
    browser,
}) => {
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
    });
    try {
        const page = await context.newPage();
        await page.goto(phi.url);
        await page
            .getByRole('button', {
                name: 'Toggle Sessions Drawer',
                exact: true,
            })
            .click();
        await page.locator('#drawer-open-sessions').click();
        await page.locator('#dsh-preview-btn').click();
        await expect(
            page
                .frameLocator('iframe.dsh-frame')
                .locator('[data-stub="dsh-carrier-ok"]'),
        ).toBeVisible({ timeout: 30_000 });
        await expect(page.locator('#mobile-refresh-console-btn')).toBeHidden();
        expect(
            await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
            ),
        ).toBe(true);
    } finally {
        await context.close();
    }
});

test('reload restores the tab and obtains a fresh carrier route', async ({
    page,
}) => {
    await page.goto(phi.url);
    const launcher = page.locator('#dsh-preview-btn');
    await expect(launcher).toBeVisible({ timeout: 60_000 });
    await launcher.click();
    const marker = page
        .frameLocator('iframe.dsh-frame')
        .locator('[data-stub="dsh-carrier-ok"]');
    await expect(marker).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await expect(marker).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.dsh-notice')).toContainText(
        'shares your Phi access',
    );
});
