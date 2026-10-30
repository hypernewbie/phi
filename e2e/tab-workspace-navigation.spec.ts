import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    expect,
    test,
    type Locator,
    type Page,
    type Request,
    type TestInfo,
} from '@playwright/test';
import { configToToml, startPhi, type PhiServer } from './_server.js';

const seedOrder = ['b1', 'a1', 'b2'];

async function startNavigationFixture(): Promise<PhiServer> {
    return startPhi({
        env: { PHI_SHUTDOWN_PTY_GRACE: '150ms', PHI_SHUTDOWN_GRACE: '1s' },
        setup(dir) {
            const beta = join(dir, 'Beta');
            const alpha = join(dir, 'alpha');
            mkdirSync(beta, { recursive: true });
            mkdirSync(alpha, { recursive: true });
            const betaRoot = realpathSync(beta);
            const alphaRoot = realpathSync(alpha);
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
                join(home, '.phi', 'config.toml'),
                configToToml({ workspaces: [betaRoot, alphaRoot] }),
            );
            writeFileSync(
                join(home, '.phi', 'tabs.json'),
                JSON.stringify([
                    {
                        id: 'b1',
                        coder: 'bash',
                        session_id: '',
                        cwd: betaRoot,
                        workspace: betaRoot,
                        title: 'Beta one',
                        pinned: true,
                    },
                    {
                        id: 'a1',
                        coder: 'bash',
                        session_id: '',
                        cwd: alphaRoot,
                        workspace: alphaRoot,
                        title: 'Alpha one',
                        pinned: true,
                    },
                    {
                        id: 'b2',
                        coder: 'bash',
                        session_id: '',
                        cwd: betaRoot,
                        workspace: betaRoot,
                        title: 'Beta two',
                        pinned: true,
                    },
                ]),
            );
        },
    });
}

async function seedBrowserOrder(page: Page) {
    await page.addInitScript((order) => {
        if (localStorage.getItem('phi_tab_order') === null) {
            localStorage.setItem('phi_tab_order', JSON.stringify(order));
            localStorage.setItem('phi_active_pane', 'b2');
        }
    }, seedOrder);
}

async function waitForFixtureTabs(page: Page, url: string) {
    await waitForTabCount(page, 3);
    await expect
        .poll(async () => {
            const response = await fetch(
                `${url}/api/terminals/b1/recording?from=0&through=4096`,
            );
            return response.ok ? response.text() : '';
        })
        .toContain('bash fixture ready');
}

async function waitForTabCount(page: Page, count: number) {
    await expect(page.locator('#tabs-container .tab')).toHaveCount(count);
}

async function expectNavigatorRowGeometry(
    row: Locator,
    {
        closing = false,
        wrapped = false,
    }: { closing?: boolean; wrapped?: boolean } = {},
) {
    const geometry = await row.evaluate(async (element) => {
        const dropdown = element.closest('.tab-overflow-dropdown');
        if (!dropdown) throw new Error('Navigator row is outside its dropdown');
        await Promise.all(
            dropdown.getAnimations().map((animation) => animation.finished),
        );
        const rect = (node: Element | null) => {
            if (!node)
                throw new Error('Navigator row is missing a label element');
            const { left, right, top, bottom, width, height } =
                node.getBoundingClientRect();
            return { left, right, top, bottom, width, height };
        };
        const countdown = element.querySelector(
            '.tab-overflow-closing-countdown',
        );
        return {
            image: rect(element.querySelector('.hostname-dropdown-favicon')),
            title: rect(element.querySelector('.hostname-dropdown-title')),
            countdown: countdown ? rect(countdown) : null,
        };
    });
    expect(geometry.image.width).toBe(14);
    expect(geometry.image.height).toBe(14);
    expect(geometry.image.right).toBeLessThanOrEqual(geometry.title.left);
    expect(
        Math.abs(geometry.image.top - geometry.title.top),
    ).toBeLessThanOrEqual(1);
    if (wrapped) expect(geometry.title.height).toBeGreaterThan(20);
    if (closing) {
        expect(geometry.countdown).not.toBeNull();
        if (!geometry.countdown)
            throw new Error('Closing row has no countdown');
        expect(geometry.countdown.left).toBeCloseTo(geometry.title.left, 0);
        expect(geometry.countdown.top).toBeGreaterThanOrEqual(
            geometry.title.bottom,
        );
    }
}

