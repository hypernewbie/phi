import { readdirSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { test, expect, guardBrowserContext } from './fixtures.ts';

async function upgrade(url: string, origin: string): Promise<number> {
    return new Promise((done, fail) => {
        const request = httpRequest(`${url}/ws/md-events`, {
            headers: {
                Connection: 'Upgrade',
                Upgrade: 'websocket',
                Origin: origin,
                'Sec-WebSocket-Protocol': 'phi.events.protobuf.v1',
                'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
            },
        });
        request.setTimeout(5_000, () => {
            request.destroy(new Error('Upgrade timed out.'));
        });
        request.once('error', fail);
        request.once('upgrade', (response, socket) => {
            socket.destroy();
            done(response.statusCode ?? 0);
        });
        request.once('response', (response) => {
            response.resume();
            done(response.statusCode ?? 0);
        });
        request.end();
    });
}

test('browser guard blocks redirects before external or forbidden API requests', async ({
    browser,
}) => {
    let targetHits = 0;
    let statusCookie: string | undefined;
    const target = createServer((_request, response) => {
        ++targetHits;
        response.end('Unexpected request');
    });
    let targetUrl = '';
    const source = createServer((request, response) => {
        if (request.url === '/') {
            response.end('<!doctype html><link rel="icon" href="data:,">');
            return;
        }
        if (request.url === '/api/auth/v2/status') {
            statusCookie = request.headers.cookie;
            response.end('{"enabled":false,"authenticated":false}');
            return;
        }
        if (request.url?.startsWith('/redirect')) {
            response.writeHead(302, {
                Location: request.url.endsWith('external')
                    ? `${targetUrl}/target`
                    : '/api/forbidden',
            });
        } else {
            ++targetHits;
        }
        response.end();
    });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
        for (const server of [target, source]) {
            await new Promise<void>((done, fail) => {
                server.once('error', fail);
                server.listen(0, '127.0.0.1', done);
            });
        }
        const targetAddress = target.address();
        const sourceAddress = source.address();
        if (
            !targetAddress ||
            typeof targetAddress === 'string' ||
            !sourceAddress ||
            typeof sourceAddress === 'string'
        )
            throw new Error('Missing fixture port.');
        targetUrl = `http://127.0.0.1:${targetAddress.port}`;
        const sourceUrl = `http://127.0.0.1:${sourceAddress.port}`;
        const violations = await guardBrowserContext(context, {
            reactUrl: sourceUrl,
            phiUrl: sourceUrl,
        });
        const page = await context.newPage();
        await page.goto(sourceUrl);
        await context.addCookies([
            { name: 'ambient', value: 'fixture-only', url: sourceUrl },
        ]);
        expect(
            await page.evaluate(async () => {
                const response = await fetch('/api/auth/v2/status', {
                    credentials: 'omit',
                });
                return response.json();
            }),
        ).toEqual({ enabled: false, authenticated: false });
        expect(statusCookie ?? '').toBe('');
        for (const destination of ['external', 'api']) {
            await expect(
                page.goto(`${sourceUrl}/redirect?${destination}`),
            ).rejects.toThrow();
            expect(targetHits).toBe(0);
        }
        expect(violations).toEqual([
            `Redirect GET ${sourceUrl}/redirect`,
            `Redirect GET ${sourceUrl}/redirect`,
        ]);
    } finally {
        await context.close();
        for (const server of [source, target]) {
            server.closeAllConnections();
            await new Promise<void>((done) => server.close(() => done()));
        }
    }
});

test('real base server reports unsupported v2 without falling back to v1', async ({
    page,
    stack,
}) => {
    const response = page.waitForResponse((reply) =>
        reply.url().endsWith('/api/auth/v2/status'),
    );
    await page.goto(stack.reactUrl);
    expect((await response).status()).toBe(404);
    await expect(page.getByRole('status')).toHaveText(
        'This server does not support v2 authentication.',
    );
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(
        page.getByRole('heading', { name: 'Connection' }),
    ).toBeVisible();
    await expect(page.getByRole('textbox')).toHaveCount(0);
});

