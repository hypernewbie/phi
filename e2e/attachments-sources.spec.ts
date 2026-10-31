import { execFileSync } from 'node:child_process';
import {
    copyFileSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
    devices,
    expect,
    test,
    type APIRequestContext,
    type Browser,
    type Page,
} from '@playwright/test';
import {
    startAttachmentProvider,
    type AttachmentProvider,
    type AttachmentProviderRequest,
} from './_pi-attachment-provider.js';
import { startPhi } from './_server.js';
import { tabList } from './_tabs.js';
import { startBridgeProxy, type BridgeProxy } from './_pi-bridge-proxy.js';
import { isCancelledWorktreeRead } from './_session-requests.js';

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const SERVER_TEXT = 'SERVER_SNAPSHOT_FIXTURE_9c4e';
const OUTSIDE_TEXT = 'OUTSIDE_CWD_FIXTURE_51b7';

function isExpectedStartupPinAbort(url: string, errorText: string): boolean {
    return (
        new URL(url).pathname.match(/^\/api\/terminals\/[^/]+\/pin$/) !==
            null && errorText === 'net::ERR_ABORTED'
    );
}

function isExpectedPinSyncConsoleError(message: string): boolean {
    return (
        message.startsWith('[term] Failed to sync pin on backend:') &&
        /AbortError|BackendScope aborted/.test(message)
    );
}

function isExpectedOptionalBackgroundFailure(
    url: string,
    status: number,
): boolean {
    const parsed = new URL(url);
    return (
        (parsed.pathname === '/api/update/status' && status === 503) ||
        (parsed.pathname === '/api/sessions' &&
            parsed.searchParams.get('coder') === 'opencode' &&
            status === 500)
    );
}

function isExpectedOfflineBackgroundFailure(
    url: string,
    errorText: string,
): boolean {
    // The cache test deliberately takes the context offline. A CPU poll or
    // the current-pane pin sync can be in flight during that transition.
    const pathname = new URL(url).pathname;
    return (
        (pathname === '/api/system/cpu' ||
            /^\/api\/terminals\/[^/]+\/pin$/.test(pathname)) &&
        errorText === 'net::ERR_INTERNET_DISCONNECTED'
    );
}

async function startSourcesFixture() {
    const provider = await startAttachmentProvider();
    const phi = await startPhi({
        config: { auto_reconnect: 'off' },
        env: { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
        setup(dir) {
            const home = join(dir, 'home');
            const agent = join(home, '.pi', 'agent');
            const work = join(dir, 'work');
            const outside = join(dir, 'outside');
            const fixtures = join(dir, 'fixtures');
            mkdirSync(agent, { recursive: true });
            mkdirSync(join(work, 'docs'), { recursive: true });
            mkdirSync(join(work, 'big'), { recursive: true });
            mkdirSync(outside, { recursive: true });
            mkdirSync(fixtures, { recursive: true });
            writeFileSync(
                join(agent, 'settings.json'),
                JSON.stringify({
                    defaultProjectTrust: 'never',
                    quietStartup: true,
                    enableInstallTelemetry: false,
                    cacheWarming: 'off',
                    retry: { enabled: false },
                    compaction: { enabled: false },
                }),
            );
            writeFileSync(
                join(agent, 'models.json'),
                JSON.stringify({
                    providers: {
                        'attachment-anthropic': {
                            baseUrl: `http://127.0.0.1:${provider.port}`,
                            api: 'anthropic-messages',
                            apiKey: 'attachment-fixture-key',
                            models: [
                                {
                                    id: 'vision',
                                    name: 'Fixture Vision',
                                    input: ['text', 'image'],
                                    contextWindow: 32_000,
                                    maxTokens: 2048,
                                },
                            ],
                        },
                    },
                }),
            );
            const command = join(dir, 'native-pi');
            const binary = join(process.cwd(), 'node_modules', '.bin', 'pi');
            const proxySocket = join(dir, 't', 'a.sock');
            writeFileSync(
                command,
                `#!/bin/sh\nexport PHI_PI_BRIDGE_ENDPOINT=${shellQuote(`unix:${proxySocket}`)}\n` +
                    `exec ${shellQuote(binary)} --no-prompt-templates --no-context-files --no-approve --model 'attachment-anthropic/vision' "$@"\n`,
                { mode: 0o755 },
            );
            const backends = join(home, '.phi', 'backends');
            mkdirSync(backends, { recursive: true });
            writeFileSync(
                join(backends, 'pi.json'),
                JSON.stringify({ id: 'pi', command }),
            );
            copyFileSync(
                join(process.cwd(), 'web', 'vendor', 'logos', 'pi.png'),
                join(fixtures, 'public.png'),
            );
            writeFileSync(
                join(fixtures, 'note.txt'),
                'DEVICE_BATCH_FIXTURE_7d2a',
            );
            writeFileSync(
                join(fixtures, 'unsupported.gif'),
                Buffer.from('GIF89a'),
            );
            for (let index = 0; index < 9; index++) {
                writeFileSync(
                    join(fixtures, `batch-${index}.txt`),
                    `batch file ${index}`,
                );
            }
            // Server-side files, selected through the Server Files modal.
            writeFileSync(join(work, 'report.txt'), SERVER_TEXT);
            writeFileSync(
                join(work, 'docs', 'nested.txt'),
                'NESTED_SERVER_FIXTURE_2b8c',
            );
            writeFileSync(join(work, 'mutate.txt'), 'original bytes');
            writeFileSync(join(work, 'delete-me.txt'), 'doomed bytes');
            writeFileSync(join(work, 'my file.txt'), 'spaces');
            writeFileSync(join(work, 'café-✓.txt'), 'unicode');
            writeFileSync(join(work, ' spaced .txt'), 'whitespace');
            writeFileSync(join(work, 'quote"angle<>.txt'), 'markup');
            writeFileSync(join(work, 'line\nbreak.txt'), 'newline');
            writeFileSync(join(work, 'unique-kb-target.txt'), 'keyboard');
            writeFileSync(join(outside, 'secret.txt'), OUTSIDE_TEXT);
            for (let index = 0; index < 1005; index++) {
                writeFileSync(
                    join(
                        work,
                        'big',
                        `t-${String(index).padStart(4, '0')}.txt`,
                    ),
                    `row ${index}`,
                );
            }
            if (process.platform !== 'win32') {
                symlinkSync(join(work, 'report.txt'), join(work, 'link.txt'));
                try {
                    execFileSync('mkfifo', [join(work, 'pipe.fifo')]);
                } catch {
                    // Owned fixture only; the listing-exclusion assertion below
                    // is skipped when FIFOs cannot be created.
                }
            }
        },
    });
    return {
        provider,
        phi,
        pngPath: join(phi.dir, 'fixtures', 'public.png'),
        textPath: join(phi.dir, 'fixtures', 'note.txt'),
        gifPath: join(phi.dir, 'fixtures', 'unsupported.gif'),
        fixtures: join(phi.dir, 'fixtures'),
        work: realpathSync(join(phi.dir, 'work')),
        outside: realpathSync(join(phi.dir, 'outside')),
        proxySocket: join(phi.dir, 't', 'a.sock'),
    };
}

async function startAttachmentProxy(
    phiDir: string,
    proxySocket: string,
): Promise<BridgeProxy> {
    const runTmp = join(phiDir, 't');
    const upstreams = readdirSync(runTmp, { withFileTypes: true })
        .filter(
            (entry) => entry.isDirectory() && entry.name.startsWith('phi-pi-'),
        )
        .map((entry) => join(runTmp, entry.name, 'bridge.sock'));
    if (upstreams.length !== 1)
        throw new Error(
            `expected one Phi bridge socket, found ${upstreams.length}`,
        );
    return startBridgeProxy(phiDir, upstreams[0]!, proxySocket);
}

async function spawnPane(
    request: APIRequestContext,
    url: string,
    cwd: string,
    title: string,
): Promise<string> {
    const response = await request.post(`${url}/api/terminals`, {
        data: { coder: 'pi', cwd, title },
    });
    expect(response.ok()).toBe(true);
    const pane = ((await response.json()) as { pane_id: string }).pane_id;
    await expect
        .poll(
            async () => {
                const result = await request.get(`${url}/api/terminals`);
                if (!result.ok()) return undefined;
                const tabs = (await result.json()) as Array<{
                    id: string;
                    pi_bridge?: {
                        state: string;
                        connected?: boolean;
                        capabilities?: string[];
                    };
                }>;
                return tabs.find((tab) => tab.id === pane)?.pi_bridge;
            },
            { timeout: 30_000 },
        )
        .toMatchObject({
            state: 'managed',
            connected: true,
            capabilities: expect.arrayContaining(['pi.attachments.v1']),
        });
    return pane;
}

async function waitForIdle(
    request: APIRequestContext,
    url: string,
    pane: string,
): Promise<void> {
    await expect
        .poll(
            async () => {
                const response = await request.get(
                    `${url}/api/pi-bridge/attachments/context?pane=${encodeURIComponent(pane)}`,
                );
                if (!response.ok()) return null;
                return response.json();
            },
            { timeout: 30_000 },
        )
        .toMatchObject({ available: true, idle: true, queued: false });
}

async function selectPane(
    page: Page,
    pane: string,
    mobile: boolean,
): Promise<void> {
    if (mobile) {
        await page.locator('#hostname-display').tap();
        const list = tabList(page);
        await expect(list).toBeVisible({ timeout: 10_000 });
        await list
            .locator(
                `.hostname-dropdown-row[data-pane-id="${pane}"] .hostname-dropdown-select-btn`,
            )
            .tap();
    } else {
        await page.locator(`.tab[data-pane-id="${pane}"]`).click();
    }
    await expect(page.locator('.tab.active')).toHaveAttribute(
        'data-pane-id',
        pane,
    );
}

async function allowLoopbackOnly(page: Page): Promise<void> {
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
            return route.continue();
        return route.abort();
    });
}

