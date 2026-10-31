import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import {
    expect,
    test,
    type APIRequestContext,
    type BrowserContext,
    type Request as PlaywrightRequest,
} from '@playwright/test';
import { configToToml, startPhi, type PhiServer } from './_server.js';
import { syntheticPiSource } from './_pi-bridge.js';
import { toastErrorScript } from '../desktop/electron/src/injected.js';
import {
    isCancelledSessionListRead,
    isCancelledWorktreeRead,
} from './_session-requests.js';

interface BridgeView {
    state: string;
    running?: boolean;
    last_run?: string;
    last_outcome?: string;
}

async function paneBridge(
    request: APIRequestContext,
    url: string,
    paneId: string,
): Promise<BridgeView | undefined> {
    const response = await request.get(`${url}/api/terminals`);
    if (!response.ok()) return undefined;
    const panes = (await response.json()) as Array<{
        id: string;
        pi_bridge?: BridgeView;
    }>;
    return panes.find((pane) => pane.id === paneId)?.pi_bridge;
}

async function paneInput(
    request: APIRequestContext,
    url: string,
    paneId: string,
    text: string,
): Promise<void> {
    const response = await request.post(
        `${url}/api/terminals/${paneId}/input`,
        {
            data: { text },
        },
    );
    expect(response.ok()).toBe(true);
}

