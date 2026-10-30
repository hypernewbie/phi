import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
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

// Compact layout means a coarse pointer too: phone chrome, touch events and
// the mobile key fallback are all part of the behavior under test.
async function openWithTabs(page: Page, width: number, height: number) {
    await page.setViewportSize({ width, height });
    await page.goto(phi.url);
    await expect(page.locator('#sidebar-panel')).toBeVisible();
    await expect(page.locator('#tabs-container .tab')).toHaveCount(2);
}

async function touchPage(browser: Browser, width: number, height: number) {
    const context = await browser.newContext({
        viewport: { width, height },
        isMobile: true,
        hasTouch: true,
    });
    const page = await context.newPage();
    await openWithTabs(page, width, height);
    return { context, page };
}

test('compact drawer shows the tab tree and a row tap switches tabs', async ({
    browser,
}) => {
    const { context, page } = await touchPage(browser, 390, 844);

    await page.locator('#mobile-sidebar-toggle').click();
    const drawerBody = page.locator('#drawer-tabs-body');
    await expect(drawerBody).toBeVisible();
    await expect(drawerBody.locator('.hostname-dropdown-row')).toHaveCount(2);
    await expect(page.locator('#drawer-panel-title')).toHaveText('TABS');
    await expect(page.locator('#drawer-open-sessions')).toBeVisible();
    await expect(page.locator('#drawer-back-to-tabs')).toBeHidden();
    await expect(page.locator('#drawer-tabs-toolbar')).toBeVisible();

    // Apple HIG slide-over: the panel covers most of the screen, it is not a
    // narrow fixed strip. 390 - 48px peek = 342px.
    const drawer = await page
        .locator('#sidebar-panel')
        .evaluate((el) => el.getBoundingClientRect().width);
    expect(drawer).toBeGreaterThan(390 * 0.8);

    // The New or Resume Session button spans the drawer, above the tree.
    const toolbarBox = await page.locator('#drawer-tabs-toolbar').boundingBox();
    const firstRowBox = await drawerBody
        .locator('.hostname-dropdown-row')
        .first()
        .boundingBox();
    expect(toolbarBox?.width).toBeGreaterThan(drawer - 30);
    expect(toolbarBox!.y + toolbarBox!.height).toBeLessThanOrEqual(
        firstRowBox!.y,
    );

    // Which seeded tab is active depends on the restore order, so derive
    // both ids instead of assuming one.
    const activeBefore = await page
        .locator('#tabs-container .tab.active')
        .getAttribute('data-pane-id');
    const targetRow = drawerBody
        .locator(`.hostname-dropdown-row:not([data-pane-id="${activeBefore}"])`)
        .first();
    const targetId = await targetRow.getAttribute('data-pane-id');
    expect(targetId).not.toBeNull();

    await targetRow.locator('.hostname-dropdown-select-btn').click();
    await expect(page.locator('#sidebar-panel')).not.toHaveClass(/drawer-open/);
    await expect(page.locator('#tabs-container .tab.active')).toHaveAttribute(
        'data-pane-id',
        targetId as string,
    );
    await context.close();
});

test('tapping the terminal dismisses either mobile drawer screen', async ({
    browser,
}) => {
    const { context, page } = await touchPage(browser, 390, 844);
    try {
        const sidebar = page.locator('#sidebar-panel');
        for (const mode of ['tabs', 'sessions']) {
            await page.locator('#mobile-sidebar-toggle').tap();
            await expect(sidebar).toHaveClass(/drawer-open/);
            if (mode === 'sessions') {
                await page.locator('#drawer-open-sessions').tap();
            }
            await expect(sidebar).toHaveAttribute('data-panel-mode', mode);
            await page.locator('#drawer-panel-title').tap();
            await expect(sidebar).toHaveClass(/drawer-open/);
            await expect
                .poll(() =>
                    sidebar.evaluate((el) => el.getBoundingClientRect().right),
                )
                .toBeGreaterThan(340);
            expect(
                await page.evaluate(() =>
                    Boolean(
                        document
                            .elementFromPoint(370, 400)
                            ?.closest('.terminal-content .xterm'),
                    ),
                ),
            ).toBe(true);

            if (mode === 'tabs') {
                const cdp = await context.newCDPSession(page);
                await cdp.send('Input.dispatchTouchEvent', {
                    type: 'touchStart',
                    touchPoints: [{ x: 370, y: 440 }],
                });
                await cdp.send('Input.dispatchTouchEvent', {
                    type: 'touchMove',
                    touchPoints: [{ x: 370, y: 400 }],
                });
                await cdp.send('Input.dispatchTouchEvent', {
                    type: 'touchEnd',
                    touchPoints: [],
                });
                await cdp.detach();
                await expect(sidebar).toHaveClass(/drawer-open/);
            }

            await page.touchscreen.tap(370, 400);
            await expect(sidebar).not.toHaveClass(/drawer-open/);
        }
        expect(
            await page.evaluate(
                () =>
                    document.documentElement.scrollWidth -
                    document.documentElement.clientWidth,
            ),
        ).toBeLessThanOrEqual(1);
    } finally {
        await context.close();
    }
});

test('drawer keys never reach the PTY: Enter activates the row', async ({
    browser,
}) => {
    const { context, page } = await touchPage(browser, 390, 844);

    await page.locator('#mobile-sidebar-toggle').click();
    const drawerBody = page.locator('#drawer-tabs-body');
    const activeBefore = await page
        .locator('#tabs-container .tab.active')
        .getAttribute('data-pane-id');
    const row = drawerBody
        .locator(`.hostname-dropdown-row:not([data-pane-id="${activeBefore}"])`)
        .first();
    const targetId = await row.getAttribute('data-pane-id');

    // The coarse-pointer key fallback forwards Enter/Tab to the PTY and
    // preventDefaults them, which would silently swallow this activation.
    await row.locator('.hostname-dropdown-select-btn').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#sidebar-panel')).not.toHaveClass(/drawer-open/);
    await expect(page.locator('#tabs-container .tab.active')).toHaveAttribute(
        'data-pane-id',
        targetId as string,
    );
    await context.close();
});

