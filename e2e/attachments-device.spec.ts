import {
    copyFileSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    writeFileSync,
} from 'node:fs';
import { realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
    devices,
    expect,
    test,
    type APIRequestContext,
    type Page,
    type Route,
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
const FILE_CONTENT = 'PHI_ATTACHMENT_READ_FIXTURE_3f7a';
const CONSUME_MARKER = 'PHI_ATTACH_HOOK_CONSUME';
const STRIP_MARKER = 'PHI_ATTACH_HOOK_STRIP_IMAGE';

// Backend profile bootstrap can abort its best-effort pin sync while its
// initial scope is replaced. Keep this exact known cancellation visible but
// separate from attachment and other failed requests.
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

function isExpectedUnsupportedImageUpload(
    url: string,
    method: string,
    status: number,
): boolean {
    return (
        method === 'PUT' &&
        status === 415 &&
        /^\/api\/attachments\/v2\/items\/[0-9a-f-]{36}$/.test(
            new URL(url).pathname,
        )
    );
}

type PaneBridge = {
    state: string;
    connected?: boolean;
    capabilities?: string[];
};

async function paneBridge(
    request: APIRequestContext,
    url: string,
    pane: string,
): Promise<PaneBridge | undefined> {
    const response = await request.get(`${url}/api/terminals`);
    if (!response.ok()) return undefined;
    const tabs = (await response.json()) as Array<{
        id: string;
        pi_bridge?: PaneBridge;
    }>;
    return tabs.find((tab) => tab.id === pane)?.pi_bridge;
}

async function startAttachmentPhi() {
    const provider = await startAttachmentProvider();
    const phi = await startPhi({
        config: { auto_reconnect: 'off' },
        env: { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
        setup(dir) {
            const home = join(dir, 'home');
            const agent = join(home, '.pi', 'agent');
            const extensions = join(agent, 'extensions');
            const work = join(dir, 'work');
            const openaiWork = join(dir, 'openai-fixture');
            const fixtures = join(dir, 'attachment-fixtures');
            mkdirSync(agent, { recursive: true });
            mkdirSync(extensions, { recursive: true });
            mkdirSync(work, { recursive: true });
            mkdirSync(openaiWork, { recursive: true });
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
                        'attachment-openai': {
                            baseUrl: `http://127.0.0.1:${provider.port}/v1`,
                            api: 'openai-completions',
                            apiKey: 'attachment-fixture-key',
                            models: [
                                {
                                    id: 'vision',
                                    name: 'Fixture Vision OpenAI',
                                    input: ['text', 'image'],
                                    contextWindow: 32_000,
                                    maxTokens: 2048,
                                },
                            ],
                        },
                    },
                }),
            );
            // This isolated harmless extension exercises Pi's own input and
            // context transformation hooks. It does not replace or disable
            // the Phi bridge or alter ordinary user extensions.
            writeFileSync(
                join(extensions, 'attachment-boundary-fixture.js'),
                `module.exports = (pi) => {\n` +
                    `  pi.registerCommand('attachment-metadata-fixture', { description: 'Append harmless fixture metadata', handler: async (_args, ctx) => { pi.appendEntry('attachment-fixture-state', { enabled: true }); require('node:fs').writeFileSync(${JSON.stringify(join(fixtures, 'metadata-leaf'))}, ctx.sessionManager.getLeafId()); } });\n` +
                    `  pi.on('input', (event) => event.text.includes('${CONSUME_MARKER}') ? { action: 'handled' } : undefined);\n` +
                    `  pi.on('context', (event) => {\n` +
                    `    if (!event.messages.some((message) => message.role === 'user' && JSON.stringify(message.content).includes('${STRIP_MARKER}'))) return;\n` +
                    `    return { messages: event.messages.map((message) => message.role === 'user' && Array.isArray(message.content) ? { ...message, content: message.content.filter((part) => part.type !== 'image') } : message) };\n` +
                    `  });\n` +
                    `};\n`,
            );
            const command = join(dir, 'native-pi');
            const binary = join(process.cwd(), 'node_modules', '.bin', 'pi');
            const proxySocket = join(dir, 't', 'a.sock');
            writeFileSync(
                command,
                `#!/bin/sh\n` +
                    `export PHI_PI_BRIDGE_ENDPOINT=${shellQuote(`unix:${proxySocket}`)}\n` +
                    `case "$PWD" in *openai-fixture*) model='attachment-openai/vision' ;; *) model='attachment-anthropic/vision' ;; esac\n` +
                    `exec ${shellQuote(binary)} --no-prompt-templates --no-context-files --no-approve --model "$model" "$@"\n`,
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
            writeFileSync(join(fixtures, 'note.txt'), FILE_CONTENT);
            writeFileSync(
                join(fixtures, 'unsupported.gif'),
                Buffer.from('GIF89a'),
            );
        },
    });
    return {
        provider,
        phi,
        pngPath: join(phi.dir, 'attachment-fixtures', 'public.png'),
        textPath: join(phi.dir, 'attachment-fixtures', 'note.txt'),
        gifPath: join(phi.dir, 'attachment-fixtures', 'unsupported.gif'),
        work: realpathSync(join(phi.dir, 'work')),
        openaiWork: realpathSync(join(phi.dir, 'openai-fixture')),
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
        .poll(() => paneBridge(request, url, pane), { timeout: 30_000 })
        .toMatchObject({
            state: 'managed',
            connected: true,
            capabilities: expect.arrayContaining(['pi.attachments.v3']),
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

async function blockExternalRequests(
    page: Page,
    record: (url: string) => void,
): Promise<void> {
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
            return route.continue();
        record(url.href);
        return route.abort();
    });
}

async function holdNextUpload(
    page: Page,
    request: APIRequestContext,
    pane: string,
    filePath: string,
): Promise<{
    responseHeld: Promise<{ status: number; body: string }>;
    release: () => Promise<void>;
}> {
    let resolveResponseHeld!: (result: {
        status: number;
        body: string;
    }) => void;
    let releaseResponse!: () => void;
    const responseHeld = new Promise<{ status: number; body: string }>(
        (resolve) => {
            resolveResponseHeld = resolve;
        },
    );
    const released = new Promise<void>((resolve) => {
        releaseResponse = resolve;
    });
    const handler = async (route: Route) => {
        if (route.request().method() !== 'PUT') return route.fallback();
        const url = new URL(route.request().url());
        const name = basename(filePath);
        const response = await request.put(route.request().url(), {
            headers: { Origin: url.origin, 'Sec-Fetch-Site': 'same-origin' },
            multipart: {
                pane,
                name,
                file: {
                    name,
                    mimeType: 'image/png',
                    buffer: readFileSync(filePath),
                },
            },
        });
        const body = await response.body();
        resolveResponseHeld({
            status: response.status(),
            body: body.toString('utf8'),
        });
        await released;
        await route.fulfill({
            status: response.status(),
            headers: response.headers(),
            body,
        });
    };
    await page.route('**/api/attachments/v2/items/**', handler);
    return {
        responseHeld,
        release: async () => {
            releaseResponse();
            await page.unroute('**/api/attachments/v2/items/**', handler);
        },
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
    const menu = page.locator('#attachment-source-dropup');
    await expect(menu).toBeVisible();
    const item = menu.locator('.dropup-model-btn', {
        hasText: new RegExp(`^${label}$`),
    });
    if (mobile) await item.tap();
    else await item.click();
}

async function chooseFile(
    page: Page,
    path: string | string[],
    mobile: boolean,
): Promise<void> {
    const chooser = page.waitForEvent('filechooser');
    await openAttachmentSource(page, mobile ? 'Files' : 'Device Files', mobile);
    await (await chooser).setFiles(path);
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

function attachedHandoffPath(request: AttachmentProviderRequest): string {
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
    const match = text.match(
        /Attached file path \(JSON-quoted\): ("(?:[^"\\]|\\.)*")/,
    );
    if (!match)
        throw new Error('Pi request did not include an attached-file path');
    const path = JSON.parse(match[1]!) as unknown;
    if (typeof path !== 'string')
        throw new Error('Pi attached-file path is not a string');
    return path;
}

function openAIImages(
    request: AttachmentProviderRequest,
): Array<{ mime: string; data: string }> {
    const body = request.body as { messages?: Array<{ content?: unknown }> };
    const found: Array<{ mime: string; data: string }> = [];
    const walk = (value: unknown): void => {
        if (Array.isArray(value)) {
            for (const child of value) walk(child);
        } else if (value && typeof value === 'object') {
            const row = value as Record<string, unknown>;
            const imageUrl = row.image_url as { url?: unknown } | undefined;
            if (row.type === 'image_url' && typeof imageUrl?.url === 'string') {
                const match = imageUrl.url.match(
                    /^data:(image\/(?:png|jpeg));base64,(.+)$/i,
                );
                if (match) found.push({ mime: match[1]!, data: match[2]! });
            }
            for (const child of Object.values(row)) walk(child);
        }
    };
    for (const message of body.messages ?? []) walk(message.content);
    return found;
}

async function waitForProvider(
    provider: AttachmentProvider,
    count: number,
): Promise<void> {
    await provider.waitForRequests(count, 30_000);
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
        item?: { path: string; sha256: string; kind: string; mimeType: string };
    };
    expect(status.state).toBe('ready');
    expect(status.item).toBeTruthy();
    return status.item!;
}

test('idle extension metadata does not falsely stale a fresh attachment send', async ({
    browser,
    request,
}) => {
    test.setTimeout(180_000);
    const { provider, phi, pngPath, work, proxySocket } =
        await startAttachmentPhi();
    let proxy: BridgeProxy | null = null;
    try {
        proxy = await startAttachmentProxy(phi.dir, proxySocket);
        const marker = join(phi.dir, 'attachment-fixtures', 'metadata-leaf');
        let previousLeaf = '';
        for (const mobile of [false, true]) {
            const pane = await spawnPane(
                request,
                phi.url,
                work,
                `Metadata ${mobile ? 'touch' : 'desktop'}`,
            );
            const context = await browser.newContext(
                mobile
                    ? devices['Pixel 7']
                    : { viewport: { width: 1440, height: 900 } },
            );
            try {
                const page = await context.newPage();
                const errors: string[] = [];
                page.on('pageerror', (error) => errors.push(error.message));
                await blockExternalRequests(page, (url) =>
                    errors.push(`external: ${url}`),
                );
                await page.goto(phi.url);
                await selectPane(page, pane, mobile);
                const appendMetadata = async () => {
                    const response = await request.post(
                        `${phi.url}/api/terminals/${pane}/input`,
                        { data: { text: '/attachment-metadata-fixture' } },
                    );
                    expect(response.ok()).toBe(true);
                    await expect
                        .poll(() => {
                            try {
                                return readFileSync(marker, 'utf8');
                            } catch {
                                return '';
                            }
                        })
                        .not.toBe(previousLeaf);
                    previousLeaf = readFileSync(marker, 'utf8');
                    return previousLeaf;
                };
                // Neither append changes the session, model, or conversation.
                // One precedes staging; the other follows its background read.
                await appendMetadata();
                await chooseFile(page, pngPath, mobile);
                await expect(page.locator('.attachment-chip')).toContainText(
                    'Ready',
                );
                const liveLeaf = await appendMetadata();
                await page.route(
                    '**/api/pi-bridge/attachments/context?**',
                    async (route) => {
                        await new Promise((resolve) =>
                            setTimeout(resolve, 300),
                        );
                        await route.continue();
                    },
                );
                let releaseAcknowledgment: () => void = () => {};
                const acknowledgmentGate = new Promise<void>((resolve) => {
                    releaseAcknowledgment = resolve;
                });
                await page.route(
                    '**/api/pi-bridge/attachments',
                    async (route) => {
                        const response = await route.fetch();
                        await acknowledgmentGate;
                        await route.fulfill({ response });
                    },
                );
                const before = provider.requests.length;
                const sent = page.waitForRequest(
                    (req) =>
                        req.method() === 'POST' &&
                        new URL(req.url()).pathname ===
                            '/api/pi-bridge/attachments',
                );
                await page
                    .locator('#input-textarea')
                    .fill('metadata regression image');
                try {
                    if (mobile) await page.locator('#send-input-btn').tap();
                    else await page.locator('#send-input-btn').click();
                    await expect(page.locator('#input-textarea')).toHaveValue(
                        '',
                    );
                    await page
                        .locator('#input-textarea')
                        .fill('newer typing stays visible');
                } finally {
                    releaseAcknowledgment();
                }
                expect((await sent).postDataJSON().context.leaf_id).toBe(
                    liveLeaf,
                );
                await expect(page.locator('#attachment-status')).toHaveText(
                    'Submitted to Pi.',
                );
                await expect(
                    page.locator('#attachment-status button'),
                ).toHaveCount(0);
                await expect(page.locator('#input-textarea')).toHaveValue(
                    'newer typing stays visible',
                );
                await page
                    .locator('#input-textarea')
                    .fill('next draft after submission');
                await expect(page.locator('#attachment-status')).toBeHidden();
                await waitForProvider(provider, before + 1);
                expect(
                    anthropicImages(provider.requests[before]!, true),
                ).toHaveLength(1);
                await waitForIdle(request, phi.url, pane);
                expect(provider.requests).toHaveLength(before + 1);
                await page.reload();
                await selectPane(page, pane, mobile);
                await expect(page.locator('#input-textarea')).toHaveValue(
                    'next draft after submission',
                );
                if (mobile) await page.locator('#attach-input-btn').tap();
                else await page.locator('#attach-input-btn').click();
                await expect(
                    page.getByRole('menuitem', {
                        name: 'Restore last attachment',
                    }),
                ).toBeVisible();
                await expect(page.locator('#attachment-status')).toBeHidden();
                let duplicateWarning = '';
                page.once('dialog', (dialog) => {
                    duplicateWarning = dialog.message();
                    void dialog.dismiss();
                });
                await page
                    .getByRole('menuitem', { name: 'Restore last attachment' })
                    .click();
                expect(duplicateWarning).toContain('can create a duplicate');
                await expect(page.locator('#input-textarea')).toHaveValue(
                    'next draft after submission',
                );
                expect(provider.requests).toHaveLength(before + 1);
                expect(
                    await page.evaluate(
                        () =>
                            document.documentElement.scrollWidth <=
                            window.innerWidth,
                    ),
                ).toBe(true);
                expect(errors).toEqual([]);
            } finally {
                await context.close();
            }
        }
    } finally {
        await proxy?.close();
        await phi.stop();
        await provider.close();
    }
});

test('device attachments reach interactive Pi as images and readable files on desktop and touch', async ({
    browser,
    request,
}) => {
    test.setTimeout(300_000);
    const { provider, phi, pngPath, textPath, work, proxySocket } =
        await startAttachmentPhi();
    let proxy: BridgeProxy | null = null;
    const contexts: Array<{
        label: string;
        mobile: boolean;
        options: Record<string, unknown>;
    }> = [
        {
            label: 'desktop',
            mobile: false,
            options: { viewport: { width: 1440, height: 900 } },
        },
        { label: 'touch', mobile: true, options: { ...devices['Pixel 7'] } },
    ];
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];
    const expectedPinAborts: string[] = [];
    const expectedBackgroundFailures: string[] = [];
    try {
        proxy = await startAttachmentProxy(phi.dir, proxySocket);
        for (const contextCase of contexts) {
            const pane = await spawnPane(
                request,
                phi.url,
                work,
                `Pi attachment ${contextCase.label}`,
            );
            const context = await browser.newContext(
                contextCase.options as never,
            );
            try {
                const page = await context.newPage();
                page.on('response', (response) => {
                    if (response.status() < 400) return;
                    const line = `${contextCase.label}: HTTP ${response.status()} ${response.url()}`;
                    if (
                        isExpectedOptionalBackgroundFailure(
                            response.url(),
                            response.status(),
                        )
                    )
                        expectedBackgroundFailures.push(line);
                    else pageErrors.push(line);
                });
                page.on('pageerror', (error) =>
                    pageErrors.push(`${contextCase.label}: ${error.message}`),
                );
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
                    if (isExpectedPinSyncConsoleError(message.text()))
                        expectedPinAborts.push(
                            `${contextCase.label}: console ${message.text()}`,
                        );
                    else
                        pageErrors.push(
                            `${contextCase.label}: console ${message.text()}`,
                        );
                });
                page.on('requestfailed', (failed) => {
                    const errorText = failed.failure()?.errorText || '';
                    const line = `${contextCase.label}: ${failed.url()} ${errorText}`;
                    if (isCancelledWorktreeRead(failed, phi.url)) return;
                    if (isExpectedStartupPinAbort(failed.url(), errorText))
                        expectedPinAborts.push(line);
                    else failedRequests.push(line);
                });
                await page.route('**/*', (route) => {
                    const url = new URL(route.request().url());
                    if (
                        url.hostname === '127.0.0.1' ||
                        url.hostname === 'localhost'
                    )
                        return route.continue();
                    failedRequests.push(
                        `${contextCase.label}: blocked external request ${url.href}`,
                    );
                    return route.abort();
                });
                const contextResponse = page.waitForResponse(
                    (response) =>
                        response
                            .url()
                            .includes('/api/pi-bridge/attachments/context') &&
                        response.url().includes(encodeURIComponent(pane)),
                    { timeout: 30_000 },
                );
                await page.setViewportSize(
                    contextCase.mobile
                        ? { width: 390, height: 844 }
                        : { width: 1440, height: 900 },
                );
                // Select the target before tab restoration so startup does not
                // issue and then abort an attachment-context read for another pane.
                await page.addInitScript(
                    (activePane) =>
                        localStorage.setItem('phi_active_pane', activePane),
                    pane,
                );
                await page.goto(phi.url);
                await selectPane(page, pane, contextCase.mobile);
                await contextResponse;
                await expect(page.locator('#attach-input-btn')).toBeVisible();

                const originalPNG = readFileSync(pngPath);
                const beforeImage = provider.requests.length;
                const uploadHold = await holdNextUpload(
                    page,
                    request,
                    pane,
                    pngPath,
                );
                try {
                    await chooseFile(page, pngPath, contextCase.mobile);
                    const heldResponse = await uploadHold.responseHeld;
                    expect(heldResponse, heldResponse.body).toMatchObject({
                        status: 200,
                    });
                    const heldChip = page
                        .locator('#attachment-strip .attachment-chip')
                        .filter({ hasText: 'public.png' });
                    await expect(heldChip).toBeVisible({ timeout: 10_000 });
                    await expect(
                        heldChip.locator('.attachment-state'),
                    ).toHaveText('Uploading');
                } finally {
                    await uploadHold.release();
                }
                const imageChip = page
                    .locator('#attachment-strip .attachment-chip')
                    .filter({ hasText: 'public.png' });
                await expect(imageChip).toBeVisible({ timeout: 10_000 });
                await expect(imageChip.locator('.attachment-state')).toHaveText(
                    'Ready',
                    { timeout: 30_000 },
                );
                const imageID = await imageChip.getAttribute('data-id');
                expect(imageID).toMatch(/^[0-9a-f-]{36}$/);
                const storedPNG = await itemFromServer(
                    request,
                    phi.url,
                    pane,
                    imageID!,
                );
                expect(storedPNG.kind).toBe('image');
                expect(storedPNG.mimeType).toBe('image/png');
                expect(readFileSync(storedPNG.path)).toEqual(originalPNG);

                const imageSend = page.locator('#send-input-btn');
                if (contextCase.mobile) await imageSend.tap();
                else await imageSend.click();
                await waitForProvider(provider, beforeImage + 1);
                const imageRequest = provider.requests
                    .slice(beforeImage)
                    .find((candidate) => anthropicImages(candidate).length > 0);
                expect(
                    imageRequest,
                    `${contextCase.label}: provider request must carry a native image block`,
                ).toBeTruthy();
                const imageParts = anthropicImages(imageRequest!);
                expect(imageParts).toHaveLength(1);
                expect(imageParts[0]!.mediaType).toBe('image/png');
                expect(Buffer.from(imageParts[0]!.data, 'base64')).toEqual(
                    originalPNG,
                );
                await expect(page.locator('#attachment-status')).toContainText(
                    'Submitted to Pi',
                    { timeout: 15_000 },
                );
                const cancelledChooser = page.waitForEvent('filechooser');
                await openAttachmentSource(
                    page,
                    contextCase.mobile ? 'Files' : 'Device Files',
                    contextCase.mobile,
                );
                await (await cancelledChooser).setFiles([]);
                await expect(
                    page.locator('#attachment-strip .attachment-chip'),
                ).toHaveCount(0);

                await waitForIdle(request, phi.url, pane);
                const beforeFile = provider.requests.length;
                await chooseFile(page, textPath, contextCase.mobile);
                const fileChip = page
                    .locator('#attachment-strip .attachment-chip')
                    .filter({ hasText: 'note.txt' });
                await expect(fileChip).toBeVisible({ timeout: 10_000 });
                await expect(fileChip.locator('.attachment-state')).toHaveText(
                    'Ready',
                    { timeout: 30_000 },
                );
                const fileID = await fileChip.getAttribute('data-id');
                const storedFile = await itemFromServer(
                    request,
                    phi.url,
                    pane,
                    fileID!,
                );
                expect(storedFile.kind).toBe('file');
                expect(readFileSync(storedFile.path, 'utf8')).toBe(
                    FILE_CONTENT,
                );
                await page
                    .locator('#input-textarea')
                    .fill('PHI_ATTACH_READ_FIXTURE');
                await page.locator('#input-textarea').press('Enter');
                await waitForProvider(provider, beforeFile + 2);
                const toolRequest = provider.requests[beforeFile]!;
                expect(anthropicUserText(toolRequest)).toContain(
                    'PHI_ATTACH_READ_FIXTURE',
                );
                const handoffPath = attachedHandoffPath(toolRequest);
                expect(handoffPath).toContain('/attachments-v2/handoff/');
                expect(handoffPath).toMatch(/\/att-[0-9a-f]{32}-note\.txt$/);
                expect(handoffPath).not.toBe(storedFile.path);
                const readResultRequest = provider.requests[beforeFile + 1]!;
                expect(anthropicUserText(readResultRequest)).toContain(
                    FILE_CONTENT,
                );
                expect(anthropicImages(toolRequest, true)).toHaveLength(0);
                await expect(page.locator('#attachment-status')).toContainText(
                    'Submitted to Pi',
                    { timeout: 15_000 },
                );
                const overflow = await page.evaluate(
                    () => document.documentElement.scrollWidth > innerWidth,
                );
                expect(
                    overflow,
                    `${contextCase.label}: horizontal overflow`,
                ).toBe(false);
            } finally {
                await context.close();
            }
        }

        expect(pageErrors).toEqual([]);
        expect(failedRequests).toEqual([]);
        if (expectedPinAborts.length)
            test.info().annotations.push({
                type: 'known-pin-scope-abort',
                description: `${expectedPinAborts.length} startup pin cancellations`,
            });
        if (expectedBackgroundFailures.length)
            test.info().annotations.push({
                type: 'known-optional-background-failure',
                description: expectedBackgroundFailures.join('; '),
            });
    } finally {
        await proxy?.close();
        await phi.stop();
        await provider.close();
    }
});

