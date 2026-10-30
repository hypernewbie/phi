import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

const IPHONE =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
let phi: PhiServer;

test.beforeAll(async () => {
    phi = await startPhi({
        config: {
            hostname_override: 'fixture hostname',
            mobile_scrollback_rows: 2500,
        },
        env: { PHI_SHUTDOWN_PTY_GRACE: '150ms', PHI_SHUTDOWN_GRACE: '1s' },
        setup(dir) {
            const folder = join(dir, 'workspace');
            mkdirSync(folder, { recursive: true });
            const workspace = realpathSync(folder);
            const state = join(dir, 'home', '.phi');
            const backends = join(state, 'backends');
            mkdirSync(backends, { recursive: true });
            const command = join(dir, 'fixture-bash');
            writeFileSync(
                command,
                '#!/bin/sh\nprintf "fixture ready\\r\\n"\nexec cat\n',
                { mode: 0o755 },
            );
            writeFileSync(
                join(backends, 'bash.json'),
                JSON.stringify({ id: 'bash', command }),
            );
            writeFileSync(
                join(state, 'tabs.json'),
                JSON.stringify([
                    {
                        id: 't1',
                        coder: 'bash',
                        session_id: '',
                        cwd: workspace,
                        workspace,
                        title: 'Settings fixture',
                    },
                ]),
            );
        },
    });
});
test.afterAll(async () => {
    await phi?.stop();
});

async function fontSize(page: Page, selector = 'body') {
    return page
        .locator(selector)
        .evaluate((el) => getComputedStyle(el).fontSize);
}
async function openDrawerSettings(page: Page, sessions = false) {
    const touch = await page.evaluate(() => navigator.maxTouchPoints > 0);
    const activate = async (selector: string) => {
        if (touch) await page.locator(selector).tap();
        else await page.locator(selector).click();
    };
    await activate('#mobile-sidebar-toggle');
    if (sessions) await activate('#drawer-open-sessions');
    await activate('#drawer-settings-btn');
    await expect(page.locator('.settings-overlay')).toBeVisible();
    await expect(page.locator('#sidebar-panel')).not.toHaveClass(/drawer-open/);
}

test('desktop and mobile sizes stay independent through drawer, editing and reload', async ({
    browser,
}) => {
    const desktop = await browser.newContext({
        viewport: { width: 1440, height: 900 },
    });
    const mobile = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        userAgent: IPHONE,
    });
    try {
        const pc = await desktop.newPage(),
            phone = await mobile.newPage();
        await pc.goto(phi.url);
        await pc.locator('#header-config-pill .pill-label').click();
        await expect(pc.locator('.settings-overlay')).toBeVisible();
        const baseline = await fontSize(
            pc,
            'label[for="settings-ui-font-size"]',
        );
        await pc.locator('#settings-ui-font-size').fill('16');
        await expect.poll(() => fontSize(pc)).toBe('16px');
        await expect
            .poll(
                async () =>
                    (
                        await (
                            await pc.request.get(`${phi.url}/api/config`)
                        ).json()
                    ).ui_font_size,
            )
            .toBe(16);
        await pc.locator('.settings-overlay .modal-close-btn').click();
        await phone.goto(phi.url);
        await expect(phone.locator('#tabs-container .tab')).toHaveCount(1);
        await openDrawerSettings(phone);
        await expect(phone.locator('#settings-mobile-status')).toHaveText(
            'Saved',
        );
        await expect(phone.locator('#settings-ui-font-size')).toBeHidden();
        await phone.locator('#settings-mobile-ui-font-size').fill('21');
        await expect.poll(() => fontSize(phone)).toBe('21px');
        await expect
            .poll(() => fontSize(phone, '#drawer-settings-btn'))
            .toBe('21px');
        await expect
            .poll(() =>
                fontSize(phone, 'label[for="settings-mobile-ui-font-size"]'),
            )
            .toBe('21px');
        await expect(phone.locator('#settings-mobile-status')).toHaveText(
            'Saved',
        );
        await expect(phone.locator('#settings-mobile-size-reset')).toHaveCSS(
            'font-size',
            '21px',
        );
        await phone.keyboard.press('Escape');
        await expect(phone.locator('#mobile-sidebar-toggle')).toBeFocused();
        await openDrawerSettings(phone, true);
        await expect(
            phone.locator('#settings-mobile-ui-font-size'),
        ).toHaveValue('21');
        await phone.locator('.settings-overlay .modal-close-btn').click();
        await Promise.all([pc.reload(), phone.reload()]);
        await expect.poll(() => fontSize(pc)).toBe('16px');
        await expect.poll(() => fontSize(phone)).toBe('21px');
        await pc.locator('#header-config-pill .pill-label').click();
        await pc.locator('#settings-mobile-view').click();
        await pc.locator('#settings-mobile-ui-font-size').fill('22');
        await expect(pc.locator('#settings-mobile-status')).toHaveText('Saved');
        await expect.poll(() => fontSize(pc)).toBe('16px');
        expect(
            await fontSize(pc, 'label[for="settings-mobile-ui-font-size"]'),
        ).toBe(baseline);
        await phone.reload();
        await expect.poll(() => fontSize(phone)).toBe('22px');
        await expect
            .poll(() => fontSize(phone, '#drawer-settings-btn'))
            .toBe('22px');
    } finally {
        await desktop.close();
        await mobile.close();
    }
});

test('narrow desktop keeps desktop identity and standalone font saves preserve shared fields', async ({
    browser,
}) => {
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
    });
    try {
        const page = await context.newPage();
        await page.goto(phi.url);
        await expect(page.locator('html')).toHaveAttribute(
            'data-appearance-profile',
            'desktop',
        );
        await openDrawerSettings(page);
        await expect(page.locator('#settings-ui-font-size')).toBeVisible();
        await page.goto(`${phi.url}/config.html`);
        await expect(page.locator('#settings-hostname-override')).toHaveValue(
            'fixture hostname',
        );
        await page.locator('#settings-ui-font-size').fill('18');
        await expect
            .poll(
                async () =>
                    (
                        await (
                            await page.request.get(`${phi.url}/api/config`)
                        ).json()
                    ).ui_font_size,
            )
            .toBe(18);
        const config = await (
            await page.request.get(`${phi.url}/api/config`)
        ).json();
        expect(config.hostname_override).toBe('fixture hostname');
        expect(config.mobile_scrollback_rows).toBe(2500);
    } finally {
        await context.close();
    }
});

