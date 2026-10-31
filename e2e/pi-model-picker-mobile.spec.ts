import { expect, test } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

let phi: PhiServer;
test.beforeAll(async () => {
    phi = await startPhi();
});
test.afterAll(async () => phi.stop());

test('mobile Models and Cmds chips have matching metrics for terminal and RPC tabs', async ({
    browser,
}) => {
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
    });
    try {
        const page = await context.newPage();
        for (const coder of ['pi', 'pi-rpc']) {
            await page.route('**/picker-fixture', (route) =>
                route.fulfill({
                    contentType: 'text/html',
                    body: fixture.replace("coder: 'pi'", `coder: '${coder}'`),
                }),
            );
            await page.goto(`${phi.url}/picker-fixture`);
            const models = page.locator('.pi-rpc-model-trigger');
            const cmds = page
                .locator('.model-trigger-btn')
                .filter({ hasText: 'Cmds' });
            await expect(models).toBeVisible();
            const metrics = (el: Element) => {
                const style = getComputedStyle(el);
                return {
                    height: el.getBoundingClientRect().height,
                    fontSize: style.fontSize,
                    lineHeight: style.lineHeight,
                    padding: style.padding,
                };
            };
            expect(await models.evaluate(metrics)).toEqual(
                await cmds.evaluate(metrics),
            );
            expect((await models.boundingBox())?.height).toBe(24);
            await page.unroute('**/picker-fixture');
        }
    } finally {
        await context.close();
    }
});

test('missing Pi model capability keeps the legacy picker available', async ({
    browser,
}) => {
    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
    });
    try {
        const page = await context.newPage();
        await page.route('**/picker-fixture', (route) =>
            route.fulfill({
                contentType: 'text/html',
                body: fixture.replace(
                    "capabilities: ['pi.models.v1']",
                    'capabilities: []',
                ),
            }),
        );
        await page.goto(`${phi.url}/picker-fixture`);
        const legacyTrigger = page.getByRole('button', {
            name: '🤖 Models ▾',
        });
        await expect(legacyTrigger).toBeVisible();
        await expect(legacyTrigger).not.toHaveClass(/pi-rpc-model-trigger/);
        await legacyTrigger.click();
        await expect(page.locator('#model-presets-dropup')).toBeVisible();
        await expect(page.locator('#pi-rpc-model-dropup')).toBeHidden();
    } finally {
        await context.close();
    }
});

