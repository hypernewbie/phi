import { copyFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { devices, expect, test, type APIRequestContext, type Browser, type Page, type Route } from '@playwright/test';
import { startAttachmentProvider, type AttachmentProvider, type AttachmentProviderRequest } from './_pi-attachment-provider.js';
import { startPhi } from './_server.js';
import { tabList } from './_tabs.js';
import { startBridgeProxy, type BridgeProxy } from './_pi-bridge-proxy.js';

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function startRecoveryFixture() {
    const provider = await startAttachmentProvider();
    const phi = await startPhi({
        config: { auto_reconnect: 'off' },
        env: { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
        setup(dir) {
            const home = join(dir, 'home');
            const agent = join(home, '.pi', 'agent');
            const work = join(dir, 'work');
            const fixtures = join(dir, 'fixtures');
            mkdirSync(agent, { recursive: true });
            mkdirSync(work, { recursive: true });
            mkdirSync(fixtures, { recursive: true });
            writeFileSync(join(agent, 'settings.json'), JSON.stringify({
                defaultProjectTrust: 'never', quietStartup: true,
                enableInstallTelemetry: false, cacheWarming: 'off',
                retry: { enabled: false }, compaction: { enabled: false },
            }));
            writeFileSync(join(agent, 'models.json'), JSON.stringify({
                providers: {
                    'attachment-anthropic': {
                        baseUrl: `http://127.0.0.1:${provider.port}`,
                        api: 'anthropic-messages', apiKey: 'attachment-fixture-key',
                        models: [{ id: 'vision', name: 'Fixture Vision', input: ['text', 'image'], contextWindow: 32_000, maxTokens: 2048 }],
                    },
                },
            }));
            const command = join(dir, 'native-pi');
            const binary = join(process.cwd(), 'node_modules', '.bin', 'pi');
            const proxySocket = join(dir, 't', 'a.sock');
            writeFileSync(command,
                `#!/bin/sh\nexport PHI_PI_BRIDGE_ENDPOINT=${shellQuote(`unix:${proxySocket}`)}\n` +
                `exec ${shellQuote(binary)} --no-prompt-templates --no-context-files --no-approve --model 'attachment-anthropic/vision' "$@"\n`,
                { mode: 0o755 },
            );
            const backends = join(home, '.phi', 'backends');
            mkdirSync(backends, { recursive: true });
            writeFileSync(join(backends, 'pi.json'), JSON.stringify({ id: 'pi', command }));
            copyFileSync(join(process.cwd(), 'web', 'vendor', 'logos', 'pi.png'), join(fixtures, 'public.png'));
        },
    });
    return {
        provider,
        phi,
        pngPath: join(phi.dir, 'fixtures', 'public.png'),
        work: realpathSync(join(phi.dir, 'work')),
        proxySocket: join(phi.dir, 't', 'a.sock'),
    };
}

async function startAttachmentProxy(phiDir: string, proxySocket: string): Promise<BridgeProxy> {
    const runTmp = join(phiDir, 't');
    const upstreams = readdirSync(runTmp, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('phi-pi-'))
        .map((entry) => join(runTmp, entry.name, 'bridge.sock'));
    if (upstreams.length !== 1) throw new Error(`expected one Phi bridge socket, found ${upstreams.length}`);
    return startBridgeProxy(phiDir, upstreams[0]!, proxySocket);
}

async function spawnPane(request: APIRequestContext, url: string, cwd: string): Promise<string> {
    const response = await request.post(`${url}/api/terminals`, { data: { coder: 'pi', cwd, title: 'Attachment recovery' } });
    expect(response.ok()).toBe(true);
    const pane = ((await response.json()) as { pane_id: string }).pane_id;
    await expect.poll(async () => {
        const result = await request.get(`${url}/api/terminals`);
        if (!result.ok()) return undefined;
        const tabs = (await result.json()) as Array<{ id: string; pi_bridge?: { state: string; connected?: boolean; capabilities?: string[] } }>;
        return tabs.find((tab) => tab.id === pane)?.pi_bridge;
    }, { timeout: 30_000 }).toMatchObject({
        state: 'managed', connected: true,
        capabilities: expect.arrayContaining(['pi.attachments.v1']),
    });
    return pane;
}

async function selectPane(page: Page, pane: string, mobile: boolean): Promise<void> {
    if (mobile) {
        await page.locator('#hostname-display').tap();
        const list = tabList(page);
        await expect(list).toBeVisible({ timeout: 10_000 });
        await list.locator(`.hostname-dropdown-row[data-pane-id="${pane}"] .hostname-dropdown-select-btn`).tap();
    } else {
        await page.locator(`.tab[data-pane-id="${pane}"]`).click();
    }
    await expect(page.locator('.tab.active')).toHaveAttribute('data-pane-id', pane);
}

async function chooseFile(page: Page, filePath: string | string[], mobile: boolean): Promise<void> {
    const chooser = page.waitForEvent('filechooser');
    const button = page.locator('#attach-input-btn');
    await expect(button).toBeVisible();
    if (mobile) await button.tap();
    else await button.click();
    const menu = page.locator('#attachment-source-dropup');
    await expect(menu).toBeVisible();
    const item = menu.locator('.dropup-model-btn', { hasText: new RegExp(`^${mobile ? 'Files' : 'Device Files'}$`) });
    if (mobile) await item.tap();
    else await item.click();
    await (await chooser).setFiles(filePath);
}

async function waitForContext(page: Page, pane: string): Promise<void> {
    const response = page.waitForResponse((item) =>
        item.url().includes('/api/pi-bridge/attachments/context') &&
        item.url().includes(encodeURIComponent(pane)) && item.request().method() === 'GET',
        { timeout: 30_000 },
    );
    await response;
}

async function allowLoopbackOnly(page: Page): Promise<void> {
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
        return route.abort();
    });
}