test('mobile shared edits preserve newer desktop cache values when broadcasts are unavailable', async ({
    browser,
}) => {
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        userAgent: IPHONE,
    });
    try {
        await context.addInitScript(() => {
            BroadcastChannel.prototype.postMessage = () => {
                throw new DOMException(
                    'fixture channel unavailable',
                    'InvalidStateError',
                );
            };
        });
        const phone = await context.newPage();
        await mobileSettings(phone);
        const desktop = await context.newPage();
        await desktop.goto(`${phi.url}/config.html?desktop=1`);
        await desktop.locator('#settings-ui-font-size').fill('24');
        await expect.poll(() => fontSize(desktop)).toBe('24px');
        await phone.locator('#settings-bg-blur').fill('8');
        await phone.locator('.settings-overlay .modal-close-btn').click();
        await desktop.reload();
        await expect.poll(() => fontSize(desktop)).toBe('24px');
        await expect(desktop.locator('#settings-ui-font-size')).toHaveValue(
            '24',
        );
    } finally {
        await context.close();
    }
});

for (const touch of [false, true]) {
    for (const choice of ['invalid input', 'server values']) {
        test(`${choice} cancels a save waiting for actual IndexedDB (${touch ? 'touch' : 'desktop'})`, async ({
            browser,
        }) => {
            const context = await browser.newContext(
                touch
                    ? {
                          viewport: { width: 390, height: 844 },
                          isMobile: true,
                          hasTouch: true,
                          userAgent: IPHONE,
                      }
                    : { viewport: { width: 1440, height: 900 } },
            );
            try {
                const page = await context.newPage();
                await mobileSettings(page);
                const writes: string[] = [];
                page.on('request', (request) => {
                    if (
                        request.method() === 'POST' &&
                        request.url().endsWith('/api/config/mobile-appearance')
                    )
                        writes.push(request.postData() || '');
                });
                const input = page.locator('#settings-mobile-ui-font-size');
                await input.fill('21');
                await expect
                    .poll(async () =>
                        (await persistedDrafts(page)).some(
                            (draft) => draft.fields.ui_font_size === 21,
                        ),
                    )
                    .toBe(true);
                await page.evaluate(
                    () =>
                        new Promise<void>((resolve, reject) => {
                            const open = indexedDB.open(
                                'phi-mobile-appearance-v1',
                                1,
                            );
                            open.onerror = () => reject(open.error);
                            open.onsuccess = () => {
                                const db = open.result;
                                const tx = db.transaction(
                                    ['owners', 'drafts'],
                                    'readwrite',
                                );
                                const store = tx.objectStore('owners');
                                let held = true;
                                (
                                    window as Window & {
                                        releaseMobileStorage?: () => void;
                                    }
                                ).releaseMobileStorage = () => {
                                    held = false;
                                };
                                tx.oncomplete = () => db.close();
                                tx.onabort = () => db.close();
                                const keepAlive = () => {
                                    const request = store.get('fixture-lock');
                                    request.onsuccess = () => {
                                        resolve();
                                        if (held) keepAlive();
                                    };
                                };
                                keepAlive();
                            };
                        }),
                );
                // Let the 300ms debounce queue its transaction behind the real lock.
                await page.waitForTimeout(400);
                if (choice === 'invalid input') await input.fill('');
                else {
                    await page
                        .locator('#settings-mobile-save')
                        [touch ? 'tap' : 'click']();
                    await page
                        .locator('#settings-mobile-use-server')
                        [touch ? 'tap' : 'click']();
                }
                await page.evaluate(() =>
                    (
                        window as Window & { releaseMobileStorage?: () => void }
                    ).releaseMobileStorage?.(),
                );
                if (choice === 'invalid input') {
                    await expect(input).toHaveAttribute('aria-invalid', 'true');
                    await expect(
                        page.locator('#settings-mobile-status'),
                    ).toContainText('whole number');
                } else
                    await expect(
                        page.locator('#settings-mobile-status'),
                    ).toHaveText('Saved');
                // Await the queued transaction, not just the synchronous input event.
                await persistedDrafts(page);
                expect(writes).toHaveLength(0);
                await input.fill('22');
                await expect(
                    page.locator('#settings-mobile-status'),
                ).toHaveText('Saved');
                expect(writes.map((body) => JSON.parse(body).fields)).toEqual([
                    { ui_font_size: 22 },
                ]);
            } finally {
                await context.close();
            }
        });
    }
}

async function mobileSettings(page: Page) {
    await page.goto(`${phi.url}/config.html?page=mobile`);
    await expect(page.locator('#settings-mobile-status')).toHaveText('Saved');
}
async function persistedDrafts(page: Page) {
    return page.evaluate(
        () =>
            new Promise<any[]>((resolve, reject) => {
                const open = indexedDB.open('phi-mobile-appearance-v1', 1);
                open.onerror = () => reject(open.error);
                open.onsuccess = () => {
                    const db = open.result;
                    const transaction = db.transaction('drafts');
                    const request = transaction.objectStore('drafts').getAll();
                    transaction.oncomplete = () => {
                        db.close();
                        resolve(request.result);
                    };
                    transaction.onerror = () => {
                        db.close();
                        reject(transaction.error);
                    };
                };
            }),
    );
}

test('offline drafts survive a closed document and require explicit restore/save', async ({
    browser,
}) => {
    const context = await browser.newContext({
        isMobile: true,
        hasTouch: true,
        userAgent: IPHONE,
        viewport: { width: 390, height: 844 },
    });
    try {
        let posts = 0;
        context.on('request', (request) => {
            if (
                request.method() === 'POST' &&
                request.url().endsWith('/api/config/mobile-appearance')
            )
                posts++;
        });
        const first = await context.newPage();
        await mobileSettings(first);
        await context.setOffline(true);
        await first.locator('#settings-mobile-ui-font-size').fill('23');
        await expect.poll(() => fontSize(first)).toBe('23px');
        await expect
            .poll(
                async () =>
                    (await persistedDrafts(first)).filter(
                        (draft) => Object.keys(draft.fields).length,
                    ).length,
            )
            .toBe(1);
        expect(posts).toBe(0);
        await first.close();
        await context.setOffline(false);
        const recovery = await context.newPage();
        await mobileSettings(recovery);
        await expect(recovery.locator('#settings-mobile-drafts')).toContainText(
            '23',
        );
        expect(posts).toBe(0);
        await recovery
            .locator('#settings-mobile-drafts button')
            .filter({ hasText: 'Restore' })
            .click();
        await expect(
            recovery.locator('#settings-mobile-ui-font-size'),
        ).toHaveValue('23');
        expect(posts).toBe(0);
        await recovery.locator('#settings-mobile-save').click();
        await expect(recovery.locator('#settings-mobile-status')).toHaveText(
            'Saved',
        );
        expect(posts).toBe(1);
    } finally {
        await context.close();
    }
});

