import { expect, test, type Page } from '@playwright/test';
import { TerminalClientFrame } from '../web/proto/terminal.js';
import { TerminalServerFrame } from '../web/proto/terminal.js';
import type {
    MessageFns,
    TerminalClientFrame as TerminalClientMessage,
    TerminalServerFrame as TerminalServerMessage,
} from '../web-src/proto/terminal.js';
import { startPhi, type PhiServer } from './_server.js';
import { tabList } from './_tabs.js';

// The served bundle carries no types; bind its runtime codecs to the
// generated declarations so spec-side encoding is fully checked.
const ServerCodec: MessageFns<TerminalServerMessage> =
    TerminalServerFrame as unknown as MessageFns<TerminalServerMessage>;
const ClientCodec: MessageFns<TerminalClientMessage> =
    TerminalClientFrame as unknown as MessageFns<TerminalClientMessage>;

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
        const dropdown = tabList(page);
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
                    if (!Buffer.isBuffer(message)) return;
                    const payload = ClientCodec.decode(
                        new Uint8Array(message),
                    ).payload;
                    if (payload?.$case === 'resize')
                        resizedConnections.add(`${id}:${connection}`);
                });
                socket.send(
                    Buffer.from(
                        ServerCodec.encode(
                            ServerCodec.fromPartial({
                                payload: {
                                    $case: 'attach',
                                    value: {
                                        epoch: BigInt(7),
                                        oldest: BigInt(0),
                                        head: BigInt(0),
                                    },
                                },
                            }),
                        ).finish(),
                    ),
                );
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

            if (!surface.isMobile) {
                const actionIds = [
                    'tab-overflow-btn',
                    'sort-tabs-btn',
                    'refresh-console-btn',
                    'close-all-tabs-btn',
                ];
                const actions = page.locator('.terminal-tabs-bar > button');
                const reference = page.locator('#refresh-diff-btn');
                const diffStyle = await reference.evaluate((button) => {
                    const style = getComputedStyle(button);
                    const rect = button.getBoundingClientRect();
                    const icon = button
                        .querySelector('.icon')
                        ?.getBoundingClientRect();
                    return {
                        width: rect.width,
                        height: rect.height,
                        padding: style.padding,
                        margin: style.margin,
                        borderRadius: style.borderRadius,
                        borderWidth: style.borderWidth,
                        borderStyle: style.borderStyle,
                        backgroundColor: style.backgroundColor,
                        color: style.color,
                        boxShadow: style.boxShadow,
                        iconWidth: icon?.width,
                        iconHeight: icon?.height,
                    };
                });
                expect(diffStyle).toMatchObject({
                    width: 24,
                    height: 24,
                    borderWidth: '0px',
                    borderStyle: 'none',
                    backgroundColor: 'rgba(0, 0, 0, 0)',
                });
                const { color: normalColor, ...buttonGeometry } = diffStyle;
                for (const width of [1280, 900]) {
                    await page.setViewportSize({ width, height: 900 });
                    if (width === 900) {
                        await page.locator('#close-diff-btn').click();
                        await expect(page.locator('#diff-panel')).toHaveClass(
                            /hidden/,
                        );
                        await expect
                            .poll(() =>
                                page
                                    .locator('#diff-panel')
                                    .evaluate(
                                        (panel) =>
                                            panel.getBoundingClientRect().left,
                                    ),
                            )
                            .toBeGreaterThanOrEqual(width);
                    }
                    const metrics = await actions.evaluateAll((buttons) =>
                        buttons.map((button) => {
                            const rect = button.getBoundingClientRect();
                            const style = getComputedStyle(button);
                            const icon = button
                                .querySelector('.icon')
                                ?.getBoundingClientRect();
                            return {
                                id: button.id,
                                left: rect.left,
                                right: rect.right,
                                centerY: rect.top + rect.height / 2,
                                width: rect.width,
                                height: rect.height,
                                padding: style.padding,
                                margin: style.margin,
                                borderRadius: style.borderRadius,
                                borderWidth: style.borderWidth,
                                borderStyle: style.borderStyle,
                                backgroundColor: style.backgroundColor,
                                color: style.color,
                                boxShadow: style.boxShadow,
                                iconWidth: icon?.width,
                                iconHeight: icon?.height,
                            };
                        }),
                    );
                    expect(metrics.map((button) => button.id)).toEqual(
                        actionIds,
                    );
                    for (const [index, button] of metrics.entries()) {
                        expect(button).toMatchObject(buttonGeometry);
                        expect(button.centerY).toBe(metrics[0].centerY);
                        expect(button.left).toBeGreaterThanOrEqual(0);
                        expect(button.right).toBeLessThanOrEqual(width);
                        if (index > 0) {
                            expect(button.left - metrics[index - 1].right).toBe(
                                8,
                            );
                        }
                        expect(button.color).toBe(normalColor);
                    }
                    const stripRight = await page
                        .locator('#tabs-container')
                        .evaluate(
                            (strip) => strip.getBoundingClientRect().right,
                        );
                    expect(metrics[0].left - stripRight).toBe(8);
                    await page.screenshot({
                        path: testInfo.outputPath(
                            `desktop-toolbar-${width}.png`,
                        ),
                    });
                }
                await page.setViewportSize(surface.viewport);
                await page
                    .getByRole('button', { name: 'Diff', exact: true })
                    .click();
                await reference.hover();
                const diffHover = await reference.evaluate(async (button) => {
                    await Promise.all(
                        button
                            .getAnimations()
                            .map((animation) => animation.finished),
                    );
                    const style = getComputedStyle(button);
                    return {
                        backgroundColor: style.backgroundColor,
                        color: style.color,
                        boxShadow: style.boxShadow,
                        textShadow: style.textShadow,
                    };
                });
                for (const id of actionIds) {
                    const button = page.locator(`#${id}`);
                    await button.hover();
                    await expect(button).toHaveCSS(
                        'background-color',
                        diffHover.backgroundColor,
                    );
                    await expect(button).toHaveCSS('color', diffHover.color);
                    await expect(button).toHaveCSS('border-width', '0px');
                    await expect(button).toHaveCSS(
                        'box-shadow',
                        diffHover.boxShadow,
                    );
                    await expect(button).toHaveCSS(
                        'text-shadow',
                        diffHover.textShadow,
                    );
                }
                await page.mouse.move(0, 0);
                await page.locator(`#${actionIds[1]}`).focus();
                await page.keyboard.press('Shift+Tab');
                for (const [index, id] of actionIds.entries()) {
                    const button = page.locator(`#${id}`);
                    await expect(button).toBeFocused();
                    await expect(button).toHaveCSS('outline-style', 'solid');
                    await expect(button).toHaveCSS('outline-width', '2px');
                    await expect(button).toHaveCSS('box-shadow', 'none');
                    if (index < actionIds.length - 1) {
                        await page.keyboard.press('Tab');
                    }
                }
            }

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
            await expect(bomb).toHaveCSS(
                'color',
                await reload.evaluate(
                    (button) => getComputedStyle(button).color,
                ),
            );
            await reload.hover();
            const reloadHover = await reload.evaluate(async (button) => {
                await Promise.all(
                    button
                        .getAnimations()
                        .map((animation) => animation.finished),
                );
                const style = getComputedStyle(button);
                return {
                    color: style.color,
                    backgroundColor: style.backgroundColor,
                    boxShadow: style.boxShadow,
                };
            });
            await bomb.hover();
            await expect(bomb).toHaveCSS('color', reloadHover.color);
            await expect(bomb).toHaveCSS(
                'background-color',
                reloadHover.backgroundColor,
            );
            await expect(bomb).toHaveCSS('box-shadow', reloadHover.boxShadow);
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