async function tabOrder(page: Page): Promise<string[]> {
    return page
        .locator('#tabs-container .tab')
        .evaluateAll((tabs) =>
            tabs.map((tab) => tab.getAttribute('data-pane-id') || ''),
        );
}

async function saveScreenshot(page: Page, testInfo: TestInfo, name: string) {
    const path = testInfo.outputPath(name);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(name, { path, contentType: 'image/png' });
    console.log(`Navigator screenshot: ${path}`);
}

test('workspace navigator sorts, discloses natively, preserves order, and navigates tabs', async ({
    page,
}, testInfo) => {
    test.setTimeout(120_000);
    const phi = await startNavigationFixture();
    try {
        await page.setViewportSize({ width: 1600, height: 1000 });
        await seedBrowserOrder(page);
        await page.goto(phi.url);
        await waitForFixtureTabs(page, phi.url);

        await expect.poll(() => tabOrder(page)).toEqual(seedOrder);
        await expect(page.locator('.tab.active')).toHaveAttribute(
            'data-pane-id',
            'b2',
        );
        const fittingStrip = await page
            .locator('#tabs-container')
            .evaluate((strip) => ({
                clientWidth: strip.clientWidth,
                scrollWidth: strip.scrollWidth,
            }));
        expect(fittingStrip.clientWidth).toBeGreaterThan(0);
        expect(fittingStrip.scrollWidth).toBeLessThanOrEqual(
            fittingStrip.clientWidth,
        );
        await expect(page.locator('#tab-overflow-btn')).toBeVisible();
        await expect(page.locator('#sort-tabs-btn')).toBeVisible();

        await page.locator('#sort-tabs-btn').click();
        await expect.poll(() => tabOrder(page)).toEqual(['a1', 'b1', 'b2']);
        await expect(page.locator('.tab.active')).toHaveAttribute(
            'data-pane-id',
            'b2',
        );
        await expect
            .poll(() =>
                page.evaluate(() =>
                    JSON.parse(localStorage.getItem('phi_tab_order') || '[]'),
                ),
            )
            .toEqual(['a1', 'b1', 'b2']);
        await page.reload();
        await waitForFixtureTabs(page, phi.url);
        await expect.poll(() => tabOrder(page)).toEqual(['a1', 'b1', 'b2']);
        await expect(page.locator('.tab.active')).toHaveAttribute(
            'data-pane-id',
            'b2',
        );
        await expect
            .poll(() =>
                page.evaluate(() =>
                    JSON.parse(localStorage.getItem('phi_tab_order') || '[]'),
                ),
            )
            .toEqual(['a1', 'b1', 'b2']);

        await page.locator('#tab-overflow-btn').click();
        const dropdown = page.locator('#tab-overflow-dropdown');
        await expect(dropdown).toBeVisible();
        await expect(dropdown).toHaveAttribute('role', 'group');
        await expect(dropdown).toHaveAttribute('aria-label', 'Open tabs');
        await expect(dropdown).toHaveAttribute('tabindex', '-1');
        const workspaces = dropdown.locator('details.tab-overflow-workspace');
        await expect(workspaces).toHaveCount(2);
        expect(
            await workspaces.evaluateAll((groups) =>
                groups.every((group) => (group as HTMLDetailsElement).open),
            ),
        ).toBe(true);
        await saveScreenshot(page, testInfo, 'workspace-navigator-open.png');

        const alphaWorkspace = workspaces.nth(0);
        const alphaSummary = alphaWorkspace.locator(':scope > summary');
        await alphaSummary.focus();
        await page.keyboard.press('Space');
        await expect
            .poll(() =>
                alphaWorkspace.evaluate(
                    (group) => (group as HTMLDetailsElement).open,
                ),
            )
            .toBe(false);
        await expect(
            alphaWorkspace.locator('.hostname-dropdown-row'),
        ).toBeHidden();
        expect(
            await workspaces
                .nth(1)
                .evaluate((group) => (group as HTMLDetailsElement).open),
        ).toBe(true);
        await alphaSummary.focus();
        await page.keyboard.press('Enter');
        await expect
            .poll(() =>
                alphaWorkspace.evaluate(
                    (group) => (group as HTMLDetailsElement).open,
                ),
            )
            .toBe(true);
        await expect(
            alphaWorkspace.locator('.hostname-dropdown-row'),
        ).toBeVisible();

        const focusKey = () =>
            page.evaluate(() => {
                const active = document.activeElement;
                if (!(active instanceof HTMLElement)) return '';
                return (
                    active.dataset.overflowFocusKey ||
                    active.id ||
                    active.tagName
                );
            });
        const selectedBeforeTab = await focusKey();
        await page.keyboard.press('Tab');
        expect(await focusKey()).not.toBe(selectedBeforeTab);
        await page.keyboard.press('Shift+Tab');
        expect(await focusKey()).toBe(selectedBeforeTab);

        await page.keyboard.press('Escape');
        await expect(dropdown).toBeHidden();
        await expect(page.locator('#tab-overflow-btn')).toBeFocused();
        await expect(page.locator('#tab-overflow-btn')).toHaveAttribute(
            'aria-expanded',
            'false',
        );

        await page.locator('#tab-overflow-btn').click();
        await expect(dropdown).toBeVisible();
        await expect
            .poll(() =>
                workspaces.evaluateAll((groups) =>
                    groups.every((group) => (group as HTMLDetailsElement).open),
                ),
            )
            .toBe(true);
        await alphaWorkspace.locator(':scope > summary').focus();
        await page.keyboard.press('Space');
        await expect
            .poll(() =>
                alphaWorkspace.evaluate(
                    (group) => (group as HTMLDetailsElement).open,
                ),
            )
            .toBe(false);
        await page.keyboard.press('Escape');
        await expect(dropdown).toBeHidden();
        await page.locator('#tab-overflow-btn').click();
        await expect(dropdown).toBeVisible();
        await expect
            .poll(() =>
                workspaces.evaluateAll((groups) =>
                    groups.every((group) => (group as HTMLDetailsElement).open),
                ),
            )
            .toBe(true);
        await page.mouse.click(800, 500);
        await expect(dropdown).toBeHidden();

        await page.locator('#tab-overflow-btn').click();
        const betaRow = dropdown.locator(
            '.hostname-dropdown-row[data-pane-id="b1"] .hostname-dropdown-select-btn',
        );
        await betaRow.click();
        await expect(dropdown).toBeHidden();
        await expect(page.locator('.tab.active')).toHaveAttribute(
            'data-pane-id',
            'b1',
        );
    } finally {
        await phi.stop();
    }
});