test('a still-open document flushes only never-dispatched work after reconnect', async ({
    browser,
}) => {
    const context = await browser.newContext({
        isMobile: true,
        hasTouch: true,
        userAgent: IPHONE,
    });
    try {
        const page = await context.newPage();
        await mobileSettings(page);
        let posts = 0;
        page.on('request', (request) => {
            if (
                request.method() === 'POST' &&
                request.url().endsWith('/api/config/mobile-appearance')
            )
                posts++;
        });
        await context.setOffline(true);
        await page.locator('#settings-mobile-ui-font-size').fill('20');
        await expect
            .poll(async () =>
                (await persistedDrafts(page)).some(
                    (draft) => draft.fields.ui_font_size === 20,
                ),
            )
            .toBe(true);
        expect(posts).toBe(0);
        await context.setOffline(false);
        await expect(page.locator('#settings-mobile-status')).toHaveText(
            'Saved',
        );
        expect(posts).toBe(1);
    } finally {
        await context.close();
    }
});

test('lost save and fence responses retain an occupied slot across reload without resending', async ({
    browser,
}) => {
    const context = await browser.newContext();
    try {
        const page = await context.newPage();
        await mobileSettings(page);
        let saves = 0,
            fences = 0;
        await context.route(
            '**/api/config/mobile-appearance',
            async (route) => {
                if (route.request().method() !== 'POST')
                    return route.continue();
                saves++;
                await route.fetch();
                await route.abort('failed');
            },
        );
        await page.locator('#settings-mobile-ui-font-size').fill('19');
        await expect(page.locator('#settings-mobile-status')).toContainText(
            'Save outcome unknown',
        );
        await expect
            .poll(
                async () =>
                    (
                        await (
                            await page.request.get(
                                `${phi.url}/api/config/mobile-appearance`,
                            )
                        ).json()
                    ).ui_font_size,
            )
            .toBe(19);
        await page.reload();
        await expect(page.locator('#settings-mobile-status')).toContainText(
            'Save outcome unknown',
        );
        expect(saves).toBe(1);
        const second = await context.newPage();
        await second.goto(`${phi.url}/config.html?page=mobile`);
        await expect(second.locator('#settings-mobile-status')).toContainText(
            'Save outcome unknown',
        );
        await context.route(
            '**/api/config/mobile-appearance/fence',
            async (route) => {
                fences++;
                await route.fetch();
                await route.abort('failed');
            },
        );
        await Promise.all([
            page.locator('#settings-mobile-resolve').dispatchEvent('click'),
            second.locator('#settings-mobile-resolve').dispatchEvent('click'),
        ]);
        await expect.poll(() => fences).toBe(1);
        await second.close();
        await page.reload();
        await expect(page.locator('#settings-mobile-status')).toContainText(
            'Save outcome unknown',
        );
        expect(saves).toBe(1);
        expect(fences).toBe(1);
        await context.unroute('**/api/config/mobile-appearance/fence');
        // The persisted dispatch deadline is part of the protocol, not a UI timeout.
        await expect(page.locator('#settings-mobile-resolve')).toBeEnabled({
            timeout: 20_000,
        });
        await page.locator('#settings-mobile-resolve').click();
        await expect(page.locator('#settings-mobile-status')).toHaveText(
            'Saved',
        );
        expect(saves).toBe(1);
        await expect(page.locator('#settings-mobile-drafts')).toContainText(
            '19',
        );
    } finally {
        await context.close();
    }
});

for (const status of [401, 404]) {
    test(`a rejected ${status} fence cannot block an older held save or free its slot`, async ({
        browser,
    }) => {
        const context = await browser.newContext();
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        try {
            const page = await context.newPage();
            await mobileSettings(page);
            let saves = 0;
            await page.route(
                '**/api/config/mobile-appearance',
                async (route) => {
                    if (route.request().method() !== 'POST')
                        return route.continue();
                    saves++;
                    await held;
                    await route.continue();
                },
            );
            await page.route('**/api/config/mobile-appearance/fence', (route) =>
                route.fulfill({ status, body: 'fixture rejection' }),
            );
            await page.locator('#settings-mobile-ui-font-size').fill('21');
            await expect.poll(() => saves).toBe(1);
            await page.locator('#settings-mobile-resolve').click();
            await expect(page.locator('#settings-mobile-status')).toHaveText(
                'Resolve failed; save outcome still unknown',
            );
            await page.locator('#settings-mobile-ui-font-size').fill('22');
            release();
            await expect
                .poll(
                    async () =>
                        (
                            await (
                                await page.request.get(
                                    `${phi.url}/api/config/mobile-appearance`,
                                )
                            ).json()
                        ).ui_font_size,
                )
                .toBe(21);
            await expect(page.locator('#settings-mobile-status')).toHaveText(
                'Resolve failed; save outcome still unknown',
            );
            expect(saves).toBe(1);
            await page.unroute('**/api/config/mobile-appearance/fence');
            await page.locator('#settings-mobile-resolve').click();
            await expect(page.locator('#settings-mobile-resolve')).toBeHidden();
            await expect(
                page.locator('#settings-mobile-ui-font-size'),
            ).toHaveValue('22');
            expect(saves).toBe(1);
            await page.locator('#settings-mobile-save').click();
            await expect(page.locator('#settings-mobile-status')).toHaveText(
                'Saved',
            );
            expect(saves).toBe(2);
        } finally {
            release();
            await context.close();
        }
    });
}

test('an older save acknowledgment cannot clear a pending fence or newer edits', async ({
    browser,
}) => {
    const context = await browser.newContext();
    let releaseSave!: () => void, releaseFence!: () => void;
    const heldSave = new Promise<void>((resolve) => {
        releaseSave = resolve;
    });
    const heldFence = new Promise<void>((resolve) => {
        releaseFence = resolve;
    });
    try {
        const page = await context.newPage();
        await mobileSettings(page);
        let saves = 0,
            fences = 0;
        await page.route('**/api/config/mobile-appearance', async (route) => {
            if (route.request().method() === 'POST') {
                saves++;
                await heldSave;
            }
            await route.continue();
        });
        await page.route(
            '**/api/config/mobile-appearance/fence',
            async (route) => {
                fences++;
                await heldFence;
                await route.continue();
            },
        );
        await page.locator('#settings-mobile-ui-font-size').fill('20');
        await expect.poll(() => saves).toBe(1);
        await page.locator('#settings-mobile-resolve').click();
        await expect.poll(() => fences).toBe(1);
        await page.locator('#settings-mobile-ui-font-size').fill('22');
        releaseSave();
        await expect
            .poll(
                async () =>
                    (
                        await (
                            await page.request.get(
                                `${phi.url}/api/config/mobile-appearance`,
                            )
                        ).json()
                    ).ui_font_size,
            )
            .toBe(20);
        await expect(page.locator('#settings-mobile-status')).toContainText(
            'Save outcome unknown',
        );
        expect(saves).toBe(1);
        releaseFence();
        await expect(page.locator('#settings-mobile-resolve')).toBeHidden();
        await expect(page.locator('#settings-mobile-ui-font-size')).toHaveValue(
            '22',
        );
        await page.locator('#settings-mobile-save').click();
        await expect(page.locator('#settings-mobile-status')).toHaveText(
            'Saved',
        );
        expect(saves).toBe(2);
    } finally {
        releaseSave();
        releaseFence();
        await context.close();
    }
});