test('M1 notifications drawer caps compact popups and dismisses locally', async ({
    browser,
    request,
}) => {
    test.setTimeout(180_000);
    let phi: PhiServer | null = null;
    const contexts: BrowserContext[] = [];

    try {
        phi = await startPhi({
            config: {
                pushover_enabled: false,
                simplepush_enabled: false,
                webhook_enabled: false,
                opencode_legacy: true,
            },
        });

        await expect
            .poll(async () => {
                try {
                    return stripVTControlCharacters(
                        await readFile(phi!.logPath, 'utf8'),
                    );
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                        return '';
                    }
                    throw error;
                }
            })
            .toContain(`Server running on: ${phi.url}`);

        const coordinator = await request.post(
            `${phi.url}/api/config/sync-coordinator`,
            { data: { sync_coordinator: phi.url } },
        );
        expect(coordinator.ok()).toBe(true);
        const shellResponse = await request.post(`${phi.url}/api/terminals`, {
            data: { coder: 'bash', cwd: phi.dir, title: 'M1 shell' },
        });
        expect(shellResponse.ok()).toBe(true);
        const shell = (await shellResponse.json()) as { pane_id: string };
        // Keep terminal activity out of this notification UI test: an
        // unpinned shell writes both busy=true and idle=false pin updates.
        const pinResponse = await request.post(
            `${phi.url}/api/terminals/${shell.pane_id}/pin`,
            { data: { pinned: true } },
        );
        expect(pinResponse.ok()).toBe(true);
        const terminalsResponse = await request.get(`${phi.url}/api/terminals`);
        expect(terminalsResponse.ok()).toBe(true);
        const terminalViews = (await terminalsResponse.json()) as Array<{
            id: string;
            pinned: boolean;
        }>;
        expect(
            terminalViews.find((terminal) => terminal.id === shell.pane_id)
                ?.pinned,
        ).toBe(true);
        const allowedOrigin = new URL(phi.url).origin;

        const viewports = [
            {
                name: 'desktop',
                viewport: { width: 1440, height: 900 },
                isMobile: false,
                hasTouch: false,
                compact: false,
                coarse: false,
            },
            {
                name: 'touch phone',
                viewport: { width: 390, height: 844 },
                isMobile: true,
                hasTouch: true,
                compact: true,
                coarse: true,
            },
            {
                name: 'touch landscape',
                viewport: { width: 932, height: 430 },
                isMobile: true,
                hasTouch: true,
                compact: true,
                coarse: true,
            },
            {
                name: 'narrow fine pointer',
                viewport: { width: 600, height: 900 },
                isMobile: false,
                hasTouch: false,
                compact: true,
                coarse: false,
            },
        ] as const;

        for (const view of viewports) {
            const context = await browser.newContext({
                viewport: view.viewport,
                isMobile: view.isMobile,
                hasTouch: view.hasTouch,
            });
            contexts.push(context);
            await context.addInitScript(() => {
                const sent: unknown[] = [];
                Object.defineProperty(window, '__m1SentFrames', {
                    configurable: false,
                    value: sent,
                });
                const send = WebSocket.prototype.send;
                const wrappedSend = function (this: WebSocket, data: unknown) {
                    sent.push(data);
                    Reflect.apply(send, this, [data]);
                } as unknown as typeof WebSocket.prototype.send;
                WebSocket.prototype.send = wrappedSend;
            });
            const page = await context.newPage();
            const pageErrors: string[] = [];
            const consoleErrors: string[] = [];
            const failedRequests: string[] = [];
            const httpFailures: string[] = [];
            const externalRequests: string[] = [];
            page.on('pageerror', (error) => pageErrors.push(error.message));
            page.on('console', (message) => {
                if (message.type() === 'error')
                    consoleErrors.push(message.text());
            });
            page.on('requestfailed', (requestInfo) => {
                if (isCancelledWorktreeRead(requestInfo, allowedOrigin)) return;
                failedRequests.push(
                    `${requestInfo.method()} ${requestInfo.url()}: ${requestInfo.failure()?.errorText || 'failed'}`,
                );
            });
            page.on('response', (response) => {
                if (response.status() >= 400) {
                    httpFailures.push(`${response.status()} ${response.url()}`);
                }
            });
            page.on('request', (requestInfo) => {
                try {
                    if (new URL(requestInfo.url()).origin !== allowedOrigin) {
                        externalRequests.push(requestInfo.url());
                    }
                } catch {
                    externalRequests.push(requestInfo.url());
                }
            });

            await page.goto(phi.url, { waitUntil: 'domcontentloaded' });
            await expect
                .poll(() =>
                    page.locator('.tab.active').getAttribute('data-pane-id'),
                )
                .toBe(shell.pane_id);
            await expect(page.locator('.tab.active')).toHaveClass(/pinned/);
            await expect(page.locator('#input-textarea')).toHaveCount(1);
            await expect
                .poll(() =>
                    page.evaluate(
                        () =>
                            typeof (
                                window as Window & { __phiShowToast?: unknown }
                            ).__phiShowToast,
                    ),
                )
                .toBe('function');

            const media = await page.evaluate(() => ({
                compact: window.matchMedia(
                    '(max-width: 768px), (max-height: 500px) and (orientation: landscape) and (pointer: coarse)',
                ).matches,
                coarse: window.matchMedia('(pointer: coarse)').matches,
            }));
            expect(media.compact, view.name).toBe(view.compact);
            expect(media.coarse, view.name).toBe(view.coarse);

            await page.evaluate(
                (labels) => {
                    const notify = (
                        window as Window & {
                            __phiShowToast?: (
                                message: string,
                                options?: { duration?: number },
                            ) => HTMLElement;
                        }
                    ).__phiShowToast;
                    if (!notify)
                        throw new Error('Phi notification hook is missing');
                    for (const label of labels) notify(label, { duration: 0 });
                },
                ['N1', 'N2', 'N3', 'N4', 'N5'],
            );

            const visiblePopupMessages = page.locator(
                '#toast-container > .toast:visible .toast-message',
            );
            await expect(visiblePopupMessages).toHaveCount(
                view.compact ? 3 : 5,
            );
            expect(await visiblePopupMessages.allTextContents()).toEqual(
                view.compact
                    ? ['N3', 'N4', 'N5']
                    : ['N1', 'N2', 'N3', 'N4', 'N5'],
            );
            expect(
                await page.locator('#toast-container > .toast').count(),
            ).toBe(5);
            const popupBoxes = await page
                .locator('#toast-container > .toast:visible')
                .evaluateAll((elements) =>
                    elements.map((element) => {
                        const rect = element.getBoundingClientRect();
                        return {
                            left: rect.left,
                            right: rect.right,
                            width: rect.width,
                        };
                    }),
                );
            for (const box of popupBoxes) {
                expect(box.width).toBeGreaterThan(0);
                expect(box.left).toBeGreaterThanOrEqual(0);
                expect(box.right).toBeLessThanOrEqual(view.viewport.width + 1);
            }

            const trigger = page.getByRole('button', {
                name: 'Notifications',
                exact: true,
            });
            await trigger.click();
            const dialog = page.getByRole('dialog', { name: 'Notifications' });
            await expect(dialog).toBeVisible();
            await expect(page.locator('.notification-item')).toHaveCount(5);
            expect(
                await page
                    .locator('.notification-item-message')
                    .allTextContents(),
            ).toEqual(['N5', 'N4', 'N3', 'N2', 'N1']);
            await expect(page.locator('#notifications-close')).toBeFocused();

            if (view.name === 'desktop') {
                await page.keyboard.press('Shift+Tab');
                await expect(
                    page.locator('#notifications-dismiss-all'),
                ).toBeFocused();
                await page.keyboard.press('Shift+Tab');
                await expect(
                    page.locator('.notification-item-dismiss').last(),
                ).toBeFocused();
                await page.keyboard.press('Tab');
                await expect(
                    page.locator('#notifications-dismiss-all'),
                ).toBeFocused();
            }

            await page
                .locator('.notification-item')
                .filter({ hasText: 'N4' })
                .getByRole('button', { name: 'Dismiss' })
                .click();
            await expect(page.locator('.notification-item')).toHaveCount(4);
            await expect(
                page
                    .locator('#toast-container .toast-message')
                    .filter({ hasText: 'N4' }),
            ).toHaveCount(0);
            expect(
                await page
                    .locator('.notification-item-message')
                    .allTextContents(),
            ).toEqual(['N5', 'N3', 'N2', 'N1']);

            const focusedRowBeforeAction = await page.evaluate(
                () =>
                    document.activeElement
                        ?.closest('.notification-item')
                        ?.getAttribute('data-notification-id') || '',
            );
            await page.evaluate(() => {
                const notify = (
                    window as Window & {
                        __phiShowToast?: (
                            message: string,
                            options?: { duration?: number },
                        ) => HTMLElement;
                    }
                ).__phiShowToast;
                if (!notify)
                    throw new Error('Phi notification hook is missing');
                (
                    window as Window & { __m1ActionCalls?: number }
                ).__m1ActionCalls = 0;
                notify('Action must not run on dismissal', {
                    duration: 0,
                    action: {
                        text: 'Run',
                        callback: () => {
                            const target = window as Window & {
                                __m1ActionCalls?: number;
                            };
                            target.__m1ActionCalls =
                                (target.__m1ActionCalls || 0) + 1;
                        },
                    },
                } as {
                    duration: number;
                    action: { text: string; callback: () => void };
                });
            });
            expect(
                await page.evaluate(
                    () =>
                        document.activeElement
                            ?.closest('.notification-item')
                            ?.getAttribute('data-notification-id') || '',
                ),
            ).toBe(focusedRowBeforeAction);
            await expect(page.locator('.notification-item')).toHaveCount(5);
            await page
                .locator('.notification-item')
                .filter({ hasText: 'Action must not run on dismissal' })
                .getByRole('button', { name: 'Dismiss' })
                .click();
            expect(
                await page.evaluate(
                    () =>
                        (window as Window & { __m1ActionCalls?: number })
                            .__m1ActionCalls,
                ),
            ).toBe(0);
            await expect(page.locator('.notification-item')).toHaveCount(4);

            const focusBeforeArrival = await page.evaluate(() => {
                const active = document.activeElement as HTMLElement | null;
                return {
                    className: active?.className || '',
                    notificationId:
                        active
                            ?.closest('.notification-item')
                            ?.getAttribute('data-notification-id') || '',
                };
            });
            await page.evaluate(() => {
                const notify = (
                    window as Window & {
                        __phiShowToast?: (
                            message: string,
                            options?: { duration?: number },
                        ) => HTMLElement;
                    }
                ).__phiShowToast;
                if (!notify)
                    throw new Error('Phi notification hook is missing');
                notify('Arrival while focused', { duration: 0 });
            });
            expect(
                await page.evaluate(() => {
                    const active = document.activeElement as HTMLElement | null;
                    return {
                        className: active?.className || '',
                        notificationId:
                            active
                                ?.closest('.notification-item')
                                ?.getAttribute('data-notification-id') || '',
                    };
                }),
            ).toEqual(focusBeforeArrival);
            await expect(page.locator('.notification-item')).toHaveCount(5);
            expect(
                await page.evaluate(
                    () =>
                        document.documentElement.scrollWidth <=
                        window.innerWidth,
                ),
            ).toBe(true);

            if (view.name === 'desktop') {
                await page.keyboard.press('Escape');
                await expect(dialog).toBeHidden();
                await expect(trigger).toBeFocused();
                await trigger.click();
                await expect(dialog).toBeVisible();
                await page.locator('#notifications-overlay').click({
                    position: { x: 4, y: 200 },
                });
                await expect(dialog).toBeHidden();
                await trigger.click();
                await expect(dialog).toBeVisible();
                await page.locator('#notifications-close').click();
                await expect(dialog).toBeHidden();
                await expect(trigger).toBeFocused();

                const pushButton = page.getByRole('button', {
                    name: 'Push Notifications (Pushover)',
                });
                await pushButton.click();
                await expect(page.locator('#pushover-modal')).not.toHaveClass(
                    /hidden/,
                );
                await page.locator('#pushover-modal-close').click();
            }

            if (view.name === 'touch phone') {
                const input = page.locator('#input-textarea');
                await input.evaluate((element) => {
                    (element as HTMLTextAreaElement).value = 'keep this staged';
                });
                const framesBefore = await page.evaluate(
                    () =>
                        (
                            window as unknown as Window & {
                                __m1SentFrames: unknown[];
                            }
                        ).__m1SentFrames.length,
                );
                await page.keyboard.press('Control+Shift+X');
                expect(await input.inputValue()).toBe('keep this staged');
                expect(
                    await page.evaluate(
                        () =>
                            (
                                window as unknown as Window & {
                                    __m1SentFrames: unknown[];
                                }
                            ).__m1SentFrames.length,
                    ),
                ).toBe(framesBefore);

                const diffWasHidden = await page
                    .locator('#diff-panel')
                    .evaluate((element) =>
                        element.classList.contains('hidden'),
                    );
                await page.evaluate(() => {
                    const target = document.querySelector(
                        '#notifications-drawer',
                    );
                    if (!target)
                        throw new Error('Notification drawer is missing');
                    const startX = window.innerWidth - 8;
                    const start = new Touch({
                        identifier: 1,
                        target,
                        clientX: startX,
                        clientY: 160,
                    });
                    const end = new Touch({
                        identifier: 1,
                        target,
                        clientX: startX - 140,
                        clientY: 160,
                    });
                    target.dispatchEvent(
                        new TouchEvent('touchstart', {
                            bubbles: true,
                            touches: [start],
                            changedTouches: [start],
                        }),
                    );
                    target.dispatchEvent(
                        new TouchEvent('touchend', {
                            bubbles: true,
                            touches: [],
                            changedTouches: [end],
                        }),
                    );
                });
                expect(
                    await page
                        .locator('#diff-panel')
                        .evaluate((element) =>
                            element.classList.contains('hidden'),
                        ),
                ).toBe(diffWasHidden);
                await page.locator('#notifications-close').tap();
                await expect(dialog).toBeHidden();
                await expect(trigger).toBeFocused();
            }

            if (view.name === 'touch phone') {
                await page.evaluate(() => {
                    const notify = (
                        window as Window & {
                            __phiShowToast?: (
                                message: string,
                                options?: { duration?: number },
                            ) => HTMLElement;
                        }
                    ).__phiShowToast;
                    if (!notify)
                        throw new Error('Phi notification hook is missing');
                    notify('x'.repeat(500), { duration: 0 });
                });
                await trigger.click();
                await expect(
                    page.locator('.notification-item-message').first(),
                ).toContainText('x'.repeat(500));
                expect(
                    await page.evaluate(
                        () =>
                            document.documentElement.scrollWidth <=
                            window.innerWidth,
                    ),
                ).toBe(true);
            }

            if (await dialog.isHidden()) await trigger.click();
            await expect(dialog).toBeVisible();
            await expect(
                page.locator('#notifications-dismiss-all'),
            ).toBeEnabled();
            await page.locator('#notifications-dismiss-all').click();
            await expect(page.locator('.notification-item')).toHaveCount(0);
            await expect(page.locator('.notifications-empty')).toHaveText(
                'No notifications yet.',
            );
            await expect(
                page.locator('#notifications-dismiss-all'),
            ).toBeDisabled();
            const dismissAllMetrics = await page
                .locator('#notifications-dismiss-all')
                .evaluate((button) => {
                    const rect = button.getBoundingClientRect();
                    const range = document.createRange();
                    range.selectNodeContents(button);
                    return {
                        width: rect.width,
                        textWidth: range.getBoundingClientRect().width,
                        dialogWidth: button
                            .closest('.notifications-drawer')
                            ?.getBoundingClientRect().width,
                        background: getComputedStyle(button).backgroundColor,
                        border: getComputedStyle(button).borderStyle,
                        className: button.className,
                        disabled: (button as HTMLButtonElement).disabled,
                    };
                });
            expect(
                dismissAllMetrics.width - dismissAllMetrics.textWidth,
            ).toBeGreaterThanOrEqual(24);
            expect(
                dismissAllMetrics.width - dismissAllMetrics.textWidth,
            ).toBeLessThan(40);
            expect(dismissAllMetrics.width).toBeLessThan(
                (dismissAllMetrics.dialogWidth || 0) / 2,
            );
            expect(dismissAllMetrics.background).not.toBe('rgba(0, 0, 0, 0)');
            expect(dismissAllMetrics.border).toBe('solid');
            expect(dismissAllMetrics.className).toContain('btn-primary');
            expect(dismissAllMetrics.disabled).toBe(true);
            await expect(page.locator('#toast-container > .toast')).toHaveCount(
                0,
            );

            await page.evaluate(() => {
                const notify = (
                    window as Window & {
                        __phiShowToast?: (
                            message: string,
                            options?: { duration?: number },
                        ) => HTMLElement;
                    }
                ).__phiShowToast;
                if (!notify)
                    throw new Error('Phi notification hook is missing');
                notify('After clear', { duration: 0 });
            });
            await expect(
                page.locator('#toast-container .toast-message'),
            ).toHaveText('After clear');
            await expect(
                page.locator('#toast-container > .toast:visible'),
            ).toHaveCount(1);

            expect(pageErrors, `${view.name} page errors`).toEqual([]);
            // startPhi builds a source binary, which has no release-only updateChecker.
            // Allow only its exact /api/update/status 503; all other failures fail here.
            await expect
                .poll(() => httpFailures.slice())
                .toEqual([`503 ${phi.url}/api/update/status`]);
            expect(consoleErrors, `${view.name} console errors`).toEqual([
                'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
            ]);

            expect(failedRequests, `${view.name} failed requests`).toEqual([]);
            expect(externalRequests, `${view.name} external requests`).toEqual(
                [],
            );
            await context.close();
        }

        const coldContext = await browser.newContext({
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
        });
        contexts.push(coldContext);
        const coldPage = await coldContext.newPage();
        const coldPageErrors: string[] = [];
        const coldConsoleErrors: string[] = [];
        const coldFailedRequests: string[] = [];
        const coldHttpFailures: string[] = [];
        const coldExternalRequests: string[] = [];
        coldPage.on('pageerror', (error) => coldPageErrors.push(error.message));
        coldPage.on('console', (message) => {
            if (message.type() === 'error')
                coldConsoleErrors.push(message.text());
        });
        coldPage.on('requestfailed', (requestInfo) => {
            if (
                isCancelledWorktreeRead(requestInfo, allowedOrigin) ||
                isCancelledSessionListRead(requestInfo, allowedOrigin)
            )
                return;
            coldFailedRequests.push(
                `${requestInfo.method()} ${requestInfo.url()}: ${requestInfo.failure()?.errorText || 'failed'}`,
            );
        });
        coldPage.on('response', (response) => {
            if (response.status() >= 400) {
                coldHttpFailures.push(`${response.status()} ${response.url()}`);
            }
        });
        coldPage.on('request', (requestInfo) => {
            try {
                if (new URL(requestInfo.url()).origin !== allowedOrigin) {
                    coldExternalRequests.push(requestInfo.url());
                }
            } catch {
                coldExternalRequests.push(requestInfo.url());
            }
        });
        const versionSignals: { started?: () => void; release?: () => void } =
            {};
        const versionStarted = new Promise<void>((resolve) => {
            versionSignals.started = resolve;
        });
        const versionGate = new Promise<void>((resolve) => {
            versionSignals.release = resolve;
        });
        await coldPage.route('**/api/version', async (route) => {
            versionSignals.started?.();
            await versionGate;
            await route.continue();
        });
        try {
            await coldPage.goto(phi.url, { waitUntil: 'domcontentloaded' });
            await versionStarted;
            await expect
                .poll(() =>
                    coldPage.evaluate(
                        () =>
                            typeof (
                                window as Window & { __phiShowToast?: unknown }
                            ).__phiShowToast,
                    ),
                )
                .toBe('function');
            await coldPage
                .getByRole('button', {
                    name: 'Notifications',
                    exact: true,
                })
                .click();
            const coldDialog = coldPage.getByRole('dialog', {
                name: 'Notifications',
            });
            await expect(coldDialog).toBeVisible();
            await coldPage.evaluate(() => {
                const notify = (
                    window as Window & {
                        __phiShowToast?: (
                            message: string,
                            options?: { duration?: number },
                        ) => HTMLElement;
                    }
                ).__phiShowToast;
                if (!notify)
                    throw new Error('Phi notification hook is missing');
                notify('Local while version waits', { duration: 0 });
            });
            await expect(
                coldPage.locator('.notification-item-message'),
            ).toHaveText('Local while version waits');
            await coldPage.locator('#notifications-dismiss-all').click();
            await expect(coldPage.locator('.notification-item')).toHaveCount(0);
            versionSignals.release?.();
            versionSignals.release = undefined;
            await expect
                .poll(() => coldHttpFailures.slice())
                .toEqual([`503 ${phi.url}/api/update/status`]);
            expect(coldPageErrors).toEqual([]);
            expect(coldConsoleErrors).toEqual([
                'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
            ]);
            expect(coldFailedRequests).toEqual([]);
            expect(coldExternalRequests).toEqual([]);
        } finally {
            versionSignals.release?.();
            await coldContext.close();
        }
    } finally {
        for (const context of contexts) {
            if (context.pages().length > 0) await context.close();
        }
        await phi?.stop();
    }
});