test('slow lists stay visible, offline picks wait, and lost acks are never replayed', async ({
    browser,
}) => {
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
    });
    let releaseModelRefresh = () => {};
    try {
        const page = await context.newPage();
        await page.route('**/picker-fixture', (route) =>
            route.fulfill({
                contentType: 'text/html',
                body: fixture
                    .replace('tm._piBridgeModelsFetch =', 'tm._unusedFetch =')
                    .replace('tm._piBridgeModelSwitch =', 'tm._unusedSwitch ='),
            }),
        );
        let modelReads = 0;
        let holdModelRefresh = false;
        let modelRefreshPending = false;
        const modelRefreshGate = new Promise<void>((resolve) => {
            releaseModelRefresh = resolve;
        });
        await page.route('**/api/pi-bridge/models?*', async (route) => {
            if (holdModelRefresh) {
                holdModelRefresh = false;
                modelRefreshPending = true;
                await modelRefreshGate;
                await route.fulfill({
                    status: 500,
                    contentType: 'application/json',
                    body: JSON.stringify({ error: 'catalog refresh failed' }),
                });
                return;
            }
            // Longer than the old one-second browser cutoff: the picker
            // must stay on its loading row instead of failing silently.
            if (modelReads++ === 0)
                await new Promise((resolve) => setTimeout(resolve, 1800));
            await route.fulfill({
                json: {
                    models: [{ provider: 'router', id: 'vendor/model-1' }],
                },
            });
        });
        let posts = 0;
        await page.route('**/api/pi-bridge/model', async (route) => {
            posts++;
            if (posts === 1) {
                await new Promise((resolve) => setTimeout(resolve, 500));
                return route.fulfill({ json: { ok: true, reason: '' } });
            }
            // The request left the browser but its reply never arrives:
            // the outcome is unknown and must never be replayed.
            await new Promise((resolve) => setTimeout(resolve, 300));
            return route.abort('failed');
        });
        await page.goto(`${phi.url}/picker-fixture`);
        const trigger = page.locator('.pi-rpc-model-trigger');
        const picker = page.locator('#pi-rpc-model-dropup');
        const lastToast = () =>
            page.evaluate(
                () =>
                    (
                        window as unknown as {
                            __toasts?: Array<{ message?: string }>;
                        }
                    ).__toasts?.at(-1)?.message || '',
            );

        await trigger.tap();
        await expect(picker.getByText('Loading Pi models…')).toBeVisible();
        await expect(picker.locator('.dropup-model-btn')).toBeVisible({
            timeout: 5000,
        });

        // A pick made offline is held and announced, never silently lost.
        await context.setOffline(true);
        await picker.locator('.dropup-model-btn').tap();
        await expect(picker).toBeHidden();
        await expect.poll(lastToast).toContain('queued');
        expect(posts).toBe(0);

        // The cached catalog makes the menu usable offline.
        await trigger.tap();
        await expect(picker.locator('.dropup-model-btn')).toBeVisible();
        await trigger.tap();

        // Reconnecting sends exactly the held pick.
        await context.setOffline(false);
        await expect.poll(() => posts).toBe(1);
        await page.waitForTimeout(800);

        // A failed background refresh keeps the cached row and search input.
        holdModelRefresh = true;
        await trigger.tap();
        const search = picker.locator('.pi-rpc-model-search');
        const modelRow = picker.locator('.dropup-model-btn');
        await expect(modelRow).toBeVisible();
        await expect.poll(() => modelRefreshPending).toBe(true);
        await search.fill('model-1');
        await expect(modelRow).toHaveCount(1);
        await expect(search).toBeFocused();
        releaseModelRefresh();
        await expect(picker.locator('.pi-rpc-dropup-message')).toContainText(
            'Could not refresh',
        );
        await expect(modelRow).toHaveCount(1);
        await expect(search).toHaveValue('model-1');
        await expect(search).toBeFocused();
        await trigger.tap();

        // A dispatched change whose ack is lost reports unknown once and
        // is never automatically sent again.
        await trigger.tap();
        await expect(picker.locator('.dropup-model-btn')).toBeVisible();
        await picker.locator('.dropup-model-btn').tap();
        await expect.poll(lastToast).toContain('unknown — reopen the picker');
        await expect(picker).toBeHidden();
        await trigger.tap();
        await expect(picker.locator('.dropup-model-btn')).toBeVisible();
        expect(posts).toBe(2);
    } finally {
        releaseModelRefresh();
        await context.close();
    }
});

test('long desktop model identities leave room for the name and stay inside the row', async ({
    page,
}) => {
    const modelPrefix =
        'vendor/some-extremely-long-model-family-and-variant-name-with-extended-context-2026-10-31-';
    const modelId = `${modelPrefix}0`;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route('**/picker-fixture', (route) =>
        route.fulfill({
            contentType: 'text/html',
            body: fixture.replace(
                "'vendor/model-' + i",
                `${JSON.stringify(modelPrefix)} + i`,
            ),
        }),
    );
    await page.goto(`${phi.url}/picker-fixture`);
    await page.locator('.pi-rpc-model-trigger').click();
    const choice = page
        .locator('#pi-rpc-model-dropup .dropup-model-btn')
        .first();
    await expect(choice).toBeVisible();
    await expect(choice).toHaveAttribute('title', `router/${modelId}`);
    await expect(choice.locator('.pi-model-name-full')).toHaveText(modelId);
    const geometry = await choice.evaluate((button) => {
        const name = button.querySelector('.pi-model-name-full')!;
        const meta = button.querySelector('.pi-rpc-dropup-meta')!;
        const rect = button.getBoundingClientRect();
        return {
            nameWidth: name.getBoundingClientRect().width,
            metaRight: meta.getBoundingClientRect().right,
            buttonRight: rect.right,
            scrollWidth: button.scrollWidth,
            clientWidth: button.clientWidth,
        };
    });
    expect(geometry.nameWidth).toBeGreaterThan(0);
    expect(geometry.metaRight).toBeLessThanOrEqual(geometry.buttonRight);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
    await choice.locator('.pi-rpc-dropup-meta').click();
    await expect(page.locator('body')).toHaveAttribute(
        'data-selected',
        `router/${modelId}`,
    );
});

