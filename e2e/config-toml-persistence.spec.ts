import {
    expect,
    test,
    type Browser,
    type Page,
    type Request,
} from '@playwright/test';
import { startPhi } from './_server.js';

function isThemeSave(request: Request): boolean {
    const url = new URL(request.url());
    return request.method() === 'POST' && url.pathname === '/api/config/theme';
}

function waitForThemeSave(page: Page): Promise<void> {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            page.off('requestfinished', onFinished);
            page.off('requestfailed', onFailed);
        };
        const onFinished = (request: Request) => {
            if (!isThemeSave(request)) return;
            cleanup();
            resolve();
        };
        const onFailed = (request: Request) => {
            if (!isThemeSave(request)) return;
            cleanup();
            reject(
                new Error(
                    `Theme request failed: ${request.failure()?.errorText}`,
                ),
            );
        };
        page.on('requestfinished', onFinished);
        page.on('requestfailed', onFailed);
    });
}

async function checkSettings(
    page: Page,
    mobile: boolean,
    pageErrors: string[],
    consoleErrors: string[],
    failedRequests: string[],
): Promise<void> {
    if (!mobile) {
        await page.locator('#header-config-pill .pill-label').click();
    }
    await expect(page.locator('.settings-modal')).toBeVisible();
    const swatch = page.locator('.settings-swatch[data-color="amber"]');
    await expect(swatch).toBeVisible();
    const themeFinished = waitForThemeSave(page);
    const themeSaved = page.waitForResponse((response) => {
        return isThemeSave(response.request());
    });
    if (mobile) {
        await swatch.tap();
    } else {
        await swatch.focus();
        await page.keyboard.press('Enter');
    }
    const [saveResponse] = await Promise.all([themeSaved, themeFinished]);
    expect(saveResponse.status()).toBe(200);
    await expect(swatch).toHaveAttribute('aria-checked', 'true');
    await expect
        .poll(async () =>
            (await page.request.get(new URL('/api/config', page.url()).href))
                .json()
                .then((config) => config.theme_color),
        )
        .toBe('amber');
    expect(
        await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
    ).toBe(true);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
}

async function runContext(browser: Browser, mobile: boolean): Promise<void> {
    const phi = await startPhi();
    const context = await browser.newContext(
        mobile
            ? {
                  viewport: { width: 390, height: 844 },
                  isMobile: true,
                  hasTouch: true,
              }
            : { viewport: { width: 1440, height: 900 } },
    );
    try {
        const page = await context.newPage();
        if (!mobile) {
            await page.addInitScript(() => {
                const state = window as Window & {
                    __phiRevalidated?: boolean;
                };
                state.__phiRevalidated = false;
                let rootObserver: MutationObserver | undefined;
                const watchRoot = (root: HTMLElement) => {
                    let sawStale = root.dataset.sync === 'stale';
                    const syncObserver = new MutationObserver(() => {
                        if (root.dataset.sync === 'stale') {
                            sawStale = true;
                        } else if (sawStale) {
                            state.__phiRevalidated = true;
                            syncObserver.disconnect();
                            rootObserver?.disconnect();
                        }
                    });
                    syncObserver.observe(root, {
                        attributes: true,
                        attributeFilter: ['data-sync'],
                    });
                };
                if (document.documentElement) {
                    watchRoot(document.documentElement);
                } else {
                    rootObserver = new MutationObserver(() => {
                        const root = document.documentElement;
                        if (!root) return;
                        watchRoot(root);
                        rootObserver?.disconnect();
                    });
                    rootObserver.observe(document, {
                        childList: true,
                        subtree: true,
                    });
                }
            });
        }
        const pageErrors: string[] = [];
        const consoleErrors: string[] = [];
        const failedRequests: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        page.on('console', (message) => {
            if (message.type() === 'error') consoleErrors.push(message.text());
        });
        page.on('requestfailed', (request) =>
            failedRequests.push(
                `${request.url()} ${request.failure()?.errorText}`,
            ),
        );
        page.on('response', (response) => {
            if (response.status() >= 400)
                failedRequests.push(`${response.status()} ${response.url()}`);
        });
        await page.route('**/api/update/status', (route) =>
            route.request().method() === 'GET'
                ? route.fulfill({
                      status: 200,
                      contentType: 'application/json',
                      body: JSON.stringify({
                          current: 'dev',
                          update_available: false,
                      }),
                  })
                : route.continue(),
        );
        await page.route('**/api/sessions?*', async (route) => {
            const url = new URL(route.request().url());
            if (
                route.request().method() === 'GET' &&
                url.pathname === '/api/sessions' &&
                url.searchParams.get('coder') === 'opencode'
            ) {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: '[]',
                });
            } else {
                await route.continue();
            }
        });
        const configLoaded = page.waitForResponse((response) => {
            return new URL(response.url()).pathname === '/api/config';
        });
        await page.goto(
            mobile ? new URL('/config.html', phi.url).href : phi.url,
        );
        await configLoaded;
        if (!mobile) {
            await page.waitForFunction(
                () =>
                    (window as Window & { __phiRevalidated?: boolean })
                        .__phiRevalidated === true,
            );
        }
        await checkSettings(
            page,
            mobile,
            pageErrors,
            consoleErrors,
            failedRequests,
        );
    } finally {
        await context.close();
        await phi.stop();
    }
}

test('config TOML persistence works with desktop keyboard and mobile touch settings', async ({
    browser,
}) => {
    await runContext(browser, false);
    await runContext(browser, true);
});
