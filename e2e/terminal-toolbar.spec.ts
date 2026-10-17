import { expect, test, type Page } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

let phi: PhiServer;
test.beforeAll(async () => {
    phi = await startPhi({ config: { auto_reconnect: 'off' } });
});
test.afterAll(async () => {
    await phi.stop();
});

const surfaces = [
    {
        name: 'desktop',
        viewport: { width: 1280, height: 900 },
        isMobile: false,
        hasTouch: false,
        reloadId: 'refresh-console-btn',
        closeId: 'close-all-tabs-btn',
    },
    {
        name: 'mobile',
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        reloadId: 'mobile-refresh-console-btn',
        closeId: 'mobile-close-all-tabs-btn',
    },
] as const;

async function selectPane(
    page: Page,
    paneId: string,
    title: string,
    mobile: boolean,
) {
    if (mobile) {
        await page.locator('#hostname-display').click();
        const dropdown = page.locator('#hostname-tabs-dropdown');
        await expect(dropdown).toBeVisible();
        await dropdown
            .locator('.hostname-dropdown-select-btn')
            .filter({ has: page.getByText(title, { exact: true }) })
            .click();
    } else {
        await page.locator(`.tab[data-pane-id="${paneId}"]`).click();
    }
    await expect(page.locator('.tab.active')).toHaveAttribute(
        'data-pane-id',
        paneId,
    );
}

test.use({ trace: 'on' });

for (const surface of surfaces) {
    test.describe(`terminal toolbar on ${surface.name}`, () => {
        test.use({
            viewport: surface.viewport,
            isMobile: surface.isMobile,
            hasTouch: surface.hasTouch,
        });

        test('reloads the selected terminal and confirms close-all without closing', async ({
            page,
        }, testInfo) => {
            const one = 'toolbar-one';
            const two = 'toolbar-two';
            const ids = [one, two];
            const connectionCounts = new Map<string, number>([
                [one, 0],
                [two, 0],
            ]);
            const resizedConnections = new Set<string>();
            const terminalDeletes: string[] = [];

            page.on('request', (request) => {
                const url = new URL(request.url());
                if (
                    request.method() === 'DELETE' &&
                    url.pathname.startsWith('/api/terminals/toolbar-')
                ) {
                    terminalDeletes.push(url.pathname);
                }
            });
            await page.route('**/api/terminals', (route) =>
                route.fulfill({
                    json: ids.map((id) => ({
                        id,
                        title: id === one ? 'Toolbar one' : 'Toolbar two',
                        coder: 'bash',
                        cwd: phi.dir,
                        workspace: phi.dir,
                        session_id: '',
                        pinned: false,
                    })),
                }),
            );
            await page.route('**/api/terminals/toolbar-*/**', (route) =>
                route.fulfill({ json: {} }),
            );
            await page.routeWebSocket('**/ws/pane/toolbar-*?*', (socket) => {
                const id = new URL(socket.url()).pathname.split('/').at(-1)!;
                const connection = connectionCounts.get(id)! + 1;
                connectionCounts.set(id, connection);
                socket.onMessage((message) => {
                    if (
                        Buffer.isBuffer(message) &&
                        message.length === 5 &&
                        message[0] === 0x02
                    ) {
                        resizedConnections.add(`${id}:${connection}`);
                    }
                });
                const header = Buffer.from(
                    JSON.stringify({ epoch: 7, oldest: 0, head: 0 }),
                );
                const frame = Buffer.alloc(5);
                frame[0] = 0x08;
                frame.writeUInt32BE(header.length, 1);
                socket.send(Buffer.concat([frame, header]));
            });

            await page.goto(phi.url);
            await expect(
                page.locator(`.tab[data-pane-id="${one}"]`),
            ).toBeAttached();
            await expect(
                page.locator(`.tab[data-pane-id="${two}"]`),
            ).toBeAttached();
            await expect(page.locator('#reconnect-all-tabs-btn')).toHaveCount(
                0,
            );
            await expect(
                page.locator('#mobile-reconnect-all-tabs-btn'),
            ).toHaveCount(0);

            const reload = page.locator(`#${surface.reloadId}`);
            const bomb = page.locator(`#${surface.closeId}`);
            await expect(reload).toBeVisible();
            await expect(reload).toHaveAccessibleName(
                'Reload current terminal',
            );
            await expect(bomb).toBeVisible();
            await expect(bomb).toHaveAccessibleName('Close all sessions');
            const icon = bomb.locator('svg');
            await expect(icon).toBeVisible();
            await expect(icon).toHaveAttribute('fill', 'none');
            await expect(icon).toHaveAttribute('stroke', 'currentColor');
            expect(
                await bomb.evaluate((button) => getComputedStyle(button).color),
            ).toBe('rgb(239, 68, 68)');
            await bomb.hover();
            await bomb.evaluate(async (button) => {
                await Promise.all(
                    button
                        .getAnimations()
                        .map((animation) => animation.finished),
                );
            });
            expect(
                await bomb.evaluate((button) => getComputedStyle(button).color),
            ).toBe('rgb(239, 68, 68)');
            await page.mouse.move(0, 0);
            await page.screenshot({
                path: testInfo.outputPath(
                    `${surface.name}-terminal-toolbar.png`,
                ),
            });

            const sizedLatestConnection = (id: string) => {
                const count = connectionCounts.get(id)!;
                return count > 0 && resizedConnections.has(`${id}:${count}`);
            };
            await selectPane(page, one, 'Toolbar one', surface.isMobile);
            await expect.poll(() => sizedLatestConnection(one)).toBe(true);
            await selectPane(page, two, 'Toolbar two', surface.isMobile);
            await expect.poll(() => sizedLatestConnection(two)).toBe(true);
            await selectPane(page, one, 'Toolbar one', surface.isMobile);
            await expect.poll(() => sizedLatestConnection(one)).toBe(true);

            const beforeReload = {
                selected: connectionCounts.get(one)!,
                background: connectionCounts.get(two)!,
            };
            await reload.click();
            await expect
                .poll(() => connectionCounts.get(one))
                .toBe(beforeReload.selected + 1);
            await expect.poll(() => sizedLatestConnection(one)).toBe(true);
            expect(connectionCounts.get(two)).toBe(beforeReload.background);

            const oneTab = page.locator(`.tab[data-pane-id="${one}"]`);
            const twoTab = page.locator(`.tab[data-pane-id="${two}"]`);
            const dialogPromise = page.waitForEvent('dialog');
            const clickPromise = bomb.click();
            const dialog = await dialogPromise;
            expect(dialog.type()).toBe('confirm');
            expect(dialog.message()).toBe(
                'Are you sure you want to close all 2 active sessions?',
            );
            await dialog.dismiss();
            await clickPromise;

            await expect(oneTab).toHaveCount(1);
            await expect(twoTab).toHaveCount(1);
            await expect(oneTab).not.toHaveClass(/soft-closed/);
            await expect(twoTab).not.toHaveClass(/soft-closed/);
            await expect(page.locator('.tab.active')).toHaveAttribute(
                'data-pane-id',
                one,
            );
            expect(terminalDeletes).toEqual([]);
        });
    });
}