function anthropicImages(request: AttachmentProviderRequest): Array<{ mediaType: string; data: string }> {
    const body = request.body as { messages?: Array<{ role?: string; content?: Array<Record<string, unknown>> }> };
    const found: Array<{ mediaType: string; data: string }> = [];
    for (const message of body.messages ?? []) {
        if (message.role !== 'user' || !Array.isArray(message.content)) continue;
        for (const part of message.content) {
            const source = part.source as { type?: string; media_type?: string; data?: string } | undefined;
            if (part.type === 'image' && source?.type === 'base64' && source.media_type && source.data) {
                found.push({ mediaType: source.media_type, data: source.data });
            }
        }
    }
    return found;
}

function providerText(request: AttachmentProviderRequest): string {
    const body = request.body as { messages?: Array<{ role?: string; content?: unknown }> };
    return (body.messages ?? []).filter((message) => message.role === 'user')
        .map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''))
        .join('\n');
}

async function waitForProvider(provider: AttachmentProvider, count: number): Promise<void> {
    await provider.waitForRequests(count, 30_000);
}

async function attachmentStoreState(page: Page, itemID: string): Promise<{
    draftPane: string | null;
    outboxPane: string | null;
    outboxState: string | null;
    hasBlob: boolean;
}> {
    return page.evaluate(async (id: string) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('phi-attachments-v1');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        try {
            return await new Promise<{
                draftPane: string | null;
                outboxPane: string | null;
                outboxState: string | null;
                hasBlob: boolean;
            }>((resolve, reject) => {
                const tx = db.transaction(['drafts', 'blobs', 'outbox'], 'readonly');
                const drafts = tx.objectStore('drafts').getAll();
                const blobs = tx.objectStore('blobs').getAll();
                const outbox = tx.objectStore('outbox').getAll();
                tx.oncomplete = () => {
                    const draft = drafts.result.find((row: { owner?: { paneId?: string }; items?: Array<{ id: string }> }) => row.items?.some((item) => item.id === id));
                    const send = outbox.result.find((row: { owner?: { paneId?: string }; items?: Array<{ id: string }> }) => row.items?.some((item) => item.id === id));
                    resolve({
                        draftPane: draft?.owner?.paneId || null,
                        outboxPane: send?.owner?.paneId || null,
                        outboxState: send?.state || null,
                        hasBlob: blobs.result.some((blob: { itemId: string }) => blob.itemId === id),
                    });
                };
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            });
        } finally {
            db.close();
        }
    }, itemID);
}