// Real picker code and stylesheet; synthetic catalog, no provider calls.
const fixture = `<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/style.css">
<div class="terminal-content" style="position:relative;width:100%;height:100dvh">
  <div id="presets-container" class="presets-container" style="position:absolute;bottom:0;width:100%"></div>
  <div id="pi-rpc-model-dropup" class="model-presets-dropup hidden"></div>
  <div id="model-presets-dropup" class="model-presets-dropup hidden"></div>
</div>
<script type="module">
import { TabManager } from '/terminal.js';
const tm = Object.create(TabManager.prototype);
const ws = {};
const tab = { paneId: 'test-pane', coder: 'pi', ws, _piBridgeFresh: ws,
  piBridge: {state: 'managed', connected: true, model: 'router/vendor/model-0',
    capabilities: ['pi.models.v1']} };
tm.tabs = new Map([[tab.paneId, tab]]);
tm.getActiveTab = () => tab;
window.__toasts = [];
tm.app = { codersPresetRegistry: {}, showToast: (message, options) => {
  window.__toasts.push({ message, options }); } };
tm.presetsContainer = document.getElementById('presets-container');
tm._piRpcMenuRequest = 0;
tm._piBridgeModelsFetch = async () => ({models: Array.from({length: 30}, (_, i) =>
  ({provider: 'router', id: 'vendor/model-' + i}))});
tm._piBridgeModelSwitch = async (_pane, provider, model) => {
  document.body.dataset.selected = provider + '/' + model;
};
tm.renderPresets('pi');
</script>`;