test('M2 real bridge settlements group distinct ready panes and open the existing tab list', async ({
    browser,
    request,
}) => {
    test.setTimeout(180_000);
    const bundlePath = join(
        process.cwd(),
        'bonus',
        'pi-phi',
        'dist',
        'pi-phi-extension.cjs',
    );
    expect(existsSync(bundlePath)).toBe(true);

    const contexts: BrowserContext[] = [];
    const phi = await startPhi({
        config: {
            pushover_enabled: false,
            simplepush_enabled: false,
            webhook_enabled: false,
            opencode_legacy: true,
        },
        setup(dir) {
            const cwd = join(dir, 'work dir with spaces');
            mkdirSync(cwd, { recursive: true });
            const backends = join(dir, 'home', '.phi', 'backends');
            mkdirSync(backends, { recursive: true });
            const synthetic = join(dir, 'synthetic-pi.cjs');
            writeFileSync(synthetic, syntheticPiSource(bundlePath), {
                mode: 0o755,
            });
            writeFileSync(
                join(backends, 'pi.json'),
                JSON.stringify({ id: 'pi', command: synthetic }),
            );
        },
    });

    try {
        await expect
            .poll(async () => {
                try {
                    return stripVTControlCharacters(
                        await readFile(phi.logPath, 'utf8'),
                    );
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                        return '';
                    throw error;
                }
            })
            .toContain(`Server running on: ${phi.url}`);

        const cwd = join(phi.dir, 'work dir with spaces');
        const shellResponse = await request.post(`${phi.url}/api/terminals`, {
            data: { coder: 'bash', cwd, title: 'Foreground shell' },
        });
        expect(shellResponse.ok()).toBe(true);
        const shell = (await shellResponse.json()) as { pane_id: string };
        const piResponses = await Promise.all(
            ['E2E Pi A', 'E2E Pi B'].map((title) =>
                request.post(`${phi.url}/api/terminals`, {
                    data: { coder: 'pi', cwd, title },
                }),
            ),
        );
        for (const response of piResponses) expect(response.ok()).toBe(true);
        const [piA, piB] = (await Promise.all(
            piResponses.map((response) => response.json()),
        )) as Array<{ pane_id: string }>;
        const paneIds = [shell.pane_id, piA.pane_id, piB.pane_id];
        // Notification settlements do not exercise dynamic busy/idle pins.
        for (const paneId of paneIds) {
            const pinResponse = await request.post(
                `${phi.url}/api/terminals/${paneId}/pin`,
                { data: { pinned: true } },
            );
            expect(pinResponse.ok()).toBe(true);
        }
        const pinUrls = new Set(
            paneIds.map((paneId) => `${phi.url}/api/terminals/${paneId}/pin`),
        );

        const coordinator = await request.post(
            `${phi.url}/api/config/sync-coordinator`,
            { data: { sync_coordinator: phi.url } },
        );
        expect(coordinator.ok()).toBe(true);
        for (const pane of [piA, piB]) {
            await expect
                .poll(() => paneBridge(request, phi.url, pane.pane_id), {
                    timeout: 15_000,
                })
                .toMatchObject({ state: 'managed', running: false });
        }

        const layouts = [
            {
                name: 'desktop',
                viewport: { width: 1440, height: 900 },
                isMobile: false,
                hasTouch: false,
                compact: false,
                visible: [
                    'M2 prior 1',
                    'M2 prior 2',
                    'M2 prior 3',
                    '2 tabs ready',
                ],
            },
            {
                name: 'touch phone',
                viewport: { width: 390, height: 844 },
                isMobile: true,
                hasTouch: true,
                compact: true,
                visible: ['M2 prior 2', 'M2 prior 3', '2 tabs ready'],
            },
        ] as const;

        for (const layout of layouts) {
            const context = await browser.newContext({
                viewport: layout.viewport,
                isMobile: layout.isMobile,
                hasTouch: layout.hasTouch,
            });
            contexts.push(context);
            await context.addInitScript((paneId) => {
                localStorage.setItem('phi_active_pane', paneId);
            }, shell.pane_id);
            const page = await context.newPage();
            const pageErrors: string[] = [];
            const consoleErrors: string[] = [];
            const httpFailures: string[] = [];
            const failedRequests: string[] = [];
            const externalRequests: string[] = [];
            const pinStatuses = new Map<string, number[]>();
            page.on('pageerror', (error) => pageErrors.push(error.message));
            page.on('console', (message) => {
                if (message.type() === 'error')
                    consoleErrors.push(message.text());
            });
            page.on('requestfailed', (requestInfo) => {
                if (
                    isCancelledWorktreeRead(requestInfo, phi.url) ||
                    isCancelledSessionListRead(requestInfo, phi.url)
                )
                    return;
                failedRequests.push(
                    `${requestInfo.method()} ${requestInfo.url()}: ${requestInfo.failure()?.errorText || 'failed'}`,
                );
            });
            page.on('response', (response) => {
                if (
                    pinUrls.has(response.url()) &&
                    response.request().method() === 'POST'
                ) {
                    const statuses = pinStatuses.get(response.url()) || [];
                    statuses.push(response.status());
                    pinStatuses.set(response.url(), statuses);
                }
                if (response.status() >= 400) {
                    httpFailures.push(`${response.status()} ${response.url()}`);
                }
            });
            page.on('request', (requestInfo) => {
                const url = new URL(requestInfo.url());
                if (url.protocol === 'ws:' || url.protocol === 'wss:') {
                    if (url.host !== new URL(phi.url).host) {
                        externalRequests.push(requestInfo.url());
                    }
                    return;
                }
                if (url.origin !== new URL(phi.url).origin) {
                    externalRequests.push(requestInfo.url());
                }
            });

            await page.goto(phi.url, { waitUntil: 'domcontentloaded' });
            await expect
                .poll(() =>
                    page.locator('.tab.active').getAttribute('data-pane-id'),
                )
                .toBe(shell.pane_id);
            await expect(page.locator('.tab.pinned')).toHaveCount(
                paneIds.length,
            );
            await expect
                .poll(() =>
                    page.evaluate(
                        () =>
                            typeof (
                                window as Window & { __phiShowToast?: unknown }
                            ).__phiShowToast,
                    ),
                )
                .toBe('function');
            const media = await page.evaluate(() => ({
                compact: window.matchMedia(
                    '(max-width: 768px), (max-height: 500px) and (orientation: landscape) and (pointer: coarse)',
                ).matches,
                coarse: window.matchMedia('(pointer: coarse)').matches,
            }));
            expect(media.compact).toBe(layout.compact);
            expect(media.coarse).toBe(layout.hasTouch);

            await page.evaluate(() => {
                const notify = (
                    window as Window & {
                        __phiShowToast?: (
                            message: string,
                            options?: { duration?: number },
                        ) => HTMLElement;
                    }
                ).__phiShowToast;
                if (!notify)
                    throw new Error('Phi notification hook is missing');
                for (let i = 1; i <= 3; i += 1) {
                    notify(`M2 prior ${i}`, { duration: 0 });
                }
            });

            await paneInput(request, phi.url, piA.pane_id, 'start');
            await paneInput(request, phi.url, piA.pane_id, 'settle');
            await expect(
                page.locator('#toast-container .toast-message').filter({
                    hasText: 'Session "E2E Pi A" is waiting at a prompt.',
                }),
            ).toBeVisible({ timeout: 15_000 });
            await paneInput(request, phi.url, piB.pane_id, 'start');
            await paneInput(request, phi.url, piB.pane_id, 'settle');
            await expect(
                page.locator('#toast-container .toast-message').filter({
                    hasText: '2 tabs ready',
                }),
            ).toHaveCount(1, { timeout: 15_000 });

            // A repeat for A promotes the live group but does not add a member.
            await paneInput(request, phi.url, piA.pane_id, 'start');
            await paneInput(request, phi.url, piA.pane_id, 'settle');
            await expect(
                page.locator('#toast-container .toast-message').filter({
                    hasText: '2 tabs ready',
                }),
            ).toHaveCount(1, { timeout: 10_000 });
            expect(
                await page
                    .locator('#toast-container > .toast:visible .toast-message')
                    .allTextContents(),
            ).toEqual(layout.visible);
            expect(
                await page.locator('#toast-container > .toast').count(),
            ).toBe(4);
            await expect(
                page.locator(`.tab[data-pane-id="${piA.pane_id}"]`),
            ).toHaveClass(/has-attention/);
            await expect(
                page.locator(`.tab[data-pane-id="${piB.pane_id}"]`),
            ).toHaveClass(/has-attention/);

            await page
                .getByRole('button', { name: 'Notifications', exact: true })
                .click();
            const dialog = page.getByRole('dialog', { name: 'Notifications' });
            await expect(dialog).toBeVisible();
            await expect(page.locator('.notification-item')).toHaveCount(4);
            await expect(
                page
                    .locator('.notification-item-message')
                    .filter({ hasText: '2 tabs ready' }),
            ).toHaveCount(1);
            expect(
                await page
                    .locator('.notification-item-message')
                    .allTextContents(),
            ).toEqual([
                '2 tabs ready',
                'M2 prior 3',
                'M2 prior 2',
                'M2 prior 1',
            ]);

            await page
                .locator('.notification-item')
                .filter({ hasText: '2 tabs ready' })
                .getByRole('button', { name: 'View tabs' })
                .click();
            if (layout.compact) {
                await expect(page.locator('#sidebar-panel')).toHaveClass(
                    /drawer-open/,
                );
                await expect(page.locator('#sidebar-panel')).toHaveAttribute(
                    'data-panel-mode',
                    'tabs',
                );
            } else {
                await expect(
                    page.locator('#tab-overflow-dropdown'),
                ).not.toHaveClass(/hidden/);
            }
            const tabList = layout.compact
                ? page.locator('#drawer-tabs-body')
                : page.locator('#tab-overflow-dropdown');
            await tabList
                .locator(
                    `.hostname-dropdown-row[data-pane-id="${piA.pane_id}"] .hostname-dropdown-select-btn`,
                )
                .click();
            await expect
                .poll(() =>
                    page.locator('.tab.active').getAttribute('data-pane-id'),
                )
                .toBe(piA.pane_id);

            expect(pageErrors, `${layout.name} page errors`).toEqual([]);
            await expect
                .poll(() => httpFailures.slice())
                .toEqual([`503 ${phi.url}/api/update/status`]);
            expect(consoleErrors, `${layout.name} console errors`).toEqual([
                'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
            ]);
            const pinFailures = failedRequests.filter((failure) =>
                [...pinUrls].some(
                    (url) => failure === `POST ${url}: net::ERR_ABORTED`,
                ),
            );
            expect(pinFailures).toEqual(failedRequests);
            expect(pinFailures.length).toBeLessThanOrEqual(paneIds.length);
            for (const failure of pinFailures) {
                const url = failure.slice(
                    'POST '.length,
                    -': net::ERR_ABORTED'.length,
                );
                expect(pinStatuses.get(url)).toContain(200);
            }
            expect(
                externalRequests,
                `${layout.name} external requests`,
            ).toEqual([]);
            await context.close();
        }
    } finally {
        for (const context of contexts) {
            if (context.pages().length > 0) await context.close();
        }
        await phi.stop();
    }
});