async function startPage(browser: Browser, url: string, pane: string, mobile: boolean) {
    const options = mobile ? { ...devices['Pixel 7'] } : { viewport: { width: 1440, height: 900 } };
    const context = await browser.newContext(options);
    const page = await context.newPage();
    await allowLoopbackOnly(page);
    await page.addInitScript((activePane) => localStorage.setItem('phi_active_pane', activePane), pane);
    const contextResponse = waitForContext(page, pane);
    await page.goto(url);
    await selectPane(page, pane, mobile);
    await contextResponse;
    await expect(page.locator('#attach-input-btn')).toBeVisible();
    return { context, page };
}

test('offline upload draft survives reload and retries only after explicit status recovery on desktop and touch', async ({ browser, request }) => {
    test.setTimeout(300_000);
    const fixture = await startRecoveryFixture();
    let proxy: BridgeProxy | null = null;
    try {
        proxy = await startAttachmentProxy(fixture.phi.dir, fixture.proxySocket);
        for (const device of [
            { name: 'desktop', mobile: false },
            { name: 'Pixel 7 touch', mobile: true },
        ]) {
            const pane = await spawnPane(request, fixture.phi.url, fixture.work);
            const { context, page } = await startPage(browser, fixture.phi.url, pane, device.mobile);
            const putURLs: string[] = [];
            const errors: string[] = [];
            page.on('request', (item) => {
                if (item.method() === 'PUT' && new URL(item.url()).pathname.startsWith('/api/attachments/v2/items/')) putURLs.push(item.url());
            });
            page.on('pageerror', (error) => errors.push(error.message));
            const failFirstUpload = async (route: Route) => {
                if (route.request().method() === 'PUT' && putURLs.length === 1) await route.abort('failed');
                else await route.continue();
            };
            try {
                await page.route('**/api/attachments/v2/items/**', failFirstUpload);
                await context.setOffline(true);
                const text = `durable draft ${device.name}`;
                await page.locator('#input-textarea').fill(text);
                await chooseFile(page, fixture.pngPath, device.mobile);
                const chip = page.locator('#attachment-strip .attachment-chip');
                await expect(chip.locator('.attachment-state')).toHaveText('Waiting to upload');
                await expect(page.locator('#attachment-status')).toContainText('waiting for a network connection');
                expect(putURLs).toHaveLength(0);

                const firstPut = page.waitForRequest((item) => item.method() === 'PUT' && item.url().includes('/api/attachments/v2/items/'));
                await context.setOffline(false);
                const failedPut = await firstPut;
                const itemID = new URL(failedPut.url()).pathname.split('/').at(-1)!;
                await expect(chip.locator('.attachment-state')).toHaveText('Unconfirmed', { timeout: 30_000 });
                expect(putURLs).toHaveLength(1);
                await expect.poll(async () => {
                    const state = await attachmentStoreState(page, itemID);
                    return state.draftPane === pane && state.hasBlob;
                }, { timeout: 30_000 }).toBe(true);

                await page.reload();
                await selectPane(page, pane, device.mobile);
                await expect.poll(async () => {
                    const state = await attachmentStoreState(page, itemID);
                    return state.draftPane === pane && state.hasBlob;
                }, { timeout: 30_000 }).toBe(true);
                const restored = page.locator(`#attachment-strip .attachment-chip[data-id="${itemID}"]`);
                await expect(restored).toBeVisible({ timeout: 30_000 });
                await expect(restored.locator('.attachment-state')).toHaveText('Unconfirmed', { timeout: 30_000 });
                await expect(page.locator('#input-textarea')).toHaveValue(text);
                await page.waitForTimeout(1200);
                expect(putURLs).toHaveLength(1);

                const retry = restored.getByRole('button', { name: 'Retry upload for public.png' });
                await expect(retry).toBeVisible();
                await retry.click();
                await expect(restored.locator('.attachment-state')).toHaveText('Ready', { timeout: 30_000 });
                expect(putURLs).toHaveLength(2);
                expect(putURLs[0]).toBe(putURLs[1]);

                const stored = await request.get(`${fixture.phi.url}/api/attachments/v2/items/${itemID}?pane=${encodeURIComponent(pane)}`);
                expect(stored.ok()).toBe(true);
                const status = (await stored.json()) as { state: string; item?: { path: string } };
                expect(status.state).toBe('ready');
                expect(status.item).toBeTruthy();
                const before = fixture.provider.requests.length;
                const send = page.locator('#send-input-btn');
                if (device.mobile) await send.tap();
                else await send.click();
                await waitForProvider(fixture.provider, before + 1);
                const delivered = fixture.provider.requests[before]!;
                const images = anthropicImages(delivered);
                expect(images).toHaveLength(1);
                expect(Buffer.from(images[0]!.data, 'base64')).toEqual(readFileSync(fixture.pngPath));
                expect(providerText(delivered)).toContain(text);
                await expect(page.locator('#attachment-status')).toContainText('Submitted to Pi');
                expect(errors, device.name).toEqual([]);
            } finally {
                await context.close();
            }
        }
    } finally {
        await proxy?.close();
        await fixture.phi.stop();
        await fixture.provider.close();
    }
});