async function waitForContext(page: Page, pane: string): Promise<void> {
    await page.waitForResponse(
        (item) =>
            item.url().includes('/api/pi-bridge/attachments/context') &&
            item.url().includes(encodeURIComponent(pane)) &&
            item.request().method() === 'GET',
        { timeout: 30_000 },
    );
}

async function startPage(
    browser: Browser,
    url: string,
    pane: string,
    mobile: boolean,
) {
    const options = mobile
        ? { ...devices['Pixel 7'] }
        : { viewport: { width: 1440, height: 900 } };
    const context = await browser.newContext(options);
    const page = await context.newPage();
    await allowLoopbackOnly(page);
    await page.addInitScript(
        (activePane) => localStorage.setItem('phi_active_pane', activePane),
        pane,
    );
    const contextResponse = waitForContext(page, pane);
    await page.goto(url);
    await selectPane(page, pane, mobile);
    await contextResponse;
    await expect(page.locator('#attach-input-btn')).toBeVisible();
    return { context, page };
}

function watchPage(page: Page, label: string) {
    const origin = page.url();
    const errors: string[] = [];
    const failedRequests: string[] = [];
    const expectedPinAborts: string[] = [];
    const expectedBackgroundFailures: string[] = [];
    page.on('response', (response) => {
        if (response.status() < 400) return;
        const line = `${label}: HTTP ${response.status()} ${response.url()}`;
        if (
            isExpectedOptionalBackgroundFailure(
                response.url(),
                response.status(),
            )
        )
            expectedBackgroundFailures.push(line);
        else errors.push(line);
    });
    page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`));
    page.on('console', (message) => {
        if (message.type() !== 'error') return;
        if (
            message
                .text()
                .startsWith(
                    'Failed to load resource: the server responded with a status of ',
                )
        )
            return;
        // Deliberately aborted routes (offline/refresh-failure cases) also
        // log here; the requestfailed handler below still records each one
        // with its URL, and the tests assert on that list instead.
        if (message.text().startsWith('Failed to load resource: net::ERR_'))
            return;
        if (isExpectedPinSyncConsoleError(message.text()))
            expectedPinAborts.push(`${label}: console ${message.text()}`);
        else errors.push(`${label}: console ${message.text()}`);
    });
    page.on('requestfailed', (failed) => {
        const errorText = failed.failure()?.errorText || '';
        if (isCancelledWorktreeRead(failed, origin)) return;
        if (isExpectedStartupPinAbort(failed.url(), errorText)) {
            expectedPinAborts.push(`${label}: ${failed.url()} ${errorText}`);
            return;
        }
        if (isExpectedOfflineBackgroundFailure(failed.url(), errorText)) {
            expectedBackgroundFailures.push(
                `${label}: ${failed.url()} ${errorText}`,
            );
            return;
        }
        failedRequests.push(`${label}: ${failed.url()} ${errorText}`);
    });
    return {
        errors,
        failedRequests,
        expectedPinAborts,
        expectedBackgroundFailures,
    };
}

async function openAttachmentSource(
    page: Page,
    label: string,
    mobile: boolean,
): Promise<void> {
    const button = page.locator('#attach-input-btn');
    await expect(button).toBeVisible();
    if (mobile) await button.tap();
    else await button.click();
    await expect(page.locator('#attachment-source-dropup')).toBeVisible();
}

async function sourceLabels(page: Page): Promise<string[]> {
    return page
        .locator('#attachment-source-dropup .dropup-model-btn')
        .allTextContents();
}

async function chooseDeviceFiles(
    page: Page,
    paths: string | string[],
    mobile: boolean,
    label?: string,
): Promise<void> {
    const chooser = page.waitForEvent('filechooser');
    await openAttachmentSource(page, '', mobile);
    const item = page.locator('#attachment-source-dropup .dropup-model-btn', {
        hasText: new RegExp(
            `^${label ?? (mobile ? 'Files' : 'Device Files')}$`,
        ),
    });
    if (mobile) await item.tap();
    else await item.click();
    await (await chooser).setFiles(paths);
}

async function openServerModal(page: Page, mobile: boolean): Promise<void> {
    await openAttachmentSource(page, '', mobile);
    const item = page.locator('#attachment-source-dropup .dropup-model-btn', {
        hasText: /^Server Files$/,
    });
    if (mobile) await item.tap();
    else await item.click();
    await expect(page.locator('#attach-server-modal')).toBeVisible();
}

function treeRow(page: Page, name: string) {
    // Match the leaf name span exactly: a treeitem filter would also match
    // ancestor rows whose subtree contains the text. Clicks bubble to the
    // tree's own click handler, so clicking the span selects the row.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return page.locator('#attach-server-modal-tree .directory-tree-name', {
        hasText: new RegExp(`^${escaped}$`),
    });
}

async function expandTreeDir(page: Page, name: string): Promise<void> {
    await treeRow(page, name)
        .locator('xpath=../span[contains(@class,"directory-tree-disclosure")]')
        .click();
}

async function treeNames(page: Page): Promise<string[]> {
    return page.evaluate(() =>
        Array.from(
            document.querySelectorAll(
                '#attach-server-modal-tree .directory-tree-name',
            ),
        ).map((node) => node.textContent ?? ''),
    );
}

async function itemFromServer(
    request: APIRequestContext,
    url: string,
    pane: string,
    id: string,
) {
    const response = await request.get(
        `${url}/api/attachments/v2/items/${id}?pane=${encodeURIComponent(pane)}`,
    );
    expect(response.ok()).toBe(true);
    const status = (await response.json()) as {
        state: string;
        item?: {
            path: string;
            sha256: string;
            kind: string;
            mimeType: string;
            name: string;
        };
    };
    expect(status.state).toBe('ready');
    expect(status.item).toBeTruthy();
    return status.item!;
}

function anthropicUserText(request: AttachmentProviderRequest): string {
    const body = request.body as {
        messages?: Array<{ role?: string; content?: unknown }>;
    };
    return (body.messages ?? [])
        .filter((message) => message.role === 'user')
        .map((message) =>
            typeof message.content === 'string'
                ? message.content
                : JSON.stringify(message.content ?? ''),
        )
        .join('\n');
}

function anthropicImages(
    request: AttachmentProviderRequest,
    latestUserOnly = false,
): Array<{ mediaType: string; data: string }> {
    const body = request.body as {
        messages?: Array<{
            role?: string;
            content?: Array<Record<string, unknown>>;
        }>;
    };
    const userMessages = (body.messages ?? []).filter(
        (message) => message.role === 'user',
    );
    const targets = latestUserOnly ? userMessages.slice(-1) : userMessages;
    const images: Array<{ mediaType: string; data: string }> = [];
    for (const message of targets) {
        if (!Array.isArray(message.content)) continue;
        for (const part of message.content) {
            const source = part.source as
                | { type?: string; media_type?: string; data?: string }
                | undefined;
            if (
                part.type === 'image' &&
                source?.type === 'base64' &&
                source.media_type &&
                source.data
            ) {
                images.push({
                    mediaType: source.media_type,
                    data: source.data,
                });
            }
        }
    }
    return images;
}

function attachedHandoffPaths(request: AttachmentProviderRequest): string[] {
    const body = request.body as {
        messages?: Array<{
            role?: string;
            content?: Array<Record<string, unknown>>;
        }>;
    };
    const lastUser = (body.messages ?? [])
        .filter((message) => message.role === 'user')
        .at(-1);
    const text = (lastUser?.content ?? [])
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text as string)
        .join('\n');
    const paths: string[] = [];
    const pattern = /Attached file path \(JSON-quoted\): ("(?:[^"\\]|\\.)*")/g;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        paths.push(JSON.parse(match[1]!) as string);
    }
    return paths;
}

function lastUserText(request: AttachmentProviderRequest): string {
    const body = request.body as {
        messages?: Array<{
            role?: string;
            content?: Array<Record<string, unknown>>;
        }>;
    };
    const lastUser = (body.messages ?? [])
        .filter((message) => message.role === 'user')
        .at(-1);
    return (lastUser?.content ?? [])
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text as string)
        .join('\n');
}

function lastUserContentOrder(request: AttachmentProviderRequest): string[] {
    const body = request.body as {
        messages?: Array<{
            role?: string;
            content?: Array<Record<string, unknown>>;
        }>;
    };
    const lastUser = (body.messages ?? [])
        .filter((message) => message.role === 'user')
        .at(-1);
    return (lastUser?.content ?? []).map((part) => {
        if (part.type === 'image') return 'image';
        if (
            part.type === 'text' &&
            typeof part.text === 'string' &&
            part.text.includes('Attached file path')
        )
            return 'file';
        return 'text';
    });
}

async function waitForProvider(
    provider: AttachmentProvider,
    count: number,
): Promise<void> {
    await provider.waitForRequests(count, 30_000);
}

test('desktop server file inside cwd snapshots without browser upload and reaches Pi read', async ({
    browser,
    request,
}) => {
    test.setTimeout(240_000);
    const fixture = await startSourcesFixture();
    let proxy: BridgeProxy | null = null;
    try {
        proxy = await startAttachmentProxy(
            fixture.phi.dir,
            fixture.proxySocket,
        );
        const pane = await spawnPane(
            request,
            fixture.phi.url,
            fixture.work,
            'Pi server source',
        );
        const { context, page } = await startPage(
            browser,
            fixture.phi.url,
            pane,
            false,
        );
        const watched = watchPage(page, 'server-inside');
        try {
            const puts: string[] = [];
            const snapshots: string[] = [];
            page.on('request', (item) => {
                const path = new URL(item.url()).pathname;
                if (
                    item.method() === 'PUT' &&
                    path.startsWith('/api/attachments/v2/items/')
                )
                    puts.push(item.url());
                if (
                    item.method() === 'POST' &&
                    path === '/api/attachments/v2/server-items'
                )
                    snapshots.push(item.url());
            });
            await openAttachmentSource(page, '', false);
            expect(await sourceLabels(page)).toEqual([
                'Device Files',
                'Server Files',
            ]);
            await page
                .locator('#attachment-source-dropup .dropup-model-btn', {
                    hasText: /^Server Files$/,
                })
                .click();
            await expect(page.locator('#attach-server-modal')).toBeVisible();
            await expect(
                page.locator(
                    '#attach-server-modal-tree .directory-tree-location',
                ),
            ).toHaveText(`Browsing: ${fixture.work}`, { timeout: 15_000 });
            await expect(treeRow(page, 'report.txt')).toBeVisible({
                timeout: 15_000,
            });
            await treeRow(page, 'report.txt').click();
            await expect(page.locator('#attach-server-modal')).toBeHidden();
            const chip = page
                .locator('#attachment-strip .attachment-chip')
                .filter({ hasText: 'report.txt' });
            await expect(chip).toBeVisible({ timeout: 10_000 });
            await expect(chip.locator('.attachment-state')).toHaveText(
                'Ready',
                { timeout: 30_000 },
            );
            expect(puts).toHaveLength(0);
            expect(snapshots).toHaveLength(1);
            const id = await chip.getAttribute('data-id');
            const stored = await itemFromServer(
                request,
                fixture.phi.url,
                pane,
                id!,
            );
            expect(readFileSync(stored.path, 'utf8')).toBe(SERVER_TEXT);

            await waitForIdle(request, fixture.phi.url, pane);
            const before = fixture.provider.requests.length;
            await page
                .locator('#input-textarea')
                .fill('PHI_ATTACH_READ_FIXTURE server file');
            await page.locator('#input-textarea').press('Enter');
            await waitForProvider(fixture.provider, before + 2);
            const toolRequest = fixture.provider.requests[before]!;
            expect(anthropicUserText(toolRequest)).toContain(
                'PHI_ATTACH_READ_FIXTURE',
            );
            const handoffPaths = attachedHandoffPaths(toolRequest);
            expect(handoffPaths).toHaveLength(1);
            expect(handoffPaths[0]).toContain('/attachments-v2/handoff/');
            const readResult = fixture.provider.requests[before + 1]!;
            expect(anthropicUserText(readResult)).toContain(SERVER_TEXT);
            await expect(page.locator('#attachment-status')).toContainText(
                'Submitted to Pi',
                { timeout: 15_000 },
            );

            expect(watched.errors).toEqual([]);
            expect(watched.failedRequests).toEqual([]);
        } finally {
            await context.close();
        }
    } finally {
        await proxy?.close();
        await fixture.phi.stop();
        await fixture.provider.close();
    }
});

test('server selection outside cwd keeps unsafe names as data and supports keyboard', async ({
    browser,
    request,
}) => {
    test.setTimeout(240_000);
    const fixture = await startSourcesFixture();
    let proxy: BridgeProxy | null = null;
    try {
        proxy = await startAttachmentProxy(
            fixture.phi.dir,
            fixture.proxySocket,
        );
        const pane = await spawnPane(
            request,
            fixture.phi.url,
            fixture.work,
            'Pi unsafe names',
        );
        const { context, page } = await startPage(
            browser,
            fixture.phi.url,
            pane,
            false,
        );
        const watched = watchPage(page, 'server-outside');
        try {
            const puts: string[] = [];
            page.on('request', (item) => {
                if (
                    item.method() === 'PUT' &&
                    new URL(item.url()).pathname.startsWith(
                        '/api/attachments/v2/items/',
                    )
                ) {
                    puts.push(item.url());
                }
            });
            await page.locator('#input-textarea').fill('keep this draft');
            await openServerModal(page, false);
            await expect(treeRow(page, 'report.txt')).toBeVisible({
                timeout: 15_000,
            });
            const names = await treeNames(page);
            for (const name of [
                'my file.txt',
                'café-✓.txt',
                ' spaced .txt',
                'quote"angle<>.txt',
                'line\nbreak.txt',
            ]) {
                expect(names).toContain(name);
            }
            // Keyboard: focus the tree, type ahead to the file, Enter selects.
            await treeRow(page, 'docs').click();
            await page.keyboard.type('unique-kb-target', { delay: 30 });
            await page.keyboard.press('Enter');
            await expect(page.locator('#attach-server-modal')).toBeHidden();
            const kbChip = page
                .locator('#attachment-strip .attachment-chip')
                .filter({ hasText: 'unique-kb-target' });
            await expect(kbChip.locator('.attachment-state')).toHaveText(
                'Ready',
                { timeout: 30_000 },
            );
            expect(await kbChip.locator('.attachment-name').textContent()).toBe(
                'unique-kb-target.txt',
            );
            expect(await page.locator('#input-textarea').inputValue()).toBe(
                'keep this draft',
            );

            // Outside cwd: Up to the fixture root, expand the sibling directory.
            await openServerModal(page, false);
            await expect(treeRow(page, 'report.txt')).toBeVisible({
                timeout: 15_000,
            });
            await page
                .locator('#attach-server-modal-tree .directory-tree-up')
                .click();
            await expect(treeRow(page, 'outside')).toBeVisible({
                timeout: 15_000,
            });
            await expandTreeDir(page, 'outside');
            await expect(treeRow(page, 'secret.txt')).toBeVisible({
                timeout: 15_000,
            });
            await treeRow(page, 'secret.txt').click();
            await expect(page.locator('#attach-server-modal')).toBeHidden();
            const outsideChip = page
                .locator('#attachment-strip .attachment-chip')
                .filter({ hasText: 'secret.txt' });
            await expect(outsideChip.locator('.attachment-state')).toHaveText(
                'Ready',
                { timeout: 30_000 },
            );
            expect(puts).toHaveLength(0);
            const outsideID = await outsideChip.getAttribute('data-id');
            const stored = await itemFromServer(
                request,
                fixture.phi.url,
                pane,
                outsideID!,
            );
            expect(stored.name).toBe('secret.txt');
            expect(readFileSync(stored.path, 'utf8')).toBe(OUTSIDE_TEXT);

            await waitForIdle(request, fixture.phi.url, pane);
            const before = fixture.provider.requests.length;
            await page
                .locator('#input-textarea')
                .fill('unsafe names stay data');
            await page.locator('#input-textarea').press('Enter');
            await waitForProvider(fixture.provider, before + 1);
            const sent = fixture.provider.requests[before]!;
            expect(anthropicUserText(sent)).toContain('unsafe names stay data');
            expect(attachedHandoffPaths(sent)).toHaveLength(2);
            expect(anthropicUserText(sent)).not.toContain('quote"angle<>');
            await expect(page.locator('#attachment-status')).toContainText(
                'Submitted to Pi',
                { timeout: 15_000 },
            );

            expect(watched.errors).toEqual([]);
            expect(watched.failedRequests).toEqual([]);
        } finally {
            await context.close();
        }
    } finally {
        await proxy?.close();
        await fixture.phi.stop();
        await fixture.provider.close();
    }
});

test('changed, deleted, and unsafe server sources keep a retained error chip', async ({
    browser,
    request,
}) => {
    test.setTimeout(240_000);
    const fixture = await startSourcesFixture();
    let proxy: BridgeProxy | null = null;
    try {
        proxy = await startAttachmentProxy(
            fixture.phi.dir,
            fixture.proxySocket,
        );
        const pane = await spawnPane(
            request,
            fixture.phi.url,
            fixture.work,
            'Pi source errors',
        );
        const { context, page } = await startPage(
            browser,
            fixture.phi.url,
            pane,
            false,
        );
        const watched = watchPage(page, 'server-errors');
        const expectedRefusals: string[] = [];
        page.on('response', (response) => {
            if (
                response.status() === 409 &&
                new URL(response.url()).pathname ===
                    '/api/attachments/v2/server-items'
            ) {
                expectedRefusals.push(response.url());
            }
        });
        try {
            await page.locator('#input-textarea').fill('error draft stays');
            await openServerModal(page, false);
            await expect(treeRow(page, 'mutate.txt')).toBeVisible({
                timeout: 15_000,
            });
            const names = await treeNames(page);
            expect(names).not.toContain('link.txt');
            expect(names).not.toContain('pipe.fifo');
            // Mutate after the listing so the cached fingerprint is stale.
            writeFileSync(
                join(fixture.work, 'mutate.txt'),
                'mutated bytes with a different length',
            );
            await treeRow(page, 'mutate.txt').click();
            await expect(page.locator('#attach-server-modal')).toBeHidden();
            const mutated = page
                .locator('#attachment-strip .attachment-chip')
                .filter({ hasText: 'mutate.txt' });
            await expect(mutated.locator('.attachment-state')).toHaveText(
                'Error: changed-source',
                { timeout: 30_000 },
            );
            expect(await page.locator('#input-textarea').inputValue()).toBe(
                'error draft stays',
            );

            await openServerModal(page, false);
            await expect(treeRow(page, 'delete-me.txt')).toBeVisible({
                timeout: 15_000,
            });
            rmSync(join(fixture.work, 'delete-me.txt'));
            await treeRow(page, 'delete-me.txt').click();
            await expect(page.locator('#attach-server-modal')).toBeHidden();
            const deleted = page
                .locator('#attachment-strip .attachment-chip')
                .filter({ hasText: 'delete-me.txt' });
            await expect(deleted.locator('.attachment-state')).toHaveText(
                'Error: changed-source',
                { timeout: 30_000 },
            );
            await expect(
                page.locator('#attachment-strip .attachment-chip'),
            ).toHaveCount(2);
            expect(await page.locator('#input-textarea').inputValue()).toBe(
                'error draft stays',
            );

            // Unsafe direct targets refuse promptly without producing an item.
            const postSnapshot = (path: string) =>
                request.post(
                    `${fixture.phi.url}/api/attachments/v2/server-items`,
                    {
                        headers: {
                            Origin: fixture.phi.url,
                            'Sec-Fetch-Site': 'same-origin',
                        },
                        data: {
                            id: '11111111-2222-4333-8555-666666666666',
                            pane,
                            path,
                            expected_fingerprint: '0'.repeat(64),
                        },
                    },
                );
            const symlink = await postSnapshot(join(fixture.work, 'link.txt'));
            expect(symlink.status()).toBe(409);
            expect((await symlink.json()) as { reason: string }).toMatchObject({
                reason: 'changed-source',
            });
            const device = await postSnapshot('/dev/null');
            expect(device.status()).toBe(409);
            const directory = await postSnapshot(join(fixture.work, 'docs'));
            expect(directory.status()).toBe(409);

            const unexpectedErrors = watched.errors.filter(
                (line) => !line.includes('/api/attachments/v2/server-items'),
            );
            expect(unexpectedErrors).toEqual([]);
            expect(watched.failedRequests).toEqual([]);
            expect(expectedRefusals).toHaveLength(2);

            await page.reload();
            await selectPane(page, pane, false);
            await expect(page.locator('#input-textarea')).toHaveValue(
                'error draft stays',
            );
            await expect(mutated.locator('.attachment-state')).toHaveText(
                'Error: changed-source',
            );
            await expect(deleted.locator('.attachment-state')).toHaveText(
                'Error: changed-source',
            );
            expect(fixture.provider.requests).toHaveLength(0);
        } finally {
            await context.close();
        }
    } finally {
        await proxy?.close();
        await fixture.phi.stop();
        await fixture.provider.close();
    }
});

test('cached server rows survive offline and refresh failure without crossing panes', async ({
    browser,
    request,
}) => {
    test.setTimeout(240_000);
    const fixture = await startSourcesFixture();
    let proxy: BridgeProxy | null = null;
    try {
        proxy = await startAttachmentProxy(
            fixture.phi.dir,
            fixture.proxySocket,
        );
        const pane = await spawnPane(
            request,
            fixture.phi.url,
            fixture.work,
            'Pi server cache',
        );
        // Spawned before page load: the tab strip only lists panes that
        // existed when the page loaded, matching the recovery spec pattern.
        const other = await spawnPane(
            request,
            fixture.phi.url,
            fixture.outside,
            'Pi server cache other',
        );
        const { context, page } = await startPage(
            browser,
            fixture.phi.url,
            pane,
            false,
        );
        const watched = watchPage(page, 'server-cache');
        try {
            await page.locator('#input-textarea').fill('cache draft');
            await openServerModal(page, false);
            await expect(treeRow(page, 'report.txt')).toBeVisible({
                timeout: 15_000,
            });
            await page.locator('#attach-server-modal-cancel-btn').click();
            await expect(page.locator('#attach-server-modal')).toBeHidden();
            expect(await page.locator('#input-textarea').inputValue()).toBe(
                'cache draft',
            );

            await context.setOffline(true);
            try {
                await openServerModal(page, false);
                await expect(treeRow(page, 'report.txt')).toBeVisible({
                    timeout: 15_000,
                });
                await expect(
                    page.locator('#attach-server-modal-status'),
                ).toHaveText('Offline. Showing a cached listing.', {
                    timeout: 15_000,
                });
                await treeRow(page, 'report.txt').click();
                await expect(page.locator('#attach-server-modal')).toBeHidden();
                await expect(page.locator('.attachment-state')).toHaveText(
                    'Unconfirmed',
                );
            } finally {
                await context.setOffline(false);
            }

            await page.reload();
            await selectPane(page, pane, false);
            await expect(page.locator('#input-textarea')).toHaveValue(
                'cache draft',
            );
            await expect(page.locator('.attachment-state')).toHaveText(
                'Unconfirmed',
            );
            await page
                .getByRole('button', { name: 'Retry upload for report.txt' })
                .click();
            await expect(page.locator('.attachment-state')).toHaveText('Ready');
            expect(fixture.provider.requests).toHaveLength(0);

            const browsePattern = '**/api/attachments/v2/browse*';
            await page.route(browsePattern, (route) => route.abort('failed'));
            try {
                await openServerModal(page, false);
                await expect(treeRow(page, 'report.txt')).toBeVisible({
                    timeout: 15_000,
                });
                await expect(
                    page.locator('#attach-server-modal-status'),
                ).toHaveText('Refresh failed. Showing a cached listing.', {
                    timeout: 15_000,
                });
                await page.locator('#attach-server-modal-cancel-btn').click();
            } finally {
                await page.unroute(browsePattern);
            }

            // A fresh pane with no cache cannot see the other pane's rows.
            // Listen before clicking: the context request fires on tab
            // activation and may complete before selectPane returns.
            const otherContext = waitForContext(page, other);
            await selectPane(page, other, false);
            await otherContext;
            await page.route(browsePattern, (route) => route.abort('failed'));
            try {
                await openServerModal(page, false);
                await expect(
                    page
                        .locator(
                            '#attach-server-modal-tree .directory-tree-branch-state',
                        )
                        .first(),
                ).toHaveText('Unable to load this directory.', {
                    timeout: 15_000,
                });
                expect(await treeNames(page)).not.toContain('report.txt');
                await page.locator('#attach-server-modal-cancel-btn').click();
            } finally {
                await page.unroute(browsePattern);
            }

            // Truncation surfaces in the tree and the modal status.
            await selectPane(page, pane, false);
            await openServerModal(page, false);
            await expect(treeRow(page, 'big')).toBeVisible({ timeout: 15_000 });
            await expandTreeDir(page, 'big');
            await expect(
                page.locator(
                    '#attach-server-modal-tree .directory-tree-truncated',
                ),
            ).toHaveText('Directory listing truncated at 1000 entries.', {
                timeout: 15_000,
            });
            await expect(
                page.locator('#attach-server-modal-status'),
            ).toHaveText(
                'Showing the first entries; the listing was truncated.',
            );
            await page.locator('#attach-server-modal-cancel-btn').click();

            const browseAborts = watched.failedRequests.filter((line) =>
                line.includes('/api/attachments/v2/browse'),
            );
            const otherFailures = watched.failedRequests.filter(
                (line) => !line.includes('/api/attachments/v2/browse'),
            );
            expect(browseAborts.length).toBeGreaterThan(0);
            expect(otherFailures).toEqual([]);
            expect(watched.errors).toEqual([]);
        } finally {
            await context.close();
        }
    } finally {
        await proxy?.close();
        await fixture.phi.stop();
        await fixture.provider.close();
    }
});

test('multi-file batches preserve order and refuse partial sends', async ({
    browser,
    request,
}) => {
    test.setTimeout(300_000);
    const fixture = await startSourcesFixture();
    let proxy: BridgeProxy | null = null;
    try {
        proxy = await startAttachmentProxy(
            fixture.phi.dir,
            fixture.proxySocket,
        );
        const pane = await spawnPane(
            request,
            fixture.phi.url,
            fixture.work,
            'Pi batch order',
        );
        const { context, page } = await startPage(
            browser,
            fixture.phi.url,
            pane,
            false,
        );
        const watched = watchPage(page, 'batch');
        const expectedRefusals: string[] = [];
        page.on('response', (response) => {
            if (
                response.status() === 415 &&
                new URL(response.url()).pathname.startsWith(
                    '/api/attachments/v2/items/',
                )
            ) {
                expectedRefusals.push(response.url());
            }
        });
        try {
            await waitForIdle(request, fixture.phi.url, pane);
            const before = fixture.provider.requests.length;
            await chooseDeviceFiles(
                page,
                [fixture.pngPath, fixture.textPath],
                false,
            );
            const chips = page.locator('#attachment-strip .attachment-chip');
            await expect(chips).toHaveCount(2, { timeout: 10_000 });
            expect(
                await chips.nth(0).locator('.attachment-name').textContent(),
            ).toBe('public.png');
            expect(
                await chips.nth(1).locator('.attachment-name').textContent(),
            ).toBe('note.txt');
            await expect(chips.nth(0).locator('.attachment-state')).toHaveText(
                'Ready',
                { timeout: 30_000 },
            );
            await expect(chips.nth(1).locator('.attachment-state')).toHaveText(
                'Ready',
                { timeout: 30_000 },
            );
            await page.locator('#input-textarea').fill('batch order check');
            await page.locator('#input-textarea').press('Enter');
            await waitForProvider(fixture.provider, before + 1);
            const batch = fixture.provider.requests[before]!;
            const images = anthropicImages(batch);
            expect(images).toHaveLength(1);
            expect(images[0]!.mediaType).toBe('image/png');
            expect(Buffer.from(images[0]!.data, 'base64')).toEqual(
                readFileSync(fixture.pngPath),
            );
            expect(attachedHandoffPaths(batch)).toHaveLength(1);
            // Pi's public sendUserMessage normalizes content to one text
            // string (text parts joined with "\n") plus a separate image
            // list, so Phi's part boundaries are not observable here.
            // Assert nothing was lost and Phi's order survived the merge.
            const batchText = lastUserText(batch);
            expect(batchText).toContain('batch order check');
            expect(batchText.indexOf('batch order check')).toBeLessThan(
                batchText.indexOf('Attached file path'),
            );
            expect(lastUserContentOrder(batch)).toEqual(['file', 'image']);
            await expect(page.locator('#attachment-status')).toContainText(
                'Submitted to Pi',
                { timeout: 15_000 },
            );

            // A failed item blocks the batch; removing it lets the rest send.
            await waitForIdle(request, fixture.phi.url, pane);
            const beforeFailed = fixture.provider.requests.length;
            await chooseDeviceFiles(
                page,
                [fixture.gifPath, fixture.pngPath],
                false,
            );
            const failedBatch = page.locator(
                '#attachment-strip .attachment-chip',
            );
            await expect(failedBatch).toHaveCount(2, { timeout: 10_000 });
            await expect(
                failedBatch.nth(0).locator('.attachment-state'),
            ).toHaveText('Error: unsupported-image', { timeout: 30_000 });
            await expect(
                failedBatch.nth(1).locator('.attachment-state'),
            ).toHaveText('Ready', { timeout: 30_000 });
            await page.locator('#input-textarea').fill('blocked batch');
            await page.locator('#input-textarea').press('Enter');
            await expect(page.locator('#attachment-status')).toContainText(
                'Wait for the attachment upload to finish or remove the failed item.',
                { timeout: 15_000 },
            );
            expect(await page.locator('#input-textarea').inputValue()).toBe(
                'blocked batch',
            );
            expect(fixture.provider.requests).toHaveLength(beforeFailed);
            page.once('dialog', (dialog) => dialog.accept());
            await failedBatch.nth(0).locator('.attachment-remove').click();
            await expect(
                page.locator('#attachment-strip .attachment-chip'),
            ).toHaveCount(1);
            await page.locator('#input-textarea').press('Enter');
            await waitForProvider(fixture.provider, beforeFailed + 1);
            const secondSend = fixture.provider.requests[beforeFailed]!;
            // The second send carries conversation history: the first
            // batch's image plus exactly one new image in the latest
            // user message. Two images in the latest message would mean
            // the PNG was staged or dispatched twice.
            expect(anthropicImages(secondSend)).toHaveLength(2);
            expect(anthropicImages(secondSend, true)).toHaveLength(1);
            await expect(page.locator('#attachment-status')).toContainText(
                'Submitted to Pi',
                { timeout: 15_000 },
            );

            // A ninth file is refused without losing the batch.
            const batchPaths = Array.from({ length: 9 }, (_, index) =>
                join(fixture.fixtures, `batch-${index}.txt`),
            );
            await chooseDeviceFiles(page, batchPaths, false);
            const nine = page.locator('#attachment-strip .attachment-chip');
            await expect(nine).toHaveCount(9, { timeout: 10_000 });
            await expect(nine.nth(8).locator('.attachment-state')).toHaveText(
                'Error: limit',
                { timeout: 30_000 },
            );
            for (let index = 0; index < 8; index++) {
                await expect(
                    nine.nth(index).locator('.attachment-state'),
                ).toHaveText('Ready', { timeout: 30_000 });
            }

            const unexpectedErrors = watched.errors.filter(
                (line) => !line.includes('/api/attachments/v2/items/'),
            );
            expect(unexpectedErrors).toEqual([]);
            expect(watched.failedRequests).toEqual([]);
            expect(expectedRefusals).toHaveLength(1);
        } finally {
            await context.close();
        }
    } finally {
        await proxy?.close();
        await fixture.phi.stop();
        await fixture.provider.close();
    }
});

test('upload races keep typing, chips, and sends consistent', async ({
    browser,
    request,
}) => {
    test.setTimeout(300_000);
    const fixture = await startSourcesFixture();
    let proxy: BridgeProxy | null = null;
    try {
        proxy = await startAttachmentProxy(
            fixture.phi.dir,
            fixture.proxySocket,
        );
        const pane = await spawnPane(
            request,
            fixture.phi.url,
            fixture.work,
            'Pi upload races',
        );
        const { context, page } = await startPage(
            browser,
            fixture.phi.url,
            pane,
            false,
        );
        const watched = watchPage(page, 'races');
        try {
            let holdUploads = false;
            let heldPutStarted = false;
            let releaseUploads: (() => void) | null = null;
            let gate: Promise<void> | null = null;
            const holdPattern = '**/api/attachments/v2/items/**';
            await page.route(holdPattern, async (route) => {
                if (route.request().method() !== 'PUT' || !holdUploads || !gate)
                    return route.fallback();
                heldPutStarted = true;
                await gate;
                return route.fallback();
            });
            const hold = () => {
                holdUploads = true;
                heldPutStarted = false;
                gate = new Promise<void>((resolve) => {
                    releaseUploads = resolve;
                });
            };
            const release = () => {
                holdUploads = false;
                releaseUploads?.();
                releaseUploads = null;
                gate = null;
            };
            const chips = page.locator('#attachment-strip .attachment-chip');

            // Send during upload waits instead of sending a partial batch.
            await waitForIdle(request, fixture.phi.url, pane);
            const beforeSend = fixture.provider.requests.length;
            hold();
            try {
                await chooseDeviceFiles(page, fixture.pngPath, false);
                await expect(chips).toHaveCount(1, { timeout: 10_000 });
                await expect
                    .poll(() => heldPutStarted, { timeout: 10_000 })
                    .toBe(true);
                await page
                    .locator('#input-textarea')
                    .fill('send while uploading');
                await page.locator('#input-textarea').press('Enter');
                await expect(page.locator('#attachment-status')).toContainText(
                    'Wait for the attachment upload to finish',
                    { timeout: 15_000 },
                );
                expect(await page.locator('#input-textarea').inputValue()).toBe(
                    'send while uploading',
                );
                expect(fixture.provider.requests).toHaveLength(beforeSend);
                // A rapid second selection stages alongside the held upload.
                await chooseDeviceFiles(page, fixture.textPath, false);
                await expect(chips).toHaveCount(2, { timeout: 10_000 });
            } finally {
                release();
            }
            await expect(chips.nth(0).locator('.attachment-state')).toHaveText(
                'Ready',
                { timeout: 30_000 },
            );
            await expect(chips.nth(1).locator('.attachment-state')).toHaveText(
                'Ready',
                { timeout: 30_000 },
            );
            await page.locator('#input-textarea').press('Enter');
            await waitForProvider(fixture.provider, beforeSend + 1);
            await expect(page.locator('#attachment-status')).toContainText(
                'Submitted to Pi',
                { timeout: 15_000 },
            );

            // Remove during upload never resurrects the chip.
            await waitForIdle(request, fixture.phi.url, pane);
            let removedId: string | null = null;
            hold();
            try {
                await chooseDeviceFiles(page, fixture.pngPath, false);
                await expect(chips).toHaveCount(1, { timeout: 10_000 });
                await expect
                    .poll(() => heldPutStarted, { timeout: 10_000 })
                    .toBe(true);
                removedId = await chips.nth(0).getAttribute('data-id');
                page.once('dialog', (dialog) => dialog.accept());
                await chips.nth(0).locator('.attachment-remove').click();
                await expect(chips).toHaveCount(0, { timeout: 10_000 });
            } finally {
                release();
            }
            await expect
                .poll(() => watched.failedRequests.length, { timeout: 10_000 })
                .toBe(1);
            await expect(chips).toHaveCount(0);
            await expect(page.locator('#attachment-status')).not.toContainText(
                'Submitted to Pi',
            );
            await page.unroute(holdPattern);

            // Removing the chip aborts its held upload: the single
            // ERR_ABORTED PUT for the removed item is the expected
            // cancellation, not a failure.
            expect(watched.errors).toEqual([]);
            expect(watched.failedRequests).toHaveLength(1);
            expect(watched.failedRequests[0]).toContain(
                `/api/attachments/v2/items/${removedId}`,
            );
            expect(watched.failedRequests[0]).toContain('ERR_ABORTED');
        } finally {
            await context.close();
        }
    } finally {
        await proxy?.close();
        await fixture.phi.stop();
        await fixture.provider.close();
    }
});

test('mobile source menu supports keyboard, distinct inputs, and cancel drafts', async ({
    browser,
    request,
}) => {
    test.setTimeout(240_000);
    const fixture = await startSourcesFixture();
    let proxy: BridgeProxy | null = null;
    try {
        proxy = await startAttachmentProxy(
            fixture.phi.dir,
            fixture.proxySocket,
        );
        const pane = await spawnPane(
            request,
            fixture.phi.url,
            fixture.work,
            'Pi mobile sources',
        );
        const { context, page } = await startPage(
            browser,
            fixture.phi.url,
            pane,
            true,
        );
        const watched = watchPage(page, 'mobile-sources');
        try {
            await page.setViewportSize({ width: 320, height: 740 });
            await expect(
                page.locator('#attachment-camera-input'),
            ).toHaveAttribute('capture', 'environment');
            await expect(
                page.locator('#attachment-camera-input'),
            ).toHaveAttribute('accept', 'image/*');
            await expect(
                page.locator('#attachment-photo-input'),
            ).toHaveAttribute('accept', 'image/*');
            await expect(
                page.locator('#attachment-photo-input'),
            ).toHaveAttribute('multiple', '');
            await expect(
                page.locator('#attachment-file-input'),
            ).toHaveAttribute('multiple', '');
            await openAttachmentSource(page, '', true);
            expect(await sourceLabels(page)).toEqual([
                'Photos',
                'Take Photo',
                'Files',
            ]);
            const menuBounds = await page
                .locator('#attachment-source-dropup')
                .boundingBox();
            expect(menuBounds).not.toBeNull();
            expect(menuBounds!.x).toBeGreaterThanOrEqual(0);
            expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(
                page.viewportSize()!.width,
            );
            const attachButton = page.getByRole('button', {
                name: 'Attach files',
            });
            const sourceMenu = page.getByRole('menu', {
                name: 'Attachment source',
            });
            const menuItems = sourceMenu.getByRole('menuitem');
            await expect(attachButton).toHaveAttribute('aria-expanded', 'true');
            await expect(menuItems).toHaveCount(3);
            for (const target of [attachButton, ...(await menuItems.all())]) {
                expect(
                    await target.evaluate(
                        (element) => element.getBoundingClientRect().height,
                    ),
                ).toBeGreaterThanOrEqual(44);
            }
            await page.keyboard.press('Escape');
            await expect(sourceMenu).toBeHidden();
            await expect(attachButton).toHaveAttribute(
                'aria-expanded',
                'false',
            );
            await expect(attachButton).toBeFocused();

            await attachButton.press('Enter');
            await expect(sourceMenu).toBeVisible();
            await expect(menuItems.first()).toBeFocused();
            await page.keyboard.press('ArrowDown');
            await expect(menuItems.nth(1)).toBeFocused();
            await page.keyboard.press('End');
            await expect(menuItems.last()).toBeFocused();
            await page.keyboard.press('ArrowUp');
            await expect(menuItems.nth(1)).toBeFocused();
            await page.keyboard.press('Home');
            await expect(menuItems.first()).toBeFocused();
            await page.keyboard.press('Escape');
            await expect(sourceMenu).toBeHidden();
            await expect(attachButton).toBeFocused();
            await openAttachmentSource(page, '', true);

            await page.locator('#input-textarea').fill('mobile draft');
            const cancelled = page.waitForEvent('filechooser');
            await page
                .locator('#attachment-source-dropup .dropup-model-btn', {
                    hasText: /^Files$/,
                })
                .tap();
            await (await cancelled).setFiles([]);
            await expect(
                page.locator('#attachment-strip .attachment-chip'),
            ).toHaveCount(0);
            expect(await page.locator('#input-textarea').inputValue()).toBe(
                'mobile draft',
            );

            await chooseDeviceFiles(page, fixture.pngPath, true, 'Photos');
            const chips = page.locator('#attachment-strip .attachment-chip');
            await expect(chips).toHaveCount(1, { timeout: 10_000 });
            await expect(chips.nth(0).locator('.attachment-state')).toHaveText(
                'Ready',
                { timeout: 30_000 },
            );
            // Repeated selection adds without clearing the draft or batch.
            await chooseDeviceFiles(page, fixture.textPath, true, 'Files');
            await expect(chips).toHaveCount(2, { timeout: 10_000 });
            expect(await page.locator('#input-textarea').inputValue()).toBe(
                'mobile draft',
            );
            await expect(chips.nth(1).locator('.attachment-state')).toHaveText(
                'Ready',
                { timeout: 30_000 },
            );

            await waitForIdle(request, fixture.phi.url, pane);
            const before = fixture.provider.requests.length;
            await page.locator('#input-textarea').press('Enter');
            await waitForProvider(fixture.provider, before + 1);
            expect(
                anthropicImages(fixture.provider.requests[before]!),
            ).toHaveLength(1);
            await expect(page.locator('#attachment-status')).toContainText(
                'Submitted to Pi',
                { timeout: 15_000 },
            );

            expect(watched.errors).toEqual([]);
            expect(watched.failedRequests).toEqual([]);
        } finally {
            await context.close();
        }
    } finally {
        await proxy?.close();
        await fixture.phi.stop();
        await fixture.provider.close();
    }
});