test('M3a restores bounded notification previews and keeps local dismissal usable offline', async ({
    browser,
    request,
}) => {
    test.setTimeout(180_000);
    const phi = await startPhi({
        config: {
            pushover_enabled: false,
            simplepush_enabled: false,
            webhook_enabled: false,
            opencode_legacy: true,
        },
    });
    const contexts: BrowserContext[] = [];
    const allowedOrigin = new URL(phi.url).origin;

    try {
        await expect
            .poll(async () => {
                try {
                    return stripVTControlCharacters(
                        await readFile(phi.logPath, 'utf8'),
                    );
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                        return '';
                    throw error;
                }
            })
            .toContain(`Server running on: ${phi.url}`);
        const coordinator = await request.post(
            `${phi.url}/api/config/sync-coordinator`,
            { data: { sync_coordinator: phi.url } },
        );
        expect(coordinator.ok()).toBe(true);

        const layouts = [
            {
                name: 'desktop',
                viewport: { width: 1440, height: 900 },
                isMobile: false,
                hasTouch: false,
                compact: false,
                coarse: false,
            },
            {
                name: 'touch phone',
                viewport: { width: 390, height: 844 },
                isMobile: true,
                hasTouch: true,
                compact: true,
                coarse: true,
            },
        ] as const;

        for (const layout of layouts) {
            const context = await browser.newContext({
                viewport: layout.viewport,
                isMobile: layout.isMobile,
                hasTouch: layout.hasTouch,
            });
            contexts.push(context);
            const page = await context.newPage();
            const pageErrors: string[] = [];
            const consoleErrors: string[] = [];
            const offlineConsoleErrors: string[] = [];
            const httpFailures: string[] = [];
            const failedRequests: string[] = [];
            const offlineFailures: string[] = [];
            const externalRequests: string[] = [];
            let offline = false;
            page.on('pageerror', (error) => pageErrors.push(error.message));
            page.on('console', (message) => {
                if (message.type() !== 'error') return;
                (offline ? offlineConsoleErrors : consoleErrors).push(
                    message.text(),
                );
            });
            const initialized = page.waitForEvent('console', {
                predicate: (message) =>
                    message.text().includes('Phi initialized successfully'),
                timeout: 60_000,
            });
            page.on('requestfailed', (requestInfo) => {
                const failure = `${requestInfo.method()} ${requestInfo.url()}: ${requestInfo.failure()?.errorText || 'failed'}`;
                if (
                    offline &&
                    new URL(requestInfo.url()).origin === allowedOrigin &&
                    requestInfo.failure()?.errorText ===
                        'net::ERR_INTERNET_DISCONNECTED'
                ) {
                    offlineFailures.push(failure);
                } else {
                    failedRequests.push(failure);
                }
            });
            page.on('response', (response) => {
                if (response.status() >= 400) {
                    httpFailures.push(`${response.status()} ${response.url()}`);
                }
            });
            page.on('request', (requestInfo) => {
                try {
                    if (new URL(requestInfo.url()).origin !== allowedOrigin) {
                        externalRequests.push(requestInfo.url());
                    }
                } catch {
                    externalRequests.push(requestInfo.url());
                }
            });

            await page.goto(phi.url, { waitUntil: 'domcontentloaded' });
            await expect
                .poll(() =>
                    page.evaluate(
                        () =>
                            typeof (
                                window as Window & { __phiShowToast?: unknown }
                            ).__phiShowToast,
                    ),
                )
                .toBe('function');
            const media = await page.evaluate(() => ({
                compact: window.matchMedia(
                    '(max-width: 768px), (max-height: 500px) and (orientation: landscape) and (pointer: coarse)',
                ).matches,
                coarse: window.matchMedia('(pointer: coarse)').matches,
            }));
            expect(media.compact, layout.name).toBe(layout.compact);
            expect(media.coarse, layout.name).toBe(layout.coarse);

            await page.evaluate(() => {
                const notify = (
                    window as Window & {
                        __phiShowToast?: (
                            message: string,
                            options?: {
                                title?: string;
                                duration?: number;
                                action?: { text: string; callback: () => void };
                            },
                        ) => HTMLElement;
                    }
                ).__phiShowToast;
                if (!notify)
                    throw new Error('Phi notification hook is missing');
                notify('M3a action retained', {
                    title: 'Action entry',
                    duration: 0,
                    action: {
                        text: 'Run action',
                        callback: () => {
                            (
                                window as Window & {
                                    __m3aActionCalled?: boolean;
                                }
                            ).__m3aActionCalled = true;
                        },
                    },
                });
                notify('M'.repeat(2_100), {
                    title: 'T'.repeat(250),
                    duration: 0,
                });
                notify('M3a latest before offline', { duration: 0 });
            });
            await expect
                .poll(() =>
                    page.evaluate(() => {
                        const value = localStorage.getItem(
                            'phi_notifications_v1',
                        );
                        return value ? JSON.parse(value).entries?.length : 0;
                    }),
                )
                .toBe(3);
            const livePreview = await page.evaluate(() => ({
                titleLength: document.querySelector(
                    '#toast-container > .toast:nth-child(2) .toast-title',
                )?.textContent?.length,
                messageLength: document.querySelector(
                    '#toast-container > .toast:nth-child(2) .toast-message',
                )?.textContent?.length,
            }));
            expect(livePreview).toEqual({
                titleLength: 250,
                messageLength: 2_100,
            });

            await page.evaluate(() => {
                const original = Storage.prototype.setItem;
                (
                    window as Window & {
                        __m3aOriginalSetItem?: typeof Storage.prototype.setItem;
                    }
                ).__m3aOriginalSetItem = original;
                Storage.prototype.setItem = function (key, value) {
                    if (key === 'phi_notifications_v1') {
                        throw new DOMException(
                            'Quota exceeded',
                            'QuotaExceededError',
                        );
                    }
                    return original.call(this, key, value);
                };
                (
                    window as Window & {
                        __phiShowToast?: (
                            message: string,
                            options?: { duration?: number },
                        ) => HTMLElement;
                    }
                ).__phiShowToast?.('M3a memory-only after write failure', {
                    duration: 0,
                });
            });
            await expect(
                page.locator('#toast-container .toast-message').filter({
                    hasText: 'M3a memory-only after write failure',
                }),
            ).toBeVisible();
            expect(
                await page.evaluate(
                    () =>
                        JSON.parse(
                            localStorage.getItem('phi_notifications_v1') ||
                                '{"entries":[]}',
                        ).entries.length,
                ),
            ).toBe(3);
            await page.evaluate(() => {
                const win = window as Window & {
                    __m3aOriginalSetItem?: typeof Storage.prototype.setItem;
                    __phiShowToast?: (
                        message: string,
                        options?: { duration?: number },
                    ) => HTMLElement;
                };
                if (win.__m3aOriginalSetItem) {
                    Storage.prototype.setItem = win.__m3aOriginalSetItem;
                    delete win.__m3aOriginalSetItem;
                }
                win.__phiShowToast?.('M3a persisted after write recovery', {
                    duration: 0,
                });
            });
            await expect
                .poll(() =>
                    page.evaluate(
                        () =>
                            JSON.parse(
                                localStorage.getItem('phi_notifications_v1') ||
                                    '{"entries":[]}',
                            ).entries.length,
                    ),
                )
                .toBe(5);

            await initialized;
            offline = true;
            await context.setOffline(true);
            await page
                .getByRole('button', { name: 'Notifications', exact: true })
                .click();
            await expect(
                page.getByRole('dialog', { name: 'Notifications' }),
            ).toBeVisible();
            await expect(page.locator('.notification-item')).toHaveCount(5);
            await page
                .locator('.notification-item')
                .filter({
                    hasText: 'M3a persisted after write recovery',
                })
                .getByRole('button', { name: 'Dismiss' })
                .click();
            await expect(page.locator('.notification-item')).toHaveCount(4);
            await expect
                .poll(() =>
                    page.evaluate(
                        () =>
                            JSON.parse(
                                localStorage.getItem('phi_notifications_v1') ||
                                    '{"entries":[]}',
                            ).entries.length,
                    ),
                )
                .toBe(4);
            offline = false;
            await context.setOffline(false);

            const reinitialized = page.waitForEvent('console', {
                predicate: (message) =>
                    message.text().includes('Phi initialized successfully'),
                timeout: 60_000,
            });
            await page.reload({ waitUntil: 'domcontentloaded' });
            await expect
                .poll(() =>
                    page.evaluate(
                        () =>
                            typeof (
                                window as Window & { __phiShowToast?: unknown }
                            ).__phiShowToast,
                    ),
                )
                .toBe('function');
            await reinitialized;
            expect(
                await page.locator('#toast-container > .toast').count(),
            ).toBe(0);
            await page
                .getByRole('button', { name: 'Notifications', exact: true })
                .click();
            await expect(page.locator('.notification-item')).toHaveCount(4);
            await expect(page.locator('.notification-item-action')).toHaveCount(
                0,
            );
            await expect(
                page.locator('.notifications-disclosure'),
            ).toContainText('Last 100 notifications');
            await expect(
                page.locator('.notifications-disclosure'),
            ).toContainText('200 characters');
            await expect(
                page.locator('.notifications-disclosure'),
            ).toContainText('2,000 characters');
            const restored = await page
                .locator('.notification-item')
                .evaluateAll((rows) =>
                    rows.map((row) => ({
                        titleLength: row.querySelector(
                            '.notification-item-title',
                        )?.textContent?.length,
                        messageLength: row.querySelector(
                            '.notification-item-message',
                        )?.textContent?.length,
                    })),
                );
            expect(restored).toEqual([
                { titleLength: 6, messageLength: 35 },
                { titleLength: 6, messageLength: 25 },
                { titleLength: 200, messageLength: 2_000 },
                { titleLength: 12, messageLength: 19 },
            ]);
            expect(
                await page.evaluate(
                    () => document.documentElement.scrollWidth <= innerWidth,
                ),
            ).toBe(true);
            await expect
                .poll(() => httpFailures.slice())
                .toEqual([
                    `503 ${phi.url}/api/update/status`,
                    `503 ${phi.url}/api/update/status`,
                ]);
            expect(pageErrors, `${layout.name} page errors`).toEqual([]);
            expect(consoleErrors, `${layout.name} console errors`).toEqual([
                'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
                'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
            ]);
            expect(
                failedRequests,
                `${layout.name} unexplained failures`,
            ).toEqual([]);
            expect(
                externalRequests,
                `${layout.name} external requests`,
            ).toEqual([]);
            expect(
                offlineFailures.every((failure) =>
                    failure.endsWith(': net::ERR_INTERNET_DISCONNECTED'),
                ),
            ).toBe(true);
            expect(
                offlineConsoleErrors.every(
                    (message) =>
                        message ===
                        'Failed to load resource: net::ERR_INTERNET_DISCONNECTED',
                ),
            ).toBe(true);
            await context.close();
        }
    } finally {
        for (const context of contexts) {
            if (context.pages().length > 0) await context.close();
        }
        await phi.stop();
    }
});