test('a never-attempted offline send survives reload and dispatches once after live identity refresh', async ({ browser, request }) => {
    test.setTimeout(240_000);
    const fixture = await startRecoveryFixture();
    let proxy: BridgeProxy | null = null;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
        proxy = await startAttachmentProxy(fixture.phi.dir, fixture.proxySocket);
        const pane = await spawnPane(request, fixture.phi.url, fixture.work);
        const page = await context.newPage();
        await allowLoopbackOnly(page);
        await page.addInitScript((activePane) => localStorage.setItem('phi_active_pane', activePane), pane);
        const initialContext = waitForContext(page, pane);
        await page.goto(fixture.phi.url);
        await selectPane(page, pane, false);
        await initialContext;
        const sendRequests: string[] = [];
        const failures: string[] = [];
        page.on('request', (item) => {
            const path = new URL(item.url()).pathname;
            if (item.method() === 'POST' && path === '/api/pi-bridge/attachments') sendRequests.push(item.url());
        });
        page.on('pageerror', (error) => failures.push(error.message));
        const onlineContextPattern = '**/api/pi-bridge/attachments/context*';
        const blockContext = async (route: Route) => route.abort('failed');

        const before = fixture.provider.requests.length;
        await chooseFile(page, fixture.pngPath, false);
        const chip = page.locator('#attachment-strip .attachment-chip');
        await expect(chip.locator('.attachment-state')).toHaveText('Ready', { timeout: 30_000 });
        await page.locator('#input-textarea').fill('send after reconnect');
        await context.setOffline(true);
        await page.locator('#send-input-btn').click();
        await expect(page.locator('#attachment-status')).toContainText('Waiting to send');
        expect(sendRequests).toHaveLength(0);
        expect(fixture.provider.requests).toHaveLength(before);

        await page.route(onlineContextPattern, blockContext);
        await context.setOffline(false);
        await expect(page.locator('#attachment-status')).toContainText('Waiting to send', { timeout: 10_000 });
        const itemID = await chip.getAttribute('data-id');
        await expect.poll(async () => {
            const state = await attachmentStoreState(page, itemID!);
            return state.outboxPane === pane && state.outboxState === 'waiting' && state.hasBlob;
        }, { timeout: 30_000 }).toBe(true);
        await page.reload();
        await selectPane(page, pane, false);
        await expect.poll(async () => {
            const state = await attachmentStoreState(page, itemID!);
            return state.outboxPane === pane && state.outboxState === 'waiting' && state.hasBlob;
        }, { timeout: 30_000 }).toBe(true);
        await expect(page.locator('#attachment-status')).toContainText('Waiting to send', { timeout: 30_000 });
        expect(sendRequests).toHaveLength(0);
        expect(fixture.provider.requests).toHaveLength(before);

        await page.unroute(onlineContextPattern, blockContext);
        const freshContext = page.waitForResponse((response) =>
            response.url().includes('/api/pi-bridge/attachments/context') && response.request().method() === 'GET',
            { timeout: 30_000 },
        );
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        const contextResponse = await freshContext;
        expect(contextResponse.ok()).toBe(true);
        expect((await contextResponse.json()).available).toBe(true);
        await waitForProvider(fixture.provider, before + 1);
        await expect(page.locator('#attachment-status')).toContainText('Submitted to Pi', { timeout: 30_000 });
        expect(sendRequests).toHaveLength(1);
        expect(fixture.provider.requests).toHaveLength(before + 1);
        expect(anthropicImages(fixture.provider.requests[before]!)).toHaveLength(1);
        expect(providerText(fixture.provider.requests[before]!)).toContain('send after reconnect');
        await page.waitForTimeout(1200);
        expect(sendRequests).toHaveLength(1);
        expect(fixture.provider.requests).toHaveLength(before + 1);
        expect(failures).toEqual([]);
    } finally {
        await context.close();
        await proxy?.close();
        await fixture.phi.stop();
        await fixture.provider.close();
    }
});

