import { createHmac, pbkdf2Sync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

// Permanent auth-transition coverage (plan M4c). Five groups, each against a
// real phi binary in its own temporary HOME:
//
//   1. A fresh v2 sign-in: raw password over the v2 route, no cookie, reload,
//      Settings/input/dynamic-Markdown access, reusable bearer.
//   2. v1 compatibility: a pre-issued legacy cookie and a saved verifier both
//      recover without a prompt and without a JWT migration.
//   3. v1-only negotiation and explicit v2 failures that must not downgrade.
//   4. Public help/changelog, the three socket URLs, rotation, one new
//      sign-in.
//   5. Bearer-over-cookie precedence and bearer headers on auth routes.
//
// Isolation: every server comes from startPhi(), which builds into and runs
// from its own temporary directory with a temporary HOME, a loopback bind, and
// an empty sync coordinator. The coordinator assertion below proves the browser
// resolves to the owned fixture, never to a user's server.

const EVENTS = 'phi.events.protobuf.v1';
const TERMINAL = 'phi.terminal.protobuf.v1';
const CONTROL = 'phi.control.protobuf.v1';

const PASSWORD = 'auth transition pass 1';
const ROTATED = 'auth transition pass 2';

// 1x1 transparent PNG.
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
);

const b64url = (buffer: Buffer): string =>
    buffer
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

/** Locks a fresh server through the public v2 route and returns its bearer. */
async function lockServer(url: string, password: string): Promise<string> {
    const res = await fetch(`${url}/api/auth/v2/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
    });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const body = JSON.parse(text) as { enabled: boolean; token: string };
    expect(body.enabled).toBe(true);
    expect(body.token).toBeTruthy();
    return body.token;
}

/** Runs the legacy proof login from outside the browser and returns its cookie. */
async function legacySessionCookie(
    url: string,
    password: string,
): Promise<string> {
    const status = (await (await fetch(`${url}/api/auth/status`)).json()) as {
        salt: string;
        iterations: number;
        challenge: string;
    };
    const verifier = pbkdf2Sync(
        password,
        Buffer.from(status.salt, 'base64url'),
        status.iterations,
        32,
        'sha256',
    );
    const proof = createHmac('sha256', verifier)
        .update(status.challenge)
        .digest();
    const res = await fetch(`${url}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            challenge: status.challenge,
            proof: b64url(proof),
        }),
    });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const cookies = res.headers.getSetCookie();
    const session = cookies
        .map((line) => /^phi_access_session=([^;]+)/.exec(line)?.[1])
        .find((value) => value);
    expect(session, cookies.join(', ')).toBeTruthy();
    return session as string;
}

/** The saved-v1-verifier record auth.js keeps in localStorage. */
async function savedVerifierRecord(
    url: string,
    password: string,
): Promise<Record<string, unknown>> {
    const status = (await (await fetch(`${url}/api/auth/status`)).json()) as {
        salt: string;
        iterations: number;
    };
    const verifier = pbkdf2Sync(
        password,
        Buffer.from(status.salt, 'base64url'),
        status.iterations,
        32,
        'sha256',
    );
    return {
        version: 'v1',
        algorithm: 'pbkdf2-sha256',
        iterations: status.iterations,
        salt: status.salt,
        verifier: b64url(verifier),
    };
}

async function unlock(page: Page, password: string): Promise<void> {
    const overlay = page.locator('.access-auth-overlay');
    await expect(overlay).toBeVisible({ timeout: 30_000 });
    await overlay.locator('#access-auth-password').fill(password);
    await overlay.locator('button[type="submit"]').click();
    await expect(overlay).toHaveCount(0, { timeout: 60_000 });
}

/**
 * A rotation can resolve an overlay opened by a stale in-flight request, and
 * that resolution reloads the page once with the replacement bearer already
 * persisted. Wait for the navigation to settle before reading storage.
 */
