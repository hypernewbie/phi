import {
    expect,
    test,
    type APIRequestContext,
    type Page,
} from '@playwright/test';
import { startPhi } from './_server.js';
import { isCancelledWorktreeRead } from './_session-requests.js';
import {
    COMPACT_SESSION_ID,
    clickReloadDesktop,
    countStarts,
    expectNewToast,
    paneBridgeReload,
    paneRecording,
    recordPaneInput,
    recordReloadCalls,
    reloadReviewHold,
    saveReloadEvidence,
    seedReloadFixture,
    stageReloadAttachment,
    startCompactStub,
} from './_pi-reload.js';

const REVIEW = process.env.PHI_RELOAD_REVIEW === '1';

async function spawnPi(
    request: APIRequestContext,
    url: string,
    cwd: string,
    title: string,
    sessionId?: string,
): Promise<string> {
    const spawned = await request.post(`${url}/api/terminals`, {
        data: {
            coder: 'pi',
            cwd,
            title,
            ...(sessionId ? { session_id: sessionId } : {}),
        },
    });
    expect(spawned.ok()).toBe(true);
    return ((await spawned.json()) as { pane_id: string }).pane_id;
}

async function watchPage(page: Page, serverOrigin: string) {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const localFailures: string[] = [];
    const blockedExternal: string[] = [];

    page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('requestfailed', (request) => {
        if (isCancelledWorktreeRead(request, serverOrigin)) return;
        const url = new URL(request.url());
        if (url.origin === serverOrigin) {
            localFailures.push(
                `${request.method()} ${request.url()}: ${request.failure()?.errorText}`,
            );
        }
    });
    page.on('response', (response) => {
        const url = new URL(response.url());
        if (url.origin === serverOrigin && response.status() >= 400) {
            localFailures.push(`${response.status()} ${response.url()}`);
        }
    });
    await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== serverOrigin) {
            blockedExternal.push(url.href);
            await route.abort();
        } else if (url.pathname === '/api/update/status') {
            await route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({
                    current: 'dev',
                    update_available: false,
                }),
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
    return { consoleErrors, pageErrors, localFailures, blockedExternal };
}

async function openCmdsReload(page: Page) {
    await page.getByRole('button', { name: 'Cmds ▾' }).focus();
    await page.keyboard.press('Enter');
    const menu = page.locator('#quick-commands-dropup');
    await expect(menu).toBeVisible();
    return menu;
}

async function selectMobilePane(page: Page, paneId: string) {
    await expect(
        page.locator(`#tabs-container .tab[data-pane-id="${paneId}"]`),
    ).toHaveCount(1, { timeout: 30_000 });
    await page.locator('#mobile-sidebar-toggle').tap({ timeout: 10_000 });
    await expect(page.locator('#sidebar-panel')).toHaveClass(/drawer-open/, {
        timeout: 10_000,
    });
    const select = page.locator(
        `#drawer-tabs-body .hostname-dropdown-row[data-pane-id="${paneId}"] .hostname-dropdown-select-btn`,
    );
    await expect(select).toBeVisible({ timeout: 10_000 });
    await select.tap({ timeout: 10_000 });
    await expect(page.locator(`#term-${paneId}`)).toBeVisible({
        timeout: 30_000,
    });
}