test('two tabs freeze the same draft revision to one send ID and one Pi dispatch', async ({ browser, request }) => {
    test.setTimeout(240_000);
    const fixture = await startRecoveryFixture();
    let proxy: BridgeProxy | null = null;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
        proxy = await startAttachmentProxy(fixture.phi.dir, fixture.proxySocket);
        const pane = await spawnPane(request, fixture.phi.url, fixture.work);
        const sendBodies: Array<{ id?: string }> = [];
        const errors: string[] = [];
        const observe = (page: Page) => {
            page.on('pageerror', (error) => errors.push(error.message));
            page.on('request', (item) => {
                if (item.method() === 'POST' && new URL(item.url()).pathname === '/api/pi-bridge/attachments') {
                    sendBodies.push(item.postDataJSON() as { id?: string });
                }
            });
        };
        const first = await context.newPage();
        observe(first);
        await allowLoopbackOnly(first);
        await first.addInitScript((activePane) => localStorage.setItem('phi_active_pane', activePane), pane);
        const firstContext = waitForContext(first, pane);
        await first.goto(fixture.phi.url);
        await selectPane(first, pane, false);
        await firstContext;
        await first.locator('#input-textarea').fill('one persisted cross-tab snapshot');
        await chooseFile(first, fixture.pngPath, false);
        const firstChip = first.locator('#attachment-strip .attachment-chip');
        await expect(firstChip.locator('.attachment-state')).toHaveText('Ready', { timeout: 30_000 });
        const itemID = await firstChip.getAttribute('data-id');

        // The second tab opens after the draft is durable, so both tabs freeze
        // the same persisted revision rather than expecting live UI broadcast.
        const second = await context.newPage();
        observe(second);
        await allowLoopbackOnly(second);
        await second.addInitScript((activePane) => localStorage.setItem('phi_active_pane', activePane), pane);
        const secondContext = waitForContext(second, pane);
        await second.goto(fixture.phi.url);
        await selectPane(second, pane, false);
        await secondContext;
        await expect(second.locator(`#attachment-strip .attachment-chip[data-id="${itemID}"]`)).toBeVisible({ timeout: 30_000 });
        await expect(second.locator('#input-textarea')).toHaveValue('one persisted cross-tab snapshot');
        await expect(second.locator('.attachment-state')).toHaveText('Ready', { timeout: 30_000 });

        const providerBaseline = fixture.provider.requests.length;
        await Promise.all([
            first.locator('#send-input-btn').click(),
            second.locator('#send-input-btn').click(),
        ]);
        await waitForProvider(fixture.provider, providerBaseline + 1);
        await expect.poll(() => sendBodies.length, { timeout: 30_000 }).toBe(1);
        await expect(first.locator('#attachment-status')).toContainText('Submitted to Pi', { timeout: 30_000 });
        expect(sendBodies).toHaveLength(1);
        expect(sendBodies[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(fixture.provider.requests).toHaveLength(providerBaseline + 1);
        expect(anthropicImages(fixture.provider.requests[providerBaseline]!)).toHaveLength(1);
        expect(errors).toEqual([]);
    } finally {
        await context.close();
        await proxy?.close();
        await fixture.phi.stop();
        await fixture.provider.close();
    }
});

test('pane switching keeps attachment drafts and sends with their captured pane', async ({ browser, request }) => {
    test.setTimeout(240_000);
    const fixture = await startRecoveryFixture();
    let proxy: BridgeProxy | null = null;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
        proxy = await startAttachmentProxy(fixture.phi.dir, fixture.proxySocket);
        const paneA = await spawnPane(request, fixture.phi.url, fixture.work);
        const paneB = await spawnPane(request, fixture.phi.url, fixture.work);
        const page = await context.newPage();
        await allowLoopbackOnly(page);
        await page.addInitScript((activePane) => localStorage.setItem('phi_active_pane', activePane), paneA);
        const contextReady = waitForContext(page, paneA);
        await page.goto(fixture.phi.url);
        await selectPane(page, paneA, false);
        await contextReady;

        await page.locator('#input-textarea').fill('draft belongs to pane A');
        await chooseFile(page, fixture.pngPath, false);
        const chipA = page.locator('#attachment-strip .attachment-chip');
        await expect(chipA.locator('.attachment-state')).toHaveText('Ready', { timeout: 30_000 });
        const idA = await chipA.getAttribute('data-id');

        await selectPane(page, paneB, false);
        await expect(page.locator('#attachment-strip .attachment-chip')).toHaveCount(0);
        await expect(page.locator('#input-textarea')).toHaveValue('');
        await page.locator('#input-textarea').fill('draft belongs to pane B');
        await chooseFile(page, fixture.pngPath, false);
        const chipB = page.locator('#attachment-strip .attachment-chip');
        await expect(chipB.locator('.attachment-state')).toHaveText('Ready', { timeout: 30_000 });
        const idB = await chipB.getAttribute('data-id');
        expect(idB).not.toBe(idA);

        await selectPane(page, paneA, false);
        await expect(page.locator(`#attachment-strip .attachment-chip[data-id="${idA}"]`)).toBeVisible();
        await expect(page.locator('#input-textarea')).toHaveValue('draft belongs to pane A');
        const before = fixture.provider.requests.length;
        await page.locator('#send-input-btn').click();
        await waitForProvider(fixture.provider, before + 1);
        const sent = fixture.provider.requests[before]!;
        expect(providerText(sent)).toContain('draft belongs to pane A');
        expect(providerText(sent)).not.toContain('draft belongs to pane B');
        expect(anthropicImages(sent)).toHaveLength(1);

        await selectPane(page, paneB, false);
        await expect(page.locator(`#attachment-strip .attachment-chip[data-id="${idB}"]`)).toBeVisible();
        await expect(page.locator('#input-textarea')).toHaveValue('draft belongs to pane B');
    } finally {
        await context.close();
        await proxy?.close();
        await fixture.phi.stop();
        await fixture.provider.close();
    }
});