test('pinned Pi OpenAI-compatible provider receives an image block', async ({
    browser,
    request,
}) => {
    test.setTimeout(240_000);
    const { provider, phi, pngPath, openaiWork, proxySocket } =
        await startAttachmentPhi();
    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
    });
    let proxy: BridgeProxy | null = null;
    try {
        proxy = await startAttachmentProxy(phi.dir, proxySocket);
        const pane = await spawnPane(
            request,
            phi.url,
            openaiWork,
            'Pi OpenAI attachment',
        );
        const page = await context.newPage();
        const failures: string[] = [];
        const expectedPinAborts: string[] = [];
        const expectedBackgroundFailures: string[] = [];
        page.on('response', (response) => {
            if (response.status() < 400) return;
            const line = `HTTP ${response.status()} ${response.url()}`;
            if (
                isExpectedOptionalBackgroundFailure(
                    response.url(),
                    response.status(),
                )
            )
                expectedBackgroundFailures.push(line);
            else failures.push(line);
        });
        page.on('pageerror', (error) => failures.push(error.message));
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
            if (isExpectedPinSyncConsoleError(message.text()))
                expectedPinAborts.push(`console ${message.text()}`);
            else failures.push(`console ${message.text()}`);
        });
        page.on('requestfailed', (failed) => {
            const errorText = failed.failure()?.errorText || '';
            if (isCancelledWorktreeRead(failed, phi.url)) return;
            const line = `${failed.url()} ${errorText}`;
            if (isExpectedStartupPinAbort(failed.url(), errorText))
                expectedPinAborts.push(line);
            else failures.push(line);
        });
        const contextResponse = page.waitForResponse(
            (response) =>
                response.url().includes('/api/pi-bridge/attachments/context') &&
                response.url().includes(encodeURIComponent(pane)),
            { timeout: 30_000 },
        );
        await blockExternalRequests(page, (url) =>
            failures.push(`blocked external request ${url}`),
        );
        await page.goto(phi.url);
        await selectPane(page, pane, false);
        await contextResponse;
        await expect(page.locator('#attach-input-btn')).toBeVisible();
        const before = provider.requests.length;
        await chooseFile(page, pngPath, false);
        await expect(
            page.locator('#attachment-strip .attachment-state'),
        ).toHaveText('Ready', { timeout: 30_000 });
        await page.locator('#send-input-btn').click();
        await waitForProvider(provider, before + 1);
        const outgoing = provider.requests
            .slice(before)
            .flatMap((item) => openAIImages(item));
        expect(outgoing).toHaveLength(1);
        expect(outgoing[0]!.mime).toBe('image/png');
        expect(Buffer.from(outgoing[0]!.data, 'base64').subarray(0, 8)).toEqual(
            readFileSync(pngPath).subarray(0, 8),
        );
        expect(failures).toEqual([]);
        if (expectedPinAborts.length)
            test.info().annotations.push({
                type: 'known-pin-scope-abort',
                description: `${expectedPinAborts.length} startup pin cancellations`,
            });
        if (expectedBackgroundFailures.length)
            test.info().annotations.push({
                type: 'known-optional-background-failure',
                description: expectedBackgroundFailures.join('; '),
            });
    } finally {
        await context.close();
        await proxy?.close();
        await phi.stop();
        await provider.close();
    }
});

