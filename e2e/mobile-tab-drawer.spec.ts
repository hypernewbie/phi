import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

let phi: PhiServer;

async function startTabFixture(): Promise<PhiServer> {
    return startPhi({
        env: { PHI_SHUTDOWN_PTY_GRACE: '150ms', PHI_SHUTDOWN_GRACE: '1s' },
        setup(dir) {
            const folder = join(dir, 'workspace');
            mkdirSync(folder, { recursive: true });
            const workspace = realpathSync(folder);
            const home = join(dir, 'home');
            const backends = join(home, '.phi', 'backends');
            mkdirSync(backends, { recursive: true });
            const command = join(dir, 'fixture-bash');
            writeFileSync(
                command,
                '#!/bin/sh\nprintf "bash fixture ready\\r\\n"\nexec cat\n',
                { mode: 0o755 },
            );
            writeFileSync(
                join(backends, 'bash.json'),
                JSON.stringify({ id: 'bash', command }),
            );
            writeFileSync(
                join(home, '.phi', 'tabs.json'),
                JSON.stringify([
                    {
                        id: 't1',
                        coder: 'bash',
                        session_id: '',
                        cwd: workspace,
                        workspace,
                        title: 'Tab one',
                    },
                    {
                        id: 't2',
                        coder: 'bash',
                        session_id: '',
                        cwd: workspace,
                        workspace,
                        title: 'Tab two',
                    },
                ]),
            );
        },
    });
}

test.beforeAll(async () => {
    phi = await startTabFixture();
});
test.afterAll(async () => {
    await phi.stop();
});

async function openWithTabs(page: Page, width: number, height: number) {
    await page.setViewportSize({ width, height });
    await page.goto(phi.url);
    await expect(page.locator('#sidebar-panel')).toBeVisible();
    await expect(page.locator('#tabs-container .tab')).toHaveCount(2);
}

test('compact drawer shows the tab tree and a row tap switches tabs', async ({
    page,
}) => {
    await openWithTabs(page, 390, 844);

    await page.locator('#mobile-sidebar-toggle').click();
    const drawerBody = page.locator('#drawer-tabs-body');
    await expect(drawerBody).toBeVisible();
    await expect(drawerBody.locator('.hostname-dropdown-row')).toHaveCount(2);
    await expect(page.locator('#drawer-panel-title')).toHaveText('TABS');
    await expect(page.locator('#drawer-open-sessions')).toBeVisible();
    await expect(page.locator('#drawer-back-to-tabs')).toBeHidden();

    await drawerBody
        .locator('.hostname-dropdown-row[data-pane-id="t2"]')
        .locator('.hostname-dropdown-select-btn')
        .click();
    await expect(page.locator('#sidebar-panel')).not.toHaveClass(/drawer-open/);
});

test('plus opens the sessions block, back arrow returns to tabs', async ({
    page,
}) => {
    await openWithTabs(page, 390, 844);

    await page.locator('#mobile-sidebar-toggle').click();
    await expect(page.locator('#drawer-tabs-body')).toBeVisible();

    await page.locator('#drawer-open-sessions').click();
    await expect(page.locator('#drawer-panel-title')).toHaveText('SESSIONS');
    await expect(page.locator('.session-list-container')).toBeVisible();
    await expect(page.locator('#drawer-tabs-body')).toBeHidden();
    await expect(page.locator('#drawer-back-to-tabs')).toBeVisible();
    await expect(page.locator('#drawer-open-sessions')).toBeHidden();

    await page.locator('#drawer-back-to-tabs').click();
    await expect(page.locator('#drawer-panel-title')).toHaveText('TABS');
    await expect(page.locator('#drawer-tabs-body')).toBeVisible();
    await expect(page.locator('.session-list-container')).toBeHidden();
});

test('a tab-sized tablet drawer keeps the sessions content', async ({
    page,
}) => {
    await openWithTabs(page, 820, 1180);

    await page.locator('#mobile-sidebar-toggle').click();
    await expect(page.locator('#sidebar-panel')).toHaveClass(/drawer-open/);
    await expect(page.locator('#sidebar-panel')).toHaveAttribute(
        'data-panel-mode',
        'sessions',
    );
    await expect(page.locator('#drawer-panel-title')).toHaveText('SESSIONS');
    await expect(page.locator('.session-list-container')).toBeVisible();
    await expect(page.locator('#drawer-tabs-body')).toBeHidden();
});

test('desktop sidebar and tab-bar dropdown are unchanged', async ({ page }) => {
    await openWithTabs(page, 1440, 900);

    await expect(page.locator('.session-list-container')).toBeVisible();
    await expect(page.locator('#drawer-tabs-body')).toBeHidden();
    await expect(page.locator('#drawer-open-sessions')).toBeHidden();

    await page.locator('#tab-overflow-btn').click();
    const dropdown = page.locator('#tab-overflow-dropdown');
    await expect(dropdown).toBeVisible();
    await expect(dropdown.locator('.hostname-dropdown-row')).toHaveCount(2);
    await expect(page.locator('#drawer-tabs-body')).toBeHidden();
});