test('a canceled waiting send stays canceled after reload and never removes the server file', async ({ browser, request }) => {
    test.setTimeout(240_000);
    const fixture = await startRecoveryFixture();
    let proxy: BridgeProxy | null = null;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
        proxy = await startAttachmentProxy(fixture.phi.dir, fixture.proxySocket);
        const pane = await spawnPane(request, fixture.phi.url, fixture.work);
        const page = await context.newPage();
        await allowLoopbackOnly(page);
        await page.addInitScript((activePane) => localStorage.setItem('phi_active_pane', activePane), pane);
        const contextReady = waitForContext(page, pane);
        await page.goto(fixture.phi.url);
        await selectPane(page, pane, false);
        await contextReady;
        const sendRequests: string[] = [];
        page.on('request', (item) => {
            if (item.method() === 'POST' && new URL(item.url()).pathname === '/api/pi-bridge/attachments') sendRequests.push(item.url());
        });

        await chooseFile(page, fixture.pngPath, false);
        const chip = page.locator('#attachment-strip .attachment-chip');
        await expect(chip.locator('.attachment-state')).toHaveText('Ready', { timeout: 30_000 });
        const itemID = await chip.getAttribute('data-id');
        await page.locator('#input-textarea').fill('do not send after cancellation');
        await context.setOffline(true);
        await page.locator('#send-input-btn').click();
        await expect(page.locator('#attachment-status')).toContainText('Waiting to send');
        await page.getByRole('button', { name: 'Cancel waiting send' }).click();
        await expect(page.locator('#attachment-status')).toContainText('Waiting send canceled');
        expect(sendRequests).toHaveLength(0);
        expect(fixture.provider.requests).toHaveLength(0);

        const pattern = '**/api/pi-bridge/attachments/context*';
        const blockContext = async (route: Route) => route.abort('failed');
        await page.route(pattern, blockContext);
        await context.setOffline(false);
        await page.reload();
        await selectPane(page, pane, false);
        await expect(page.locator('#attachment-status')).toContainText('Waiting send canceled', { timeout: 30_000 });
        await page.unroute(pattern, blockContext);
        const liveContext = page.waitForResponse((response) =>
            response.url().includes('/api/pi-bridge/attachments/context') && response.request().method() === 'GET',
            { timeout: 30_000 },
        );
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        expect((await liveContext).ok()).toBe(true);
        await page.waitForTimeout(1200);
        expect(sendRequests).toHaveLength(0);
        expect(fixture.provider.requests).toHaveLength(0);

        page.once('dialog', (dialog) => dialog.accept());
        await page.getByRole('button', { name: 'Forget local copy' }).click();
        await expect(page.locator('#attachment-status')).toContainText('Local attachment copy forgotten');
        const stored = await request.get(`${fixture.phi.url}/api/attachments/v2/items/${itemID}?pane=${encodeURIComponent(pane)}`);
        expect(stored.ok()).toBe(true);
        expect((await stored.json()).state).toBe('ready');
    } finally {
        await context.close();
        await proxy?.close();
        await fixture.phi.stop();
        await fixture.provider.close();
    }
});

