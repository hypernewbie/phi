import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';
import {
    COMPACT_SESSION_ID,
    countStarts,
    expectNewToast,
    paneBridgeReload,
    paneRecording,
    recordPaneInput,
    recordReloadCalls,
    saveReloadEvidence,
    seedReloadFixture,
    stageReloadAttachment,
    startCompactStub,
    type CompactStub,
} from './_pi-reload.js';

async function watchDiagnostics(page: Page, serverOrigin: string) {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const localFailures: string[] = [];
    page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('response', (response) => {
        const url = new URL(response.url());
        const expectedReloadUnknown =
            url.pathname === '/api/pi-bridge/reload' &&
            response.status() === 504;
        if (
            url.origin === serverOrigin &&
            response.status() >= 400 &&
            !expectedReloadUnknown
        ) {
            localFailures.push(`${response.status()} ${response.url()}`);
        }
    });
    await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== serverOrigin) {
            await route.abort();
        } else if (url.pathname === '/api/update/status') {
            await route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({
                    current: 'dev',
                    update_available: false,
                }),
            });
        } else if (url.pathname === '/api/system/cpu') {
            await route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({ cpu: 0 }),
            });
        } else if (
            url.pathname === '/api/sessions' &&
            url.searchParams.get('coder') === 'opencode'
        ) {
            await route.fulfill({
                contentType: 'application/json',
                body: '[]',
            });
        } else {
            await route.continue();
        }
    });
    return { consoleErrors, pageErrors, localFailures };
}

