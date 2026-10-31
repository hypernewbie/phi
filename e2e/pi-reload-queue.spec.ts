import {
    expect,
    test,
    type APIRequestContext,
    type Page,
} from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';
import {
    COMPACT_SESSION_ID,
    clickReloadDesktop,
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
        if (url.origin === serverOrigin && response.status() >= 400) {
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

async function spawnSeeded(
    request: APIRequestContext,
    url: string,
    cwd: string,
    title: string,
): Promise<string> {
    const spawned = await request.post(`${url}/api/terminals`, {
        data: { coder: 'pi', cwd, title, session_id: COMPACT_SESSION_ID },
    });
    expect(spawned.ok()).toBe(true);
    return ((await spawned.json()) as { pane_id: string }).pane_id;
}

async function holdTurn(
    request: APIRequestContext,
    url: string,
    pane: string,
    stub: CompactStub,
    text: string,
): Promise<void> {
    stub.holdNext();
    const input = await request.post(`${url}/api/terminals/${pane}/input`, {
        data: { text },
    });
    expect(input.status()).toBe(204);
    await expect
        .poll(() => paneBridgeReload(request, url, pane), { timeout: 20_000 })
        .toMatchObject({ running: true });
    // Running publishes before the provider request reaches the stub.
    await expect.poll(() => stub.heldCount(), { timeout: 20_000 }).toBe(1);
}

async function openReloadEntry(page: Page) {
    await page.getByRole('button', { name: 'Cmds ▾' }).focus();
    await page.keyboard.press('Enter');
    const menu = page.locator('#quick-commands-dropup');
    await expect(menu).toBeVisible();
    return menu;
}

test('queued reload waits for its turn, then cancels or flushes', async ({
    browser,
    page,
    request,
}, testInfo) => {
    test.setTimeout(300_000);
    let mobilePage: Page | undefined;
    let phi: PhiServer | undefined;
    let stub: CompactStub | undefined;
    try {
        stub = await startCompactStub();
        const stubPort = stub.port;
        let markerFile = '';
        let cwd = '';
        phi = await startPhi({
            config: { auto_reconnect: 'off' },
            env: { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
            setup(dir) {
                const seed = seedReloadFixture(dir, stubPort);
                markerFile = seed.markerFile;
                cwd = seed.cwd;
            },
        });
        const serverUrl = phi.url;
        const pane = await spawnSeeded(
            request,
            serverUrl,
            cwd,
            'Pi reload queue',
        );
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
        const desktopWatch = await watchDiagnostics(page, origin);
        const desktopInput = recordPaneInput(page);
        const desktopReloads = recordReloadCalls(page);
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(serverUrl);
        await page.locator(`.tab[data-pane-id="${pane}"]`).click();
        await page.locator('#input-textarea').fill('QUEUE DRAFT HELD');

        // First held turn: queue, then cancel before release.
        await holdTurn(request, serverUrl, pane, stub, 'QUEUE A RELOAD');
        await openReloadEntry(page);
        const menu = page.locator('#quick-commands-dropup');
        await expectNewToast(page, 'Reload queued — runs when Pi is idle', () =>
            clickReloadDesktop(page),
        );
        expect(countStarts(markerFile)).toBe(1);
        expect(desktopReloads.calls).toHaveLength(0);
        // The open row shows the held state with its marker.
        await openReloadEntry(page);
        const queuedBtn = menu.locator('button.pi-reload-btn');
        await expect(queuedBtn).toHaveAttribute(
            'title',
            'Reload queued — press to cancel',
        );
        await expect(queuedBtn).toHaveClass(/pi-reload-queued/);
        expect(
            await queuedBtn.evaluate(
                (el) => getComputedStyle(el, '::after').content,
            ),
        ).toContain('queued');
        await queuedBtn.focus();
        await page.keyboard.press('Enter');
        await expect(
            page.locator('.toast', { hasText: 'Queued reload cancelled' }),
        ).toBeVisible({ timeout: 15_000 });
        stub.release();
        // Settling after a cancel dispatches nothing.
        await expect
            .poll(() => paneBridgeReload(request, serverUrl, pane), {
                timeout: 30_000,
            })
            .toMatchObject({ running: false });
        await page.waitForTimeout(2000);
        expect(desktopReloads.calls).toHaveLength(0);
        expect(countStarts(markerFile)).toBe(1);
        expect(stub.count()).toBe(1);

        // Second held turn: queue, then release into one dispatch.
        await holdTurn(request, serverUrl, pane, stub, 'FLUSH A RELOAD');
        await openReloadEntry(page);
        await expectNewToast(page, 'Reload queued — runs when Pi is idle', () =>
            clickReloadDesktop(page),
        );
        stub.release();
        const queuedToast = page.locator('.toast', {
            hasText: 'Reload requested — check Pi',
        });
        await expect(queuedToast.first()).toBeVisible({ timeout: 60_000 });
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
        expect(stub.count()).toBe(2);
        await expect
            .poll(() => desktopReloads.calls.length, { timeout: 10_000 })
            .toBe(1);
        expect(desktopReloads.calls[0]).toMatchObject({
            status: 202,
            body: { outcome: 'dispatched' },
        });
        expect(desktopInput.frames.join('\n')).not.toContain('/reload');
        await expect(page.locator('#input-textarea')).toHaveValue(
            'QUEUE DRAFT HELD',
        );

        // Third held turn: newer input spends the wait into review.
        await holdTurn(request, serverUrl, pane, stub, 'REVIEW A RELOAD');
        await openReloadEntry(page);
        await expectNewToast(page, 'Reload queued — runs when Pi is idle', () =>
            clickReloadDesktop(page),
        );
        const followup = await request.post(
            `${serverUrl}/api/terminals/${pane}/input`,
            { data: { text: 'SPEND THE QUEUE' } },
        );
        expect(followup.status()).toBe(204);
        // The spend surfaces once the held turn moves again: the
        // queued followup shows up as pending input or a context
        // move, and the wait reviews instead of dispatching.
        stub.release();
        await expect(
            page.locator('.toast', {
                hasText: 'Reload not sent — review the current Pi session',
            }),
        ).toBeVisible({ timeout: 30_000 });
        await expect
            .poll(() => paneBridgeReload(request, serverUrl, pane), {
                timeout: 60_000,
            })
            .toMatchObject({ running: false });
        await page.waitForTimeout(2000);
        expect(desktopReloads.calls).toHaveLength(1);
        expect(countStarts(markerFile)).toBe(2);

        // Mobile touch repeats queue then cancel on a fresh pane.
        const mobileSpawned = await request.post(`${serverUrl}/api/terminals`, {
            data: { coder: 'pi', cwd, title: 'Pi reload queue mobile' },
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
                generation: '1',
                reload_idle: true,
                reload_pending: false,
            });
        await expect
            .poll(() => countStarts(markerFile), { timeout: 30_000 })
            .toBe(3);
        mobilePage = await browser.newPage({
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
        });
        const mobileWatch = await watchDiagnostics(mobilePage, origin);
        const mobileInput = recordPaneInput(mobilePage);
        const mobileReloads = recordReloadCalls(mobilePage);
        await mobilePage.goto(serverUrl);
        await mobilePage.locator('#mobile-sidebar-toggle').tap();
        const drawerBody = mobilePage.locator('#drawer-tabs-body');
        await expect(drawerBody).toBeVisible();
        await drawerBody
            .locator(
                `.hostname-dropdown-row[data-pane-id="${mobilePane}"] .hostname-dropdown-select-btn`,
            )
            .tap();
        await expect(mobilePage.locator(`#term-${mobilePane}`)).toBeVisible({
            timeout: 30_000,
        });
        await holdTurn(
            request,
            serverUrl,
            mobilePane,
            stub,
            'MOBILE QUEUE CANCEL',
        );
        await mobilePage.getByRole('button', { name: 'Cmds ▾' }).tap();
        const mobileMenu = mobilePage.locator('#quick-commands-dropup');
        await expect(mobileMenu).toContainText('Built-in Commands');
        await mobileMenu.getByRole('button', { name: '/reload' }).tap();
        await expect(
            mobilePage.locator('.toast', {
                hasText: 'Reload queued — runs when Pi is idle',
            }),
        ).toBeVisible({ timeout: 15_000 });
        await mobilePage.getByRole('button', { name: 'Cmds ▾' }).tap();
        await mobileMenu.getByRole('button', { name: '/reload' }).tap();
        await expect(
            mobilePage.locator('.toast', {
                hasText: 'Queued reload cancelled',
            }),
        ).toBeVisible({ timeout: 15_000 });
        stub.release();
        await expect
            .poll(() => paneBridgeReload(request, serverUrl, mobilePane), {
                timeout: 60_000,
            })
            .toMatchObject({ running: false });
        await mobilePage.waitForTimeout(2000);
        expect(desktopReloads.calls).toHaveLength(1);
        expect(mobileReloads.calls).toHaveLength(0);
        expect(countStarts(markerFile)).toBe(3);

        // A second touch turn queues Reload, then dispatches once after
        // settlement without changing the staged draft or attachment.
        await mobilePage
            .locator('#input-textarea')
            .fill('MOBILE QUEUE DRAFT HELD');
        await stageReloadAttachment(mobilePage);
        const providerRequestsBeforeMobileFlush = stub.count();
        await holdTurn(
            request,
            serverUrl,
            mobilePane,
            stub,
            'MOBILE QUEUE RELEASE',
        );
        const touchPage = mobilePage;
        if (!touchPage) throw new Error('mobile page was not created');
        await expectNewToast(
            touchPage,
            'Reload queued — runs when Pi is idle',
            async () => {
                await touchPage.getByRole('button', { name: 'Cmds ▾' }).tap();
                await mobileMenu.getByRole('button', { name: '/reload' }).tap();
            },
        );
        expect(mobileReloads.calls).toHaveLength(0);
        await mobilePage.getByRole('button', { name: 'Cmds ▾' }).tap();
        await expect(mobileMenu.locator('button.pi-reload-btn')).toHaveClass(
            /pi-reload-queued/,
        );
        await saveReloadEvidence(
            testInfo,
            'pi-reload-queue-mobile.png',
            await mobileMenu.screenshot(),
            'image/png',
        );
        await mobilePage.keyboard.press('Escape');
        stub.release();
        await expect(
            mobilePage.locator('.toast', {
                hasText: 'Reload requested — check Pi',
            }),
        ).toBeVisible({ timeout: 60_000 });
        await expect
            .poll(() => paneBridgeReload(request, serverUrl, mobilePane), {
                timeout: 30_000,
            })
            .toMatchObject({ generation: '2', connected: true });
        await expect
            .poll(() => paneRecording(request, serverUrl, mobilePane), {
                timeout: 30_000,
            })
            .toContain('Reloaded keybindings');
        await expect
            .poll(() => countStarts(markerFile), { timeout: 30_000 })
            .toBe(4);
        await expect
            .poll(() => mobileReloads.calls.length, { timeout: 10_000 })
            .toBe(1);
        expect(mobileReloads.calls[0]).toMatchObject({
            status: 202,
            body: { outcome: 'dispatched' },
        });
        expect(stub.count()).toBe(providerRequestsBeforeMobileFlush + 1);
        expect(mobileInput.frames.join('\n')).not.toContain('/reload');
        await expect(mobilePage.locator('#input-textarea')).toHaveValue(
            'MOBILE QUEUE DRAFT HELD',
        );
        await expect(
            mobilePage.locator('#attachment-strip .attachment-chip'),
        ).toHaveCount(1);

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
        }
        await saveReloadEvidence(
            testInfo,
            'pi-reload-queue-summary.json',
            JSON.stringify(
                {
                    desktopNativeDispatches: desktopReloads.calls.length,
                    mobileNativeDispatches: mobileReloads.calls.length,
                    desktopQueueCancelled: true,
                    desktopQueueFlushedOnce: true,
                    desktopContextChangeRequiredReview: true,
                    mobileQueueCancelled: true,
                    mobileQueueFlushedOnce: true,
                    mobileDraftAndAttachmentPreserved: true,
                    reloadAddedNoProviderRequest: true,
                    noPtyReloadForBridgeLivePanes: true,
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