test('an attempted send remains unknown across reload and Phi restart without replay', async ({ browser, request }) => {
    test.setTimeout(240_000);
    const fixture = await startRecoveryFixture();
    let proxy: BridgeProxy | null = null;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
        proxy = await startAttachmentProxy(fixture.phi.dir, fixture.proxySocket);
        const pane = await spawnPane(request, fixture.phi.url, fixture.work);
        const page = await context.newPage();
        await allowLoopbackOnly(page);
        await page.addInitScript((activePane) => localStorage.setItem('phi_active_pane', activePane), pane);
        const contextReady = waitForContext(page, pane);
        await page.goto(fixture.phi.url);
        await selectPane(page, pane, false);
        await contextReady;
        const sends: Array<{ id?: string }> = [];
        page.on('request', (item) => {
            if (item.method() === 'POST' && new URL(item.url()).pathname === '/api/pi-bridge/attachments') {
                sends.push(item.postDataJSON() as { id?: string });
            }
        });
        await chooseFile(page, fixture.pngPath, false);
        await expect(page.locator('#attachment-strip .attachment-state')).toHaveText('Ready', { timeout: 30_000 });
        await page.locator('#input-textarea').fill('uncertain across restart');
        const providerBaseline = fixture.provider.requests.length;
        proxy.pausePiToPhi();
        await page.locator('#send-input-btn').click();
        await waitForProvider(fixture.provider, providerBaseline + 1);
        await expect.poll(() => sends.length, { timeout: 30_000 }).toBe(1);
        const sendID = sends[0]?.id;
        expect(sendID).toMatch(/^[0-9a-f-]{36}$/);
        await proxy.drop();
        await expect(page.locator('#attachment-status')).toContainText('Submission not confirmed', { timeout: 30_000 });
        expect(fixture.provider.requests).toHaveLength(providerBaseline + 1);

        await page.reload();
        await selectPane(page, pane, false);
        await expect(page.locator('#attachment-status')).toContainText('Submission not confirmed', { timeout: 30_000 });
        expect(sends).toHaveLength(1);
        expect(fixture.provider.requests).toHaveLength(providerBaseline + 1);
        let restoreWarning = '';
        page.once('dialog', (dialog) => {
            restoreWarning = dialog.message();
            void dialog.dismiss();
        });
        await page.getByRole('button', { name: 'Restore to draft' }).click();
        expect(restoreWarning).toContain('can create a duplicate');
        await expect(page.locator('#attachment-status')).toContainText('Submission not confirmed');

        await proxy.close();
        proxy = null;
        await fixture.phi.restart();
        const saved = await request.get(`${fixture.phi.url}/api/pi-bridge/attachments?id=${encodeURIComponent(sendID!)}&pane=${encodeURIComponent(pane)}`);
        expect(saved.ok()).toBe(true);
        expect((await saved.json()).state).toBe('unknown');
        await page.waitForTimeout(1200);
        expect(sends).toHaveLength(1);
        expect(fixture.provider.requests).toHaveLength(providerBaseline + 1);
    } finally {
        await context.close();
        await proxy?.close();
        await fixture.phi.stop();
        await fixture.provider.close();
    }
});