for (const [name, body, text] of [
    [
        'disabled',
        { enabled: false, authenticated: false },
        'Connected. Password protection is disabled.',
    ],
    [
        'protected',
        { enabled: true, authenticated: false },
        'Server requires sign-in. Login is not available in this stage.',
    ],
    [
        'not a restored session',
        { enabled: true, authenticated: true },
        'Server requires sign-in. Login is not available in this stage.',
    ],
    [
        'invalid fields',
        { enabled: 'false', authenticated: false },
        'Cannot check this server. Retry the connection.',
    ],
] as const) {
    test(`status: ${name}`, async ({ page, stack, statusMock }) => {
        statusMock.reply = { body };
        await page.goto(stack.reactUrl);
        await expect(page.getByRole('status')).toHaveText(text);
        await expect(
            page.getByRole('button', { name: 'Retry', exact: true }),
        ).toBeEnabled();
    });
}

for (const status of [201, 401, 403, 500]) {
    test(`HTTP ${status} is unavailable, not successful authentication`, async ({
        page,
        stack,
        statusMock,
    }) => {
        statusMock.reply = {
            status,
            body: { enabled: false, authenticated: false },
        };
        await page.goto(stack.reactUrl);
        await expect(page.getByRole('status')).toHaveText(
            'Cannot check this server. Retry the connection.',
        );
    });
}

test('keeps the status node, keyboard navigation, and disabled/busy retry behavior', async ({
    page,
    stack,
    statusMock,
}) => {
    let release = () => {};
    statusMock.reply = {
        body: { enabled: false, authenticated: false },
        wait: new Promise<void>((done) => {
            release = done;
        }),
    };
    try {
        await page.goto(stack.reactUrl);
        await expect(
            page.getByRole('button', { name: 'Checking…' }),
        ).toBeDisabled();
        await expect(
            page.getByRole('button', { name: 'Checking…' }),
        ).toHaveAttribute('aria-busy', 'true');
        await page.getByRole('status').evaluate((element) => {
            element.setAttribute('data-original', 'true');
        });
        await page.keyboard.press('Tab');
        await expect(
            page.getByRole('button', { name: 'Connection', exact: true }),
        ).toBeFocused();
        release();
        await expect(page.getByRole('status')).toHaveText(
            'Connected. Password protection is disabled.',
        );
        await expect(page.getByRole('status')).toHaveAttribute(
            'data-original',
            'true',
        );
        await expect(
            page.getByRole('button', { name: 'Connection', exact: true }),
        ).toBeFocused();
        statusMock.reply = { status: 405, raw: 'unsupported' };
        await page.keyboard.press('Tab');
        const retry = page.getByRole('button', { name: 'Retry', exact: true });
        await expect(retry).toBeFocused();
        await retry.press('Enter');
        await expect(page.getByRole('status')).toHaveText(
            'This server does not support v2 authentication.',
        );
        await expect(retry).toBeFocused();
        statusMock.reply = { raw: '{secret-broken-json' };
        await retry.press('Space');
        await expect(page.getByRole('status')).toHaveText(
            'Cannot check this server. Retry the connection.',
        );
        await expect(retry).toBeFocused();
        await expect(page.getByRole('main')).not.toContainText(
            'secret-broken-json',
        );
    } finally {
        release();
    }
});

for (const activity of [
    'stay on Retry',
    'focus another control',
    'focus then blur',
    'pointer elsewhere',
    'Tab',
] as const) {
    test(`pending keyboard Retry: ${activity}`, async ({
        page,
        stack,
        statusMock,
    }) => {
        let release = () => {};
        statusMock.reply = { body: { enabled: false, authenticated: false } };
        try {
            await page.goto(stack.reactUrl);
            const retry = page.getByRole('button', {
                name: 'Retry',
                exact: true,
            });
            await expect(retry).toBeEnabled();
            statusMock.reply = {
                body: { enabled: false, authenticated: false },
                wait: new Promise<void>((done) => {
                    release = done;
                }),
            };
            await retry.focus();
            await page.keyboard.press('Enter');
            await expect(
                page.getByRole('button', { name: 'Checking…' }),
            ).toBeDisabled();
            const navigation = page.getByRole('button', {
                name: 'Connection',
                exact: true,
            });
            if (
                activity === 'focus another control' ||
                activity === 'focus then blur'
            ) {
                await navigation.focus();
                if (activity === 'focus then blur')
                    await navigation.evaluate((element) => element.blur());
            } else if (activity === 'pointer elsewhere') {
                await page.getByRole('heading', { name: 'Connection' }).click();
            } else if (activity === 'Tab') {
                await page.keyboard.press('Tab');
            }
            release();
            await expect(retry).toBeEnabled();
            await expect(page.getByRole('status')).toHaveText(
                'Connected. Password protection is disabled.',
            );
            if (activity === 'stay on Retry') await expect(retry).toBeFocused();
            else await expect(retry).not.toBeFocused();
            if (activity === 'focus another control')
                await expect(navigation).toBeFocused();
        } finally {
            release();
        }
    });
}