test('an old save reply cannot clear a different draft restored while it was pending', async ({
    browser,
}) => {
    const context = await browser.newContext({
        isMobile: true,
        hasTouch: true,
        userAgent: IPHONE,
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    try {
        const source = await context.newPage(),
            active = await context.newPage();
        await mobileSettings(source);
        await mobileSettings(active);
        await context.setOffline(true);
        await source.locator('#settings-mobile-ui-font-size').fill('23');
        await active.locator('#settings-mobile-ui-font-size').fill('21');
        await expect
            .poll(
                async () =>
                    (await persistedDrafts(active)).filter(
                        (draft) => Object.keys(draft.fields).length,
                    ).length,
            )
            .toBe(2);
        let posts = 0;
        await context.route(
            '**/api/config/mobile-appearance',
            async (route) => {
                if (route.request().method() === 'POST') {
                    posts++;
                    await held;
                }
                await route.continue();
            },
        );
        await context.setOffline(false);
        await expect(active.locator('#settings-mobile-drafts')).toContainText(
            '23',
        );
        expect(posts).toBe(0);
        await active.locator('#settings-mobile-save').click();
        await expect.poll(() => posts).toBe(1);
        await active
            .locator('.settings-recovery-entry')
            .filter({ hasText: '23' })
            .getByRole('button', { name: 'Restore', exact: true })
            .click();
        await expect(
            active.locator('#settings-mobile-ui-font-size'),
        ).toHaveValue('23');
        release();
        await expect(active.locator('#settings-mobile-save')).toBeEnabled();
        await expect(
            active.locator('#settings-mobile-ui-font-size'),
        ).toHaveValue('23');
        await expect.poll(() => fontSize(active)).toBe('23px');
        expect(posts).toBe(1);
        await active.locator('#settings-mobile-save').click();
        await expect(active.locator('#settings-mobile-status')).toHaveText(
            'Saved',
        );
        expect(posts).toBe(2);
    } finally {
        release();
        await context.close();
    }
});

test('two documents keep separate drafts despite cloned session storage', async ({
    browser,
}) => {
    const context = await browser.newContext();
    try {
        const first = await context.newPage(),
            second = await context.newPage();
        await mobileSettings(first);
        await mobileSettings(second);
        await first.evaluate(() =>
            sessionStorage.setItem('phi-mobile-draft', 'cloned'),
        );
        await second.evaluate(() =>
            sessionStorage.setItem('phi-mobile-draft', 'cloned'),
        );
        await context.setOffline(true);
        await first.locator('#settings-mobile-ui-font-size').fill('18');
        await second.locator('#settings-mobile-ui-font-size').fill('24');
        await expect
            .poll(
                async () =>
                    (await persistedDrafts(first)).filter(
                        (draft) => Object.keys(draft.fields).length,
                    ).length,
            )
            .toBe(2);
        await context.setOffline(false);
        await Promise.all([first.reload(), second.reload()]);
        await expect(first.locator('#settings-mobile-drafts')).toContainText(
            '18',
        );
        await expect(first.locator('#settings-mobile-drafts')).toContainText(
            '24',
        );
        await expect(second.locator('#settings-mobile-drafts')).toContainText(
            '18',
        );
        await expect(second.locator('#settings-mobile-drafts')).toContainText(
            '24',
        );
        const drafts = (await persistedDrafts(first)).filter(
            (draft) => Object.keys(draft.fields).length,
        );
        expect(new Set(drafts.map((draft) => draft.id)).size).toBe(2);
    } finally {
        await context.close();
    }
});

test('slow background reads and storage failure do not block local typing', async ({
    browser,
}) => {
    const context = await browser.newContext({
        isMobile: true,
        hasTouch: true,
        userAgent: IPHONE,
        viewport: { width: 390, height: 844 },
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    try {
        const page = await context.newPage();
        await page.goto(phi.url);
        await openDrawerSettings(page);
        await expect(page.locator('#settings-mobile-status')).toHaveText(
            'Saved',
        );
        const oldState = await (
            await page.request.get(`${phi.url}/api/config/mobile-appearance`)
        ).json();
        let heldReads = 0;
        await page.route('**/api/config/mobile-appearance', async (route) => {
            if (route.request().method() !== 'GET') return route.continue();
            heldReads++;
            await held;
            await new Promise((resolve) => setTimeout(resolve, 3000));
            await route.fulfill({ json: oldState });
        });
        await page.locator('.settings-overlay .modal-close-btn').click();
        await openDrawerSettings(page);
        await expect.poll(() => heldReads).toBeGreaterThan(0);
        await page.locator('#settings-mobile-ui-font-size').fill('21');
        await expect.poll(() => fontSize(page)).toBe('21px');
        await expect(page.locator('#settings-mobile-status')).toHaveText(
            'Saved',
        );
        const oldResponse = page.waitForResponse(
            (response) =>
                response.request().method() === 'GET' &&
                response.url().endsWith('/api/config/mobile-appearance'),
        );
        release();
        await (await oldResponse).finished();
        await expect.poll(() => fontSize(page)).toBe('21px');
        // Force a real browser transaction failure, not a fake IndexedDB library.
        await page.evaluate(() => {
            IDBDatabase.prototype.transaction = () => {
                throw new DOMException(
                    'fixture storage failure',
                    'UnknownError',
                );
            };
        });
        await page.locator('#settings-mobile-ui-font-size').fill('23');
        await expect.poll(() => fontSize(page)).toBe('23px');
        await expect(page.locator('#settings-mobile-status')).toContainText(
            'Changes remain in memory',
        );
    } finally {
        release();
        await context.close();
    }
});

test('wide touch tablets can choose a rendering profile and reach Mobile Settings', async ({
    browser,
}) => {
    const context = await browser.newContext({
        isMobile: true,
        hasTouch: true,
        userAgent:
            'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
        viewport: { width: 1024, height: 768 },
    });
    try {
        const page = await context.newPage();
        await page.goto(phi.url);
        await page.locator('#drawer-settings-btn').tap();
        await expect(
            page.locator('#settings-mobile-ui-font-size'),
        ).toBeVisible();
        await page
            .locator('#settings-appearance-profile')
            .selectOption('desktop');
        await expect(page.locator('html')).toHaveAttribute(
            'data-appearance-profile',
            'desktop',
        );
        await page.locator('#settings-mobile-view').tap();
        await expect(
            page.locator('#settings-mobile-ui-font-size'),
        ).toBeVisible();
        await page
            .locator('#settings-appearance-profile')
            .selectOption('mobile');
        await page.reload();
        await expect(page.locator('html')).toHaveAttribute(
            'data-appearance-profile',
            'mobile',
        );
    } finally {
        await context.close();
    }
});

test('fresh main-page Settings opens before shared config and version finish loading', async ({
    browser,
}) => {
    const context = await browser.newContext({
        isMobile: true,
        hasTouch: true,
        userAgent: IPHONE,
        viewport: { width: 390, height: 844 },
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    try {
        await context.route('**/api/config', async (route) => {
            await held;
            await route.continue();
        });
        await context.route('**/api/version', async (route) => {
            await held;
            await route.continue();
        });
        const page = await context.newPage();
        await page.goto(phi.url);
        await openDrawerSettings(page);
        await expect(
            page.locator('#settings-hostname-override'),
        ).toBeDisabled();
        await expect(
            page.locator('#settings-mobile-scrollback'),
        ).toBeDisabled();
        await expect(
            page.locator('#settings-mobile-ui-font-size'),
        ).toBeEnabled();
        await page.locator('#settings-mobile-ui-font-size').fill('21');
        await expect.poll(() => fontSize(page)).toBe('21px');
        release();
        await expect(page.locator('#settings-hostname-override')).toBeEnabled();
        await expect(page.locator('#settings-hostname-override')).toHaveValue(
            'fixture hostname',
        );
        await expect(page.locator('#settings-mobile-ui-font-size')).toHaveValue(
            '21',
        );
    } finally {
        release();
        await context.close();
    }
});

// Capture real xterm instances without replacing their renderer or protocol.
async function captureAppearanceTerminals(page: Page) {
    await page.addInitScript(() => {
        type Term = {
            element?: HTMLElement;
            options: { fontFamily: string; fontSize: number };
        };
        const target = window as unknown as { appearanceTerms: Term[] };
        target.appearanceTerms = [];
        let terminalCtor: new (options: unknown) => Term;
        Object.defineProperty(window, 'Terminal', {
            configurable: true,
            get: () => terminalCtor,
            set: (base: new (options: unknown) => Term) => {
                terminalCtor = class extends base {
                    constructor(options: unknown) {
                        super(options);
                        target.appearanceTerms.push(this);
                    }
                };
            },
        });
    });
}
async function terminalFamilies(page: Page) {
    return page.evaluate(() => {
        const terms = (
            window as unknown as {
                appearanceTerms: {
                    element?: HTMLElement;
                    options: { fontFamily: string; fontSize: number };
                }[];
            }
        ).appearanceTerms;
        return terms
            .filter((term) => term.element?.isConnected)
            .map((term) => ({
                family: term.options.fontFamily,
                size: term.options.fontSize,
                visibleWidth: term.element?.getBoundingClientRect().width || 0,
            }));
    });
}

test('four font overrides update real terminals, inherit remote desktop families and survive a process restart', async ({
    browser,
}) => {
    const desktop = await browser.newContext({
        viewport: { width: 1440, height: 900 },
    });
    const mobile = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        userAgent: IPHONE,
    });
    try {
        const pc = await desktop.newPage(),
            phone = await mobile.newPage();
        await pc.request.post(`${phi.url}/api/config/appearance`, {
            data: {
                ui_font_family: 'Inter, system-ui, sans-serif',
                ui_font_size: 16,
                terminal_font_family: 'monospace',
                terminal_font_size: 18,
            },
        });
        const state = await (
            await pc.request.get(`${phi.url}/api/config/mobile-appearance`)
        ).json();
        await pc.request.post(`${phi.url}/api/config/mobile-appearance`, {
            data: {
                revision: state.revision,
                fields: {
                    ui_font_family: null,
                    terminal_font_family: null,
                    ui_font_size: null,
                    terminal_font_size: null,
                },
            },
        });
        await phone.addInitScript(() =>
            localStorage.setItem(
                'phi_appearance',
                JSON.stringify({
                    ui_font_family: 'stale legacy',
                    terminal_font_family: 'stale terminal',
                    ui_font_size: 24,
                }),
            ),
        );
        await captureAppearanceTerminals(pc);
        await captureAppearanceTerminals(phone);
        await pc.goto(phi.url);
        await phone.goto(phi.url);
        await expect
            .poll(async () => (await terminalFamilies(pc)).length)
            .toBe(2);
        await expect
            .poll(async () => (await terminalFamilies(phone)).length)
            .toBe(2);
        await expect(phone.locator('body')).toHaveCSS('font-family', /Inter/);
        await expect
            .poll(async () =>
                (await terminalFamilies(phone)).every(
                    (term) => term.family === 'monospace',
                ),
            )
            .toBe(true);
        await pc.locator('#header-config-pill .pill-label').click();
        await pc
            .locator('#settings-ui-font')
            .selectOption('"Segoe UI", system-ui, sans-serif');
        // No reload or shared browser storage: the mobile poll must learn the server family.
        await expect(phone.locator('body')).toHaveCSS(
            'font-family',
            /Segoe UI/,
            { timeout: 15000 },
        );
        await openDrawerSettings(phone);
        await phone
            .locator('#settings-mobile-ui-font')
            .selectOption(
                JSON.stringify('system-ui, -apple-system, sans-serif'),
            );
        await phone
            .locator('#settings-mobile-term-font')
            .selectOption(JSON.stringify('monospace'));
        await phone.locator('#settings-mobile-ui-font-size').fill('20');
        await phone.locator('#settings-mobile-term-font-size').fill('22');
        await expect(phone.locator('#settings-mobile-status')).toHaveText(
            'Saved',
        );
        await expect(phone.locator('body')).toHaveCSS('font-size', '20px');
        await pc
            .locator('#settings-ui-font')
            .selectOption('"Helvetica Neue", Arial, sans-serif');
        await expect
            .poll(
                async () =>
                    (
                        await (
                            await pc.request.get(`${phi.url}/api/config`)
                        ).json()
                    ).ui_font_family,
            )
            .toContain('Helvetica Neue');
        await expect
            .poll(
                async () =>
                    phone
                        .locator('#settings-mobile-ui-font option')
                        .first()
                        .textContent(),
                { timeout: 15000 },
            )
            .toContain('Helvetica Neue');
        await expect(phone.locator('body')).toHaveCSS(
            'font-family',
            /system-ui, -apple-system/,
        );
        // Edit inactive mobile values from desktop; desktop terminal and UI must not preview them.
        await pc.locator('#settings-mobile-view').click();
        await pc
            .locator('#settings-mobile-ui-font')
            .selectOption(JSON.stringify('Inter, system-ui, sans-serif'));
        await pc
            .locator('#settings-mobile-term-font')
            .selectOption(
                JSON.stringify("'Fira Code', ui-monospace, monospace"),
            );
        await expect(pc.locator('#settings-mobile-status')).toHaveText('Saved');
        await expect(pc.locator('body')).toHaveCSS(
            'font-family',
            /Helvetica Neue/,
        );
        await expect(pc.locator('body')).toHaveCSS('font-size', '16px');
        await expect
            .poll(async () =>
                (await terminalFamilies(pc))
                    .filter((term) => term.visibleWidth > 0)
                    .every((term) => term.family === 'monospace'),
            )
            .toBe(true);
        await expect(phone.locator('body')).toHaveCSS('font-family', /Inter/, {
            timeout: 15000,
        });
        await expect
            .poll(async () =>
                (await terminalFamilies(phone)).some(
                    (term) =>
                        term.family.includes('Fira Code') &&
                        term.size >= 8 &&
                        term.size <= 22,
                ),
            )
            .toBe(true);
        await phone.keyboard.press('Escape');
        await expect(phone.locator('#term-t1 .xterm-screen')).toBeVisible();
        await pc.locator('.settings-overlay .modal-close-btn').click();
        await pc
            .locator('#coder-selector .coder-tab[data-coder="bash"]')
            .click();
        await expect
            .poll(async () => (await terminalFamilies(pc)).length)
            .toBe(3);
        await expect
            .poll(async () =>
                (await terminalFamilies(pc)).every(
                    (term) => term.family === 'monospace',
                ),
            )
            .toBe(true);
        const before = await (
            await pc.request.get(`${phi.url}/api/config/mobile-appearance`)
        ).json();
        expect(before).toMatchObject({
            ui_font_family: 'Inter, system-ui, sans-serif',
            ui_font_size: 20,
            terminal_font_family: "'Fira Code', ui-monospace, monospace",
            terminal_font_size: 22,
        });
        await pc.close();
        await phone.close();
        await phi.restart();
        const fresh = await browser.newContext({
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
            userAgent: IPHONE,
        });
        try {
            const restored = await fresh.newPage();
            await captureAppearanceTerminals(restored);
            await restored.goto(phi.url);
            await expect(restored.locator('body')).toHaveCSS(
                'font-size',
                '20px',
            );
            await expect(restored.locator('body')).toHaveCSS(
                'font-family',
                /Inter/,
            );
            await expect
                .poll(async () =>
                    (await terminalFamilies(restored))
                        .filter((term) => term.visibleWidth > 0)
                        .some((term) => term.family.includes('Fira Code')),
                )
                .toBe(true);
            expect(
                await (
                    await restored.request.get(
                        `${phi.url}/api/config/mobile-appearance`,
                    )
                ).json(),
            ).toEqual(before);
            const config = await (
                await restored.request.get(`${phi.url}/api/config`)
            ).json();
            expect(config).toMatchObject({
                ui_font_size: 16,
                terminal_font_size: 18,
                ui_font_family: '"Helvetica Neue", Arial, sans-serif',
                terminal_font_family: 'monospace',
            });
        } finally {
            await fresh.close();
        }
    } finally {
        await desktop.close();
        await mobile.close();
    }
});

test('real Pi RPC chat keeps terminal fonts through live edits, disconnection and restore', async ({
    browser,
}) => {
    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
    });
    let rpc: PhiServer | undefined;
    try {
        rpc = await startPhi({
            config: { pi_bridge_no_inject: true, auto_reconnect: 'off' },
            env: { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
            setup(dir) {
                const cwd = realpathSync(dir);
                const home = join(dir, 'home');
                const agent = join(home, '.pi', 'agent');
                mkdirSync(agent, { recursive: true });
                writeFileSync(
                    join(agent, 'settings.json'),
                    JSON.stringify({
                        defaultProjectTrust: 'never',
                        quietStartup: true,
                        enableInstallTelemetry: false,
                        cacheWarming: 'off',
                    }),
                );
                const bin = join(dir, 'bin');
                mkdirSync(bin);
                const binary = join(
                    process.cwd(),
                    'node_modules',
                    '.bin',
                    'pi',
                );
                const quoted = `'${binary.replaceAll("'", "'\\''")}'`;
                writeFileSync(
                    join(bin, 'pi'),
                    `#!/bin/sh\nexec ${quoted} --offline --no-extensions --no-skills --no-prompt-templates --no-context-files --no-approve --model anthropic/claude-sonnet-4-5 "$@"\n`,
                    { mode: 0o755 },
                );
                const encoded = cwd
                    .replaceAll('\\', '/')
                    .replace(/^\/+|\/+$/g, '')
                    .replace(/:/g, '-')
                    .replace(/\//g, '-');
                const sessions = join(agent, 'sessions', `--${encoded}--`);
                mkdirSync(sessions, { recursive: true });
                writeFileSync(
                    join(sessions, 'appearance.jsonl'),
                    [
                        {
                            type: 'session',
                            version: 3,
                            id: 'appearance-chat',
                            cwd,
                        },
                        { type: 'session_info', name: 'Appearance chat' },
                    ]
                        .map((entry) => JSON.stringify(entry))
                        .join('\n') + '\n',
                );
            },
        });
        const page = await context.newPage();
        await page.addInitScript(() =>
            localStorage.setItem('phi_appearance_profile', 'mobile'),
        );
        await page.goto(rpc.url);
        await page
            .locator('#coder-selector .coder-tab[data-coder="pi"]')
            .click();
        const row = page.locator(
            '.session-item[data-session-id="appearance-chat"]',
        );
        await row.hover();
        await row.locator('.review-btn').click();
        const chat = page
            .locator('.term-container')
            .filter({ has: page.locator('.review-chat-wrapper') });
        await expect(chat.locator('.review-header-coder').last()).toHaveText(
            'Ready',
            {
                timeout: 30000,
            },
        );
        await expect(chat).toHaveCSS('font-size', '14px');
        await page.locator('#header-config-pill .pill-label').click();
        await page
            .locator('#settings-mobile-term-font')
            .selectOption(JSON.stringify('monospace'));
        await page.locator('#settings-mobile-term-font-size').fill('20');
        await expect(chat).toHaveCSS('font-family', 'monospace');
        await expect(chat).toHaveCSS('font-size', '20px');
        await expect(page.locator('#settings-mobile-status')).toHaveText(
            'Saved',
        );
        await context.setOffline(true);
        await page.locator('#settings-mobile-term-font-size').fill('23');
        await expect(chat).toHaveCSS('font-size', '23px');
        await context.setOffline(false);
        await expect(page.locator('#settings-mobile-status')).toHaveText(
            'Saved',
        );
        await page.reload();
        await expect(chat).toBeVisible({ timeout: 30000 });
        await expect(chat).toHaveCSS('font-family', 'monospace');
        await expect(chat).toHaveCSS('font-size', '23px');
        await expect(page.locator('body')).toHaveCSS('font-size', '17px');
    } finally {
        await context.close();
        await rpc?.stop();
    }
});

test('offline mobile reset preserves desktop fields and browser-local font/background blobs', async ({
    browser,
}) => {
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        userAgent: IPHONE,
    });
    try {
        const page = await context.newPage();
        await mobileSettings(page);
        const before = await (
            await page.request.get(`${phi.url}/api/config`)
        ).json();
        await page.evaluate(
            () =>
                new Promise<void>((resolve, reject) => {
                    const open = indexedDB.open('phi', 2);
                    open.onupgradeneeded = () => {
                        for (const name of ['fonts', 'backgrounds'])
                            if (!open.result.objectStoreNames.contains(name))
                                open.result.createObjectStore(name);
                    };
                    open.onerror = () => reject(open.error);
                    open.onsuccess = () => {
                        const db = open.result,
                            tx = db.transaction(
                                ['fonts', 'backgrounds'],
                                'readwrite',
                            );
                        tx.objectStore('fonts').put(
                            {
                                displayName: 'retained font',
                                blob: new Blob(['font bytes']),
                            },
                            'custom',
                        );
                        tx.objectStore('backgrounds').put(
                            {
                                displayName: 'retained background',
                                blob: new Blob(['background bytes']),
                            },
                            'custom_bg',
                        );
                        tx.oncomplete = () => {
                            db.close();
                            resolve();
                        };
                        tx.onerror = () => reject(tx.error);
                    };
                }),
        );
        await context.setOffline(true);
        await page.locator('#settings-mobile-reset').click();
        await expect(page.locator('body')).toHaveCSS('font-size', '17px');
        await expect(
            page.locator('#settings-mobile-term-font-size'),
        ).toHaveValue('14');
        await expect
            .poll(async () =>
                (await persistedDrafts(page)).some(
                    (draft) =>
                        Object.keys(draft.fields).length === 4 &&
                        Object.values(draft.fields).every(
                            (value) => value === null,
                        ),
                ),
            )
            .toBe(true);
        await context.setOffline(false);
        await expect(page.locator('#settings-mobile-status')).toHaveText(
            'Saved',
            { timeout: 15000 },
        );
        await page.reload();
        await expect(page.locator('#settings-mobile-status')).toHaveText(
            'Saved',
        );
        const after = await (
            await page.request.get(`${phi.url}/api/config`)
        ).json();
        for (const key of [
            'ui_font_size',
            'terminal_font_size',
            'ui_font_family',
            'terminal_font_family',
        ])
            expect(after[key]).toEqual(before[key]);
        const blobs = await page.evaluate(
            () =>
                new Promise<string[]>((resolve, reject) => {
                    const open = indexedDB.open('phi', 2);
                    open.onerror = () => reject(open.error);
                    open.onsuccess = () => {
                        const db = open.result,
                            tx = db.transaction(['fonts', 'backgrounds']);
                        const font = tx.objectStore('fonts').get('custom'),
                            bg = tx.objectStore('backgrounds').get('custom_bg');
                        tx.oncomplete = () => {
                            db.close();
                            void Promise.all([
                                font.result.blob.text(),
                                bg.result.blob.text(),
                            ]).then(resolve, reject);
                        };
                        tx.onerror = () => reject(tx.error);
                    };
                }),
        );
        expect(blobs).toEqual(['font bytes', 'background bytes']);
        expect(
            await (
                await page.request.get(
                    `${phi.url}/api/config/mobile-appearance`,
                )
            ).json(),
        ).toMatchObject({
            ui_font_family: null,
            terminal_font_family: null,
            ui_font_size: null,
            terminal_font_size: null,
        });
    } finally {
        await context.close();
    }
});

test('missing custom fonts remain selected and reset waits for explicit resolution of an unknown save', async ({
    browser,
}) => {
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        userAgent: IPHONE,
    });
    try {
        const page = await context.newPage();
        const state = await (
            await page.request.get(`${phi.url}/api/config/mobile-appearance`)
        ).json();
        await page.request.post(`${phi.url}/api/config/mobile-appearance`, {
            data: {
                revision: state.revision,
                fields: {
                    ui_font_family: 'Phi Custom Font',
                    terminal_font_family: 'Phi Custom Font',
                },
            },
        });
        await mobileSettings(page);
        await expect(page.locator('#settings-mobile-ui-font')).toHaveValue(
            JSON.stringify('Phi Custom Font'),
        );
        await expect(page.locator('#settings-mobile-font-note')).toContainText(
            'Saved font unavailable on this device',
        );
        await expect(page.locator('body')).toHaveCSS(
            'font-family',
            /sans-serif/,
        );
        let writes = 0;
        await context.route(
            '**/api/config/mobile-appearance',
            async (route) => {
                if (route.request().method() !== 'POST') {
                    await route.continue();
                    return;
                }
                writes++;
                await route.fetch();
                await route.abort('failed');
            },
        );
        await page.locator('#settings-mobile-ui-font-size').fill('21');
        await expect(page.locator('#settings-mobile-status')).toHaveText(
            'Save outcome unknown',
        );
        await page.locator('#settings-mobile-reset').click();
        await expect(page.locator('body')).toHaveCSS('font-size', '17px');
        await expect(page.locator('#settings-mobile-save')).toBeDisabled();
        await page.waitForTimeout(400);
        expect(writes).toBe(1);
        await context.unroute('**/api/config/mobile-appearance');
        await page.locator('#settings-mobile-resolve').click();
        await expect(page.locator('#settings-mobile-save')).toBeEnabled();
        await page.locator('#settings-mobile-save').click();
        await expect(page.locator('#settings-mobile-status')).toHaveText(
            'Saved',
        );
        expect(
            await (
                await page.request.get(
                    `${phi.url}/api/config/mobile-appearance`,
                )
            ).json(),
        ).toMatchObject({
            ui_font_family: null,
            terminal_font_family: null,
            ui_font_size: null,
            terminal_font_size: null,
        });
    } finally {
        await context.close();
    }
});