test('extension transformations are not mistaken for model receipt; lost ack is never replayed', async ({
    browser,
    request,
}) => {
    test.setTimeout(240_000);
    const { provider, phi, pngPath, work, proxySocket } =
        await startAttachmentPhi();
    let proxy: BridgeProxy | null = null;
    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
    });
    try {
        proxy = await startAttachmentProxy(phi.dir, proxySocket);
        const pane = await spawnPane(
            request,
            phi.url,
            work,
            'Pi attachment outcome',
        );
        const page = await context.newPage();
        const failures: string[] = [];
        const expectedPinAborts: string[] = [];
        const expectedBackgroundFailures: string[] = [];
        page.on('response', (response) => {
            if (response.status() < 400) return;
            const line = `HTTP ${response.status()} ${response.url()}`;
            if (
                isExpectedOptionalBackgroundFailure(
                    response.url(),
                    response.status(),
                )
            )
                expectedBackgroundFailures.push(line);
            else failures.push(line);
        });
        page.on('pageerror', (error) => failures.push(error.message));
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
            if (isExpectedPinSyncConsoleError(message.text()))
                expectedPinAborts.push(`console ${message.text()}`);
            else failures.push(`console ${message.text()}`);
        });
        page.on('requestfailed', (failed) => {
            const errorText = failed.failure()?.errorText || '';
            if (isCancelledWorktreeRead(failed, phi.url)) return;
            const line = `${failed.url()} ${errorText}`;
            if (isExpectedStartupPinAbort(failed.url(), errorText))
                expectedPinAborts.push(line);
            else failures.push(line);
        });
        const contextResponse = page.waitForResponse(
            (response) =>
                response.url().includes('/api/pi-bridge/attachments/context') &&
                response.url().includes(encodeURIComponent(pane)),
            { timeout: 30_000 },
        );
        await blockExternalRequests(page, (url) =>
            failures.push(`blocked external request ${url}`),
        );
        await page.goto(phi.url);
        await selectPane(page, pane, false);
        await contextResponse;

        // Pi's input hook consumes this prompt. Phi can confirm only that
        // sendUserMessage returned; the absence of a provider call is not
        // treated as failure or as permission to replay it.
        const beforeConsumed = provider.requests.length;
        await chooseFile(page, pngPath, false);
        await expect(
            page.locator('#attachment-strip .attachment-state'),
        ).toHaveText('Ready', { timeout: 30_000 });
        await page.locator('#input-textarea').fill(CONSUME_MARKER);
        await page.locator('#send-input-btn').click();
        await expect(page.locator('#attachment-status')).toContainText(
            'Submitted to Pi',
            { timeout: 15_000 },
        );
        await page.waitForTimeout(1_000);
        expect(provider.requests).toHaveLength(beforeConsumed);

        // A context hook removes the image after dispatch. This is a Pi
        // extension-level transform, not a Phi encoding failure.
        await waitForIdle(request, phi.url, pane);
        const beforeStripped = provider.requests.length;
        await chooseFile(page, pngPath, false);
        await expect(
            page.locator('#attachment-strip .attachment-state'),
        ).toHaveText('Ready', { timeout: 30_000 });
        await page.locator('#input-textarea').fill(STRIP_MARKER);
        await page.locator('#send-input-btn').click();
        await waitForProvider(provider, beforeStripped + 1);
        const strippedRequest = provider.requests[beforeStripped]!;
        expect(anthropicUserText(strippedRequest)).toContain(STRIP_MARKER);
        expect(anthropicImages(strippedRequest)).toHaveLength(0);
        await expect(page.locator('#attachment-status')).toContainText(
            'Submitted to Pi',
            { timeout: 15_000 },
        );

        // Pause only Pi-to-Phi bytes. After the real provider receives the
        // image, drop the bridge before the acknowledgment can reach Phi.
        await waitForIdle(request, phi.url, pane);
        const beforeLostAck = provider.requests.length;
        await chooseFile(page, pngPath, false);
        await expect(
            page.locator('#attachment-strip .attachment-state'),
        ).toHaveText('Ready', { timeout: 30_000 });
        await page
            .locator('#input-textarea')
            .fill('PHI_ATTACHMENT_LOST_ACK_FIXTURE');
        // Let the read-only live context refresh finish. Pause only
        // when the actual dispatch POST is about to leave the browser.
        let resumePiToPhi = () => {};
        const activeProxy = proxy;
        await page.route('**/api/pi-bridge/attachments', (route) => {
            if (route.request().method() === 'POST')
                resumePiToPhi = activeProxy.pausePiToPhi();
            return route.continue();
        });
        await page.locator('#send-input-btn').click();
        await waitForProvider(provider, beforeLostAck + 1);
        await proxy.drop();
        resumePiToPhi();
        await expect(page.locator('#attachment-status')).toContainText(
            'Submission not confirmed',
            { timeout: 20_000 },
        );
        await proxy.resume();
        await expect
            .poll(() => paneBridge(request, phi.url, pane), { timeout: 30_000 })
            .toMatchObject({
                state: 'managed',
                connected: true,
                capabilities: expect.arrayContaining(['pi.attachments.v3']),
            });
        await page.waitForTimeout(1_500);
        expect(provider.requests).toHaveLength(beforeLostAck + 1);
        await expect(page.locator('#attachment-status')).toContainText(
            'Submission not confirmed',
        );
        expect(failures).toEqual([]);
        if (expectedPinAborts.length)
            test.info().annotations.push({
                type: 'known-pin-scope-abort',
                description: `${expectedPinAborts.length} startup pin cancellations`,
            });
        if (expectedBackgroundFailures.length)
            test.info().annotations.push({
                type: 'known-optional-background-failure',
                description: expectedBackgroundFailures.join('; '),
            });
    } finally {
        await context.close();
        await proxy?.close();
        await phi.stop();
        await provider.close();
    }
});

