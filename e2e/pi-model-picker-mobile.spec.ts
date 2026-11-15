import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startPhi, type PhiServer } from './_server.js';

let phi: PhiServer;
test.beforeAll(async () => {
    phi = await startPhi();
});
test.afterAll(async () => phi.stop());

// Keep fixture evidence for a failed run: phi.stop() removes the owned
// ephemeral directory, so the log and identity must be attached first.
// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructuring pattern for hooks
test.afterEach(async ({}, testInfo) => {
    if (!phi || testInfo.status === testInfo.expectedStatus) return;
    if (existsSync(phi.logPath))
        await testInfo.attach('server.log', {
            path: phi.logPath,
            contentType: 'text/plain',
        });
    const identity = join(phi.dir, 'server-identity.json');
    if (existsSync(identity))
        await testInfo.attach('server-identity.json', {
            path: identity,
            contentType: 'application/json',
        });
});

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
            const root = await page.evaluate(() =>
                parseFloat(getComputedStyle(document.documentElement).fontSize),
            );
            expect((await models.boundingBox())?.height).toBe(root * 2);
            await page.unroute('**/picker-fixture');
        }
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
        await page.route('**/api/pi-bridge/models?*', async (route) => {
            // Longer than the old one-second browser cutoff: the picker
            // must stay on its loading row instead of failing silently.
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
        await context.close();
    }
});

// Real picker code and stylesheet; synthetic catalog, no provider calls.
// prepaint publishes the root font size exactly as every real page does,
// so the authored rem ladder renders at the configured size.
const fixture = `<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/style.css">
<script type="module" src="/prepaint.js"></script>
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
            const box = await picker.boundingBox();
            if (!box) throw new Error('Picker has no bounds');
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
                    (await choice.boundingBox())?.height,
                ).toBeGreaterThanOrEqual(44);
                expect(
                    (
                        await picker
                            .locator('.pi-rpc-model-star')
                            .first()
                            .boundingBox()
                    )?.width,
                ).toBeGreaterThanOrEqual(44);
                // iOS zooms a page when a focused field is smaller than
                // 16px, so that is the invariant, not one exact size: the
                // field still scales with a larger UI setting.
                expect(
                    Number.parseFloat(
                        await picker
                            .locator('.pi-rpc-model-search')
                            .evaluate((el) => getComputedStyle(el).fontSize),
                    ),
                ).toBeGreaterThanOrEqual(16);
                const list = picker.locator('.pi-rpc-model-list-container');
                expect(
                    await list.evaluate(
                        (el) => el.scrollHeight > el.clientHeight,
                    ),
                ).toBe(true);
                // Right edge used to be inert identity text. It now selects.
                const choiceBox = await choice.boundingBox();
                if (!choiceBox) throw new Error('Choice has no bounds');
                await page.touchscreen.tap(
                    choiceBox.x + choiceBox.width - 5,
                    choiceBox.y + choiceBox.height / 2,
                );
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
                await choice.locator('.pi-rpc-dropup-meta').click();
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

// Compact Pi proof: the real compiled module, stylesheet, and vendored SVG
// are served over HTTP by phi. The synthetic page supplies only the state a
// live bridge or RPC session would have set.
function compactPillsFixture(mode: 'bridge' | 'rpc'): string {
    const state =
        mode === 'bridge'
            ? `const ws = {};
const tab = {
  paneId: 'pill-pane',
  coder: 'pi',
  ws,
  _piBridgeFresh: ws,
  directMode: false,
  piBridge: {
    state: 'managed',
    connected: true,
    model: 'deepseek/deepseek-chat',
    thinking_level: 'max',
    capabilities: ['pi.models.v1', 'pi.thinking.v1'],
  },
};
tm.tabs = new Map([[tab.paneId, tab]]);
tm.getActiveTab = () => tab;
window.__setBridge = (over) => {
  Object.assign(tab.piBridge, over);
  tm.renderPresets('pi');
};`
            : `const tab = { paneId: 'pill-pane', coder: 'pi-rpc', directMode: false };