test('slow upload stays usable beyond 30 seconds and completes without losing typing', async ({ browser, request }) => {
    test.setTimeout(180_000);
    const fixture = await startRecoveryFixture();
    let proxy: BridgeProxy | null = null;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const uploadGate: { release?: () => void } = {};
    const uploadPattern = '**/api/attachments/v2/items/**';
    try {
        proxy = await startAttachmentProxy(fixture.phi.dir, fixture.proxySocket);
        const pane = await spawnPane(request, fixture.phi.url, fixture.work);
        const page = await context.newPage();
        await allowLoopbackOnly(page);
        await page.addInitScript((activePane) => localStorage.setItem('phi_active_pane', activePane), pane);
        const contextReady = waitForContext(page, pane);
        await page.goto(fixture.phi.url);
        await selectPane(page, pane, false);
        await contextReady;
        let reachUpload!: () => void;
        const uploadReached = new Promise<void>((resolve) => { reachUpload = resolve; });
        await page.route(uploadPattern, async (route) => {
            if (route.request().method() !== 'PUT') return route.continue();
            reachUpload();
            await new Promise<void>((resolve) => { uploadGate.release = resolve; });
            await route.continue();
        });

        await chooseFile(page, fixture.pngPath, false);
        await uploadReached;
        const chip = page.locator('#attachment-strip .attachment-chip');
        await expect(chip.locator('.attachment-state')).toHaveText('Uploading');
        const started = Date.now();
        await page.locator('#input-textarea').fill('typed while upload is slow');
        const chooser = page.waitForEvent('filechooser');
        await page.locator('#attach-input-btn').click();
        await page.locator('#attachment-source-dropup .dropup-model-btn', { hasText: /^Device Files$/ }).click();
        await (await chooser).setFiles([]);
        await expect(page.locator('#attachment-strip .attachment-chip')).toHaveCount(1);
        await page.waitForTimeout(31_000);
        expect(Date.now() - started).toBeGreaterThanOrEqual(31_000);
        await expect(chip.locator('.attachment-state')).toHaveText('Uploading');
        uploadGate.release?.();
        await expect(chip.locator('.attachment-state')).toHaveText('Ready', { timeout: 30_000 });
        await expect(page.locator('#input-textarea')).toHaveValue('typed while upload is slow');
    } finally {
        uploadGate.release?.();
        await context.close();
        await proxy?.close();
        await fixture.phi.stop();
        await fixture.provider.close();
    }
});
