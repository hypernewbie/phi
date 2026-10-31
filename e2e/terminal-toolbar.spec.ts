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
const IPHONE =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

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

async function compactButtonHeight(page: Page): Promise<number> {
    return page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.cssText =
            'position:fixed;visibility:hidden;width:1px;height:var(--btn-compact-height)';
        document.body.appendChild(probe);
        const height = probe.getBoundingClientRect().height;
        probe.remove();
        return height;
    });
}

async function resolveTokenColor(
    page: Page,
    property: 'background-color' | 'color',
    token: string,
): Promise<string> {
    return page.evaluate(
        ({ property, token }) => {
            const probe = document.createElement('span');
            probe.style.cssText = 'position:fixed;visibility:hidden';
            probe.style.setProperty(property, `var(${token})`);
            document.body.appendChild(probe);
            const color = getComputedStyle(probe).getPropertyValue(property);
            probe.remove();
            return color;
        },
        { property, token },
    );
}

async function selectPane(
    page: Page,
    paneId: string,
    title: string,
    mobile: boolean,
) {
    if (mobile) {
        await page.locator('#hostname-display').tap();
        const dropdown = tabList(page);
        await expect(dropdown).toBeVisible();
        await dropdown
            .locator('.hostname-dropdown-select-btn')
            .filter({ has: page.getByText(title, { exact: true }) })
            .tap();
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
            userAgent: surface.isMobile ? IPHONE : undefined,
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
            await expect(page.locator('html')).toHaveAttribute(
                'data-appearance-profile',
                surface.isMobile ? 'mobile' : 'desktop',
            );
            if (surface.isMobile) {
                expect(
                    await page.evaluate(() => navigator.maxTouchPoints),
                ).toBeGreaterThan(0);
            }
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
                const diffRefresh = page.locator('#refresh-diff-btn');
                const diffSize = await diffRefresh.evaluate((button) => {
                    const rect = button.getBoundingClientRect();
                    return { width: rect.width, height: rect.height };
                });
                expect(diffSize).toEqual({ width: 24, height: 24 });
                const headerReference = page.locator(
                    '#header-notifications-btn',
                );
                const backgroundToken = await resolveTokenColor(
                    page,
                    'background-color',
                    '--bg-elevated',
                );
                const textToken = await resolveTokenColor(
                    page,
                    'color',
                    '--text-primary',
                );
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
                        const headerLayout = await page.evaluate(() => {
                            const actions = document.querySelector(
                                '.app-header .header-actions',
                            )!;
                            const visibleActions = Array.from(
                                actions.querySelectorAll('button.btn-compact'),
                            ).filter(
                                (button) =>
                                    button.getClientRects().length &&
                                    button.getBoundingClientRect().width > 0,
                            );
                            const actionRect = actions.getBoundingClientRect();
                            const firstRect =
                                visibleActions[0].getBoundingClientRect();
                            const firstFits =
                                firstRect.left >= actionRect.left &&
                                firstRect.right <= actionRect.right;
                            const initialScrollLeft = actions.scrollLeft;
                            const maxScroll =
                                actions.scrollWidth - actions.clientWidth;
                            actions.scrollLeft = maxScroll;
                            const lastRect = visibleActions
                                .at(-1)!
                                .getBoundingClientRect();
                            const reachedEnd =
                                actions.scrollLeft >= maxScroll - 1;
                            const lastFits =
                                lastRect.left >= actionRect.left &&
                                lastRect.right <= actionRect.right;
                            const otherControls = Array.from(
                                document.querySelectorAll(
                                    '.app-header button.btn-compact',
                                ),
                            )
                                .filter(
                                    (button) =>
                                        !actions.contains(button) &&
                                        button.getClientRects().length,
                                )
                                .map((button) => {
                                    const rect = button.getBoundingClientRect();
                                    return {
                                        left: rect.left,
                                        right: rect.right,
                                    };
                                });
                            actions.scrollLeft = initialScrollLeft;
                            return {
                                bodyScrollWidth: document.body.scrollWidth,
                                firstFits,
                                reachedEnd,
                                lastFits,
                                otherControls,
                            };
                        });
                        expect(
                            headerLayout.bodyScrollWidth,
                        ).toBeLessThanOrEqual(width);
                        expect(headerLayout.firstFits).toBe(true);
                        expect(headerLayout.reachedEnd).toBe(true);
                        expect(headerLayout.lastFits).toBe(true);
                        for (const control of headerLayout.otherControls) {
                            expect(control.left).toBeGreaterThanOrEqual(0);
                            expect(control.right).toBeLessThanOrEqual(width);
                        }
                    }
                    const tokenHeight = await compactButtonHeight(page);
                    expect(tokenHeight).toBe(32);
                    const headerMetrics = await headerReference.evaluate(
                        (button) => {
                            const rect = button.getBoundingClientRect();
                            const style = getComputedStyle(button);
                            return {
                                width: rect.width,
                                height: rect.height,
                                backgroundColor: style.backgroundColor,
                                color: style.color,
                            };
                        },
                    );
                    expect(
                        Math.abs(headerMetrics.height - tokenHeight),
                    ).toBeLessThanOrEqual(1);
                    expect(headerMetrics.backgroundColor).toBe(backgroundToken);
                    expect(headerMetrics.color).toBe(textToken);
                    const metrics = await actions.evaluateAll((buttons) =>
                        buttons.map((button) => {
                            const rect = button.getBoundingClientRect();
                            const style = getComputedStyle(button);
                            return {
                                id: button.id,
                                left: rect.left,
                                right: rect.right,
                                centerY: rect.top + rect.height / 2,
                                width: rect.width,
                                height: rect.height,
                                backgroundColor: style.backgroundColor,
                                color: style.color,
                            };
                        }),
                    );
                    expect(metrics.map((button) => button.id)).toEqual(
                        actionIds,
                    );
                    for (const [index, button] of metrics.entries()) {
                        expect(
                            Math.abs(button.height - tokenHeight),
                        ).toBeLessThanOrEqual(1);
                        expect(
                            Math.abs(button.width - headerMetrics.width),
                        ).toBeLessThanOrEqual(1);
                        expect(
                            Math.abs(button.height - headerMetrics.height),
                        ).toBeLessThanOrEqual(1);
                        expect(button.backgroundColor).toBe(backgroundToken);
                        expect(button.color).toBe(textToken);
                        expect(button.centerY).toBe(metrics[0].centerY);
                        expect(button.left).toBeGreaterThanOrEqual(0);
                        expect(button.right).toBeLessThanOrEqual(width);
                        if (index > 0) {
                            expect(button.left - metrics[index - 1].right).toBe(
                                8,
                            );
                        }
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
            const headerReference = page.locator('#header-notifications-btn');
            await expect(headerReference).toBeVisible();
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
            const expectedHeight = surface.isMobile ? 44 : 32;
            expect(await compactButtonHeight(page)).toBe(expectedHeight);
            const expectedBackground = await resolveTokenColor(
                page,
                'background-color',
                '--bg-elevated',
            );
            const expectedText = await resolveTokenColor(
                page,
                'color',
                '--text-primary',
            );
            for (const control of [headerReference, reload, bomb]) {
                const metrics = await control.evaluate((button) => {
                    const rect = button.getBoundingClientRect();
                    const style = getComputedStyle(button);
                    return {
                        width: rect.width,
                        height: rect.height,
                        backgroundColor: style.backgroundColor,
                        color: style.color,
                    };
                });
                expect(
                    Math.abs(metrics.height - expectedHeight),
                ).toBeLessThanOrEqual(1);
                expect(
                    Math.abs(metrics.width - expectedHeight),
                ).toBeLessThanOrEqual(1);
                expect(metrics.backgroundColor).toBe(expectedBackground);
                expect(metrics.color).toBe(expectedText);
            }
            if (surface.isMobile) {
                for (const { width, height } of [
                    { width: 390, height: 844 },
                    { width: 320, height: 568 },
                ]) {
                    await page.setViewportSize({ width, height });
                    const layout = await page.evaluate(() => {
                        const header = document.querySelector('.app-header')!;
                        const workspace =
                            document.querySelector('.workspace-area')!;
                        const actions = document.querySelector(
                            '.app-header .header-actions',
                        )!;
                        const actionButtons = Array.from(
                            actions.querySelectorAll('button.btn-compact'),
                        ).filter((button) => button.getClientRects().length);
                        const actionRect = actions.getBoundingClientRect();
                        const initialScroll = actions.scrollLeft;
                        const firstRect =
                            actionButtons[0].getBoundingClientRect();
                        actions.scrollLeft =
                            actions.scrollWidth - actions.clientWidth;
                        const lastRect = actionButtons
                            .at(-1)!
                            .getBoundingClientRect();
                        const lastFits =
                            lastRect.left >= actionRect.left &&
                            lastRect.right <= actionRect.right;
                        actions.scrollLeft = initialScroll;
                        const headerRect = header.getBoundingClientRect();
                        const workspaceRect = workspace.getBoundingClientRect();
                        const workspaceButtons = Array.from(
                            workspace.querySelectorAll('button'),
                        ).map((button) => button.getBoundingClientRect());
                        return {
                            profile:
                                document.documentElement.dataset
                                    .appearanceProfile,
                            pageWidth: document.documentElement.scrollWidth,
                            viewportWidth: window.innerWidth,
                            headerHeight: headerRect.height,
                            workspaceHeight: workspaceRect.height,
                            workspaceFits:
                                workspace.scrollWidth <=
                                    workspace.clientWidth + 1 &&
                                workspaceButtons.every(
                                    (rect) =>
                                        rect.left >= workspaceRect.left - 1 &&
                                        rect.right <= workspaceRect.right + 1 &&
                                        rect.top >= headerRect.top - 1 &&
                                        rect.bottom <= headerRect.bottom + 1,
                                ),
                            actionViewport: actions.clientWidth,
                            actionMinimum:
                                actionButtons[0].getBoundingClientRect().height,
                            firstFits:
                                firstRect.left >= actionRect.left &&
                                firstRect.right <= actionRect.right,
                            lastFits,
                        };
                    });
                    expect(layout.profile).toBe('mobile');
                    expect(layout.pageWidth).toBeLessThanOrEqual(width);
                    expect(layout.viewportWidth).toBe(width);
                    expect(layout.workspaceFits).toBe(true);
                    expect(
                        Math.abs(layout.workspaceHeight - layout.headerHeight),
                    ).toBeLessThanOrEqual(1);
                    expect(layout.actionViewport).toBeGreaterThanOrEqual(44);
                    expect(layout.actionMinimum).toBe(44);
                    expect(layout.firstFits).toBe(true);
                    expect(layout.lastFits).toBe(true);
                }
                await page.setViewportSize(surface.viewport);
            }
            await expect(bomb).toHaveCSS(
                'color',
                await reload.evaluate(
                    (button) => getComputedStyle(button).color,
                ),
            );
            const notifications = page.locator('#header-notifications-btn');
            if (surface.isMobile) await notifications.tap();
            else await notifications.click();
            const notificationDrawer = page.locator('#notifications-drawer');
            await expect(notificationDrawer).toBeVisible();
            await page.keyboard.press('Escape');
            await expect(notificationDrawer).toBeHidden();
            await expect(notifications).toBeFocused();
            if (!surface.isMobile) {
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
                    };
                });
                await bomb.hover();
                await expect(bomb).toHaveCSS('color', reloadHover.color);
                await expect(bomb).toHaveCSS(
                    'background-color',
                    reloadHover.backgroundColor,
                );
            }
            await page.mouse.move(0, 0);
            await page.screenshot({
                path: testInfo.outputPath(
                    `${surface.name}-terminal-toolbar.png`,
                ),
            });
            expect(
                await page.evaluate(
                    () =>
                        document.documentElement.scrollWidth <=
                        window.innerWidth,
                ),
            ).toBe(true);
            if (!surface.isMobile) {
                const configTrigger = page.locator(
                    '#header-config-pill .pill-label',
                );
                const configButtons = page.locator(
                    '#header-config-pill > button',
                );
                expect(
                    await configButtons.evaluateAll((buttons) =>
                        buttons.map(
                            (button) => button.getBoundingClientRect().height,
                        ),
                    ),
                ).toEqual([32, 32, 32]);
                for (const activation of ['click', 'Enter', 'Space']) {
                    if (activation === 'click') {
                        await configTrigger.click();
                    } else {
                        await configTrigger.focus();
                        await page.keyboard.press(activation);
                    }
                    await expect(
                        page.locator('.settings-overlay'),
                    ).toBeVisible();
                    await page.keyboard.press('Escape');
                    await expect(
                        page.locator('.settings-overlay'),
                    ).toBeHidden();
                    await expect(configTrigger).toBeFocused();
                    if (activation !== 'click') {
                        expect(
                            await configTrigger.evaluate((button) =>
                                button.matches(':focus-visible'),
                            ),
                        ).toBe(true);
                        expect(
                            await configTrigger.evaluate(
                                (button) => getComputedStyle(button).boxShadow,
                            ),
                        ).not.toBe('none');
                    }
                }
            }

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
            if (surface.isMobile) await reload.tap();
            else await reload.click();
            await expect
                .poll(() => connectionCounts.get(one))
                .toBe(beforeReload.selected + 1);
            await expect.poll(() => sizedLatestConnection(one)).toBe(true);
            expect(connectionCounts.get(two)).toBe(beforeReload.background);

            const oneTab = page.locator(`.tab[data-pane-id="${one}"]`);
            const twoTab = page.locator(`.tab[data-pane-id="${two}"]`);
            const dialogPromise = page.waitForEvent('dialog');
            const clickPromise = surface.isMobile ? bomb.tap() : bomb.click();
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