const rpc = {
  ready: true,
  exited: false,
  busy: false,
  queueDepth: 0,
  hasTranscript: false,
  model: 'DeepSeek V3',
  thinking: 'max',
  skills: [],
};
tm.tabs = new Map([[tab.paneId, tab]]);
tm.getActiveTab = () => tab;
tm._piRpcControlsFor = () => rpc;
tm.cancelInputBtn = document.createElement('button');
tm.copyInputBtn = document.createElement('button');
tm.directModeToggle = document.createElement('button');
tm.thinkingVisibilityBtn = document.createElement('button');
tm._piRpcResetPending = new Set();
window.__setRpc = (over) => {
  Object.assign(rpc, over);
  tm.renderPresets('pi-rpc');
};`;
    return `<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/style.css">
<script type="module" src="/prepaint.js"></script>
<style>
  * { animation: none !important; transition: none !important; }
</style>
<div class="terminal-content" style="position:relative;width:100%;height:100dvh">
  <div id="presets-container" class="presets-container" style="position:absolute;bottom:0;width:100%"></div>
  <div id="pi-rpc-model-dropup" class="model-presets-dropup hidden"></div>
  <div id="pi-rpc-thinking-dropup" class="model-presets-dropup hidden"></div>
</div>
<script type="module">
import { TabManager } from '/terminal.js';
import { applyThemeTokens } from '/theme.js';
document.documentElement.style.fontSize = '14px';
const tm = Object.create(TabManager.prototype);
${state}
tm.presetsContainer = document.getElementById('presets-container');
tm._piRpcMenuRequest = 0;
tm._piRpcThinkingPending = null;
tm.app = { codersPresetRegistry: {}, showToast: () => {} };
window.__dropups = [];
tm._toggleDropup = (id, trigger) => { window.__dropups.push({ id, trigger }); };
window.__applyTheme = (key) => applyThemeTokens(key);
window.__rerender = () => tm.renderPresets('${mode}');
tm.renderPresets('${mode}');
</script>`;
}

// Prove the mask paints instead of trusting a computed URL: hide the slot,
// capture it twice, then compare normal paint with an unmasked solid square.
// Same page, same settled background, pointer parked off the chip.
async function expectPainted(
    page: Page,
    selector: string,
    testInfo: TestInfo,
    label: string,
) {
    const slot = page.locator(selector);
    await expect(slot).toBeVisible();
    const box = await slot.boundingBox();
    if (!box) throw new Error(`${label}: slot has no bounds`);
    expect(box.width).toBeCloseTo(16, 1);
    expect(box.height).toBeCloseTo(16, 1);
    await page.mouse.move(0, 0);
    const capture = () =>
        page.screenshot({
            clip: box,
            animations: 'disabled',
            caret: 'hide',
            scale: 'css',
        });
    const original = await slot.evaluate((el) => el.getAttribute('style'));
    try {
        await slot.evaluate((el) => {
            (el as HTMLElement).style.visibility = 'hidden';
        });
        const hidden = await capture();
        expect(hidden.equals(await capture())).toBe(true);
        await slot.evaluate((el) => {
            (el as HTMLElement).style.visibility = '';
        });
        let painted = hidden;
        await expect
            .poll(
                async () => {
                    painted = await capture();
                    return !painted.equals(hidden);
                },
                {
                    timeout: 5000,
                    message: `${label}: the mask painted nothing`,
                },
            )
            .toBe(true);
        await slot.evaluate((el) => {
            const style = (el as HTMLElement).style;
            style.maskImage = 'none';
            style.setProperty('-webkit-mask-image', 'none');
        });
        const solid = await capture();
        expect(painted.equals(solid), `${label}: the mask painted solid`).toBe(
            false,
        );
        writeFileSync(testInfo.outputPath(`${label}-painted.png`), painted);
        writeFileSync(testInfo.outputPath(`${label}-hidden.png`), hidden);
        writeFileSync(testInfo.outputPath(`${label}-solid.png`), solid);
    } finally {
        await slot.evaluate((el, style) => {
            if (style === null) el.removeAttribute('style');
            else el.setAttribute('style', style);
        }, original);
    }
}

test.describe('compact Pi model and thinking pills', () => {
    const modes = ['bridge', 'rpc'] as const;
    const providers = [
        ['deepseek', 'deepseek/deepseek-chat', 'DeepSeek V3'],
        ['kimi', 'kimi-coding/k3', 'Kimi K3'],
        ['minimax', 'minimax/MiniMax-M3', 'MiniMax M3'],
        ['zhipu', 'zai/glm-5', 'GLM-5'],
        ['openai', 'openai-codex/gpt-5', 'OpenAI GPT-5'],
        ['openrouter', 'openrouter/vendor/model-0', 'OpenRouter'],
    ] as const;

    async function openPills(page: Page, mode: (typeof modes)[number]) {
        await page.route('**/compact-pills-fixture', (route) =>
            route.fulfill({
                contentType: 'text/html',
                body: compactPillsFixture(mode),
            }),
        );
        await page.goto(`${phi.url}/compact-pills-fixture`, {
            waitUntil: 'domcontentloaded',
        });
        await expect(page.locator('.pi-rpc-model-trigger')).toBeVisible();
    }

    async function setModel(
        page: Page,
        mode: (typeof modes)[number],
        model: string,
    ) {
        await page.evaluate(
            ({ mode, model }) => {
                const hooks = window as unknown as {
                    __setBridge: (patch: unknown) => void;
                    __setRpc: (patch: unknown) => void;
                };
                if (mode === 'bridge') hooks.__setBridge({ model });
                else hooks.__setRpc({ model });
            },
            { mode, model },
        );
    }

    test('renders every provider mark synchronously without robot or fetch', async ({
        browser,
    }, testInfo) => {
        for (const mode of modes) {
            const context = await browser.newContext({
                viewport: { width: 390, height: 844 },
                isMobile: true,
                hasTouch: true,
            });
            try {
                const page = await context.newPage();
                const iconRequests: string[] = [];
                page.on('request', (request) => {
                    const url = new URL(request.url());
                    if (url.pathname.startsWith('/vendor/model-icons/'))
                        iconRequests.push(url.pathname);
                });
                await openPills(page, mode);
                const model = page.locator('.pi-rpc-model-trigger');
                const slot = model.locator('.compact-mark-slot');

                // No known mark may pass through the robot fallback, not
                // even for one frame. Count observations, not final state.
                await page.evaluate(() => {
                    const hooks = window as unknown as {
                        __markFlashes: number;
                    };
                    hooks.__markFlashes = 0;
                    const root = document.getElementById('presets-container');
                    if (!root) return;
                    new MutationObserver(() => {
                        const pill = document.querySelector(
                            '.pi-rpc-model-trigger',
                        );
                        if (pill?.querySelector('.compact-model-fallback'))
                            hooks.__markFlashes += 1;
                    }).observe(root, { childList: true, subtree: true });
                });

                for (const [id, bridgeModel, rpcModel] of providers) {
                    await setModel(
                        page,
                        mode,
                        mode === 'bridge' ? bridgeModel : rpcModel,
                    );
                    await expect(model).toHaveAttribute('data-model-mark', id);
                    await expect(
                        model.locator('.compact-model-fallback'),
                    ).toHaveCount(0);
                    await expect(slot).toHaveClass(/model-provider-mark/);
                    const mask = await slot.evaluate((el) =>
                        (el as HTMLElement).style.getPropertyValue(
                            '--model-mark',
                        ),
                    );
                    expect(
                        mask.startsWith('url("data:image/svg+xml;utf8,'),
                    ).toBe(true);
                }
                expect(
                    await page.evaluate(
                        () =>
                            (window as unknown as { __markFlashes: number })
                                .__markFlashes,
                    ),
                ).toBe(0);
                expect(iconRequests).toEqual([]);

                for (const [id, bridgeModel, rpcModel] of providers.slice(
                    0,
                    3,
                )) {
                    await setModel(
                        page,
                        mode,
                        mode === 'bridge' ? bridgeModel : rpcModel,
                    );
                    await expectPainted(
                        page,
                        '.pi-rpc-model-trigger .compact-mark-slot',
                        testInfo,
                        `${mode}-${id}`,
                    );
                }

                await setModel(
                    page,
                    mode,
                    mode === 'bridge'
                        ? 'deepseek/deepseek-chat'
                        : 'DeepSeek V3',
                );
                await page.evaluate(() =>
                    (
                        window as unknown as {
                            __applyTheme: (key: string) => void;
                        }
                    ).__applyTheme('red'),
                );
                await expect
                    .poll(() =>
                        slot.evaluate(
                            (el) => getComputedStyle(el).backgroundColor,
                        ),
                    )
                    .toBe('rgb(252, 165, 165)');
                await expectPainted(
                    page,
                    '.pi-rpc-model-trigger .compact-mark-slot',
                    testInfo,
                    `${mode}-deepseek-red`,
                );
            } finally {
                await context.close();
            }
        }
    });
});

test.describe('compact Pi model and thinking pills — ladder and viewports', () => {
    async function setPillsState(
        page: Page,
        mode: 'bridge' | 'rpc',
        over: Record<string, unknown>,
    ) {
        await page.evaluate(
            ({ mode, over }) => {
                const bridge = window as unknown as {
                    __setBridge: (patch: unknown) => void;
                    __setRpc: (patch: unknown) => void;
                };
                if (mode === 'bridge') bridge.__setBridge(over);
                else bridge.__setRpc(over);
            },
            { mode, over },
        );
    }

    async function openPills(page: Page, mode: 'bridge' | 'rpc') {
        await page.route('**/compact-pills-fixture', (route) =>
            route.fulfill({
                contentType: 'text/html',
                body: compactPillsFixture(mode),
            }),
        );
        await page.goto(`${phi.url}/compact-pills-fixture`, {
            waitUntil: 'domcontentloaded',
        });
        await expect(page.locator('.pi-rpc-model-trigger')).toBeVisible();
    }

    const tiers = [
        ['off', '🧠', 'off', 5, 0.55],
        ['minimal', '🧠', 'minimal', 11, 1],
        ['low', '🧠', 'low', 13, 1],
        ['medium', '🧠', 'medium', 14, 1],
        ['high', '🧠', 'high', 15, 1],
        ['xhigh', '🧠', 'xhigh', 16, 1],
        ['max', '🌌', 'max', 16, 1],
        ['', '🧠', 'unknown', 16, 1],
        ['turbo', '🧠', 'unknown', 16, 1],
    ] as const;

    test('paints every thinking tier and the unknown robot', async ({
        browser,
    }, testInfo) => {
        for (const mode of ['bridge', 'rpc'] as const) {
            const context = await browser.newContext({
                viewport: { width: 390, height: 844 },
                isMobile: true,
                hasTouch: true,
            });
            try {
                const page = await context.newPage();
                await openPills(page, mode);
                const thinking = page.locator('.pi-rpc-thinking-trigger');
                const thinkingTitle = mode === 'bridge' ? 'Thinking · ' : null;
                for (const [level, glyph, tier, size, opacity] of tiers) {
                    await setPillsState(
                        page,
                        mode,
                        mode === 'bridge'
                            ? { thinking_level: level }
                            : { thinking: level },
                    );
                    await expect(
                        thinking.locator('.thinking-glyph'),
                    ).toHaveText(glyph);
                    const title =
                        mode === 'bridge'
                            ? `${thinkingTitle}${level || '—'}`
                            : 'Change the thinking level';
                    const label = level
                        ? `Thinking: ${level}. ${title}`
                        : title;
                    await expect(thinking).toHaveAttribute('title', title);
                    await expect(thinking).toHaveAttribute('aria-label', label);
                    const measured = await page.evaluate(() => {
                        const el = document.querySelector(
                            '.pi-rpc-thinking-trigger .thinking-glyph',
                        ) as HTMLElement;
                        const slot = el.closest(
                            '.compact-mark-slot',
                        ) as HTMLElement;
                        const button = el.closest(
                            '.pi-rpc-thinking-trigger',
                        ) as HTMLElement;
                        const cmds = [
                            ...document.querySelectorAll('.model-trigger-btn'),
                        ].find(
                            (candidate) =>
                                candidate.textContent?.trim() === 'Cmds ▾',
                        ) as HTMLElement;
                        const slotRect = slot.getBoundingClientRect();
                        return {
                            tier: el.dataset.thinkingTier,
                            size: getComputedStyle(el).fontSize,
                            opacity: getComputedStyle(el).opacity,
                            slotWidth: slotRect.width,
                            slotHeight: slotRect.height,
                            button: button.getBoundingClientRect().height,
                            cmds: cmds.getBoundingClientRect().height,
                        };
                    });
                    expect(measured.tier).toBe(tier);
                    expect(measured.size).toBe(`${size}px`);
                    expect(Number.parseFloat(measured.opacity)).toBeCloseTo(
                        opacity,
                        2,
                    );
                    expect(measured.slotWidth).toBeCloseTo(16, 1);
                    expect(measured.slotHeight).toBeCloseTo(16, 1);
                    expect(
                        Math.abs(measured.button - measured.cmds),
                    ).toBeLessThan(0.2);
                    const box = await thinking.boundingBox();
                    if (!box) throw new Error('thinking pill has no bounds');
                    writeFileSync(
                        testInfo.outputPath(
                            `${mode}-thinking-${level || 'empty'}.png`,
                        ),
                        await page.screenshot({ clip: box }),
                    );
                }

                await setPillsState(
                    page,
                    mode,
                    mode === 'bridge'
                        ? { model: 'unknown-vendor/ambig' }
                        : { model: 'Ambiguous Model 9000' },
                );
                const model = page.locator('.pi-rpc-model-trigger');
                await expect(model).toHaveAttribute(
                    'data-model-mark',
                    'fallback',
                );
                await expect(
                    model.locator('.compact-model-fallback'),
                ).toHaveText('🤖');
                await expect(locatorSlot(model)).toHaveCount(1);
                const box = await model.boundingBox();
                if (!box) throw new Error('model pill has no bounds');
                writeFileSync(
                    testInfo.outputPath(`${mode}-unknown-robot.png`),
                    await page.screenshot({ clip: box }),
                );
            } finally {
                await context.close();
            }
        }
    });

    function locatorSlot(model: ReturnType<Page['locator']>) {
        return model.locator('.compact-mark-slot');
    }

    test('keeps pills compact at the boundary and words above it', async ({
        browser,
    }) => {
        for (const mode of ['bridge', 'rpc'] as const) {
            const context = await browser.newContext({
                viewport: { width: 769, height: 900 },
            });
            try {
                const page = await context.newPage();
                await openPills(page, mode);
                const model = page.locator('.pi-rpc-model-trigger');
                const thinking = page.locator('.pi-rpc-thinking-trigger');
                const wideModel =
                    mode === 'bridge'
                        ? 'Model: deepseek/deepseek-chat ▾'
                        : 'Model: DeepSeek V3 ▾';
                // 769 px, fine pointer, tall viewport: desktop words.
                await expect(model).toHaveText(wideModel);
                await expect(thinking).toHaveText('Thinking: max ▾');
                await expect(model).not.toHaveClass(/compact-icon-btn/);
                await expect(thinking).not.toHaveClass(/compact-icon-btn/);
                await expect(model.locator('.compact-mark-slot')).toHaveCount(
                    0,
                );
                if (mode === 'bridge') {
                    await expect(model).not.toHaveAttribute('aria-label');
                    await expect(thinking).not.toHaveAttribute('aria-label');
                } else {
                    await expect(thinking).toHaveAttribute(
                        'aria-label',
                        'Change the thinking level',
                    );
                }

                // 768 px is still the compact layout.
                await page.setViewportSize({ width: 768, height: 900 });
                await page.evaluate(() =>
                    (
                        window as unknown as { __rerender: () => void }
                    ).__rerender(),
                );
                await expect(model).toHaveClass(/compact-icon-btn/);
                await expect
                    .poll(() => model.getAttribute('data-model-mark'))
                    .toBe('deepseek');
                await expect(model.locator('.compact-mark-slot')).toHaveCount(
                    1,
                );
                await expect(
                    thinking.locator('.thinking-glyph--max'),
                ).toHaveText('🌌');

                // Returning to 769 px restores the words, not a half-compact
                // row.
                await page.setViewportSize({ width: 769, height: 900 });
                await page.evaluate(() =>
                    (
                        window as unknown as { __rerender: () => void }
                    ).__rerender(),
                );
                await expect(model).toHaveText(wideModel);
                await expect(model).not.toHaveClass(/compact-icon-btn/);
                await expect(thinking).toHaveText('Thinking: max ▾');
            } finally {
                await context.close();
            }
        }
    });

    test('compacts a short coarse landscape and a narrow fine desktop', async ({
        browser,
    }) => {
        for (const mode of ['bridge', 'rpc'] as const) {
            for (const view of [
                {
                    name: 'landscape',
                    viewport: { width: 932, height: 430 },
                    isMobile: true,
                    hasTouch: true,
                },
                {
                    name: 'narrow-fine',
                    viewport: { width: 390, height: 844 },
                    isMobile: false,
                    hasTouch: false,
                },
            ] as const) {
                const context = await browser.newContext({
                    viewport: view.viewport,
                    isMobile: view.isMobile,
                    hasTouch: view.hasTouch,
                });
                try {
                    const page = await context.newPage();
                    await openPills(page, mode);
                    const model = page.locator('.pi-rpc-model-trigger');
                    const thinking = page.locator('.pi-rpc-thinking-trigger');
                    await expect(model).toHaveClass(/compact-icon-btn/);
                    await expect
                        .poll(() => model.getAttribute('data-model-mark'))
                        .toBe('deepseek');
                    await expect(
                        thinking.locator('.thinking-glyph--max'),
                    ).toHaveText('🌌');
                    const heights = await page.evaluate(() => {
                        const model = document.querySelector(
                            '.pi-rpc-model-trigger',
                        ) as HTMLElement;
                        const cmds = [
                            ...document.querySelectorAll('.model-trigger-btn'),
                        ].find(
                            (candidate) =>
                                candidate.textContent?.trim() === 'Cmds ▾',
                        ) as HTMLElement;
                        return {
                            model: model.getBoundingClientRect().height,
                            cmds: cmds.getBoundingClientRect().height,
                        };
                    });
                    expect(Math.abs(heights.model - heights.cmds)).toBeLessThan(
                        0.2,
                    );
                    expect(
                        await page.evaluate(
                            () =>
                                document.documentElement.scrollWidth -
                                window.innerWidth,
                        ),
                    ).toBeLessThanOrEqual(0);
                } finally {
                    await context.close();
                }
            }
        }
    });

    test('keeps chip height in step with Cmds at every root size', async ({
        browser,
    }, testInfo) => {
        const context = await browser.newContext({
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
        });
        try {
            const page = await context.newPage();
            await openPills(page, 'bridge');
            const model = page.locator('.pi-rpc-model-trigger');
            const thinking = page.locator('.pi-rpc-thinking-trigger');
            for (const root of [10, 14, 17, 24]) {
                await page.evaluate((size) => {
                    document.documentElement.style.fontSize = `${size}px`;
                }, root);
                const expected = 2 * root;
                await expect
                    .poll(async () => {
                        const measured = await page.evaluate(() => {
                            const model = document.querySelector(
                                '.pi-rpc-model-trigger',
                            ) as HTMLElement;
                            const thinking = document.querySelector(
                                '.pi-rpc-thinking-trigger',
                            ) as HTMLElement;
                            const cmds = [
                                ...document.querySelectorAll(
                                    '.model-trigger-btn',
                                ),
                            ].find(
                                (candidate) =>
                                    candidate.textContent?.trim() === 'Cmds ▾',
                            ) as HTMLElement;
                            const slot = model.querySelector(
                                '.compact-mark-slot',
                            ) as HTMLElement;
                            const slotRect = slot.getBoundingClientRect();
                            return {
                                model: model.getBoundingClientRect().height,
                                thinking:
                                    thinking.getBoundingClientRect().height,
                                cmds: cmds.getBoundingClientRect().height,
                                slotWidth: slotRect.width,
                                slotHeight: slotRect.height,
                            };
                        });
                        return (
                            Math.abs(measured.model - expected) < 0.2 &&
                            Math.abs(measured.thinking - expected) < 0.2 &&
                            Math.abs(measured.model - measured.cmds) < 0.2 &&
                            Math.abs(measured.slotWidth - 16) < 0.1 &&
                            Math.abs(measured.slotHeight - 16) < 0.1
                        );
                    })
                    .toBe(true);
                const heights = await page.evaluate(() => {
                    const model = document.querySelector(
                        '.pi-rpc-model-trigger',
                    ) as HTMLElement;
                    const thinking = document.querySelector(
                        '.pi-rpc-thinking-trigger',
                    ) as HTMLElement;
                    const cmds = [
                        ...document.querySelectorAll('.model-trigger-btn'),
                    ].find(
                        (candidate) =>
                            candidate.textContent?.trim() === 'Cmds ▾',
                    ) as HTMLElement;
                    return {
                        model: model.getBoundingClientRect().height,
                        thinking: thinking.getBoundingClientRect().height,
                        cmds: cmds.getBoundingClientRect().height,
                    };
                });
                expect(Math.abs(heights.model - heights.cmds)).toBeLessThan(
                    0.2,
                );
                expect(Math.abs(heights.thinking - heights.cmds)).toBeLessThan(
                    0.2,
                );
                expect(Math.abs(heights.model - expected)).toBeLessThan(0.2);
                const box = await model.boundingBox();
                if (!box) throw new Error('model pill has no bounds');
                writeFileSync(
                    testInfo.outputPath(`root-${root}-pill.png`),
                    await page.screenshot({ clip: box }),
                );
            }
        } finally {
            await context.close();
        }
    });
});