test('New Session refreshes the open navigator through the Bash creation path', async ({
    page,
}, testInfo) => {
    test.setTimeout(120_000);
    const phi = await startNavigationFixture();
    let releaseRequest!: () => void;
    let captureRequest!: (request: Request) => void;
    const requestCaptured = new Promise<Request>((resolve) => {
        captureRequest = resolve;
    });
    const requestReleased = new Promise<void>((resolve) => {
        releaseRequest = resolve;
    });
    let intercepted = false;
    try {
        await page.setViewportSize({ width: 1600, height: 1000 });
        await seedBrowserOrder(page);
        await page.goto(phi.url);
        await waitForFixtureTabs(page, phi.url);
        const betaRoot = realpathSync(join(phi.dir, 'Beta'));
        let selectionIntercepted = false;
        await page.route('**/api/terminals', async (route) => {
            const request = route.request();
            if (request.method() !== 'POST' || selectionIntercepted) {
                await route.continue();
                return;
            }
            selectionIntercepted = true;
            const body = request.postDataJSON() as { coder?: string };
            if (body.coder !== 'bash') {
                await route.fulfill({
                    status: 400,
                    contentType: 'text/plain',
                    body: 'Blocked an unexpected shell-selector request',
                });
                return;
            }
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ pane_id: 'b2', session_id: '' }),
            });
        });
        const selectorRequest = page.waitForRequest(
            (request) =>
                request.url().endsWith('/api/terminals') &&
                request.method() === 'POST',
        );
        const selectorResponse = page.waitForResponse(
            (response) =>
                response.url().endsWith('/api/terminals') &&
                response.request().method() === 'POST',
        );
        await page
            .locator('#coder-selector .coder-tab[data-coder="bash"]')
            .click();
        const quickLaunch = await selectorRequest;
        const quickLaunchBody = quickLaunch.postDataJSON() as {
            coder: string;
            cwd: string;
            workspace: string;
        };
        expect(quickLaunchBody).toMatchObject({
            coder: 'bash',
            cwd: betaRoot,
            workspace: betaRoot,
        });
        expect((await selectorResponse).status()).toBe(200);
        await page.unroute('**/api/terminals');
        await expect(page.locator('#tabs-container .tab')).toHaveCount(3);
        await expect(
            page.locator('#coder-selector .coder-tab[data-coder="bash"]'),
        ).toHaveClass(/active/);
        await page.route('**/api/terminals', async (route) => {
            const request = route.request();
            if (request.method() !== 'POST') {
                await route.continue();
                return;
            }
            captureRequest(request);
            const body = request.postDataJSON() as {
                coder?: string;
                cwd?: string;
                session_id?: string;
                workspace?: string;
            };
            const safeBetaRoot = realpathSync(join(phi.dir, 'Beta'));
            if (
                intercepted ||
                body.coder !== 'bash' ||
                body.cwd !== safeBetaRoot ||
                body.workspace !== safeBetaRoot ||
                body.session_id !== ''
            ) {
                await route.fulfill({
                    status: 400,
                    contentType: 'text/plain',
                    body: 'Blocked an unexpected terminal fixture request',
                });
                return;
            }
            intercepted = true;
            await requestReleased;
            await route.continue();
        });
        await page.locator('#new-session-btn').click();
        const captured = await requestCaptured;
        const body = captured.postDataJSON() as {
            coder: string;
            cwd: string;
            session_id: string;
            workspace: string;
        };
        expect(body).toMatchObject({
            coder: 'bash',
            cwd: betaRoot,
            session_id: '',
            workspace: betaRoot,
        });

        await page.locator('#tab-overflow-btn').click();
        const dropdown = page.locator('#tab-overflow-dropdown');
        await expect(dropdown).toBeVisible();
        releaseRequest();
        await expect(dropdown.locator('.hostname-dropdown-row')).toHaveCount(4);
        await expect(page.locator('#tab-overflow-btn')).toHaveAttribute(
            'aria-expanded',
            'true',
        );
        await expect(dropdown).toBeVisible();
        await saveScreenshot(
            page,
            testInfo,
            'workspace-navigator-after-new-session-live-refresh.png',
        );
        const paneIds = await dropdown
            .locator('.hostname-dropdown-row')
            .evaluateAll((rows) => rows.map((row) => row.dataset.paneId || ''));
        expect(paneIds).toHaveLength(4);
        expect(paneIds.every(Boolean)).toBe(true);
        const createdPaneIds = paneIds.filter(
            (paneId) => !['b1', 'a1', 'b2'].includes(paneId),
        );
        expect(createdPaneIds).toHaveLength(1);
        await expect(
            dropdown.locator(
                `.hostname-dropdown-row[data-pane-id="${createdPaneIds[0]}"]`,
            ),
        ).toHaveClass(/active/);
        await expect(page.locator('.tab.active')).toHaveAttribute(
            'data-pane-id',
            createdPaneIds[0],
        );
    } finally {
        releaseRequest?.();
        await page.unroute('**/api/terminals').catch(() => {});
        await phi.stop();
    }
});

