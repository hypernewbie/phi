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
            expect((await models.boundingBox())!.height).toBe(24);
            await page.unroute('**/picker-fixture');
        }
    } finally {
        await context.close();
    }
});

// Real picker code and stylesheet; synthetic catalog, no provider calls.
const fixture = `<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/style.css">
<div class="terminal-content" style="position:relative;width:100%;height:100dvh">
  <div id="presets-container" class="presets-container" style="position:absolute;bottom:0;width:100%"></div>
  <div id="pi-rpc-model-dropup" class="model-presets-dropup hidden"></div>
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
tm.app = { codersPresetRegistry: {}, showToast: () => {} };
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
            const box = await picker.boundingBox();
            expect(box).not.toBeNull();
            if (mobile) {
                expect(box!.width).toBeGreaterThan(350);
                expect(box!.height).toBeGreaterThan(450);
                expect(box!.x).toBeGreaterThanOrEqual(0);
                expect(box!.x + box!.width).toBeLessThanOrEqual(390);
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
                    (await choice.boundingBox())!.height,
                ).toBeGreaterThanOrEqual(44);
                expect(
                    (await picker
                        .locator('.pi-rpc-model-star')
                        .first()
                        .boundingBox())!.width,
                ).toBeGreaterThanOrEqual(44);
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
                // Right edge used to be inert identity text. It now selects.
                const choiceBox = (await choice.boundingBox())!;
                await page.touchscreen.tap(
                    choiceBox.x + choiceBox.width - 5,
                    choiceBox.y + choiceBox.height / 2,
                );
            } else {
                expect(box!.width).toBe(420);
                await expect(
                    choice.locator('.pi-model-name-compact'),
                ).toBeHidden();
                await expect(choice.locator('.pi-model-name-full')).toHaveText(
                    'vendor/model-0',
                );
                await expect(
                    choice.locator('.pi-rpc-dropup-meta'),
                ).toBeVisible();
                await choice.locator('.pi-rpc-dropup-meta').click();
            }
            await expect(page.locator('body')).toHaveAttribute(
                'data-selected',
                'router/vendor/model-0',
            );
            await expect(picker).toBeHidden();
        } finally {
            await context.close();
        }
    }
});