for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
]) {
    test(`mobile typography and Settings remain reachable at ${viewport.width}x${viewport.height}`, async ({
        browser,
    }) => {
        const context = await browser.newContext({
            viewport,
            userAgent: IPHONE,
            isMobile: true,
            hasTouch: true,
        });
        try {
            const page = await context.newPage();
            await captureAppearanceTerminals(page);
            await page.goto(phi.url);
            // The restart case also persists a newly opened shell; require shell + diff, not a fixed total.
            await expect
                .poll(async () => (await terminalFamilies(page)).length, {
                    timeout: 30_000,
                })
                .toBeGreaterThanOrEqual(2);
            await openDrawerSettings(page);
            await expect(
                page.getByRole('dialog', { name: 'Phi Settings' }),
            ).toBeVisible();
            const terminalSizes = (await terminalFamilies(page)).map(
                (term) => term.size,
            );
            for (const value of ['10', '17', '24']) {
                await page.locator('#settings-mobile-ui-font-size').fill(value);
                await expect(page.locator('body')).toHaveCSS(
                    'font-size',
                    `${value}px`,
                );
                await expect(
                    page.locator('label[for="settings-mobile-ui-font-size"]'),
                ).toHaveCSS('font-size', `${value}px`);
                await expect(
                    page.locator('#settings-mobile-ui-font-size'),
                ).toHaveCSS('font-size', `${Math.max(16, Number(value))}px`);
                await expect(
                    page.locator('#settings-mobile-status'),
                ).toHaveText('Saved');
            }
            // A measured 34px system body is the 200% equivalent; actual iOS is checked separately.
            await page.locator('#phi-system-text-probe').evaluate((el) => {
                el.style.fontSize = '34px';
            });
            await expect(page.locator('body')).toHaveCSS('font-size', '48px');
            await expect(
                page.locator('#settings-mobile-ui-font-size'),
            ).toHaveCSS('font-size', '48px');
            expect(
                (await terminalFamilies(page)).map((term) => term.size),
            ).toEqual(terminalSizes);
            for (const color of ['purple', 'white']) {
                await page
                    .locator(`.settings-swatch[data-color="${color}"]`)
                    .tap();
                await page.locator('#settings-font-upload').setInputFiles({
                    name: 'fixture.ttf',
                    mimeType: 'font/ttf',
                    buffer: Buffer.from('fixture font'),
                });
                await page.locator('#settings-bg-upload').setInputFiles({
                    name: 'fixture.png',
                    mimeType: 'image/png',
                    buffer: Buffer.from(
                        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7WQAAAAASUVORK5CYII=',
                        'base64',
                    ),
                });
                await expect(page.locator('#settings-bg-remove')).toBeVisible();
                await page.locator('#settings-bg-remove').tap();
                await page
                    .locator('#settings-mobile-reset')
                    .scrollIntoViewIfNeeded();
                await expect(
                    page.locator('#settings-mobile-reset'),
                ).toBeInViewport();
                await page
                    .locator('#settings-access-new')
                    .scrollIntoViewIfNeeded();
                await expect(
                    page.locator('#settings-access-new'),
                ).toBeInViewport();
                const overflow = await page.evaluate(() =>
                    [
                        document.documentElement,
                        document.querySelector('.settings-modal')!,
                        document.querySelector('.settings-body')!,
                    ].map((el) => el.scrollWidth - el.clientWidth),
                );
                expect(
                    overflow.every((width) => width <= 1),
                    JSON.stringify(overflow),
                ).toBe(true);
                await expect(
                    page.locator('.settings-footer button'),
                ).toBeInViewport();
                await expect(
                    page.locator('.settings-header .modal-close-btn'),
                ).toBeInViewport();
            }
            const close = page.locator('.settings-overlay .modal-close-btn');
            await close.focus();
            await page.keyboard.press('Shift+Tab');
            await expect(page.locator('.settings-footer button')).toBeFocused();
            await page.keyboard.press('Tab');
            await expect(close).toBeFocused();
            await page.keyboard.press('Escape');
            await expect(page.locator('.settings-overlay')).toHaveCount(0);
            await expect(page.locator('#mobile-sidebar-toggle')).toBeFocused();
            for (const sessions of [false, true]) {
                await page.locator('#mobile-sidebar-toggle').tap();
                if (sessions) await page.locator('#drawer-open-sessions').tap();
                const button = page.locator('#drawer-settings-btn');
                await expect(button).toBeInViewport();
                const bounds = await button.boundingBox();
                expect(bounds!.width).toBeGreaterThanOrEqual(44);
                expect(bounds!.height).toBeGreaterThanOrEqual(44);
                await button.tap();
                await expect(
                    page.locator('#settings-mobile-ui-font-size'),
                ).toBeVisible();
                await page.keyboard.press('Escape');
            }
        } finally {
            await context.close();
        }
    });
}