test('phone picker uses short names, wide rows, scrolling and full-width tap targets; desktop keeps identities', async ({
    browser,
}) => {
    for (const mobile of [true, false]) {
        const context = await browser.newContext({
            viewport: mobile
                ? { width: 390, height: 844 }
                : { width: 1440, height: 900 },
            isMobile: mobile,
            hasTouch: mobile,
        });
        try {
            const page = await context.newPage();
            await page.route('**/picker-fixture', (route) =>
                route.fulfill({ contentType: 'text/html', body: fixture }),
            );
            await page.goto(`${phi.url}/picker-fixture`);
            const trigger = page.locator('.pi-rpc-model-trigger');
            await trigger.click();
            const picker = page.locator('#pi-rpc-model-dropup');
            const choice = picker.locator('.dropup-model-btn').first();
            await expect(choice).toBeVisible();
            await expect(choice).toHaveAttribute(
                'title',
                'router/vendor/model-0',
            );
            const compactHeight = await page.evaluate(() => {
                const probe = document.createElement('div');
                probe.style.cssText =
                    'position:fixed;visibility:hidden;width:1px;height:var(--btn-compact-height)';
                document.body.appendChild(probe);
                const height = probe.getBoundingClientRect().height;
                probe.remove();
                return height;
            });
            const expectedHeight = mobile ? 44 : 32;
            expect(compactHeight).toBe(expectedHeight);
            const box = await picker.boundingBox();
            if (!box) throw new Error('Picker has no bounds');
            const groupToggle = picker
                .locator('.pi-rpc-model-group-toggle')
                .first();
            const star = picker.locator('.pi-rpc-model-star').first();
            const rowBox = await choice.boundingBox();
            const starBox = await star.boundingBox();
            const groupBox = await groupToggle.boundingBox();
            if (!rowBox || !starBox || !groupBox) {
                throw new Error('Picker control has no bounds');
            }
            expect(
                Math.abs(rowBox.height - expectedHeight),
            ).toBeLessThanOrEqual(1);
            expect(
                Math.abs(starBox.width - expectedHeight),
            ).toBeLessThanOrEqual(1);
            expect(
                Math.abs(starBox.height - expectedHeight),
            ).toBeLessThanOrEqual(1);
            expect(
                Math.abs(groupBox.height - expectedHeight),
            ).toBeLessThanOrEqual(1);
            await expect(groupToggle).toHaveAttribute('aria-expanded', 'true');
            if (mobile) {
                expect(box.width).toBeGreaterThan(350);
                expect(box.height).toBeGreaterThan(450);
                expect(box.x).toBeGreaterThanOrEqual(0);
                expect(box.x + box.width).toBeLessThanOrEqual(390);
                await expect(
                    choice.locator('.pi-model-name-compact'),
                ).toHaveText('model-0');
                await expect(
                    choice.locator('.pi-model-name-full'),
                ).toBeHidden();
                await expect(
                    choice.locator('.pi-rpc-dropup-meta'),
                ).toBeHidden();
                await expect(
                    picker.locator('.dropup-header .pi-model-name-compact'),
                ).toHaveText('Model · model-0');
                expect(
                    await picker
                        .locator('.pi-rpc-model-search')
                        .evaluate((el) => getComputedStyle(el).fontSize),
                ).toBe('16px');
                const list = picker.locator('.pi-rpc-model-list-container');
                expect(
                    await list.evaluate(
                        (el) => el.scrollHeight > el.clientHeight,
                    ),
                ).toBe(true);
            } else {
                expect(box.width).toBe(420);
                await expect(
                    choice.locator('.pi-model-name-compact'),
                ).toBeHidden();
                await expect(choice.locator('.pi-model-name-full')).toHaveText(
                    'vendor/model-0',
                );
                await expect(
                    choice.locator('.pi-rpc-dropup-meta'),
                ).toBeVisible();
            }
            await groupToggle.click();
            const collapsedGroup = picker
                .locator('.pi-rpc-model-group-toggle')
                .first();
            await expect(collapsedGroup).toHaveAttribute(
                'aria-expanded',
                'false',
            );
            await expect(
                picker.locator('.dropup-model-btn').first(),
            ).toBeHidden();
            await collapsedGroup.click();
            const expandedGroup = picker
                .locator('.pi-rpc-model-group-toggle')
                .first();
            await expect(expandedGroup).toHaveAttribute(
                'aria-expanded',
                'true',
            );
            await picker.locator('.pi-rpc-model-star').first().click();
            await expect(
                picker.locator('.pi-rpc-model-star').first(),
            ).toHaveAttribute('aria-pressed', 'true');
            expect(
                await page.locator('body').getAttribute('data-selected'),
            ).toBeNull();
            const selectionChoice = picker.locator('.dropup-model-btn').first();
            if (mobile) {
                // Right edge used to be inert identity text. It now selects.
                const choiceBox = await selectionChoice.boundingBox();
                if (!choiceBox) throw new Error('Choice has no bounds');
                await page.touchscreen.tap(
                    choiceBox.x + choiceBox.width - 5,
                    choiceBox.y + choiceBox.height / 2,
                );
            } else {
                await selectionChoice.locator('.pi-rpc-dropup-meta').click();
            }
            await expect(page.locator('body')).toHaveAttribute(
                'data-selected',
                'router/vendor/model-0',
            );
            await expect(picker).toBeHidden();
            if (mobile) {
                await page.setViewportSize({ width: 932, height: 430 });
                await trigger.tap();
                await expect(picker).toBeVisible();
                const landscape = await picker.boundingBox();
                expect(landscape?.width).toBe(480);
                expect(landscape?.height).toBeLessThanOrEqual(430 * 0.68 + 1);
                // The visual-viewport cap also leaves a scrollable list when
                // a phone keyboard reduces the available vertical space.
                await page.evaluate(() =>
                    document.documentElement.style.setProperty(
                        '--vv-height',
                        '300px',
                    ),
                );
                await expect
                    .poll(async () => (await picker.boundingBox())?.height)
                    .toBeLessThanOrEqual(205);
                expect(
                    await picker
                        .locator('.pi-rpc-model-list-container')
                        .evaluate((el) => el.scrollHeight > el.clientHeight),
                ).toBe(true);
            }
        } finally {
            await context.close();
        }
    }
});