test('bridge-free Pi keeps ordinary text usable and retains attachment drafts', async ({
    browser,
    request,
}) => {
    test.setTimeout(240_000);
    const { provider, phi, pngPath, gifPath, work, proxySocket } =
        await startAttachmentPhi();
    let proxy: BridgeProxy | null = null;
    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
    });
    try {
        proxy = await startAttachmentProxy(phi.dir, proxySocket);
        const noInject = await request.post(
            `${phi.url}/api/config/pi-bridge-no-inject`,
            { data: { enabled: true } },
        );
        expect(noInject.ok()).toBe(true);
        const spawned = await request.post(`${phi.url}/api/terminals`, {
            data: { coder: 'pi', cwd: work, title: 'Pi without bridge' },
        });
        expect(spawned.ok()).toBe(true);
        const pane = ((await spawned.json()) as { pane_id: string }).pane_id;
        await expect
            .poll(() => paneBridge(request, phi.url, pane), { timeout: 15_000 })
            .toMatchObject({ connected: false });

        const page = await context.newPage();
        const failures: string[] = [];
        const expectedBackgroundFailures: string[] = [];
        const expectedAttachmentRefusals: string[] = [];
        page.on('response', (response) => {
            if (response.status() < 400) return;
            const line = `HTTP ${response.status()} ${response.url()}`;
            if (
                isExpectedUnsupportedImageUpload(
                    response.url(),
                    response.request().method(),
                    response.status(),
                )
            )
                expectedAttachmentRefusals.push(line);
            else if (
                isExpectedOptionalBackgroundFailure(
                    response.url(),
                    response.status(),
                )
            )
                expectedBackgroundFailures.push(line);
            else failures.push(line);
        });
        page.on('pageerror', (error) => failures.push(error.message));
        page.on('console', (message) => {
            if (
                message.type() !== 'error' ||
                message
                    .text()
                    .startsWith(
                        'Failed to load resource: the server responded with a status of ',
                    )
            )
                return;
            failures.push(`console ${message.text()}`);
        });
        page.on('requestfailed', (failed) => {
            const errorText = failed.failure()?.errorText || '';
            if (isCancelledWorktreeRead(failed, phi.url)) return;
            if (!isExpectedStartupPinAbort(failed.url(), errorText))
                failures.push(`${failed.url()} ${errorText}`);
        });
        await blockExternalRequests(page, (url) =>
            failures.push(`blocked external request ${url}`),
        );
        await page.goto(phi.url);
        await selectPane(page, pane, false);
        await expect(page.locator('#attach-input-btn')).toBeVisible();
        await chooseFile(page, gifPath, false);
        const badChip = page.locator('#attachment-strip .attachment-chip');
        await expect(badChip.locator('.attachment-state')).toHaveText(
            'Error: unsupported-image',
            { timeout: 30_000 },
        );
        const badRemove = badChip.locator('.attachment-remove');
        page.once('dialog', (dialog) => dialog.accept());
        await badRemove.focus();
        await badRemove.press('Enter');
        await expect(badChip).toHaveCount(0);

        await chooseFile(page, pngPath, false);
        const chip = page.locator('#attachment-strip .attachment-chip');
        await expect(chip.locator('.attachment-state')).toHaveText('Ready', {
            timeout: 30_000,
        });
        await page.locator('#send-input-btn').click();
        await expect(page.locator('#attachment-status')).toContainText(
            /unavailable|unknown/i,
            { timeout: 10_000 },
        );
        await expect(chip).toBeVisible();
        const requestsBeforeText = provider.requests.length;
        const remove = chip.locator('.attachment-remove');
        page.once('dialog', (dialog) => dialog.accept());
        await remove.focus();
        await remove.press('Enter');
        await expect(chip).toHaveCount(0);
        await page
            .locator('#input-textarea')
            .fill('PHI_BRIDGE_FREE_TEXT_FIXTURE');
        await page.locator('#input-textarea').press('Enter');
        await waitForProvider(provider, requestsBeforeText + 1);
        expect(
            anthropicUserText(provider.requests[requestsBeforeText]!),
        ).toContain('PHI_BRIDGE_FREE_TEXT_FIXTURE');
        expect(failures).toEqual([]);
        expect(expectedAttachmentRefusals).toHaveLength(1);
        if (expectedAttachmentRefusals.length)
            test.info().annotations.push({
                type: 'expected-unsupported-image',
                description: expectedAttachmentRefusals.join('; '),
            });
        if (expectedBackgroundFailures.length)
            test.info().annotations.push({
                type: 'known-optional-background-failure',
                description: expectedBackgroundFailures.join('; '),
            });
    } finally {
        await context.close();
        await proxy?.close();
        await phi.stop();
        await provider.close();
    }
});