async function settled(page: Page): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt++) {
        try {
            await page.waitForLoadState('load');
            await page.waitForTimeout(200);
            await page.waitForLoadState('load');
            return;
        } catch {
            await page.waitForTimeout(200);
        }
    }
}

async function expectSignedIn(page: Page): Promise<void> {
    await expect(page.locator('#sidebar-panel')).toBeVisible({
        timeout: 30_000,
    });
    await expect(page.locator('.access-auth-overlay')).toHaveCount(0);
}

/** Resolves the socket URL the way the page does and opens one. */
async function socketURLs(page: Page): Promise<Record<string, string>> {
    return page.evaluate(() => ({
        pane: window.phiAccessAuth.webSocketURL(
            new URL('/ws/pane/probe', location.href),
        ).href,
        events: window.phiAccessAuth.webSocketURL(
            new URL('/ws/md-events', location.href),
        ).href,
        control: window.phiAccessAuth.webSocketURL(
            new URL('/ws/control', location.href),
        ).href,
    }));
}

async function openSocket(page: Page, path: string, protocol: string) {
    return page.evaluate(
        async ([socketPath, subprotocol]) => {
            const url = window.phiAccessAuth.webSocketURL(
                new URL(socketPath, location.href),
            );
            return new Promise<string>((resolve) => {
                const ws = new WebSocket(url.href, subprotocol);
                ws.onopen = () => {
                    ws.close();
                    resolve('open');
                };
                ws.onerror = () => resolve('error');
                ws.onclose = (event) => resolve(`close:${event.code}`);
                setTimeout(() => resolve('timeout'), 10_000);
            });
        },
        [path, protocol],
    );
}