test('offline reload waits for reconnect and restores without replay', async ({
    browser,
    page,
    context,
    request,
}, testInfo) => {
    test.setTimeout(300_000);
    let phi: PhiServer | undefined;
    let stub: CompactStub | undefined;
    let mobilePage: Page | undefined;
    try {
        stub = await startCompactStub();
        const stubPort = stub.port;
        let markerFile = '';
        let cwd = '';
        phi = await startPhi({
            config: { auto_reconnect: 'visible' },
            env: { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
            setup(dir) {
                const seed = seedReloadFixture(dir, stubPort);
                markerFile = seed.markerFile;
                cwd = seed.cwd;
            },
        });
        const serverUrl = phi.url;
        const spawned = await request.post(`${serverUrl}/api/terminals`, {
            data: {
                coder: 'pi',
                cwd,
                title: 'Pi reload reconnect',
                session_id: COMPACT_SESSION_ID,
            },
        });
        expect(spawned.ok()).toBe(true);
        const pane = ((await spawned.json()) as { pane_id: string }).pane_id;
        await expect
            .poll(() => paneBridgeReload(request, serverUrl, pane), {
                timeout: 60_000,
            })
            .toMatchObject({
                state: 'managed',
                connected: true,
                generation: '1',
                reload_idle: true,
            });
        await expect
            .poll(() => countStarts(markerFile), { timeout: 30_000 })
            .toBe(1);

        const origin = new URL(serverUrl).origin;
        const watch = await watchDiagnostics(page, origin);
        const reloads = recordReloadCalls(page);
        let paneConnections = 0;
        let firstPaneSocket: WebSocketRoute | undefined;
        await page.routeWebSocket(`**/ws/pane/${pane}?*`, (socket) => {
            paneConnections++;
            firstPaneSocket ??= socket;
            socket.connectToServer();
        });
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(serverUrl);
        await page.locator(`.tab[data-pane-id="${pane}"]`).click();
        await page.locator('#input-textarea').fill('RECONNECT DRAFT HELD');

        // Dropping the browser offline holds the press visibly and
        // sends nothing; the draft stays staged.
        await context.setOffline(true);
        await page.getByRole('button', { name: 'Cmds ▾' }).focus();
        await page.keyboard.press('Enter');
        const menu = page.locator('#quick-commands-dropup');
        await expect(menu).toBeVisible();
        await menu.getByRole('button', { name: '/reload' }).focus();
        await page.keyboard.press('Enter');
        await expect(menu).toBeHidden();
        await expect(
            page.locator('.toast', {
                hasText: 'Reload queued — waiting for connection',
            }),
        ).toBeVisible({ timeout: 15_000 });
        expect(reloads.calls).toHaveLength(0);
        expect(countStarts(markerFile)).toBe(1);
        await expect(page.locator('#input-textarea')).toHaveValue(
            'RECONNECT DRAFT HELD',
        );

        // Browser offline emulation does not close an established WebSocket.
        // Drop the proxied pane socket after restoring network so this test
        // exercises the real attach/state resync that releases the queue.
        await context.setOffline(false);
        if (!firstPaneSocket) throw new Error('pane socket was not routed');
        await firstPaneSocket.close({
            code: 1001,
            reason: 'exercise reconnect queue',
        });
        await expect
            .poll(() => paneConnections, { timeout: 30_000 })
            .toBeGreaterThan(1);
        await expect
            .poll(() => reloads.calls.length, { timeout: 60_000 })
            .toBe(1);
        expect(reloads.calls[0]).toMatchObject({
            status: 202,
            body: { outcome: 'dispatched' },
        });
        await expect(
            page.locator('.toast', {
                hasText: 'Reload requested — check Pi',
            }),
        ).toBeVisible({ timeout: 60_000 });
        await expect
            .poll(() => paneBridgeReload(request, serverUrl, pane), {
                timeout: 30_000,
            })
            .toMatchObject({ generation: '2', connected: true });
        await expect
            .poll(() => paneRecording(request, serverUrl, pane), {
                timeout: 30_000,
            })
            .toContain('Reloaded keybindings');
        await expect
            .poll(() => countStarts(markerFile), { timeout: 30_000 })
            .toBe(2);
        expect(stub.count()).toBe(0);
        await expect(page.locator('#input-textarea')).toHaveValue(
            'RECONNECT DRAFT HELD',
        );

        // Reloading the browser restores uncertainty without replay:
        // nothing dispatches until an explicit new press.
        await page.reload();
        await expect(page.locator(`.tab[data-pane-id="${pane}"]`)).toBeVisible({
            timeout: 30_000,
        });
        await page.waitForTimeout(3000);
        expect(reloads.calls).toHaveLength(1);
        await page.locator(`.tab[data-pane-id="${pane}"]`).click();
        await page.getByRole('button', { name: 'Cmds ▾' }).focus();
        await page.keyboard.press('Enter');
        const menu2 = page.locator('#quick-commands-dropup');
        await expect(menu2).toBeVisible();
        await menu2.getByRole('button', { name: '/reload' }).focus();
        await page.keyboard.press('Enter');
        await expect(menu2).toBeHidden();
        // Either the restored marker reports its status with no new
        // call, or release evidence already retired it and the fresh
        // press dispatches; both are consistent, and neither replays
        // silently. Settle on what the browser actually did.
        await page.waitForTimeout(3000);
        if (reloads.calls.length === 1) {
            await expect(
                page.locator('.toast', {
                    hasText: 'Reload requested — check Pi',
                }),
            ).toBeVisible({ timeout: 15_000 });
            await expect
                .poll(() => paneBridgeReload(request, serverUrl, pane), {
                    timeout: 30_000,
                })
                .toMatchObject({ generation: '2' });
        } else {
            expect(reloads.calls).toHaveLength(2);
            expect(reloads.calls[1]).toMatchObject({
                status: 202,
                body: { outcome: 'dispatched' },
            });
            await expect(
                page.locator('.toast', {
                    hasText: 'Reload requested — check Pi',
                }),
            ).toBeVisible({ timeout: 60_000 });
            await expect
                .poll(() => paneBridgeReload(request, serverUrl, pane), {
                    timeout: 30_000,
                })
                .toMatchObject({ generation: '3' });
            await expect
                .poll(() => countStarts(markerFile), { timeout: 30_000 })
                .toBe(3);
        }
        expect(
            await page.evaluate(
                () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
        ).toBe(true);
        expect(watch.pageErrors).toEqual([]);
        expect(watch.localFailures).toEqual([]);
        expect(watch.consoleErrors).toEqual([]);

        // Repeat offline intent and reconnect in an actual touch context.
        const startsBeforeMobile = countStarts(markerFile);
        const providerRequestsBeforeMobile = stub.count();
        const mobileSpawned = await request.post(`${serverUrl}/api/terminals`, {
            data: {
                coder: 'pi',
                cwd,
                title: 'Pi reload mobile reconnect',
            },
        });
        expect(mobileSpawned.ok()).toBe(true);
        const mobilePane = ((await mobileSpawned.json()) as { pane_id: string })
            .pane_id;
        await expect
            .poll(() => paneBridgeReload(request, serverUrl, mobilePane), {
                timeout: 60_000,
            })
            .toMatchObject({
                state: 'managed',
                connected: true,
                reload_idle: true,
            });
        const mobileInitialBridge = await paneBridgeReload(
            request,
            serverUrl,
            mobilePane,
        );
        if (!mobileInitialBridge?.generation)
            throw new Error('mobile pane has no bridge generation');
        const nextMobileGeneration = String(
            BigInt(mobileInitialBridge.generation) + 1n,
        );
        await expect
            .poll(() => countStarts(markerFile), { timeout: 30_000 })
            .toBe(startsBeforeMobile + 1);

        mobilePage = await browser.newPage({
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
        });
        const mobileWatch = await watchDiagnostics(mobilePage, origin);
        const mobileReloads = recordReloadCalls(mobilePage);
        const mobileInput = recordPaneInput(mobilePage);
        let mobilePaneConnections = 0;
        let firstMobilePaneSocket: WebSocketRoute | undefined;
        await mobilePage.routeWebSocket(
            `**/ws/pane/${mobilePane}?*`,
            (socket) => {
                mobilePaneConnections++;
                firstMobilePaneSocket ??= socket;
                socket.connectToServer();
            },
        );
        await mobilePage.goto(serverUrl);
        await mobilePage.locator('#mobile-sidebar-toggle').tap();
        const mobileDrawer = mobilePage.locator('#drawer-tabs-body');
        await expect(mobileDrawer).toBeVisible();
        await mobileDrawer
            .locator(
                `.hostname-dropdown-row[data-pane-id="${mobilePane}"] .hostname-dropdown-select-btn`,
            )
            .tap();
        await expect(mobilePage.locator(`#term-${mobilePane}`)).toBeVisible({
            timeout: 30_000,
        });
        await mobilePage
            .locator('#input-textarea')
            .fill('MOBILE RECONNECT DRAFT');
        await stageReloadAttachment(mobilePage);
        await mobilePage.context().setOffline(true);
        await mobilePage.getByRole('button', { name: 'Cmds ▾' }).tap();
        const mobileMenu = mobilePage.locator('#quick-commands-dropup');
        await expect(mobileMenu).toContainText('Built-in Commands');
        await mobileMenu.getByRole('button', { name: '/reload' }).tap();
        await expect(
            mobilePage.locator('.toast', {
                hasText: 'Reload queued — waiting for connection',
            }),
        ).toBeVisible({ timeout: 15_000 });
        expect(mobileReloads.calls).toHaveLength(0);
        expect(countStarts(markerFile)).toBe(startsBeforeMobile + 1);
        await expect(mobilePage.locator('#input-textarea')).toHaveValue(
            'MOBILE RECONNECT DRAFT',
        );
        await expect(
            mobilePage.locator('#attachment-strip .attachment-chip'),
        ).toHaveCount(1);

        await mobilePage.context().setOffline(false);
        if (!firstMobilePaneSocket)
            throw new Error('mobile pane socket was not routed');
        await firstMobilePaneSocket.close({
            code: 1001,
            reason: 'exercise mobile reconnect queue',
        });
        await expect
            .poll(() => mobilePaneConnections, { timeout: 30_000 })
            .toBeGreaterThan(1);
        await expect
            .poll(() => mobileReloads.calls.length, { timeout: 60_000 })
            .toBe(1);
        const mobileReload = mobileReloads.calls[0];
        let mobileOutcome: 'dispatched' | 'unknown';
        if (mobileReload?.status === 202) {
            mobileOutcome = 'dispatched';
            expect(mobileReload).toMatchObject({
                status: 202,
                body: { outcome: 'dispatched' },
            });
            await expect(
                mobilePage.locator('.toast', {
                    hasText: 'Reload requested — check Pi',
                }),
            ).toBeVisible({ timeout: 60_000 });
            await expect
                .poll(() => paneBridgeReload(request, serverUrl, mobilePane), {
                    timeout: 30_000,
                })
                .toMatchObject({
                    generation: nextMobileGeneration,
                    connected: true,
                });
            await expect
                .poll(() => paneRecording(request, serverUrl, mobilePane), {
                    timeout: 30_000,
                })
                .toContain('Reloaded keybindings');
            await expect
                .poll(() => countStarts(markerFile), { timeout: 30_000 })
                .toBe(startsBeforeMobile + 2);
        } else {
            mobileOutcome = 'unknown';
            expect(mobileReload).toMatchObject({
                status: 504,
                body: { outcome: 'unknown' },
            });
            await expect(
                mobilePage.locator('.toast', {
                    hasText: 'Reload unconfirmed — check Pi. Not retried.',
                }),
            ).toBeVisible({ timeout: 15_000 });
            await mobilePage.reload();
            await expect(mobilePage.locator(`#term-${mobilePane}`)).toBeVisible(
                { timeout: 30_000 },
            );
            await expect(mobilePage.locator('#input-textarea')).toHaveValue(
                'MOBILE RECONNECT DRAFT',
            );
            await expect(
                mobilePage.locator('#attachment-strip .attachment-chip'),
            ).toHaveCount(1);
            await mobilePage.waitForTimeout(3000);
            expect(mobileReloads.calls).toHaveLength(1);
            const reloadedMobilePage = mobilePage;
            if (!reloadedMobilePage)
                throw new Error('mobile page was not restored');
            await expectNewToast(
                reloadedMobilePage,
                'Reload unconfirmed — check Pi. Not retried.',
                async () => {
                    await reloadedMobilePage
                        .getByRole('button', { name: 'Cmds ▾' })
                        .tap();
                    await reloadedMobilePage
                        .locator('#quick-commands-dropup')
                        .getByRole('button', { name: '/reload' })
                        .tap();
                },
            );
            await mobilePage.waitForTimeout(1000);
            expect(mobileReloads.calls).toHaveLength(1);
        }
        expect(stub.count()).toBe(providerRequestsBeforeMobile);
        expect(mobileInput.frames.join('\n')).not.toContain('/reload');
        await expect(mobilePage.locator('#input-textarea')).toHaveValue(
            'MOBILE RECONNECT DRAFT',
        );
        await expect(
            mobilePage.locator('#attachment-strip .attachment-chip'),
        ).toHaveCount(1);

        await mobilePage.reload();
        await expect(
            mobilePage.locator('#mobile-sidebar-toggle'),
        ).toBeVisible();
        await mobilePage.waitForTimeout(3000);
        expect(mobileReloads.calls).toHaveLength(1);
        if (mobileOutcome === 'dispatched') {
            expect(countStarts(markerFile)).toBe(startsBeforeMobile + 2);
        } else {
            expect(countStarts(markerFile)).toBeLessThanOrEqual(
                startsBeforeMobile + 2,
            );
        }
        expect(mobileWatch.pageErrors).toEqual([]);
        expect(mobileWatch.localFailures).toEqual([]);
        expect(mobileWatch.consoleErrors).toEqual([]);
        expect(
            await mobilePage.evaluate(
                () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
        ).toBe(true);
        await saveReloadEvidence(
            testInfo,
            'pi-reload-reconnect-summary.json',
            JSON.stringify(
                {
                    desktopViewport: '1440x900',
                    mobileViewport: '390x844',
                    mobileTouch: true,
                    desktopReloadResponses: reloads.calls.map(
                        ({ status }) => status,
                    ),
                    mobileOutcome,
                    mobileReloadResponses: mobileReloads.calls.map(
                        ({ status }) => status,
                    ),
                    mobilePageReloadDidNotReplay:
                        mobileReloads.calls.length === 1,
                    mobileDraftAndAttachmentRestored: true,
                    providerRequestsUnchanged: true,
                    nativeStartUpperBound:
                        countStarts(markerFile) - startsBeforeMobile,
                    unexpectedBrowserErrors: 0,
                    unexpectedLocalFailures: 0,
                },
                null,
                2,
            ),
            'application/json',
        );
    } finally {
        await mobilePage?.close();
        stub?.release();
        await phi?.stop();
        await stub?.close();
    }
});