test('native reload from Cmds on desktop and mobile touch', async ({
    browser,
    page,
    request,
}, testInfo) => {
    test.setTimeout(REVIEW ? 900_000 : 300_000);
    let mobilePage: Page | undefined;
    let stopPhi: (() => Promise<void>) | undefined;
    let releaseStub: (() => void) | undefined;
    let closeStub: (() => Promise<void>) | undefined;
    try {
        const stub = await startCompactStub();
        releaseStub = () => stub.release();
        closeStub = () => stub.close();
        let markerFile = '';
        let cwd = '';
        const phi = await startPhi({
            config: { auto_reconnect: 'off' },
            env: { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
            setup(dir) {
                const seed = seedReloadFixture(dir, stub.port);
                markerFile = seed.markerFile;
                cwd = seed.cwd;
            },
        });
        stopPhi = () => phi.stop();

        const livePane = await spawnPi(
            request,
            phi.url,
            cwd,
            'Pi reload',
            COMPACT_SESSION_ID,
        );
        const emptyPane = await spawnPi(
            request,
            phi.url,
            cwd,
            'Pi reload empty',
        );
        const mobilePane = await spawnPi(
            request,
            phi.url,
            cwd,
            'Pi reload mobile',
        );
        for (const pane of [livePane, emptyPane, mobilePane]) {
            await expect
                .poll(() => paneBridgeReload(request, phi.url, pane), {
                    timeout: 60_000,
                })
                .toMatchObject({
                    state: 'managed',
                    connected: true,
                    generation: '1',
                    capabilities: expect.arrayContaining(['pi.reload.v1']),
                    run_id: '0',
                    context_revision: '0',
                    reload_idle: true,
                    reload_pending: false,
                });
        }
        const noInject = await request.post(
            `${phi.url}/api/config/pi-bridge-no-inject`,
            { data: { enabled: true } },
        );
        expect(noInject.ok()).toBe(true);
        const absentPane = await spawnPi(
            request,
            phi.url,
            cwd,
            'Pi reload absent',
        );
        const reInject = await request.post(
            `${phi.url}/api/config/pi-bridge-no-inject`,
            { data: { enabled: false } },
        );
        expect(reInject.ok()).toBe(true);
        await expect
            .poll(() => paneBridgeReload(request, phi.url, absentPane), {
                timeout: 30_000,
            })
            .toMatchObject({ connected: false });
        expect(stub.count()).toBe(0);
        await expect
            .poll(() => countStarts(markerFile), { timeout: 30_000 })
            .toBe(4);

        if (REVIEW) {
            // Manual flows are the evidence in review mode; the
            // scripted assertions below stay for automated runs. A
            // paused run is not a test pass.
            await reloadReviewHold(
                phi.dir,
                phi.url,
                {
                    live: livePane,
                    empty: emptyPane,
                    mobile: mobilePane,
                    absent: absentPane,
                },
                stub,
                (message) => console.log(message),
            );
            for (const pane of [livePane, emptyPane, mobilePane]) {
                const bridge = await paneBridgeReload(request, phi.url, pane);
                expect(bridge?.state).toBe('managed');
            }
            return;
        }

        const origin = new URL(phi.url).origin;
        const desktopWatch = await watchPage(page, origin);
        const desktopInput = recordPaneInput(page);
        const desktopReloads = recordReloadCalls(page);
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(phi.url);
        await page.locator(`.tab[data-pane-id="${livePane}"]`).click();

        // /reload lives in Cmds, never in the preset strip.
        const rowLabels = await page
            .locator('#presets-container .preset-btn')
            .allTextContents();
        expect(rowLabels).not.toContain('/reload');
        await page.locator('#input-textarea').fill('RELOAD DRAFT HELD');
        await stageReloadAttachment(page);
        await page.emulateMedia({ colorScheme: 'dark' });
        const darkMenu = await openCmdsReload(page);
        await expect(
            darkMenu.getByRole('button', { name: '/reload' }),
        ).toBeVisible();
        await saveReloadEvidence(
            testInfo,
            'pi-reload-menu-desktop.png',
            await darkMenu.screenshot(),
            'image/png',
        );
        await page.keyboard.press('Escape');
        await expect(darkMenu).toBeHidden();
        await expect(
            page.getByRole('button', { name: 'Cmds ▾' }),
        ).toBeFocused();
        await page.emulateMedia({ colorScheme: 'light' });
        const menu = await openCmdsReload(page);
        await expect(menu.locator('.dropup-header').first()).toHaveText(
            'Built-in Commands',
        );
        const entry = menu.getByRole('button', { name: '/reload' });
        await expect(entry).toBeVisible();
        await expectNewToast(page, 'Reload requested — check Pi', () =>
            clickReloadDesktop(page),
        );
        await expect
            .poll(() => paneBridgeReload(request, phi.url, livePane), {
                timeout: 30_000,
            })
            .toMatchObject({ generation: '2', connected: true });
        await expect
            .poll(() => paneRecording(request, phi.url, livePane), {
                timeout: 30_000,
            })
            .toContain('Reloaded keybindings');
        await expect
            .poll(() => countStarts(markerFile), { timeout: 30_000 })
            .toBe(5);
        expect(stub.count()).toBe(0);
        await expect(page.locator('#input-textarea')).toHaveValue(
            'RELOAD DRAFT HELD',
        );
        await expect(
            page.locator('#attachment-strip .attachment-chip'),
        ).toHaveCount(1);
        await expect
            .poll(() => desktopReloads.calls.length, { timeout: 10_000 })
            .toBe(1);
        expect(desktopReloads.calls[0]).toMatchObject({
            status: 202,
            body: { outcome: 'dispatched' },
        });
        expect(typeof desktopReloads.calls[0]?.body).toBe('object');
        expect(desktopInput.frames.join('\n')).not.toContain('/reload');

        // A second explicit reload after release evidence.
        await expect
            .poll(() => paneBridgeReload(request, phi.url, livePane), {
                timeout: 30_000,
            })
            .toMatchObject({ reload_pending: false, reload_high_water: '1' });
        await openCmdsReload(page);
        await expectNewToast(page, 'Reload requested — check Pi', () =>
            clickReloadDesktop(page),
        );
        await expect
            .poll(() => paneBridgeReload(request, phi.url, livePane), {
                timeout: 30_000,
            })
            .toMatchObject({ generation: '3' });
        await expect
            .poll(() => countStarts(markerFile), { timeout: 30_000 })
            .toBe(6);
        expect(stub.count()).toBe(0);
        await expect
            .poll(() => desktopReloads.calls.length, { timeout: 10_000 })
            .toBe(2);
        expect(desktopReloads.calls[1]).toMatchObject({
            status: 202,
            body: { outcome: 'dispatched' },
        });
        expect(desktopInput.frames.join('\n')).not.toContain('/reload');

        // An empty session reloads through the same native path.
        await page.locator(`.tab[data-pane-id="${emptyPane}"]`).click();
        await openCmdsReload(page);
        await expectNewToast(page, 'Reload requested — check Pi', () =>
            clickReloadDesktop(page),
        );
        await expect
            .poll(() => paneBridgeReload(request, phi.url, emptyPane), {
                timeout: 30_000,
            })
            .toMatchObject({ generation: '2', connected: true });
        await expect
            .poll(() => paneRecording(request, phi.url, emptyPane), {
                timeout: 30_000,
            })
            .toContain('Reloaded keybindings');
        await expect
            .poll(() => countStarts(markerFile), { timeout: 30_000 })
            .toBe(7);
        expect(stub.count()).toBe(0);
        await expect
            .poll(() => desktopReloads.calls.length, { timeout: 10_000 })
            .toBe(3);

        // Without the bridge the same menu entry types the legacy PTY
        // command: the command frame goes out, no bridge call is made,
        // and the real Pi still executes its builtin reload.
        await page.locator(`.tab[data-pane-id="${absentPane}"]`).click();
        await openCmdsReload(page);
        await menu.getByRole('button', { name: '/reload' }).focus();
        await page.keyboard.press('Enter');
        await expect(menu).toBeHidden();
        await expect
            .poll(() => paneRecording(request, phi.url, absentPane), {
                timeout: 30_000,
            })
            .toContain('Reloaded keybindings');
        await expect
            .poll(() => countStarts(markerFile), { timeout: 30_000 })
            .toBe(8);
        expect(desktopReloads.calls).toHaveLength(3);
        expect(desktopInput.frames.join('\n')).toContain('/reload');

        // Mobile touch repeats the native idle path on a fresh pane.
        mobilePage = await browser.newPage({
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
        });
        const mobileWatch = await watchPage(mobilePage, origin);
        const mobileInput = recordPaneInput(mobilePage);
        const mobileReloads = recordReloadCalls(mobilePage);
        await mobilePage.goto(phi.url);
        // Compact view parks tabs in the drawer, not the tab bar.
        await selectMobilePane(mobilePage, mobilePane);
        await mobilePage.locator('#input-textarea').fill('MOBILE RELOAD DRAFT');
        await stageReloadAttachment(mobilePage);
        await mobilePage.emulateMedia({ colorScheme: 'dark' });
        await mobilePage.getByRole('button', { name: 'Cmds ▾' }).tap();
        const mobileMenu = mobilePage.locator('#quick-commands-dropup');
        await expect(mobileMenu).toContainText('Built-in Commands');
        await saveReloadEvidence(
            testInfo,
            'pi-reload-menu-mobile.png',
            await mobileMenu.screenshot(),
            'image/png',
        );
        await mobilePage.keyboard.press('Escape');
        await expect(mobileMenu).toBeHidden();
        await expect(
            mobilePage.getByRole('button', { name: 'Cmds ▾' }),
        ).toBeFocused();
        await mobilePage.emulateMedia({ colorScheme: 'light' });
        await mobilePage.getByRole('button', { name: 'Cmds ▾' }).tap();
        await expectNewToast(
            mobilePage,
            'Reload requested — check Pi',
            async () => {
                await mobileMenu.getByRole('button', { name: '/reload' }).tap();
                await expect(mobileMenu).toBeHidden();
            },
        );
        await expect
            .poll(() => paneBridgeReload(request, phi.url, mobilePane), {
                timeout: 30_000,
            })
            .toMatchObject({ generation: '2', connected: true });
        await expect
            .poll(() => paneRecording(request, phi.url, mobilePane), {
                timeout: 30_000,
            })
            .toContain('Reloaded keybindings');
        await expect
            .poll(() => countStarts(markerFile), { timeout: 30_000 })
            .toBe(9);
        expect(stub.count()).toBe(0);
        await expect(mobilePage.locator('#input-textarea')).toHaveValue(
            'MOBILE RELOAD DRAFT',
        );
        await expect(
            mobilePage.locator('#attachment-strip .attachment-chip'),
        ).toHaveCount(1);
        await expect
            .poll(() => mobileReloads.calls.length, { timeout: 10_000 })
            .toBe(1);
        expect(mobileReloads.calls[0]).toMatchObject({
            status: 202,
            body: { outcome: 'dispatched' },
        });
        expect(mobileInput.frames.join('\n')).not.toContain('/reload');
        // The menu path never focuses the staged input on touch.
        expect(
            await mobilePage.evaluate(() => document.activeElement?.id),
        ).not.toBe('input-textarea');

        // The same command remains a PTY fallback when injection is
        // disabled for this pane, including on touch.
        await selectMobilePane(mobilePage, absentPane);
        await mobilePage.getByRole('button', { name: 'Cmds ▾' }).tap();
        const fallbackMenu = mobilePage.locator('#quick-commands-dropup');
        await fallbackMenu.getByRole('button', { name: '/reload' }).tap();
        await expect(fallbackMenu).toBeHidden();
        await expect
            .poll(() => paneRecording(request, phi.url, absentPane), {
                timeout: 30_000,
            })
            .toContain('Reloaded keybindings');
        await expect
            .poll(() => countStarts(markerFile), { timeout: 30_000 })
            .toBe(10);
        expect(mobileReloads.calls).toHaveLength(1);
        expect(mobileInput.frames.join('\n')).toContain('/reload');

        for (const target of [page, mobilePage]) {
            expect(
                await target.evaluate(
                    () =>
                        document.documentElement.scrollWidth <=
                        window.innerWidth,
                ),
            ).toBe(true);
        }
        for (const diagnostics of [desktopWatch, mobileWatch]) {
            expect(diagnostics.pageErrors).toEqual([]);
            expect(diagnostics.localFailures).toEqual([]);
            expect(diagnostics.consoleErrors).toEqual([]);
            expect(diagnostics.blockedExternal).toEqual([]);
        }
        await saveReloadEvidence(
            testInfo,
            'pi-reload-menu-summary.json',
            JSON.stringify(
                {
                    desktopViewport: '1440x900',
                    mobileViewport: '390x844',
                    mobileTouch: true,
                    desktopNativeDispatches: desktopReloads.calls.length,
                    mobileNativeDispatches: mobileReloads.calls.length,
                    providerRequests: stub.count(),
                    piConfirmation: 'Reloaded keybindings',
                    bridgeAbsentPtyFallback: true,
                    draftAndAttachmentPreserved: true,
                    noPtyReloadForBridgeLivePanes: true,
                    escapeRestoredCmdsFocus: true,
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
        releaseStub?.();
        await stopPhi?.();
        await closeStub?.();
    }
});