/** Spawns a shell pane with the bearer, so the pane socket has something to attach. */
async function spawnPane(
    page: Page,
    url: string,
    token: string,
): Promise<string> {
    for (const coder of process.platform === 'win32'
        ? ['pwsh', 'bash']
        : ['bash']) {
        const res = await page.evaluate(
            async ([url, coder, bearer]) => {
                const response = await fetch(`${url}/api/terminals`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${bearer}`,
                    },
                    body: JSON.stringify({ coder }),
                });
                return {
                    status: response.status,
                    body: await response.text(),
                };
            },
            [url, coder, token] as const,
        );
        if (res.status !== 200) continue;
        const body = JSON.parse(res.body) as { pane_id?: string };
        if (body.pane_id) return body.pane_id;
    }
    throw new Error('no shell coder available for the pane socket');
}

async function assertCoordinatorIsOwned(url: string, token: string) {
    const config = (await (
        await fetch(`${url}/api/config`, {
            headers: { Authorization: `Bearer ${token}` },
        })
    ).json()) as { sync_coordinator: string };
    expect(config.sync_coordinator.startsWith(url)).toBe(true);
    expect(config.sync_coordinator).not.toContain(':7070');
}

test.describe('v2 bearer session', () => {
    let phi: PhiServer;
    let enableToken: string;

    test.beforeAll(async () => {
        phi = await startPhi({ config: { sync_coordinator: '', peers: [] } });
        enableToken = await lockServer(phi.url, PASSWORD);
    });

    test.afterAll(async () => {
        await phi.stop();
    });

    test('signs in with the raw password, survives reload, and reuses the bearer', async ({
        browser,
    }) => {
        await assertCoordinatorIsOwned(phi.url, enableToken);

        const context = await browser.newContext();
        const page = await context.newPage();
        const v2Logins: string[] = [];
        const v1Logins: string[] = [];
        page.on('request', (request) => {
            if (request.url().includes('/api/auth/v2/login')) {
                v2Logins.push(request.postData() ?? '');
            }
            if (request.url().endsWith('/api/auth/login')) {
                v1Logins.push(request.postData() ?? '');
            }
        });

        await page.goto(phi.url);
        await unlock(page, PASSWORD);
        await expectSignedIn(page);

        // The v2 route receives the raw password; the legacy proof route is
        // never used, and the request carries no derived verifier.
        expect(v2Logins).toHaveLength(1);
        expect(JSON.parse(v2Logins[0])).toEqual({ password: PASSWORD });
        expect(v1Logins).toEqual([]);

        // A bearer-only session: no legacy cookie is ever set.
        expect(
            (await context.cookies(phi.url)).some(
                (cookie) => cookie.name === 'phi_access_session',
            ),
        ).toBe(false);

        const issued = await page.evaluate(
            () => localStorage.getItem('phi_access_bearer_v1') ?? '',
        );
        expect(issued).toBeTruthy();
        expect(
            await page.evaluate(
                async () => (await fetch('/api/coders')).status,
            ),
        ).toBe(200);

        // Reload: the stored bearer is revalidated, not re-minted.
        v2Logins.length = 0;
        const statusChecks: number[] = [];
        page.on('response', (response) => {
            if (response.url().includes('/api/auth/v2/status')) {
                statusChecks.push(response.status());
            }
        });
        await page.reload();
        await expectSignedIn(page);
        expect(v2Logins).toEqual([]);
        expect(statusChecks).toContain(200);
        expect(
            await page.evaluate(
                () => localStorage.getItem('phi_access_bearer_v1') ?? '',
            ),
        ).toBe(issued);

        // Settings and the remote keyboard are signed in from the same token.
        const settings = await context.newPage();
        await settings.goto(`${phi.url}/config.html`);
        await expect(settings.locator('.settings-overlay')).toBeVisible({
            timeout: 30_000,
        });
        await expect(settings.locator('.access-auth-overlay')).toHaveCount(0);
        await settings.close();

        const remote = await context.newPage();
        await remote.goto(`${phi.url}/input.html`);
        await expect(remote.locator('#kb-pane')).toBeVisible({
            timeout: 30_000,
        });
        await expect(remote.locator('.access-auth-overlay')).toHaveCount(0);
        await remote.close();

        // Dynamic Markdown: the viewer fetches its image with the bearer and
        // mounts it from an object URL, because there is no cookie to send.
        const dir = join(phi.dir, 'auth-md');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'pic.png'), PNG);
        writeFileSync(join(dir, 'doc.md'), '# doc\n\n![pic](pic.png)\n');
        const md = await context.newPage();
        const assetStatuses: number[] = [];
        md.on('response', (response) => {
            if (response.url().includes('/api/markdown/asset')) {
                assetStatuses.push(response.status());
            }
        });
        await md.goto(
            `${phi.url}/md.html?path=${encodeURIComponent(join(dir, 'doc.md'))}&cwd=${encodeURIComponent(dir)}`,
        );
        const image = md.locator('.md-rendered img');
        await expect(image).toHaveAttribute('src', /^blob:/, {
            timeout: 30_000,
        });
        await expect
            .poll(() =>
                image.evaluate((el: HTMLImageElement) => el.naturalWidth),
            )
            .toBe(1);
        expect(assetStatuses).toEqual([200]);
        await md.close();

        // The same bearer is reusable: two later requests accept it.
        for (let attempt = 0; attempt < 2; attempt++) {
            const res = await context.request.get(`${phi.url}/api/config`, {
                headers: { Authorization: `Bearer ${issued}` },
            });
            expect(res.status()).toBe(200);
        }
        await context.close();
    });

    test('sends the bearer ahead of a legacy cookie and on auth routes', async ({
        browser,
    }) => {
        // The suite already locked this server in beforeAll.
        const cookie = await legacySessionCookie(phi.url, PASSWORD);

        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(phi.url);
        await unlock(page, PASSWORD);
        await expectSignedIn(page);
        const bearer = await page.evaluate(
            () => localStorage.getItem('phi_access_bearer_v1') ?? '',
        );
        expect(bearer).toBeTruthy();

        // Now hold both credentials: the bearer must still win.
        await context.addCookies([
            {
                name: 'phi_access_session',
                value: cookie,
                domain: new URL(phi.url).hostname,
                path: '/',
                httpOnly: true,
            },
        ]);
        const protectedRequests: Array<{ auth: string; cookie: string }> = [];
        page.on('request', async (request) => {
            if (!request.url().endsWith('/api/coders')) return;
            const headers = await request.allHeaders();
            protectedRequests.push({
                auth: headers.authorization ?? '',
                cookie: headers.cookie ?? '',
            });
        });
        await page.reload();
        await expectSignedIn(page);
        expect(
            await page.evaluate(
                async () => (await fetch('/api/coders')).status,
            ),
        ).toBe(200);
        expect(protectedRequests.length).toBeGreaterThan(0);
        for (const request of protectedRequests) {
            expect(request.auth).toBe(`Bearer ${bearer}`);
            expect(request.cookie).toContain('phi_access_session=');
        }
        // The bearer is authoritative: an explicit bad bearer is rejected even
        // though the same request carries a valid legacy cookie.
        expect(
            await page.evaluate(
                async () =>
                    (
                        await fetch('/api/coders', {
                            headers: { Authorization: 'Bearer not-a-token' },
                        })
                    ).status,
            ),
        ).toBe(401);

        // The rotation request itself carries the bearer: a cookie cannot
        // replace a v2 password.
        const passwordRequests: Array<{ auth: string }> = [];
        page.on('request', (request) => {
            if (!request.url().endsWith('/api/auth/v2/password')) return;
            passwordRequests.push({
                auth: request.headers().authorization ?? '',
            });
        });
        const rotated = await page.evaluate(async (password) => {
            const auth = await import(new URL('./auth.js', location.href).href);
            return auth.setAccessPassword(password);
        }, ROTATED);
        expect(rotated).toEqual({ enabled: true });
        expect(passwordRequests).toHaveLength(1);
        expect(passwordRequests[0].auth).toBe(`Bearer ${bearer}`);
        await context.close();
    });
});

test.describe('v1 compatibility', () => {
    let phi: PhiServer;

    test.beforeAll(async () => {
        phi = await startPhi({ config: { sync_coordinator: '', peers: [] } });
        await lockServer(phi.url, PASSWORD);
    });

    test.afterAll(async () => {
        await phi.stop();
    });

    test('keeps a legacy cookie session without a prompt or a JWT', async ({
        browser,
    }) => {
        const cookie = await legacySessionCookie(phi.url, PASSWORD);
        const context = await browser.newContext();
        await context.addCookies([
            {
                name: 'phi_access_session',
                value: cookie,
                domain: new URL(phi.url).hostname,
                path: '/',
                httpOnly: true,
            },
        ]);
        const page = await context.newPage();
        const v2Logins: string[] = [];
        page.on('request', (request) => {
            if (request.url().includes('/api/auth/v2/')) {
                v2Logins.push(request.url());
            }
        });

        await page.goto(phi.url);
        await expectSignedIn(page);
        expect(v2Logins).toEqual([]);
        expect(
            await page.evaluate(() =>
                localStorage.getItem('phi_access_bearer_v1'),
            ),
        ).toBeNull();
        expect(
            await page.evaluate(() => window.phiAccessAuth.getAccessToken()),
        ).toBeNull();
        expect(
            await page.evaluate(
                async () => (await fetch('/api/coders')).status,
            ),
        ).toBe(200);
        await context.close();
    });

    test('recovers a saved verifier without a prompt or a JWT', async ({
        browser,
    }) => {
        const record = await savedVerifierRecord(phi.url, PASSWORD);
        const context = await browser.newContext();
        await context.addInitScript((saved) => {
            localStorage.setItem(
                'phi_access_credential_v1',
                JSON.stringify(saved),
            );
        }, record);
        const page = await context.newPage();
        const logins: string[] = [];
        const v2Logins: string[] = [];
        page.on('request', (request) => {
            if (request.url().endsWith('/api/auth/login')) {
                logins.push(request.postData() ?? '');
            }
            if (request.url().includes('/api/auth/v2/')) {
                v2Logins.push(request.url());
            }
        });

        await page.goto(phi.url);
        await expectSignedIn(page);
        // Exactly the silent proof login, and no v2 credential was minted.
        expect(logins).toHaveLength(1);
        expect(v2Logins).toEqual([]);
        expect(
            await page.evaluate(() =>
                localStorage.getItem('phi_access_bearer_v1'),
            ),
        ).toBeNull();
        expect(
            await page.evaluate(() => window.phiAccessAuth.getAccessToken()),
        ).toBeNull();
        expect(
            await page.evaluate(
                async () => (await fetch('/api/coders')).status,
            ),
        ).toBe(200);
        await context.close();
    });
});

test.describe('v1-only capability', () => {
    let phi: PhiServer;

    test.beforeAll(async () => {
        phi = await startPhi({ config: { sync_coordinator: '', peers: [] } });
        await lockServer(phi.url, PASSWORD);
    });

    test.afterAll(async () => {
        await phi.stop();
    });

    test('a v1-only status negotiates the legacy login', async ({
        browser,
    }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        // A v1-only capability response with every v2 route blocked, without
        // claiming that an old binary ran: the browser sees the legacy wire
        // contract, which is what the client must negotiate.
        await page.route('**/api/auth/status', async (route) => {
            const response = await route.fetch();
            const body = (await response.json()) as Record<string, unknown>;
            delete body.protocols;
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(body),
            });
        });
        await page.route('**/api/auth/v2/**', (route) =>
            route.fulfill({ status: 404, body: 'not found' }),
        );
        const legacyLogins: string[] = [];
        const v2Attempts: string[] = [];
        page.on('request', (request) => {
            if (request.url().endsWith('/api/auth/login')) {
                legacyLogins.push(request.url());
            }
            if (request.url().includes('/api/auth/v2/login')) {
                v2Attempts.push(request.url());
            }
        });

        await page.goto(phi.url);
        await unlock(page, PASSWORD);
        await expectSignedIn(page);
        expect(legacyLogins).toHaveLength(1);
        expect(v2Attempts).toEqual([]);
        expect(
            await page.evaluate(() => window.phiAccessAuth.getAccessToken()),
        ).toBeNull();
        await context.close();
    });

    test('a failing v2 login never downgrades to the legacy route', async ({
        browser,
    }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.route('**/api/auth/v2/login', (route) =>
            route.fulfill({ status: 500, body: 'unavailable' }),
        );
        const legacyLogins: string[] = [];
        page.on('request', (request) => {
            if (request.url().endsWith('/api/auth/login')) {
                legacyLogins.push(request.url());
            }
        });

        await page.goto(phi.url);
        const overlay = page.locator('.access-auth-overlay');
        await expect(overlay).toBeVisible({ timeout: 30_000 });
        await overlay.locator('#access-auth-password').fill(PASSWORD);
        await overlay.locator('button[type="submit"]').click();
        await expect(overlay.locator('.access-auth-error')).not.toBeEmpty({
            timeout: 30_000,
        });
        await expect(overlay).toBeVisible();
        expect(legacyLogins).toEqual([]);
        await context.close();
    });
});

test.describe('public pages, sockets, and rotation', () => {
    // The rotation test retires the password the mobile test used to need;
    // run them in order and skip the rest if one fails.
    test.describe.configure({ mode: 'serial' });

    let phi: PhiServer;
    let retiredBearer = '';

    test.beforeAll(async () => {
        phi = await startPhi({ config: { sync_coordinator: '', peers: [] } });
        await lockServer(phi.url, PASSWORD);
    });

    test.afterAll(async () => {
        await phi.stop();
    });

    test('serves help and changelog without a login', async ({ browser }) => {
        const context = await browser.newContext();
        for (const asset of ['/help.md', '/changelog.md']) {
            const res = await context.request.get(`${phi.url}${asset}`);
            expect(res.status(), asset).toBe(200);
            expect((await res.text()).length).toBeGreaterThan(0);
        }
        const protectedRes = await context.request.get(`${phi.url}/api/coders`);
        expect(protectedRes.status()).toBe(401);
        await context.close();
    });

    test('carries the bearer on all three socket URLs, then rotates once', async ({
        browser,
    }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(phi.url);
        await unlock(page, PASSWORD);
        await expectSignedIn(page);

        const token = await page.evaluate(
            () => localStorage.getItem('phi_access_bearer_v1') ?? '',
        );
        const urls = await socketURLs(page);
        for (const [name, href] of Object.entries(urls)) {
            const parsed = new URL(href);
            expect(parsed.origin, name).toBe(new URL(phi.url).origin);
            expect(parsed.searchParams.get('token'), name).toBe(token);
        }
        expect(await openSocket(page, '/ws/md-events', EVENTS)).toBe('open');
        expect(await openSocket(page, '/ws/control', CONTROL)).toBe('open');
        const paneId = await spawnPane(page, phi.url, token);
        expect(await openSocket(page, `/ws/pane/${paneId}`, TERMINAL)).toBe(
            'open',
        );

        // Rotate from the page: the response carries a replacement bearer, so
        // the page stays signed in without a second prompt.
        expect(
            await page.evaluate(async (password) => {
                const auth = await import(
                    new URL('./auth.js', location.href).href
                );
                return auth.setAccessPassword(password);
            }, ROTATED),
        ).toEqual({ enabled: true });
        await settled(page);
        await expectSignedIn(page);
        const replacement = await page.evaluate(
            () => localStorage.getItem('phi_access_bearer_v1') ?? '',
        );
        expect(replacement).toBeTruthy();
        expect(replacement).not.toBe(token);
        expect(await openSocket(page, '/ws/md-events', EVENTS)).toBe('open');

        // Exactly one new sign-in: a fresh context needs the rotated password.
        const fresh = await browser.newContext();
        const freshPage = await fresh.newPage();
        const logins: string[] = [];
        freshPage.on('request', (request) => {
            if (request.url().includes('/api/auth/v2/login')) {
                logins.push(request.postData() ?? '');
            }
        });
        await freshPage.goto(phi.url);
        await unlock(freshPage, ROTATED);
        await expectSignedIn(freshPage);
        expect(logins).toEqual([JSON.stringify({ password: ROTATED })]);

        // The retired password and its bearer are checked in a separate test:
        // a failed login arms the rate limiter for this client address.
        retiredBearer = token;
        await fresh.close();
        await context.close();
    });

    test('a mobile context signs in with the same bearer flow', async ({
        browser,
    }) => {
        const mobile = await browser.newContext({
            viewport: { width: 390, height: 844 },
            hasTouch: true,
            isMobile: true,
        });
        const page = await mobile.newPage();
        await page.goto(phi.url);
        await unlock(page, ROTATED);
        await expectSignedIn(page);
        expect(
            await page.evaluate(
                async () => (await fetch('/api/coders')).status,
            ),
        ).toBe(200);
        expect(await openSocket(page, '/ws/md-events', EVENTS)).toBe('open');
        expect(
            await page.evaluate(
                () => document.documentElement.scrollWidth > window.innerWidth,
            ),
        ).toBe(false);
        await mobile.close();
    });

    test('retires the old password and its bearer after rotation', async () => {
        expect(retiredBearer).toBeTruthy();
        const retired = await fetch(`${phi.url}/api/auth/v2/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: PASSWORD }),
        });
        expect(retired.status).toBe(401);
        // The status route is public discovery: it stays 200 and reports the
        // retired bearer as unauthenticated.
        const oldStatus = await fetch(`${phi.url}/api/auth/v2/status`, {
            headers: { Authorization: `Bearer ${retiredBearer}` },
        });
        expect(oldStatus.status).toBe(200);
        expect(await oldStatus.json()).toEqual({
            enabled: true,
            authenticated: false,
        });
    });
});

declare global {
    interface Window {
        phiAccessAuth: {
            webSocketURL: (url: URL | string) => URL;
            getAccessToken: () => string | null;
            installToken: (token: string) => boolean;
        };
    }
}