test('auth-status-offline startup remains locked without deleting retained drafts', async ({
    browser,
}) => {
    const context = await browser.newContext();
    try {
        const first = await context.newPage();
        await mobileSettings(first);
        await context.setOffline(true);
        await first.locator('#settings-mobile-ui-font-size').fill('24');
        await expect
            .poll(async () =>
                (await persistedDrafts(first)).some(
                    (draft) => draft.fields.ui_font_size === 24,
                ),
            )
            .toBe(true);
        await first.close();
        await context.setOffline(false);
        await context.route('**/api/auth/status', (route) =>
            route.abort('failed'),
        );
        const recovery = await context.newPage();
        await recovery.goto(`${phi.url}/config.html?page=mobile`);
        await expect(recovery.locator('body')).toContainText(
            'Unable to open Settings',
        );
        await expect(recovery.locator('.settings-overlay')).toHaveCount(0);
        expect(
            (await persistedDrafts(recovery)).some(
                (draft) => draft.fields.ui_font_size === 24,
            ),
        ).toBe(true);
        await context.unroute('**/api/auth/status');
        await recovery.reload();
        await expect(recovery.locator('#settings-mobile-drafts')).toContainText(
            '24',
        );
        await expect(recovery.locator('#settings-mobile-status')).toHaveText(
            'Saved',
        );
    } finally {
        await context.close();
    }
});