test('sorting preserves the selected tab draft through reload', async ({
    page,
}) => {
    test.setTimeout(120_000);
    const phi = await startNavigationFixture();
    try {
        await page.setViewportSize({ width: 1600, height: 1000 });
        await seedBrowserOrder(page);
        await page.goto(phi.url);
        await waitForFixtureTabs(page, phi.url);
        await page.locator('.tab[data-pane-id="a1"]').click();
        await expect(page.locator('.tab.active')).toHaveAttribute(
            'data-pane-id',
            'a1',
        );
        await page.locator('#direct-mode-toggle').click();
        await expect(page.locator('#input-textarea')).toBeVisible();
        const draft = 'unsent workspace sorting draft\tkept exactly  ';
        await page.locator('#input-textarea').fill(draft);
        await expect
            .poll(() =>
                page.evaluate(
                    () =>
                        JSON.parse(
                            localStorage.getItem('phi_tab_draft_a1') || '{}',
                        ).text,
                ),
            )
            .toBe(draft);

        await page.locator('#sort-tabs-btn').click();
        await expect.poll(() => tabOrder(page)).toEqual(['a1', 'b1', 'b2']);
        await expect(page.locator('.tab.active')).toHaveAttribute(
            'data-pane-id',
            'a1',
        );
        await page.reload();
        await waitForFixtureTabs(page, phi.url);
        await expect.poll(() => tabOrder(page)).toEqual(['a1', 'b1', 'b2']);
        await expect(page.locator('.tab.active')).toHaveAttribute(
            'data-pane-id',
            'a1',
        );
        await page.locator('#direct-mode-toggle').click();
        await expect(page.locator('#input-textarea')).toBeVisible();
        await expect(page.locator('#input-textarea')).toHaveValue(draft);
    } finally {
        await phi.stop();
    }
});