test('a left-edge swipe opens the drawer on the tab tree', async ({
    browser,
}) => {
    const { context, page } = await touchPage(browser, 390, 844);

    // The swipe handler reads document-level touchstart/touchend and needs a
    // start inside the left 40px edge plus 60px of horizontal travel.
    await page.evaluate(() => {
        const touch = (x: number) =>
            new Touch({
                identifier: 1,
                target: document.body,
                clientX: x,
                clientY: 400,
            });
        document.dispatchEvent(
            new TouchEvent('touchstart', {
                bubbles: true,
                touches: [touch(10)],
                changedTouches: [touch(10)],
            }),
        );
        document.dispatchEvent(
            new TouchEvent('touchend', {
                bubbles: true,
                touches: [],
                changedTouches: [touch(140)],
            }),
        );
    });

    await expect(page.locator('#sidebar-panel')).toHaveClass(/drawer-open/);
    await expect(page.locator('#drawer-panel-title')).toHaveText('TABS');
    await expect(
        page.locator('#drawer-tabs-body .hostname-dropdown-row'),
    ).toHaveCount(2);
    await context.close();
});

test('the brand opens the drawer on phones, the desktop dropdown on wide screens', async ({
    browser,
}) => {
    const { context, page } = await touchPage(browser, 390, 844);

    await page.locator('#hostname-display').click();
    await expect(page.locator('#sidebar-panel')).toHaveClass(/drawer-open/);
    await expect(page.locator('#drawer-panel-title')).toHaveText('TABS');
    await expect(
        page.locator('#drawer-tabs-body .hostname-dropdown-row'),
    ).toHaveCount(2);
    // The phone gets the drawer, not the separate flat active-sessions list.
    await expect(page.locator('#hostname-tabs-dropdown')).toBeHidden();

    // Tapping the brand again closes it.
    await page.locator('#hostname-display').click();
    await expect(page.locator('#sidebar-panel')).not.toHaveClass(/drawer-open/);
    await context.close();
});

test('New or Resume Session swaps to the sessions block, back arrow returns', async ({
    page,
}) => {
    await openWithTabs(page, 390, 844);

    await page.locator('#mobile-sidebar-toggle').click();
    await expect(page.locator('#drawer-tabs-body')).toBeVisible();

    await page.locator('#drawer-open-sessions').click();
    await expect(page.locator('#drawer-panel-title')).toHaveText('SESSIONS');
    await expect(page.locator('.session-list-container')).toBeVisible();
    await expect(page.locator('#drawer-tabs-body')).toBeHidden();
    await expect(page.locator('#drawer-tabs-toolbar')).toBeHidden();
    await expect(page.locator('#drawer-back-to-tabs')).toBeVisible();
    await expect(page.locator('#drawer-open-sessions')).toBeHidden();

    await page.locator('#drawer-back-to-tabs').click();
    await expect(page.locator('#drawer-panel-title')).toHaveText('TABS');
    await expect(page.locator('#drawer-tabs-body')).toBeVisible();
    await expect(page.locator('.session-list-container')).toBeHidden();

    // Reopening always lands in tabs mode, whatever the last mode was.
    await page.locator('#drawer-open-sessions').click();
    await expect(page.locator('#drawer-panel-title')).toHaveText('SESSIONS');
    await page.locator('#mobile-sidebar-toggle').click();
    await expect(page.locator('#sidebar-panel')).not.toHaveClass(/drawer-open/);
    await page.locator('#mobile-sidebar-toggle').click();
    await expect(page.locator('#sidebar-panel')).toHaveClass(/drawer-open/);
    await expect(page.locator('#drawer-panel-title')).toHaveText('TABS');
    await expect(
        page.locator('#drawer-tabs-body .hostname-dropdown-row'),
    ).toHaveCount(2);
});

test('a tablet drawer keeps sessions content and closes on a terminal tap', async ({
    browser,
}) => {
    const { context, page } = await touchPage(browser, 820, 1180);
    try {
        const sidebar = page.locator('#sidebar-panel');
        await page.locator('#mobile-sidebar-toggle').tap();
        await expect(sidebar).toHaveClass(/drawer-open/);
        await expect(sidebar).toHaveAttribute('data-panel-mode', 'sessions');
        await expect(page.locator('#drawer-panel-title')).toHaveText(
            'SESSIONS',
        );
        await expect(page.locator('.session-list-container')).toBeVisible();
        await expect(page.locator('#drawer-tabs-body')).toBeHidden();
        expect(
            await page.evaluate(() =>
                Boolean(
                    document
                        .elementFromPoint(700, 400)
                        ?.closest('.terminal-content .xterm'),
                ),
            ),
        ).toBe(true);
        await page.touchscreen.tap(700, 400);
        await expect(sidebar).not.toHaveClass(/drawer-open/);
        expect(
            await page.evaluate(
                () =>
                    document.documentElement.scrollWidth -
                    document.documentElement.clientWidth,
            ),
        ).toBeLessThanOrEqual(1);
    } finally {
        await context.close();
    }
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

    // The brand keeps its flat active-sessions dropdown on wide screens.
    await page.locator('#hostname-display').click();
    await expect(page.locator('#hostname-tabs-dropdown')).toBeVisible();
    await expect(page.locator('#sidebar-panel')).not.toHaveClass(/drawer-open/);
});