test('serves public documents and retains real WebSocket Origin enforcement through Vite', async ({
    context,
    stack,
}) => {
    for (const path of ['/help.md', '/changelog.md']) {
        const response = await context.request.get(`${stack.reactUrl}${path}`, {
            maxRedirects: 0,
        });
        expect(response.status()).toBe(200);
        expect(await response.text()).toMatch(/phi/i);
    }
    const unlisted = await context.request.get(`${stack.reactUrl}/style.css`, {
        maxRedirects: 0,
    });
    expect(await unlisted.text()).toContain('id="root"');
    expect(await upgrade(stack.reactUrl, stack.reactUrl)).toBe(101);
    expect(await upgrade(stack.reactUrl, 'http://foreign.invalid')).toBe(403);
});

test('loads offline Latin/Greek fonts and keeps Phi controls usable at narrow widths', async ({
    page,
    stack,
}, info) => {
    await page.goto(stack.reactUrl);
    await expect(
        page.getByRole('button', { name: 'Retry', exact: true }),
    ).toBeEnabled();
    const loaded = await page.evaluate(async () => {
        await document.fonts.ready;
        const inter = await document.fonts.load('400 13px "Inter"', 'Phi Φ ϕ');
        const mono = await document.fonts.load(
            '400 13px "JetBrains Mono"',
            'Phi Φ ϕ',
        );
        return { inter: inter.length, mono: mono.length };
    });
    expect(loaded.inter).toBeGreaterThan(0);
    expect(loaded.mono).toBeGreaterThan(0);
    const fonts = readdirSync(
        fileURLToPath(new URL('../../public/fonts/', import.meta.url)),
    ).filter((name) => name.endsWith('.woff2'));
    expect(fonts).toHaveLength(13);
    for (const font of fonts) {
        const response = await page.request.get(
            `${stack.reactUrl}/fonts/${font}`,
            { maxRedirects: 0 },
        );
        expect(response.status()).toBe(200);
        expect((await response.body()).byteLength).toBeGreaterThan(0);
    }
    for (const button of await page.getByRole('button').all()) {
        const bounds = await button.boundingBox();
        expect(bounds?.width).toBeGreaterThanOrEqual(24);
        expect(bounds?.height).toBe(36);
        await expect(button).toHaveCSS('font-size', '13px');
    }
    await page.keyboard.press('Tab');
    await expect(
        page.getByRole('button', { name: 'Connection', exact: true }),
    ).toHaveCSS('outline-width', '2px');
    await page.screenshot({
        path: info.outputPath('connection.png'),
        fullPage: true,
    });
    await page.setViewportSize({ width: 320, height: 844 });
    expect(
        await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
        ),
    ).toBe(true);
    await page.screenshot({
        path: info.outputPath('connection-320.png'),
        fullPage: true,
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(
        page.getByRole('button', { name: 'Retry', exact: true }),
    ).toHaveCSS('transition-duration', '0s');
    // Static legacy markup/CSS only: never run the old app or its side effects.
    const reference = await page.context().newPage();
    try {
        const source = await page.request.get(stack.phiUrl, {
            maxRedirects: 0,
        });
        const html = (await source.text()).replace(
            /<script\b[^>]*>[\s\S]*?<\/script>/gi,
            '',
        );
        await reference.setViewportSize(
            info.project.use.viewport ?? { width: 1280, height: 800 },
        );
        // Establish the fixture origin before loading its fonts (not an opaque about:blank origin).
        await reference.goto(`${stack.phiUrl}/healthz`);
        await reference.setContent(
            html.replace('<head>', `<head><base href="${stack.phiUrl}/">`),
        );
        await reference.evaluate(async () => {
            await document.fonts.ready;
            await document.fonts.load('400 13px "Inter"', 'Phi Φ ϕ');
            await document.fonts.load('400 13px "JetBrains Mono"', 'Phi Φ ϕ');
        });
        await expect(reference.locator('.btn-primary').first()).toHaveCSS(
            'font-size',
            '13px',
        );
        await expect(reference.locator('.btn-primary').first()).toHaveCSS(
            'border-radius',
            '6px',
        );
        await reference.screenshot({
            path: info.outputPath('legacy-static-reference.png'),
            fullPage: true,
        });
    } finally {
        await reference.close();
    }
});