test('bridge loss before Send refuses without dispatch or later replay', async ({
    browser,
    request,
}) => {
    test.setTimeout(240_000);
    const { provider, phi, pngPath, work, proxySocket } =
        await startAttachmentPhi();
    let proxy: BridgeProxy | null = null;
    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
    });
    try {
        proxy = await startAttachmentProxy(phi.dir, proxySocket);
        const pane = await spawnPane(
            request,
            phi.url,
            work,
            'Pi attachment pre-dispatch loss',
        );
        const page = await context.newPage();
        const failures: string[] = [];
        const backgroundFailures: string[] = [];
        page.on('response', (response) => {
            if (response.status() < 400) return;
            const line = `HTTP ${response.status()} ${response.url()}`;
            if (
                isExpectedOptionalBackgroundFailure(
                    response.url(),
                    response.status(),
                )
            )
                backgroundFailures.push(line);
            else failures.push(line);
        });
        page.on('pageerror', (error) => failures.push(error.message));
        page.on('console', (message) => {
            if (
                message.type() !== 'error' ||
                message
                    .text()
                    .startsWith(
                        'Failed to load resource: the server responded with a status of ',
                    )
            )
                return;
            failures.push(`console ${message.text()}`);
        });
        page.on('requestfailed', (failed) => {
            const errorText = failed.failure()?.errorText || '';
            if (isCancelledWorktreeRead(failed, phi.url)) return;
            if (!isExpectedStartupPinAbort(failed.url(), errorText))
                failures.push(`${failed.url()} ${errorText}`);
        });
        await blockExternalRequests(page, (url) =>
            failures.push(`blocked external request ${url}`),
        );
        const contextResponse = page.waitForResponse(
            (response) =>
                response.url().includes('/api/pi-bridge/attachments/context') &&
                response.url().includes(encodeURIComponent(pane)),
            { timeout: 30_000 },
        );
        await page.goto(phi.url);
        await selectPane(page, pane, false);
        await contextResponse;
        const requestsBeforeSend = provider.requests.length;
        await chooseFile(page, pngPath, false);
        const chip = page.locator('#attachment-strip .attachment-chip');
        await expect(chip.locator('.attachment-state')).toHaveText('Ready', {
            timeout: 30_000,
        });

        await proxy.drop();
        await expect
            .poll(() => paneBridge(request, phi.url, pane), { timeout: 15_000 })
            .toMatchObject({ connected: false });
        await page.locator('#send-input-btn').click();
        await expect(page.locator('#attachment-status')).toContainText(
            /unavailable|refused|unknown/i,
            { timeout: 15_000 },
        );
        await expect(chip).toBeVisible();
        await page.waitForTimeout(1_000);
        expect(provider.requests).toHaveLength(requestsBeforeSend);

        await proxy.resume();
        await expect
            .poll(() => paneBridge(request, phi.url, pane), { timeout: 30_000 })
            .toMatchObject({ connected: true });
        await page.waitForTimeout(1_500);
        expect(provider.requests).toHaveLength(requestsBeforeSend);
        await expect(chip).toBeVisible();
        expect(failures).toEqual([]);
        if (backgroundFailures.length)
            test.info().annotations.push({
                type: 'known-optional-background-failure',
                description: backgroundFailures.join('; '),
            });
    } finally {
        await context.close();
        await proxy?.close();
        await phi.stop();
        await provider.close();
    }
});