test('M3b keeps notification actions local and blocked until an explicit route is confirmed', async ({
    browser,
    request,
}) => {
    test.setTimeout(180_000);
    let phiA: PhiServer | undefined;
    let phiB: PhiServer | undefined;
    const contexts: BrowserContext[] = [];

    async function startProfile(label: string) {
        let workspace = '';
        const server = await startPhi({
            config: {
                pushover_enabled: false,
                simplepush_enabled: false,
                webhook_enabled: false,
                opencode_legacy: true,
            },
            setup(dir) {
                workspace = join(dir, `workspace-${label}`);
                mkdirSync(workspace, { recursive: true });
                mkdirSync(join(dir, 'home', '.phi'), { recursive: true });
                writeFileSync(
                    join(dir, 'home', '.phi', 'config.toml'),
                    configToToml({
                        pushover_enabled: false,
                        simplepush_enabled: false,
                        webhook_enabled: false,
                        opencode_legacy: true,
                        workspaces: [workspace],
                    }),
                );
            },
        });
        return { server, workspace };
    }

    async function expectOwnedBanner(phi: PhiServer) {
        await expect
            .poll(async () => {
                try {
                    return stripVTControlCharacters(
                        await readFile(phi.logPath, 'utf8'),
                    );
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                        return '';
                    throw error;
                }
            })
            .toContain(`Server running on: ${phi.url}`);
    }

    try {
        const profileA = await startProfile('A');
        const profileB = await startProfile('B');
        phiA = profileA.server;
        phiB = profileB.server;
        await expectOwnedBanner(phiA);
        await expectOwnedBanner(phiB);
        for (const phi of [phiA, phiB]) {
            const coordinator = await request.post(
                `${phi.url}/api/config/sync-coordinator`,
                { data: { sync_coordinator: phi.url } },
            );
            expect(coordinator.ok()).toBe(true);
            const terminals = await request.get(`${phi.url}/api/terminals`);
            expect(terminals.ok()).toBe(true);
            expect(await terminals.json()).toEqual([]);
        }

        const layouts = [
            {
                name: 'desktop',
                viewport: { width: 1440, height: 900 },
                isMobile: false,
                hasTouch: false,
                compact: false,
                coarse: false,
            },
            {
                name: 'touch phone',
                viewport: { width: 390, height: 844 },
                isMobile: true,
                hasTouch: true,
                compact: true,
                coarse: true,
            },
        ] as const;

        for (const layout of layouts) {
            const profiles: Record<string, { url: string; workspace: string }> =
                {
                    A: { url: phiA.url, workspace: profileA.workspace },
                    B: { url: phiB.url, workspace: profileB.workspace },
                };
            type ActiveMode =
                | 'success'
                | '503'
                | 'abort-unchanged'
                | 'abort-changed';
            let transportActive = 'A';
            let nextMode: ActiveMode = 'success';
            const activeRequests: Array<{
                profileId: string;
                mode: ActiveMode;
                release: () => void;
                released: boolean;
            }> = [];
            const observedConfigs: Array<{
                profileId: string;
                workspaces: string[];
            }> = [];
            const unknownProfiles: string[] = [];
            const routeErrors: string[] = [];
            const pageErrors: string[] = [];
            const consoleErrors: string[] = [];
            const httpFailures: string[] = [];
            const failedRequests: string[] = [];
            const intentionalAbortFailures: string[] = [];
            const scopedSwitchAbortFailures: PlaywrightRequest[] = [];
            const externalRequests: string[] = [];
            const socketEvents: string[] = [];
            let abortFailureBudget = 0;
            let abortConsoleBudget = 0;
            const activeUrl = `${phiA.url}/__phi/active`;

            const context = await browser.newContext({
                viewport: layout.viewport,
                isMobile: layout.isMobile,
                hasTouch: layout.hasTouch,
            });
            contexts.push(context);
            const allowedOrigin = new URL(phiA.url).origin;
            await context.addInitScript((origin) => {
                if (window.location.origin !== origin) return;
                try {
                    localStorage.setItem('phi_diff_panel_open', 'false');
                } catch {}
                const canceled: string[] = [];
                Object.defineProperty(window, '__m3bCanceledFetches', {
                    value: canceled,
                });
                const originalFetch = window.fetch.bind(window);
                let nextRequestId = 0;
                window.fetch = (input, init) => {
                    const headers = new Headers(init?.headers);
                    if (
                        !init?.signal ||
                        !headers.has('x-phi-backend') ||
                        (init.method || 'GET').toUpperCase() !== 'GET'
                    )
                        return originalFetch(input, init);
                    const id = String(++nextRequestId);
                    headers.set('x-m3b-fetch-id', id);
                    init.signal.addEventListener(
                        'abort',
                        () => canceled.push(id),
                        { once: true },
                    );
                    return originalFetch(input, { ...init, headers });
                };
            }, allowedOrigin);
            const page = await context.newPage();
            page.on('pageerror', (error) => pageErrors.push(error.message));
            page.on('console', (message) => {
                if (message.type() !== 'error') return;
                if (
                    abortConsoleBudget > 0 &&
                    message.text() ===
                        'Failed to load resource: net::ERR_FAILED'
                ) {
                    abortConsoleBudget -= 1;
                } else {
                    consoleErrors.push(message.text());
                }
            });
            page.on('websocket', (socket) => socketEvents.push(socket.url()));
            page.on('requestfailed', (requestInfo) => {
                const error = requestInfo.failure()?.errorText || 'failed';
                const failure = `${requestInfo.method()} ${requestInfo.url()}: ${error}`;
                const scopedSwitchAbort =
                    Boolean(requestInfo.headers()['x-m3b-fetch-id']) &&
                    error === 'net::ERR_ABORTED';
                if (scopedSwitchAbort) {
                    scopedSwitchAbortFailures.push(requestInfo);
                } else if (
                    requestInfo.url() === activeUrl &&
                    abortFailureBudget > 0 &&
                    (error === 'net::ERR_FAILED' ||
                        error === 'net::ERR_ABORTED')
                ) {
                    abortFailureBudget -= 1;
                    intentionalAbortFailures.push(failure);
                } else {
                    failedRequests.push(failure);
                }
            });
            page.on('response', (response) => {
                if (response.status() >= 400) {
                    httpFailures.push(
                        `${response.status()} ${new URL(response.url()).pathname}`,
                    );
                }
            });
            page.on('request', (requestInfo) => {
                try {
                    const url = new URL(requestInfo.url());
                    if (
                        url.protocol !== 'data:' &&
                        url.origin !== allowedOrigin
                    ) {
                        externalRequests.push(requestInfo.url());
                    }
                } catch {
                    externalRequests.push(requestInfo.url());
                }
            });

            await page.route(`${phiA.url}/api/**`, async (route) => {
                try {
                    const incoming = route.request();
                    const incomingUrl = new URL(incoming.url());
                    const headers = await incoming.allHeaders();
                    const profileId =
                        headers['x-phi-backend'] || transportActive;
                    const profile = profiles[profileId];
                    if (!profile) {
                        unknownProfiles.push(profileId);
                        await route.abort('failed');
                        return;
                    }
                    for (const name of [
                        'host',
                        'origin',
                        'cookie',
                        'connection',
                        'content-length',
                        'x-phi-backend',
                        'x-m3b-fetch-id',
                    ])
                        delete headers[name];
                    headers.origin = new URL(profile.url).origin;
                    const upstream = await route.fetch({
                        url: `${profile.url}${incomingUrl.pathname}${incomingUrl.search}`,
                        headers,
                        maxRedirects: 0,
                        maxRetries: 0,
                    });
                    const body = await upstream.body();
                    if (
                        incomingUrl.pathname === '/api/config' &&
                        upstream.ok()
                    ) {
                        const config = JSON.parse(body.toString('utf8')) as {
                            workspaces?: string[];
                        };
                        observedConfigs.push({
                            profileId,
                            workspaces: config.workspaces || [],
                        });
                    }
                    const responseHeaders = await upstream.headers();
                    delete responseHeaders['content-length'];
                    delete responseHeaders['content-encoding'];
                    delete responseHeaders['transfer-encoding'];
                    await route.fulfill({
                        status: upstream.status(),
                        headers: responseHeaders,
                        body,
                    });
                } catch (error) {
                    routeErrors.push(String(error));
                    await route.abort('failed');
                }
            });
            page.route(activeUrl, async (route) => {
                const body = JSON.parse(route.request().postData() || '{}') as {
                    profileId?: string;
                };
                const profileId = body.profileId || '';
                if (!profiles[profileId]) {
                    unknownProfiles.push(profileId);
                    await route.abort('failed');
                    return;
                }
                const mode = nextMode;
                nextMode = 'success';
                let release!: () => void;
                const held = new Promise<void>((resolve) => {
                    release = resolve;
                });
                const pending = { profileId, mode, release, released: false };
                activeRequests.push(pending);
                await held;
                if (mode === 'success') {
                    transportActive = profileId;
                    await route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        body: JSON.stringify({
                            ok: true,
                            profileId,
                            origin: new URL(profiles[profileId].url).origin,
                        }),
                    });
                } else if (mode === '503') {
                    await route.fulfill({
                        status: 503,
                        contentType: 'application/json',
                        body: JSON.stringify({
                            error: 'Injected active-route failure',
                        }),
                    });
                } else {
                    if (mode === 'abort-changed') transportActive = profileId;
                    abortFailureBudget += 1;
                    abortConsoleBudget += 1;
                    await route.abort('failed');
                }
            });

            const enqueueSwitch = async (
                profileId: string,
                mode: ActiveMode = 'success',
            ): Promise<number> => {
                nextMode = mode;
                return page.evaluate(
                    ({ id, origin }) => {
                        const win = window as Window & {
                            __phiEmbed?: {
                                switchTo: (
                                    id: string,
                                    origin: string,
                                ) => Promise<unknown>;
                            };
                            __m3bSwitches?: Promise<unknown>[];
                        };
                        if (!win.__phiEmbed)
                            throw new Error('Phi embed hook is missing');
                        win.__m3bSwitches ||= [];
                        win.__m3bSwitches.push(
                            win.__phiEmbed.switchTo(id, origin),
                        );
                        return win.__m3bSwitches.length - 1;
                    },
                    {
                        id: profileId,
                        origin: new URL(profiles[profileId].url).origin,
                    },
                );
            };
            const waitForActive = async (count: number): Promise<void> => {
                await expect.poll(() => activeRequests.length).toBe(count);
            };
            const releaseActive = (index: number): void => {
                const pending = activeRequests[index];
                if (!pending || pending.released)
                    throw new Error(`Missing active route ${index}`);
                pending.released = true;
                pending.release();
            };
            const waitForSwitch = async (index: number): Promise<void> => {
                await page.evaluate(async (switchIndex) => {
                    const promises = (
                        window as Window & {
                            __m3bSwitches?: Promise<unknown>[];
                        }
                    ).__m3bSwitches;
                    await promises?.[switchIndex];
                }, index);
            };
            const notify = async (
                message: string,
                actionText?: string,
                flag?: string,
            ): Promise<void> => {
                await page.evaluate(
                    ({ text, buttonText, callbackFlag }) => {
                        const win = window as Window & {
                            __phiShowToast?: (
                                message: string,
                                options?: {
                                    duration?: number;
                                    action?: {
                                        text: string;
                                        callback: () => void;
                                    };
                                },
                            ) => HTMLElement;
                        };
                        win.__phiShowToast?.(text, {
                            duration: 0,
                            action: buttonText
                                ? {
                                      text: buttonText,
                                      callback: () => {
                                          if (callbackFlag) {
                                              (
                                                  window as unknown as Record<
                                                      string,
                                                      unknown
                                                  >
                                              )[callbackFlag] = true;
                                          }
                                      },
                                  }
                                : undefined,
                        });
                    },
                    {
                        text: message,
                        buttonText: actionText,
                        callbackFlag: flag,
                    },
                );
            };

            const initialized = page.waitForEvent('console', {
                predicate: (message) =>
                    message.text().includes('Phi initialized successfully'),
                timeout: 60_000,
            });
            await page.goto(
                `${phiA.url}/?embedded=1&profile=A&origin=${encodeURIComponent(phiA.url)}`,
                { waitUntil: 'domcontentloaded' },
            );
            await expect
                .poll(() =>
                    page.evaluate(
                        () =>
                            typeof (
                                window as Window & { __phiShowToast?: unknown }
                            ).__phiShowToast,
                    ),
                )
                .toBe('function');
            await initialized;
            expect(await page.locator('.tab').count()).toBe(0);
            const media = await page.evaluate(() => ({
                compact: window.matchMedia(
                    '(max-width: 768px), (max-height: 500px) and (orientation: landscape) and (pointer: coarse)',
                ).matches,
                coarse: window.matchMedia('(pointer: coarse)').matches,
            }));
            expect(media.compact, layout.name).toBe(layout.compact);
            expect(media.coarse, layout.name).toBe(layout.coarse);

            await notify(
                'A-only history',
                'Run A action',
                '__m3bAInitialAction',
            );
            await page
                .getByRole('button', { name: 'Notifications', exact: true })
                .click();
            await expect(page.locator('.notification-item-message')).toHaveText(
                ['A-only history'],
            );
            await page.evaluate(() => {
                (document.querySelector('.main-layout') as HTMLElement).inert =
                    false;
                (
                    document.getElementById('toast-container') as HTMLElement
                ).inert = true;
                (
                    document.getElementById(
                        'header-notifications-btn',
                    ) as HTMLElement
                ).inert = false;
                (
                    document.getElementById(
                        'notifications-overlay',
                    ) as HTMLElement
                ).inert = false;
            });

            const firstSwitch = await enqueueSwitch('B');
            await waitForActive(1);
            await expect(
                page.locator('#notifications-routing-status'),
            ).toBeVisible();
            await expect(
                page.locator('#notifications-overlay'),
            ).not.toHaveClass(/hidden/);
            await expect(page.locator('.notification-item')).toHaveCount(0);
            const inertWhileHeld = await page.evaluate(() => ({
                main: (document.querySelector('.main-layout') as HTMLElement)
                    .inert,
                toast: (
                    document.getElementById('toast-container') as HTMLElement
                ).inert,
                trigger: (
                    document.getElementById(
                        'header-notifications-btn',
                    ) as HTMLElement
                ).inert,
                overlay: (
                    document.getElementById(
                        'notifications-overlay',
                    ) as HTMLElement
                ).inert,
            }));
            expect(inertWhileHeld).toEqual({
                main: true,
                toast: true,
                trigger: false,
                overlay: false,
            });
            await notify(
                'B action during pending route',
                'Use B action',
                '__m3bBAction',
            );
            await notify('B row to dismiss');
            const bActionRow = page.locator('.notification-item').filter({
                hasText: 'B action during pending route',
            });
            await expect(
                bActionRow.getByRole('button', { name: 'Use B action' }),
            ).toBeDisabled();
            await expect(
                page.locator('.toast-action-btn').first(),
            ).toBeDisabled();
            await page
                .locator('.notification-item')
                .filter({ hasText: 'B row to dismiss' })
                .getByRole('button', { name: 'Dismiss' })
                .click();
            await expect(page.locator('.notification-item')).toHaveCount(1);
            expect(await page.evaluate(() => location.search)).toContain(
                'profile=B',
            );
            releaseActive(0);
            await waitForSwitch(firstSwitch);
            expect(transportActive).toBe('B');
            await expect(
                bActionRow.getByRole('button', { name: 'Use B action' }),
            ).toBeEnabled();
            await expect(
                page.locator('#notifications-routing-status'),
            ).toHaveClass(/hidden/);
            await bActionRow
                .getByRole('button', { name: 'Use B action' })
                .click();
            expect(
                await page.evaluate(
                    () =>
                        (window as Window & { __m3bBAction?: boolean })
                            .__m3bBAction,
                ),
            ).toBe(true);
            await notify('B-only retained history');
            await expect
                .poll(() =>
                    page.evaluate(() => ({
                        a: JSON.parse(
                            localStorage.getItem('phi_notifications_v1:A') ||
                                '{"entries":[]}',
                        ).entries.map(
                            (entry: { message: string }) => entry.message,
                        ),
                        b: JSON.parse(
                            localStorage.getItem('phi_notifications_v1:B') ||
                                '{"entries":[]}',
                        ).entries.map(
                            (entry: { message: string }) => entry.message,
                        ),
                    })),
                )
                .toMatchObject({
                    a: ['A-only history'],
                    b: ['B-only retained history'],
                });
            await expect
                .poll(() =>
                    observedConfigs.some(
                        (entry) =>
                            entry.profileId === 'B' &&
                            entry.workspaces.includes(profileB.workspace),
                    ),
                )
                .toBe(true);

            const failedSwitch = await enqueueSwitch('A', '503');
            await waitForActive(2);
            await expect(page.locator('.notification-item-message')).toHaveText(
                ['A-only history'],
            );
            await notify(
                'A action during failed route',
                'Use A action',
                '__m3bAAction',
            );
            await expect(
                page.locator('.notification-item-action'),
            ).toBeDisabled();
            releaseActive(1);
            await waitForSwitch(failedSwitch);
            expect(transportActive).toBe('B');
            await expect(
                page.locator('#notifications-routing-status'),
            ).toBeVisible();
            await expect(
                page.locator('.notification-item-action'),
            ).toBeDisabled();
            await expect(
                page.locator('#notifications-overlay'),
            ).not.toHaveClass(/hidden/);
            await notify('A dismiss after failed route');
            await page
                .locator('.notification-item')
                .filter({ hasText: 'A dismiss after failed route' })
                .getByRole('button', { name: 'Dismiss' })
                .click();
            await expect(page.locator('.notification-item')).toHaveCount(2);
            expect(await page.evaluate(() => location.search)).toContain(
                'profile=A',
            );

            const recoveredA = await enqueueSwitch('A');
            await waitForActive(3);
            await notify(
                'A action after explicit recovery',
                'Run recovered A',
                '__m3bRecoveredA',
            );
            await expect(
                page.locator('.notification-item-action').last(),
            ).toBeDisabled();
            releaseActive(2);
            await waitForSwitch(recoveredA);
            await expect(
                page.locator('#notifications-routing-status'),
            ).toHaveClass(/hidden/);
            await page
                .locator('.notification-item')
                .filter({
                    hasText: 'A action after explicit recovery',
                })
                .getByRole('button', { name: 'Run recovered A' })
                .click();
            expect(
                await page.evaluate(
                    () =>
                        (window as Window & { __m3bRecoveredA?: boolean })
                            .__m3bRecoveredA,
                ),
            ).toBe(true);

            const abortedUnchanged = await enqueueSwitch(
                'B',
                'abort-unchanged',
            );
            await waitForActive(4);
            releaseActive(3);
            await waitForSwitch(abortedUnchanged);
            expect(transportActive).toBe('A');
            await expect(
                page.locator('#notifications-routing-status'),
            ).toBeVisible();
            await expect(page.locator('.notification-item-action')).toHaveCount(
                0,
            );

            const recoverB = await enqueueSwitch('B');
            await waitForActive(5);
            await notify(
                'B action after unchanged abort',
                'Run recovered B',
                '__m3bRecoveredB',
            );
            releaseActive(4);
            await waitForSwitch(recoverB);
            await expect(
                page.locator('#notifications-routing-status'),
            ).toHaveClass(/hidden/);
            await page
                .locator('.notification-item')
                .filter({
                    hasText: 'B action after unchanged abort',
                })
                .getByRole('button', { name: 'Run recovered B' })
                .click();
            expect(
                await page.evaluate(
                    () =>
                        (window as Window & { __m3bRecoveredB?: boolean })
                            .__m3bRecoveredB,
                ),
            ).toBe(true);

            const abortedChanged = await enqueueSwitch('A', 'abort-changed');
            await waitForActive(6);
            releaseActive(5);
            await waitForSwitch(abortedChanged);
            expect(transportActive).toBe('A');
            await expect(
                page.locator('#notifications-routing-status'),
            ).toBeVisible();
            await expect(page.locator('.notification-item-action')).toHaveCount(
                0,
            );

            const recoverA = await enqueueSwitch('A');
            await waitForActive(7);
            await notify(
                'A action after changed abort',
                'Run recovered A again',
                '__m3bRecoveredAAgain',
            );
            releaseActive(6);
            await waitForSwitch(recoverA);
            await expect(
                page.locator('#notifications-routing-status'),
            ).toHaveClass(/hidden/);
            await page
                .locator('.notification-item')
                .filter({
                    hasText: 'A action after changed abort',
                })
                .getByRole('button', { name: 'Run recovered A again' })
                .click();
            expect(
                await page.evaluate(
                    () =>
                        (window as Window & { __m3bRecoveredAAgain?: boolean })
                            .__m3bRecoveredAAgain,
                ),
            ).toBe(true);

            const staleSuccess = await enqueueSwitch('B');
            await waitForActive(8);
            const currentSwitch = await enqueueSwitch('A');
            releaseActive(7);
            await waitForActive(9);
            await waitForSwitch(staleSuccess);
            expect(transportActive).toBe('B');
            expect(await page.evaluate(() => location.search)).toContain(
                'profile=A',
            );
            await expect(
                page.locator('#notifications-routing-status'),
            ).toBeVisible();
            await notify(
                'A action after superseded success',
                'Run final A',
                '__m3bFinalA',
            );
            await expect(
                page.locator('.notification-item-action'),
            ).toBeDisabled();
            releaseActive(8);
            await waitForSwitch(currentSwitch);
            expect(transportActive).toBe('A');
            await expect(
                page.locator('#notifications-routing-status'),
            ).toHaveClass(/hidden/);
            await page
                .locator('.notification-item')
                .filter({
                    hasText: 'A action after superseded success',
                })
                .getByRole('button', { name: 'Run final A' })
                .click();
            expect(
                await page.evaluate(
                    () =>
                        (window as Window & { __m3bFinalA?: boolean })
                            .__m3bFinalA,
                ),
            ).toBe(true);

            expect(activeRequests.map((entry) => entry.profileId)).toEqual([
                'B',
                'A',
                'A',
                'B',
                'B',
                'A',
                'A',
                'B',
                'A',
            ]);
            expect(unknownProfiles).toEqual([]);
            expect(routeErrors).toEqual([]);
            expect(intentionalAbortFailures).toHaveLength(2);
            const canceledBySwitch = await page.evaluate(
                () =>
                    (window as Window & { __m3bCanceledFetches?: string[] })
                        .__m3bCanceledFetches || [],
            );
            for (const canceled of scopedSwitchAbortFailures) {
                expect(canceledBySwitch).toContain(
                    canceled.headers()['x-m3b-fetch-id'],
                );
                expect(canceled.failure()?.errorText).toBe('net::ERR_ABORTED');
            }
            expect(scopedSwitchAbortFailures.length).toBeLessThanOrEqual(
                canceledBySwitch.length,
            );
            expect(failedRequests).toEqual([]);
            expect(socketEvents).toEqual([]);
            expect(externalRequests).toEqual([]);
            expect(pageErrors).toEqual([]);
            expect(
                httpFailures.filter(
                    (failure) =>
                        failure !== '503 /api/update/status' &&
                        failure !== '503 /__phi/active',
                ),
            ).toEqual([]);
            expect(
                httpFailures.filter(
                    (failure) => failure === '503 /__phi/active',
                ),
            ).toHaveLength(1);
            expect(httpFailures).toContain('503 /api/update/status');
            expect(
                consoleErrors.every(
                    (message) =>
                        message ===
                        'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
                ),
            ).toBe(true);
            expect(consoleErrors.length).toBeGreaterThan(0);
            expect(
                observedConfigs.some(
                    (entry) =>
                        entry.profileId === 'A' &&
                        entry.workspaces.includes(profileA.workspace),
                ),
            ).toBe(true);
            expect(
                observedConfigs.some(
                    (entry) =>
                        entry.profileId === 'B' &&
                        entry.workspaces.includes(profileB.workspace),
                ),
            ).toBe(true);
            expect(
                await page.evaluate(
                    () => document.documentElement.scrollWidth <= innerWidth,
                ),
            ).toBe(true);
            const finalInert = await page.evaluate(() => ({
                main: (document.querySelector('.main-layout') as HTMLElement)
                    .inert,
                toast: (
                    document.getElementById('toast-container') as HTMLElement
                ).inert,
                trigger: (
                    document.getElementById(
                        'header-notifications-btn',
                    ) as HTMLElement
                ).inert,
                overlay: (
                    document.getElementById(
                        'notifications-overlay',
                    ) as HTMLElement
                ).inert,
            }));
            expect(finalInert).toEqual({
                main: false,
                toast: true,
                trigger: false,
                overlay: false,
            });
            await context.close();
        }
    } finally {
        for (const context of contexts) {
            if (context.pages().length > 0) await context.close();
        }
        await phiB?.stop();
        await phiA?.stop();
    }
});