test('long navigator scrolls at desktop widths and keeps compact navigation unchanged', async ({
    page,
    request,
}, testInfo) => {
    test.setTimeout(180_000);
    const phi = await startNavigationFixture();
    try {
        const alphaRoot = realpathSync(join(phi.dir, 'alpha'));
        const paneIds = ['b1', 'a1', 'b2'];
        for (let index = 3; index < 24; index += 1) {
            const worktree = join(
                phi.dir,
                `long-worktree-prefix-${String(index).padStart(2, '0')}-navigation-fixture`,
                'team',
                'work',
            );
            mkdirSync(worktree, { recursive: true });
            const response = await request.post(`${phi.url}/api/terminals`, {
                data: {
                    coder: 'bash',
                    cwd: worktree,
                    session_id: '',
                    title:
                        index === 3
                            ? `Long fixture session ${String(index).padStart(2, '0')} ${'workspace navigator wrapping '.repeat(5)}`
                            : `Long fixture session ${String(index).padStart(2, '0')}`,
                    workspace: alphaRoot,
                },
            });
            expect(response.ok()).toBe(true);
            const body = (await response.json()) as { pane_id: string };
            paneIds.push(body.pane_id);
        }

        await page.setViewportSize({ width: 1280, height: 900 });
        await seedBrowserOrder(page);
        await page.goto(phi.url);
        await waitForTabCount(page, 24);
        await expect
            .poll(async () => {
                const response = await request.get(
                    `${phi.url}/api/terminals/b1/recording?from=0&through=4096`,
                );
                return response.ok() ? response.text() : '';
            })
            .toContain('bash fixture ready');

        const trigger = page.locator('#tab-overflow-btn');
        const dropdown = page.locator('#tab-overflow-dropdown');
        for (const width of [1280, 900]) {
            await page.setViewportSize({ width, height: 900 });
            if (width === 900) {
                await page.locator('#close-diff-btn').click();
                await expect(page.locator('#diff-panel')).toHaveClass(/hidden/);
                await expect(page.locator('#diff-panel')).not.toHaveClass(
                    /mobile-open/,
                );
                await expect
                    .poll(() =>
                        page
                            .locator('#diff-panel')
                            .evaluate(
                                (panel) => panel.getBoundingClientRect().left,
                            ),
                    )
                    .toBeGreaterThanOrEqual(width);
            }
            const stripMetrics = await page
                .locator('#tabs-container')
                .evaluate((strip) => {
                    if (!(strip instanceof HTMLElement)) {
                        throw new Error('Tab strip is not an HTML element');
                    }
                    strip.scrollLeft = strip.scrollWidth;
                    const lastTab = strip.querySelector('.tab:last-child');
                    const firstAction =
                        document.getElementById('tab-overflow-btn');
                    if (!lastTab || !firstAction) {
                        throw new Error('Tab strip or first action is missing');
                    }
                    const style = getComputedStyle(strip);
                    return {
                        gap:
                            firstAction.getBoundingClientRect().left -
                            lastTab.getBoundingClientRect().right,
                        paddingRight: style.paddingRight,
                        overflowY: style.overflowY,
                        scrollbarWidth: style.scrollbarWidth,
                        verticalGutter: strip.offsetWidth - strip.clientWidth,
                        horizontalGutter:
                            strip.offsetHeight - strip.clientHeight,
                        clientWidth: strip.clientWidth,
                        scrollWidth: strip.scrollWidth,
                    };
                });
            expect(stripMetrics.scrollWidth).toBeGreaterThan(
                stripMetrics.clientWidth,
            );
            expect(stripMetrics).toMatchObject({
                paddingRight: '0px',
                overflowY: 'hidden',
                scrollbarWidth: 'none',
                verticalGutter: 0,
                horizontalGutter: 0,
            });
            expect(stripMetrics.gap).toBeCloseTo(8, 0);
            await page.locator('.terminal-tabs-bar').screenshot({
                path: testInfo.outputPath(
                    `toolbar-overflow-spacing-${width}.png`,
                ),
            });
            if (await dropdown.isHidden()) await trigger.click();
            await expect(dropdown).toBeVisible();
            const metrics = await dropdown.evaluate((element) => {
                const rect = element.getBoundingClientRect();
                return {
                    clientHeight: element.clientHeight,
                    clientWidth: element.clientWidth,
                    height: rect.height,
                    left: rect.left,
                    right: rect.right,
                    scrollHeight: element.scrollHeight,
                    scrollWidth: element.scrollWidth,
                };
            });
            expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
            expect(metrics.scrollWidth).toBeLessThanOrEqual(
                metrics.clientWidth,
            );
            expect(metrics.left).toBeGreaterThanOrEqual(0);
            expect(metrics.right).toBeLessThanOrEqual(width);
            await expect(
                dropdown.locator('.hostname-dropdown-row'),
            ).toHaveCount(24);
            await expect(
                dropdown.locator('details.tab-overflow-worktree'),
            ).toHaveCount(23);
            await expectNavigatorRowGeometry(
                dropdown.locator('.hostname-dropdown-row[data-pane-id="a1"]'),
            );
            await expectNavigatorRowGeometry(
                dropdown.locator(
                    `.hostname-dropdown-row[data-pane-id="${paneIds[3]}"]`,
                ),
                { wrapped: true },
            );
            const fullPathLabel = dropdown
                .locator('details.tab-overflow-worktree > summary')
                .filter({
                    hasText: 'long-worktree-prefix-03-navigation-fixture',
                })
                .first();
            await expect(fullPathLabel).toBeVisible();
            await expect(fullPathLabel).toContainText('team');
            const layout = await dropdown.evaluate((element) => {
                const popup = element.getBoundingClientRect();
                const labels = Array.from(
                    element.querySelectorAll('.tab-overflow-summary-label'),
                );
                const actions = Array.from(
                    element.querySelectorAll('.hostname-dropdown-close-btn'),
                );
                return {
                    actionCount: actions.length,
                    labelsWithinPopup: labels.every((label) => {
                        const rect = label.getBoundingClientRect();
                        return (
                            rect.left >= popup.left && rect.right <= popup.right
                        );
                    }),
                };
            });
            expect(layout.actionCount).toBe(24);
            expect(layout.labelsWithinPopup).toBe(true);
            await saveScreenshot(
                page,
                testInfo,
                `workspace-long-list-${width}.png`,
            );
            const scrollHeight = metrics.scrollHeight;
            const box = await dropdown.boundingBox();
            if (!box) throw new Error('Open popup has no bounding box');
            await page.mouse.move(
                box.x + box.width / 2,
                box.y + box.height / 2,
            );
            await page.mouse.wheel(0, scrollHeight);
            await expect
                .poll(() => dropdown.evaluate((element) => element.scrollTop))
                .toBeGreaterThan(0);
            const lastRow = dropdown.locator('.hostname-dropdown-row').last();
            const lastPaneId = await lastRow.getAttribute('data-pane-id');
            if (!lastPaneId) throw new Error('Final row has no pane ID');
            await expect(lastRow).toBeVisible();
            const lastAction = lastRow.locator('.hostname-dropdown-close-btn');
            const actionBox = await lastAction.boundingBox();
            const popupBox = await dropdown.boundingBox();
            if (!actionBox || !popupBox) {
                throw new Error('Scrolled popup action has no bounding box');
            }
            expect(actionBox.x + actionBox.width).toBeLessThanOrEqual(
                popupBox.x + popupBox.width,
            );
            if (width === 1280) {
                await lastRow.locator('.hostname-dropdown-select-btn').click();
                await expect(dropdown).toBeHidden();
                await expect(page.locator('.tab.active')).toHaveAttribute(
                    'data-pane-id',
                    lastPaneId,
                );
            } else {
                await lastAction.click();
                const closingRow = dropdown.locator(
                    `.tab-overflow-closing-row[data-pane-id="${lastPaneId}"]`,
                );
                await expect(closingRow).toBeVisible();
                await expectNavigatorRowGeometry(closingRow, { closing: true });
                await closingRow
                    .locator('.hostname-dropdown-select-btn')
                    .click();
                await expect(dropdown).toBeHidden();
                await expect(page.locator('.tab.active')).toHaveAttribute(
                    'data-pane-id',
                    lastPaneId,
                );
                await waitForTabCount(page, 24);
            }
        }

        await page.setViewportSize({ width: 600, height: 900 });
        await expect(page.locator('.terminal-tabs-bar')).toBeHidden();
        await expect(trigger).toBeHidden();
        await expect(page.locator('#sort-tabs-btn')).toBeHidden();
    } finally {
        await phi.stop();
    }
});

test('wide touch navigator retains native keyboard behavior and desktop controls', async ({
    browser,
}, testInfo) => {
    test.setTimeout(120_000);
    const phi = await startNavigationFixture();
    const context = await browser.newContext({
        hasTouch: true,
        isMobile: false,
        viewport: { width: 1280, height: 900 },
    });
    try {
        const page = await context.newPage();
        await seedBrowserOrder(page);
        await page.goto(phi.url);
        await waitForFixtureTabs(page, phi.url);
        expect(
            await page.evaluate(() => matchMedia('(pointer: coarse)').matches),
        ).toBe(true);
        await expect(page.locator('.terminal-tabs-bar')).toBeVisible();
        await expect(page.locator('#tab-overflow-btn')).toBeVisible();
        await expect(page.locator('#sort-tabs-btn')).toBeVisible();
        await expect(page.locator('#input-textarea')).toHaveValue('');

        const trigger = page.locator('#tab-overflow-btn');
        const dropdown = page.locator('#tab-overflow-dropdown');
        await trigger.focus();
        await page.keyboard.press('Enter');
        await expect(dropdown).toBeVisible();
        const firstWorkspace = dropdown
            .locator('details.tab-overflow-workspace')
            .nth(0);
        const summary = firstWorkspace.locator(':scope > summary');
        await summary.focus();
        await page.keyboard.press('Enter');
        await expect
            .poll(() =>
                firstWorkspace.evaluate(
                    (group) => (group as HTMLDetailsElement).open,
                ),
            )
            .toBe(false);
        await expect(
            firstWorkspace.locator('.hostname-dropdown-row'),
        ).toBeHidden();
        await page.keyboard.press('Enter');
        await expect
            .poll(() =>
                firstWorkspace.evaluate(
                    (group) => (group as HTMLDetailsElement).open,
                ),
            )
            .toBe(true);
        await expect(
            firstWorkspace.locator('.hostname-dropdown-row'),
        ).toBeVisible();

        await page.keyboard.press('Shift+Tab');
        const sortButton = page.locator('#sort-tabs-btn');
        await expect(sortButton).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(trigger).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(sortButton).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(summary).toBeFocused();
        const worktreeSummary = firstWorkspace.locator(
            'details.tab-overflow-worktree > summary',
        );
        await page.keyboard.press('Tab');
        await expect(worktreeSummary).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(summary).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(sortButton).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(trigger).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(sortButton).toBeFocused();
        await saveScreenshot(
            page,
            testInfo,
            'workspace-navigator-wide-touch.png',
        );
        await page.keyboard.press('Enter');
        await expect.poll(() => tabOrder(page)).toEqual(['a1', 'b1', 'b2']);
        await expect(page.locator('.tab.active')).toHaveAttribute(
            'data-pane-id',
            'b2',
        );
        await expect(dropdown).toBeVisible();
        await expect(sortButton).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(dropdown).toBeHidden();
        await expect(trigger).toHaveAttribute('aria-expanded', 'false');
        await expect(trigger).toBeFocused();
    } finally {
        await context.close();
        await phi.stop();
    }
});