test('M3c injected Electron errors share the browser notification history and compact popup cap', async ({
    browser,
    request,
}) => {
    test.setTimeout(180_000);
    const phi = await startPhi({
        config: {
            pushover_enabled: false,
            simplepush_enabled: false,
            webhook_enabled: false,
            opencode_legacy: true,
        },
    });
    const contexts: BrowserContext[] = [];
    const allowedOrigin = new URL(phi.url).origin;
    const errorMessage = 'M3c failed to open <img src=x onerror=alert(1)>';

    try {
        await expect
            .poll(async () => {
                try {
                    return stripVTControlCharacters(
                        await readFile(phi.logPath, 'utf8'),
                    );
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                        return '';
                    throw error;
                }
            })
            .toContain(`Server running on: ${phi.url}`);
        const coordinator = await request.post(
            `${phi.url}/api/config/sync-coordinator`,
            { data: { sync_coordinator: phi.url } },
        );
        expect(coordinator.ok()).toBe(true);

        const layouts = [
            {
                name: 'desktop',
                viewport: { width: 1440, height: 900 },
                isMobile: false,
                hasTouch: false,
                compact: false,
                colorScheme: undefined,
                reducedMotion: undefined,
                lowPower: false,
                theme: undefined,
                visibleCount: 4,
                visibleMessages: [
                    'M3c ordinary one',
                    'M3c ordinary two',
                    '2 tabs ready',
                    errorMessage,
                ],
            },
            {
                name: 'touch phone',
                viewport: { width: 390, height: 844 },
                isMobile: true,
                hasTouch: true,
                compact: true,
                colorScheme: 'light',
                reducedMotion: 'reduce',
                lowPower: true,
                theme: 'white',
                visibleCount: 3,
                visibleMessages: [
                    'M3c ordinary two',
                    '2 tabs ready',
                    errorMessage,
                ],
            },
        ] as const;

        for (const layout of layouts) {
            if (layout.theme) {
                const themeUpdate = await request.post(
                    `${phi.url}/api/config/theme`,
                    {
                        data: { color: layout.theme },
                    },
                );
                expect(themeUpdate.ok()).toBe(true);
            }
            const context = await browser.newContext({
                viewport: layout.viewport,
                isMobile: layout.isMobile,
                hasTouch: layout.hasTouch,
                colorScheme: layout.colorScheme,
                reducedMotion: layout.reducedMotion,
            });
            contexts.push(context);
            await context.addInitScript(
                (config) => {
                    if (window.location.origin !== config.origin) return;
                    try {
                        localStorage.setItem('phi_diff_panel_open', 'false');
                        if (config.theme)
                            localStorage.setItem(
                                'phi_theme_color',
                                config.theme,
                            );
                        if (config.lowPower)
                            localStorage.setItem('phi_low_power', 'true');
                    } catch {}
                },
                {
                    origin: allowedOrigin,
                    theme: layout.theme,
                    lowPower: layout.lowPower,
                },
            );
            const page = await context.newPage();
            const pageErrors: string[] = [];
            const consoleErrors: string[] = [];
            const httpFailures: string[] = [];
            const failedRequests: string[] = [];
            const externalRequests: string[] = [];
            page.on('pageerror', (error) => pageErrors.push(error.message));
            page.on('console', (message) => {
                if (message.type() === 'error')
                    consoleErrors.push(message.text());
            });
            page.on('requestfailed', (requestInfo) => {
                failedRequests.push(
                    `${requestInfo.method()} ${requestInfo.url()}: ${requestInfo.failure()?.errorText || 'failed'}`,
                );
            });
            page.on('response', (response) => {
                if (response.status() >= 400) {
                    httpFailures.push(`${response.status()} ${response.url()}`);
                }
            });
            page.on('request', (requestInfo) => {
                try {
                    if (new URL(requestInfo.url()).origin !== allowedOrigin) {
                        externalRequests.push(requestInfo.url());
                    }
                } catch {
                    externalRequests.push(requestInfo.url());
                }
            });

            const initialized = page.waitForEvent('console', {
                predicate: (message) =>
                    message.text().includes('Phi initialized successfully'),
                timeout: 60_000,
            });
            await page.goto(phi.url, { waitUntil: 'domcontentloaded' });
            await expect
                .poll(() =>
                    page.evaluate(
                        () =>
                            typeof (
                                window as Window & { __phiShowToast?: unknown }
                            ).__phiShowToast,
                    ),
                )
                .toBe('function');
            await initialized;
            const media = await page.evaluate(() => ({
                compact: window.matchMedia(
                    '(max-width: 768px), (max-height: 500px) and (orientation: landscape) and (pointer: coarse)',
                ).matches,
                coarse: window.matchMedia('(pointer: coarse)').matches,
                light: window.matchMedia('(prefers-color-scheme: light)')
                    .matches,
                reducedMotion: window.matchMedia(
                    '(prefers-reduced-motion: reduce)',
                ).matches,
            }));
            expect(media.compact, layout.name).toBe(layout.compact);
            expect(media.coarse, layout.name).toBe(layout.hasTouch);
            if (layout.colorScheme === 'light') expect(media.light).toBe(true);
            if (layout.reducedMotion === 'reduce')
                expect(media.reducedMotion).toBe(true);

            await page.evaluate(() => {
                const notify = (
                    window as Window & {
                        __phiShowToast?: (
                            message: string,
                            options?: {
                                duration?: number;
                                readyPaneId?: string;
                                action?: { text: string; callback: () => void };
                            },
                        ) => HTMLElement;
                    }
                ).__phiShowToast;
                if (!notify)
                    throw new Error('Phi notification hook is missing');
                notify('M3c ordinary one', { duration: 0 });
                notify('M3c ordinary two', { duration: 0 });
                notify('M3c ready A', {
                    duration: 0,
                    readyPaneId: 'm3c-pane-a',
                    action: { text: 'Go to tab', callback: () => {} },
                });
                notify('M3c ready B', {
                    duration: 0,
                    readyPaneId: 'm3c-pane-b',
                    action: { text: 'Go to tab', callback: () => {} },
                });
            });
            await page.addScriptTag({
                content: toastErrorScript(errorMessage),
            });

            const visiblePopups = page.locator(
                '#toast-container > .toast:visible .toast-message',
            );
            await expect(visiblePopups).toHaveCount(layout.visibleCount);
            expect(await visiblePopups.allTextContents()).toEqual(
                layout.visibleMessages,
            );
            expect(
                await page.locator('#toast-container > .toast').count(),
            ).toBe(4);
            expect(
                await page
                    .locator('#toast-container .toast-message')
                    .filter({ hasText: errorMessage })
                    .count(),
            ).toBe(1);
            expect(
                await page
                    .locator('#toast-container .toast-error .toast-title')
                    .allTextContents(),
            ).toEqual(["Couldn't open"]);
            expect(
                await page.locator('#toast-container .toast img').count(),
            ).toBe(0);

            await page
                .getByRole('button', { name: 'Notifications', exact: true })
                .click();
            await expect(page.locator('.notification-item')).toHaveCount(4);
            if (layout.theme === 'white') {
                const presentation = await page.evaluate(() => {
                    const drawer = document.getElementById(
                        'notifications-drawer',
                    );
                    return {
                        theme: document.documentElement.dataset.themeColor,
                        accent: getComputedStyle(document.documentElement)
                            .getPropertyValue('--accent')
                            .trim(),
                        fastMode: document.body.classList.contains('fast-mode'),
                        animation: drawer
                            ? getComputedStyle(drawer).animationName
                            : null,
                    };
                });
                expect(presentation).toEqual({
                    theme: 'white',
                    accent: '#ffffff',
                    fastMode: true,
                    animation: 'none',
                });
            }
            expect(
                await page
                    .locator('.notification-item-message')
                    .allTextContents(),
            ).toEqual([
                errorMessage,
                '2 tabs ready',
                'M3c ordinary two',
                'M3c ordinary one',
            ]);
            await expect(
                page
                    .locator('.notification-item-title')
                    .filter({ hasText: "Couldn't open" }),
            ).toHaveCount(1);
            expect(
                await page
                    .locator('.notification-item-message')
                    .filter({ hasText: errorMessage })
                    .count(),
            ).toBe(1);
            expect(await page.locator('.notification-item img').count()).toBe(
                0,
            );
            expect(
                await page.evaluate(
                    () => document.documentElement.scrollWidth <= innerWidth,
                ),
            ).toBe(true);
            await expect
                .poll(() => httpFailures.slice())
                .toEqual([`503 ${phi.url}/api/update/status`]);
            expect(consoleErrors).toEqual([
                'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
            ]);
            expect(pageErrors, `${layout.name} page errors`).toEqual([]);
            expect(failedRequests, `${layout.name} failed requests`).toEqual(
                [],
            );
            expect(
                externalRequests,
                `${layout.name} external requests`,
            ).toEqual([]);
            await context.close();
        }
    } finally {
        for (const context of contexts) {
            if (context.pages().length > 0) await context.close();
        }
        await phi.stop();
    }
});
