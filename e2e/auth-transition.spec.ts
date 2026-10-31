import {
    createHash,
    createHmac,
    hkdfSync,
    pbkdf2Sync,
    randomBytes,
} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
    expect,
    test,
    type Browser,
    type Page,
    type Route,
} from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });

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

function preissuedLegacySession(verifier: Buffer): string {
    const expiresAt = Math.floor(Date.now() / 1000) + 100 * 365 * 24 * 60 * 60;
    const payload = `${b64url(randomBytes(32))}.${expiresAt}`;
    const signature = createHmac('sha256', verifier).update(payload).digest();
    return `${payload}.${b64url(signature)}`;
}

function readV2DbState(server: PhiServer): {
    maxGeneration: bigint;
    consumedHandles: number;
} {
    const database = new DatabaseSync(
        join(server.dir, 'home', '.phi', 'auth.db'),
        { readOnly: true },
    );
    try {
        const rows = database
            .prepare('SELECT hex(generation) AS generation FROM auth_families')
            .all() as { generation: string }[];
        if (rows.length === 0)
            throw new Error('auth family is missing from fixture DB');
        let maxGeneration = 0n;
        for (const row of rows) {
            const generation = BigInt(`0x${row.generation}`);
            if (generation > maxGeneration) maxGeneration = generation;
        }
        const consumed = database
            .prepare('SELECT COUNT(*) AS count FROM auth_consumed_handles')
            .get() as { count: number };
        return { maxGeneration, consumedHandles: consumed.count };
    } finally {
        database.close();
    }
}

function jwtJti(token: string): string {
    const payload = token.split('.')[1];
    if (!payload) throw new Error('fixture JWT has no payload');
    const claims = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
    ) as { jti?: unknown };
    if (typeof claims.jti !== 'string')
        throw new Error('fixture JWT has no JTI');
    return claims.jti;
}

/** Locks a fresh server through the public v2 route and returns its bearer. */
async function lockServer(url: string, password: string): Promise<string> {
    const res = await fetch(`${url}/api/auth/v2/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Phi-Auth': 'v2' },
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

async function unlockMvp(
    page: Page,
    password: string,
    mobile: boolean,
): Promise<void> {
    const overlay = page.locator('.access-auth-overlay');
    await expect(overlay).toBeVisible({ timeout: 30_000 });
    const input = overlay.locator('#access-auth-password');
    await input.fill(password);
    if (mobile) {
        await overlay.locator('button[type="submit"]').tap();
    } else {
        await input.press('Enter');
    }
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

        const issued = await page.evaluate(() =>
            window.phiAccessAuth.getAccessToken(),
        );
        expect(issued).toBeTruthy();
        // The access JWT lives in memory only: the superseded standalone
        // bearer key is gone, and no browser storage holds the token.
        expect(
            await page.evaluate(() =>
                localStorage.getItem('phi_access_bearer_v1'),
            ),
        ).toBeNull();
        expect(
            await page.evaluate((token) => {
                const stores = [
                    ...Object.values(localStorage),
                    ...Object.values(sessionStorage),
                ];
                return stores.some((value) => value.includes(token));
            }, issued as string),
        ).toBe(false);

        // The refresh handle is HttpOnly: the page cannot read it, and neither
        // cookie leaks a value the page JavaScript can see.
        expect(await page.evaluate(() => document.cookie)).not.toContain(
            'phi_access',
        );
        // The refresh and asset cookies are path-scoped, so each is visible
        // only to its own URL: query the scope that owns it.
        const sessionCookies = await context.cookies(
            `${phi.url}/api/auth/v2/refresh`,
        );
        const refreshCookie = sessionCookies.find(
            (cookie) => cookie.name === 'phi_access_refresh',
        );
        expect(refreshCookie).toBeTruthy();
        expect(refreshCookie).toMatchObject({
            httpOnly: true,
            sameSite: 'Strict',
            path: '/api/auth/v2/refresh',
        });
        expect(refreshCookie?.secure).toBe(false);
        const assetCookie = (
            await context.cookies(`${phi.url}/api/coders`)
        ).find((cookie) => cookie.name === 'phi_access_asset');
        expect(assetCookie).toMatchObject({
            httpOnly: true,
            sameSite: 'Strict',
            path: '/api',
        });
        expect(
            await page.evaluate(
                async () => (await fetch('/api/coders')).status,
            ),
        ).toBe(200);

        // Reload: memory is empty, so the page bootstraps from the HttpOnly
        // refresh cookie. Exactly one coalesced refresh, no second prompt, and
        // discovery is the public route because nothing is selected yet.
        v2Logins.length = 0;
        let discoveries = 0;
        let refreshes = 0;
        page.on('request', (request) => {
            if (request.url().endsWith('/api/auth/status')) discoveries += 1;
            if (request.url().includes('/api/auth/v2/refresh')) refreshes += 1;
            if (request.url().includes('/api/auth/v2/login')) {
                v2Logins.push(request.postData() ?? '');
            }
        });
        await page.reload();
        await expectSignedIn(page);
        await expect
            .poll(
                () =>
                    page.evaluate(() =>
                        Boolean(window.phiAccessAuth?.getAccessToken()),
                    ),
                { timeout: 30_000 },
            )
            .toBe(true);
        expect(v2Logins).toEqual([]);
        expect(discoveries).toBe(1);
        expect(refreshes).toBe(1);
        const renewed = await page.evaluate(() =>
            window.phiAccessAuth.getAccessToken(),
        );
        expect(renewed).toBeTruthy();
        expect(renewed).not.toBe(issued);

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

        // Dynamic Markdown: the image loads from its ordinary same-origin
        // asset URL, so the scoped cookie participates and the browser streams
        // it natively instead of the page buffering it into a blob.
        const dir = join(phi.dir, 'auth-md');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'pic.png'), PNG);
        writeFileSync(join(dir, 'doc.md'), '# doc\n\n![pic](pic.png)\n');
        const md = await context.newPage();
        const assetStatuses: number[] = [];
        const assetAuth: string[] = [];
        md.on('response', (response) => {
            if (response.url().includes('/api/markdown/asset')) {
                assetStatuses.push(response.status());
            }
        });
        md.on('request', async (request) => {
            if (!request.url().includes('/api/markdown/asset')) return;
            assetAuth.push((await request.allHeaders()).authorization ?? '');
        });
        await md.goto(
            `${phi.url}/md.html?path=${encodeURIComponent(join(dir, 'doc.md'))}&cwd=${encodeURIComponent(dir)}`,
        );
        const image = md.locator('.md-rendered img');
        await expect(image).toHaveAttribute(
            'src',
            /^\/api\/markdown\/asset\?path=/,
            { timeout: 30_000 },
        );
        await expect
            .poll(() =>
                image.evaluate((el: HTMLImageElement) => el.naturalWidth),
            )
            .toBe(1);
        expect(assetStatuses).toEqual([200]);
        // Cookie-authenticated: the asset request carries no explicit bearer.
        expect(assetAuth).toEqual(['']);
        await md.close();

        // The scoped cookie alone authorizes the two asset routes, and the
        // browser streams them natively: GET, HEAD and a 206 Range all work
        // without a bearer header. `path` is cwd-relative by contract.
        const assetPath = `/api/file/asset?path=pic.png&cwd=${encodeURIComponent(dir)}`;
        const assetGet = await context.request.get(`${phi.url}${assetPath}`);
        expect(assetGet.status()).toBe(200);
        expect(Buffer.from(await assetGet.body()).equals(PNG)).toBe(true);
        const assetHead = await context.request.fetch(
            `${phi.url}${assetPath}`,
            { method: 'HEAD' },
        );
        expect(assetHead.status()).toBe(200);
        const assetRange = await context.request.get(`${phi.url}${assetPath}`, {
            headers: { Range: 'bytes=0-3' },
        });
        expect(assetRange.status()).toBe(206);
        expect((await assetRange.body()).length).toBe(4);
        expect(assetRange.headers()['content-range']).toContain('bytes 0-3/');

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
        const bearer = await page.evaluate(() =>
            window.phiAccessAuth.getAccessToken(),
        );
        expect(bearer).toBeTruthy();

        // Hold both credentials in the same selected-v2 session (no reload):
        // the bearer must still win, and the cookie still rides along.
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

test.describe('MVP legacy home', () => {
    let phi: PhiServer;
    let refreshHandle = '';
    let preissuedSession = '';
    let mvpPassword = '';
    let savedVerifier: Record<string, unknown> = {};
    let legacyConfigBytes = '';

    test.describe.configure({ mode: 'serial' });

    test.beforeEach(async () => {
        mvpPassword = 'migration fixture pass';
        const salt = Buffer.alloc(16, 0x11);
        const verifier = pbkdf2Sync(mvpPassword, salt, 600_000, 32, 'sha256');
        const encoded = `v1.pbkdf2-sha256.600000.${b64url(salt)}.${b64url(verifier)}`;
        preissuedSession = preissuedLegacySession(verifier);
        savedVerifier = {
            version: 'v1',
            algorithm: 'pbkdf2-sha256',
            iterations: 600_000,
            salt: b64url(salt),
            verifier: b64url(verifier),
        };
        legacyConfigBytes = JSON.stringify({
            access_password_hash: encoded,
            theme_color: 'teal',
            quick_commands: [
                { name: 'auth fixture', command: 'printf auth-mvp' },
            ],
            sync_coordinator: '',
            peers: [],
            opencode_legacy: true,
        });
        const familyBytes = Buffer.alloc(32, 0x33);
        const familyID = b64url(familyBytes);
        const recordID = b64url(Buffer.alloc(32, 0x22));
        const nonce = b64url(Buffer.alloc(32, 0x44));
        const refreshKey = Buffer.from(
            hkdfSync('sha256', verifier, salt, 'phi/refresh-handle/v1', 32),
        );
        const generation = Buffer.alloc(8);
        const handle = createHmac('sha256', refreshKey)
            .update('phi/refresh-handle/v1\0')
            .update(familyBytes)
            .update(generation)
            .digest();
        refreshHandle = b64url(handle);
        const now = Math.floor(Date.now() / 1000);
        const legacyState = {
            version: 1,
            active: {
                record_binding: createHash('sha256')
                    .update(encoded)
                    .digest('hex'),
                record_id: recordID,
                epoch: 1,
                refresh_key: b64url(refreshKey),
                families: [
                    {
                        id: familyID,
                        generation: 0,
                        created_at: now - 30,
                        last_used_at: now - 10,
                        idle_expires_at: now + 3600,
                        absolute_expires_at: now + 7200,
                        active_digest: createHash('sha256')
                            .update(handle)
                            .digest('hex'),
                        current_access: {
                            iat: now - 30,
                            exp: now + 1800,
                            jti: nonce,
                        },
                        consumed: [],
                    },
                ],
            },
        };

        phi = await startPhi({
            setup: (dir) => {
                const configDir = join(dir, 'home', '.phi');
                mkdirSync(configDir, { recursive: true });
                expect(existsSync(join(configDir, 'config.toml'))).toBe(false);
                writeFileSync(
                    join(configDir, 'config.json'),
                    legacyConfigBytes,
                );
                writeFileSync(
                    join(configDir, 'auth-v2-state.json'),
                    JSON.stringify(legacyState),
                );
            },
        });
    });

    test.afterEach(async () => {
        await phi.stop();
    });

    /**
     * The restart below stops the owned listener while both surviving pages
     * stay open. The decorative CPU poll then records a connection refusal,
     * and its console line names no URL, so the quiet gate cannot tell it
     * from a real failure. Hold that one endpoint steady for the restart
     * window, as `pi-reload-reconnect.spec.ts` already does. Auth, config,
     * sockets, and every other request stay real.
     */
    async function stubDecorativeCpu(...pages: Page[]): Promise<void> {
        for (const page of pages) {
            await page.route('**/api/system/cpu', (route) =>
                route.fulfill({
                    contentType: 'application/json',
                    body: JSON.stringify({ cpu: 0 }),
                }),
            );
        }
    }

    async function exerciseMvpProfile(browser: Browser, mobile: boolean) {
        const profileOptions = mobile
            ? {
                  viewport: { width: 390, height: 844 },
                  isMobile: true,
                  hasTouch: true,
                  deviceScaleFactor: 3,
              }
            : { viewport: { width: 1440, height: 900 } };
        console.log(
            `M1 browser: ${browser.browserType().name()} ${browser.version()}`,
        );

        const configDir = join(phi.dir, 'home', '.phi');
        const configPath = join(configDir, 'config.json');
        const databasePath = join(configDir, 'auth.db');
        const assertMigration = () => {
            expect(readFileSync(configPath, 'utf8')).toBe(legacyConfigBytes);
            const persistedToml = readFileSync(
                join(configDir, 'config.toml'),
                'utf8',
            );
            expect(persistedToml).not.toMatch(/^access_password_hash\s*=/m);
            expect(persistedToml).toContain('theme_color = "teal"');
            expect(persistedToml).toContain('opencode_legacy = true');
            expect(persistedToml).toContain('name = "auth fixture"');
            expect(persistedToml).toContain('command = "printf auth-mvp"');
            const marker = persistedToml.match(
                /\[access_auth_migration\]\s+state\s*=\s*"complete"\s+id\s*=\s*"([^"]+)"/,
            );
            expect(marker).not.toBeNull();
            if (!marker?.[1])
                throw new Error('completed migration ID is missing');
            const databaseID = execFileSync(
                'sqlite3',
                [
                    '-readonly',
                    databasePath,
                    'SELECT hex(migration_id) FROM auth_state WHERE singleton_id=1;',
                ],
                { encoding: 'utf8' },
            ).trim();
            expect(
                Buffer.from(marker[1], 'base64url')
                    .toString('hex')
                    .toUpperCase(),
            ).toBe(databaseID);
            expect(existsSync(databasePath)).toBe(true);
            expect(existsSync(join(configDir, 'auth-v2-state.json'))).toBe(
                false,
            );
            return persistedToml;
        };
        assertMigration();
        expect((await fetch(`${phi.url}/healthz`)).status).toBe(200);
        expect((await fetch(`${phi.url}/api/coders`)).status).toBe(401);

        const legacyContext = await browser.newContext(profileOptions);
        await legacyContext.addCookies([
            {
                name: 'phi_access_session',
                value: preissuedSession,
                domain: new URL(phi.url).hostname,
                path: '/',
                httpOnly: true,
                sameSite: 'Strict',
            },
        ]);
        const legacyPage = await legacyContext.newPage();
        const legacyQuiet = monitorMvpPage(legacyPage);
        let legacyLogins = 0;
        let legacyV2Requests = 0;
        legacyPage.on('request', (request) => {
            const pathname = new URL(request.url()).pathname;
            if (pathname === '/api/auth/login') legacyLogins += 1;
            if (pathname.startsWith('/api/auth/v2/')) legacyV2Requests += 1;
        });
        await legacyPage.goto(phi.url);
        await expectSignedIn(legacyPage);
        expect(legacyLogins).toBe(0);
        expect(legacyV2Requests).toBe(0);
        expect(
            await legacyPage.evaluate(
                async () => (await fetch('/api/coders')).status,
            ),
        ).toBe(200);
        expect(
            await legacyPage.evaluate(() =>
                window.phiAccessAuth.getAccessToken(),
            ),
        ).toBeNull();
        expect(
            await legacyPage.evaluate(
                async () =>
                    (
                        await fetch('/api/coders', {
                            headers: {
                                Authorization: 'Bearer invalid-mvp-token',
                            },
                        })
                    ).status,
            ),
        ).toBe(401);

        const savedContext = await browser.newContext(profileOptions);
        await savedContext.addInitScript((saved) => {
            localStorage.setItem(
                'phi_access_credential_v1',
                JSON.stringify(saved),
            );
        }, savedVerifier);
        const savedPage = await savedContext.newPage();
        const savedQuiet = monitorMvpPage(savedPage);
        let savedV1Logins = 0;
        let savedV2Requests = 0;
        savedPage.on('request', (request) => {
            const pathname = new URL(request.url()).pathname;
            if (pathname === '/api/auth/login') savedV1Logins += 1;
            if (pathname.startsWith('/api/auth/v2/')) savedV2Requests += 1;
        });
        await savedPage.goto(phi.url);
        await expectSignedIn(savedPage);
        expect(savedV1Logins).toBe(1);
        expect(savedV2Requests).toBe(0);
        expect(
            await savedPage.evaluate(() =>
                window.phiAccessAuth.getAccessToken(),
            ),
        ).toBeNull();
        expect(
            await savedPage.evaluate(
                async () => (await fetch('/api/coders')).status,
            ),
        ).toBe(200);
        await savedContext.close();

        const migratedContext = await browser.newContext(profileOptions);
        await migratedContext.addCookies([
            {
                name: 'phi_access_refresh',
                value: refreshHandle,
                domain: new URL(phi.url).hostname,
                path: '/api/auth/v2/refresh',
                httpOnly: true,
                sameSite: 'Strict',
            },
        ]);
        const migratedPage = await migratedContext.newPage();
        const migratedQuiet = monitorMvpPage(migratedPage);
        let migratedV1Logins = 0;
        let migratedV2Logins = 0;
        let migratedRefreshStatus = 0;
        migratedPage.on('request', (request) => {
            const pathname = new URL(request.url()).pathname;
            if (pathname === '/api/auth/login') migratedV1Logins += 1;
            if (pathname === '/api/auth/v2/login') migratedV2Logins += 1;
        });
        migratedPage.on('response', (response) => {
            if (new URL(response.url()).pathname === '/api/auth/v2/refresh') {
                migratedRefreshStatus = response.status();
            }
        });
        await migratedPage.goto(phi.url);
        await expect.poll(() => migratedRefreshStatus).toBe(200);
        await expectSignedIn(migratedPage);
        expect(migratedV1Logins).toBe(0);
        expect(migratedV2Logins).toBe(0);
        expect(
            await migratedPage.evaluate(
                async () => (await fetch('/api/coders')).status,
            ),
        ).toBe(200);
        expect(
            await migratedPage.evaluate(() =>
                Boolean(window.phiAccessAuth.getAccessToken()),
            ),
        ).toBe(true);
        migratedQuiet.assertQuiet();
        await migratedContext.close();

        const v2Context = await browser.newContext(profileOptions);
        const v2Page = await v2Context.newPage();
        const v2Quiet = monitorMvpPage(v2Page);
        let v1Logins = 0;
        let v2Logins = 0;
        const refreshStatuses: number[] = [];
        v2Page.on('request', (request) => {
            const pathname = new URL(request.url()).pathname;
            if (pathname === '/api/auth/login') v1Logins += 1;
            if (pathname === '/api/auth/v2/login') v2Logins += 1;
        });
        v2Page.on('response', (response) => {
            if (new URL(response.url()).pathname === '/api/auth/v2/refresh') {
                refreshStatuses.push(response.status());
            }
        });
        await v2Page.goto(phi.url);
        await unlockMvp(v2Page, mvpPassword, mobile);
        await expectSignedIn(v2Page);
        expect(v1Logins).toBe(0);
        expect(v2Logins).toBe(1);
        expect(
            await v2Page.evaluate(() =>
                Boolean(window.phiAccessAuth.getAccessToken()),
            ),
        ).toBe(true);
        const apiConfig = await v2Page.evaluate(async () => {
            const response = await fetch('/api/config');
            const config = (await response.json()) as Record<string, unknown>;
            return {
                status: response.status,
                theme: config.theme_color,
                hasMigrationMarker: Object.hasOwn(
                    config,
                    'access_auth_migration',
                ),
                hasVerifier: Object.hasOwn(config, 'access_password_hash'),
            };
        });
        expect(apiConfig).toEqual({
            status: 200,
            theme: 'teal',
            hasMigrationMarker: false,
            hasVerifier: false,
        });
        expect(
            await v2Page.evaluate(
                async () => (await fetch('/api/coders')).status,
            ),
        ).toBe(200);
        await expect.poll(() => refreshStatuses).not.toContain(200);

        await v2Page.reload();
        await expectSignedIn(v2Page);
        await expect.poll(() => refreshStatuses).toContain(200);
        expect(v2Logins).toBe(1);
        expect(
            await v2Page.evaluate(() =>
                Boolean(window.phiAccessAuth.getAccessToken()),
            ),
        ).toBe(true);
        expect(await openSocket(v2Page, '/ws/md-events', EVENTS)).toBe('open');
        expect(await openSocket(v2Page, '/ws/control', CONTROL)).toBe('open');

        await stubDecorativeCpu(legacyPage, v2Page);
        const beforeRestart = phi.identity;
        legacyQuiet.setRestarting(true);
        v2Quiet.setRestarting(true);
        await phi.restart();
        legacyQuiet.setRestarting(false);
        v2Quiet.setRestarting(false);
        expect(phi.identity.directory).toBe(beforeRestart.directory);
        expect(phi.identity.port).toBe(beforeRestart.port);
        expect(phi.identity.binarySha256).toBe(beforeRestart.binarySha256);
        assertMigration();

        await legacyPage.reload();
        await expectSignedIn(legacyPage);
        expect(legacyLogins).toBe(0);
        expect(
            await legacyPage.evaluate(
                async () => (await fetch('/api/coders')).status,
            ),
        ).toBe(200);
        expect(
            await legacyPage.evaluate(() =>
                window.phiAccessAuth.getAccessToken(),
            ),
        ).toBeNull();
        refreshStatuses.length = 0;
        await v2Page.reload();
        await expectSignedIn(v2Page);
        await expect.poll(() => refreshStatuses).toContain(200);
        expect(v2Logins).toBe(1);
        expect(
            await v2Page.evaluate(
                async () => (await fetch('/api/coders')).status,
            ),
        ).toBe(200);
        expect(await openSocket(v2Page, '/ws/md-events', EVENTS)).toBe('open');
        expect(await openSocket(v2Page, '/ws/control', CONTROL)).toBe('open');
        expect(
            await v2Page.evaluate(
                () => document.documentElement.scrollWidth > window.innerWidth,
            ),
            mobile
                ? 'mobile horizontal overflow'
                : 'desktop horizontal overflow',
        ).toBe(false);

        legacyQuiet.assertQuiet();
        savedQuiet.assertQuiet();
        v2Quiet.assertQuiet();
        await legacyContext.close();
        await v2Context.close();
    }

    test('MVP legacy home / desktop', async ({ browser }) => {
        await exerciseMvpProfile(browser, false);
    });

    test('MVP legacy home / mobile touch', async ({ browser }) => {
        await exerciseMvpProfile(browser, true);
    });
});

test.describe('migration failure', () => {
    let phi: PhiServer;

    test.beforeEach(async () => {
        phi = await startPhi();
        const token = await lockServer(phi.url, PASSWORD);
        const protectedResponse = await fetch(`${phi.url}/api/coders`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(protectedResponse.status).toBe(200);
    });

    test.afterEach(async () => {
        await phi.stop();
    });

    async function expectDatabaseFailure(state: 'missing' | 'corrupt') {
        const configDir = join(phi.dir, 'home', '.phi');
        const configPath = join(configDir, 'config.toml');
        const databasePath = join(configDir, 'auth.db');
        const configBefore = readFileSync(configPath);
        const databaseBefore = readFileSync(databasePath);
        const backupDir = join(phi.dir, 'auth-backup');
        mkdirSync(backupDir);
        const backupConfigPath = join(backupDir, 'config.toml');
        const backupDatabasePath = join(backupDir, 'auth.db');
        writeFileSync(backupConfigPath, configBefore);
        writeFileSync(backupDatabasePath, databaseBefore);
        expect(configBefore.toString()).toMatch(
            /\[access_auth_migration\][\s\S]*?state\s*=\s*"complete"/,
        );
        expect(readFileSync(backupConfigPath)).toEqual(configBefore);
        expect(readFileSync(backupDatabasePath)).toEqual(databaseBefore);

        const corruptBytes = Buffer.from('synthetic corrupt auth database');
        let startupFailure: unknown;
        try {
            await phi.restart(() => {
                if (state === 'missing') unlinkSync(databasePath);
                else writeFileSync(databasePath, corruptBytes);
            });
        } catch (error) {
            startupFailure = error;
        }

        if (startupFailure !== undefined) {
            expect(String(startupFailure)).toMatch(
                /fixture server exited (?:before health|(?:before|during) identity check)|phi server never came up/,
            );
            expect(readFileSync(phi.logPath, 'utf8')).toContain(
                'invalid access password configuration',
            );
        } else {
            phi.verify();
            const statusResponse = await fetch(`${phi.url}/api/auth/v2/status`);
            expect(statusResponse.status).toBe(200);
            const status = (await statusResponse.json()) as {
                enabled: boolean;
            };
            expect(status.enabled).toBe(true);
            const protectedResponse = await fetch(`${phi.url}/api/coders`);
            expect(protectedResponse.status).not.toBe(200);
        }

        expect(readFileSync(backupConfigPath)).toEqual(configBefore);
        expect(readFileSync(backupDatabasePath)).toEqual(databaseBefore);
        if (state === 'missing') {
            expect(existsSync(databasePath)).toBe(false);
        } else {
            expect(readFileSync(databasePath)).toEqual(corruptBytes);
        }
    }

    test('/ missing DB', async () => {
        await expectDatabaseFailure('missing');
    });

    test('/ corrupt DB', async () => {
        await expectDatabaseFailure('corrupt');
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

    test('an old-v2 server without the refresh route leaves no durable credential', async ({
        browser,
    }) => {
        // The unpublished candidate's v2 kept a long-lived token in storage. A
        // server advertising v2 but answering the refresh route with 404 must
        // therefore leave nothing behind: the new client persists no token, so
        // an old-v2 server cannot hold a session open across a reload.
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(phi.url);
        await unlock(page, PASSWORD);
        await expectSignedIn(page);
        expect(
            await page.evaluate(() => window.phiAccessAuth.getAccessToken()),
        ).toBeTruthy();

        await page.route('**/api/auth/v2/refresh', (route) =>
            route.fulfill({ status: 404, body: 'not found' }),
        );
        const legacyLogins: string[] = [];
        page.on('request', (request) => {
            if (request.url().endsWith('/api/auth/login')) {
                legacyLogins.push(request.url());
            }
        });
        await page.reload();
        await expect
            .poll(() =>
                page.evaluate(() => window.phiAccessAuth.getAccessToken()),
            )
            .toBeNull();
        // No v1 session is fabricated and no v1 login is attempted.
        expect(legacyLogins).toEqual([]);
        expect(
            (await context.cookies(phi.url)).some(
                (cookie) => cookie.name === 'phi_access_session',
            ),
        ).toBe(false);
        expect(
            await page.evaluate(() =>
                localStorage.getItem('phi_access_credential_v1'),
            ),
        ).toBeNull();
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

        const token = await page.evaluate(() =>
            window.phiAccessAuth.getAccessToken(),
        );
        expect(token).toBeTruthy();
        const urls = await socketURLs(page);
        for (const [name, href] of Object.entries(urls)) {
            const parsed = new URL(href);
            expect(parsed.origin, name).toBe(new URL(phi.url).origin);
            expect(parsed.searchParams.get('token'), name).toBe(token);
        }
        expect(await openSocket(page, '/ws/md-events', EVENTS)).toBe('open');
        expect(await openSocket(page, '/ws/control', CONTROL)).toBe('open');
        const paneId = await spawnPane(page, phi.url, token as string);
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
        const replacement = await page.evaluate(() =>
            window.phiAccessAuth.getAccessToken(),
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
        retiredBearer = token as string;
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
            headers: { 'Content-Type': 'application/json', 'X-Phi-Auth': 'v2' },
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
            owned: true,
        });
    });
});

async function provePoorNetworkRecovery(
    browser: Browser,
    server: PhiServer,
    options: Parameters<Browser['newContext']>[0],
): Promise<void> {
    const context = await browser.newContext(options);
    const mobile = Boolean(options?.hasTouch);
    const activate = async (page: Page, selector: string) => {
        if (mobile) await page.locator(selector).tap();
        else await page.locator(selector).click();
    };
    let release = () => {};
    try {
        const page = await context.newPage();
        await page.goto(server.url);
        await unlockMvp(page, PASSWORD, mobile);
        await expectSignedIn(page);
        const openSettings = async () => {
            if (mobile) {
                await activate(page, '#mobile-sidebar-toggle');
                await activate(page, '#drawer-settings-btn');
            } else {
                await activate(page, '#header-config-pill .pill-label');
            }
            await expect(page.locator('.settings-overlay')).toBeVisible();
        };
        // Populate the normal local Settings cache before injecting faults.
        await openSettings();
        await expect(page.locator('#settings-access-new')).toBeEnabled();
        await activate(page, '.settings-overlay .modal-close-btn');
        const failed: string[] = [];
        const errors: string[] = [];
        const exceptions: string[] = [];
        const httpFailures: string[] = [];
        const writes: string[] = [];
        let refreshPosts = 0;
        page.on('request', (request) => {
            const path = new URL(request.url()).pathname;
            if (request.method() === 'POST' && path === '/api/auth/v2/refresh')
                refreshPosts++;
            else if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()))
                writes.push(`${request.method()} ${path}`);
        });
        page.on('requestfailed', (request) =>
            failed.push(
                `${request.method()} ${new URL(request.url()).pathname}`,
            ),
        );
        page.on('console', (message) => {
            if (message.type() === 'error') errors.push(message.text());
        });
        page.on('pageerror', (error) => exceptions.push(error.name));
        page.on('response', (response) => {
            if (response.status() < 400) return;
            const path = new URL(response.url()).pathname;
            if (
                response.status() === 503 &&
                response.request().method() === 'GET' &&
                path === '/api/update/status'
            )
                return;
            httpFailures.push(
                `${response.status()} ${response.request().method()} ${path}`,
            );
        });
        const beforeLatency = await page.evaluate(() =>
            window.phiAccessAuth.getAccessToken(),
        );
        let markHeld!: () => void;
        const held = new Promise<void>((resolve) => {
            markHeld = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        await page.route('**/api/auth/v2/refresh', async (route) => {
            markHeld();
            await gate;
            await route.continue();
        });
        await page.evaluate(async () => {
            const auth = await import(new URL('./auth.js', location.href).href);
            void auth.__test__.renewIfDue({ ifDue: false });
        });
        await held;
        const heldAt = Date.now();
        await openSettings();
        const draft = page.locator('#settings-access-new');
        await draft.fill('unsent-network-fixture');
        await expect(draft).toHaveValue('unsent-network-fixture');
        expect(Date.now() - heldAt).toBeLessThan(2_000);
        expect(refreshPosts).toBe(1);
        expect(
            (await page.evaluate(() =>
                window.phiAccessAuth.getAccessToken(),
            )) === beforeLatency,
        ).toBe(true);
        release();
        await expect
            .poll(
                async () =>
                    (await page.evaluate(() =>
                        window.phiAccessAuth.getAccessToken(),
                    )) !== beforeLatency,
            )
            .toBe(true);
        await page.unroute('**/api/auth/v2/refresh');

        // Assets are already loaded: exercise real offline bootstrap, not an
        // uncached navigation that could never reach the auth code.
        const beforeOffline = await page.evaluate(() =>
            window.phiAccessAuth.getAccessToken(),
        );
        await context.setOffline(true);
        try {
            const result = await page.evaluate(async () => {
                const auth = await import(
                    new URL('./auth.js', location.href).href
                );
                try {
                    await auth.bootstrapAccessAuth();
                    return 'unexpected success';
                } catch {
                    return 'unavailable';
                }
            });
            expect(result).toBe('unavailable');
            await expect(draft).toHaveValue('unsent-network-fixture');
            expect(
                (await page.evaluate(() =>
                    window.phiAccessAuth.getAccessToken(),
                )) === beforeOffline,
            ).toBe(true);
            await expect(page.locator('.access-auth-overlay')).toHaveCount(0);
        } finally {
            await context.setOffline(false);
        }
        await page.evaluate(async () => {
            const auth = await import(new URL('./auth.js', location.href).href);
            await auth.bootstrapAccessAuth();
        });

        for (const status of [429, 500, 200]) {
            const before = await page.evaluate(() =>
                window.phiAccessAuth.getAccessToken(),
            );
            const postsBefore = refreshPosts;
            let injected = 0;
            await page.route('**/api/auth/v2/refresh', async (route) => {
                if (injected > 0) {
                    await route.continue();
                    return;
                }
                injected++;
                await route.fulfill({
                    status,
                    headers: status === 429 ? { 'Retry-After': '2' } : {},
                    contentType: 'application/json',
                    body: status === 200 ? '{malformed' : '{}',
                });
            });
            try {
                await page.evaluate(async () => {
                    const auth = await import(
                        new URL('./auth.js', location.href).href
                    );
                    await auth.__test__.renewIfDue({ ifDue: false });
                });
                expect(injected).toBe(1);
                expect(refreshPosts - postsBefore).toBe(1);
                expect(
                    (await page.evaluate(() =>
                        window.phiAccessAuth.getAccessToken(),
                    )) === before,
                ).toBe(true);
                expect(
                    await page.evaluate(async () => {
                        const auth = await import(
                            new URL('./auth.js', location.href).href
                        );
                        return auth.__test__.getAccessState().selectedProtocol;
                    }),
                ).toBe('v2');
                await expect(draft).toHaveValue('unsent-network-fixture');
                await expect(page.locator('.access-auth-overlay')).toHaveCount(
                    0,
                );
                // No tight retry loop; a 429 must honor its two-second delay.
                await page.waitForTimeout(status === 429 ? 1_800 : 500);
                expect(refreshPosts - postsBefore).toBe(1);
                await expect
                    .poll(
                        async () =>
                            (await page.evaluate(() =>
                                window.phiAccessAuth.getAccessToken(),
                            )) !== before,
                    )
                    .toBe(true);
                expect(refreshPosts - postsBefore).toBe(2);
            } finally {
                await page.unroute('**/api/auth/v2/refresh');
            }
        }
        await expect(draft).toHaveValue('unsent-network-fixture');
        await activate(page, '.settings-overlay .modal-close-btn');
        expect(
            await page.evaluate(
                async () => (await fetch('/api/coders')).status,
            ),
        ).toBe(200);
        expect(await openSocket(page, '/ws/md-events', EVENTS)).toBe('open');
        expect(await openSocket(page, '/ws/control', CONTROL)).toBe('open');
        expect(
            await page.evaluate(
                () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
        ).toBe(true);
        expect(writes).toEqual([]);
        expect(failed).toEqual(['GET /api/auth/status']);
        expect(httpFailures).toEqual([
            '429 POST /api/auth/v2/refresh',
            '500 POST /api/auth/v2/refresh',
        ]);
        expect(errors).toEqual([
            'Failed to load resource: net::ERR_INTERNET_DISCONNECTED',
            'Failed to load resource: the server responded with a status of 429 (Too Many Requests)',
            'Failed to load resource: the server responded with a status of 500 (Internal Server Error)',
        ]);
        expect(exceptions).toEqual([]);
    } finally {
        release();
        await context.close();
    }
}

test.describe('poor network', () => {
    let phi: PhiServer;
    test.beforeEach(async () => {
        phi = await startPhi({
            config: { sync_coordinator: '', peers: [], opencode_legacy: true },
        });
        await lockServer(phi.url, PASSWORD);
    });
    test.afterEach(async () => {
        await phi.stop();
    });
    for (const profile of [
        {
            name: 'desktop',
            options: { viewport: { width: 1440, height: 900 } },
        },
        {
            name: 'mobile touch',
            options: {
                viewport: { width: 390, height: 844 },
                isMobile: true,
                hasTouch: true,
                deviceScaleFactor: 3,
            },
        },
    ]) {
        test(`/ ${profile.name}`, async ({ browser }) => {
            await provePoorNetworkRecovery(browser, phi, profile.options);
        });
    }
});

async function provePostCommitRefreshLoss(
    browser: Browser,
    server: PhiServer,
    options: Parameters<Browser['newContext']>[0],
): Promise<void> {
    const context = await browser.newContext(options);
    try {
        const page = await context.newPage();
        await page.goto(server.url);
        await unlock(page, PASSWORD);
        await expectSignedIn(page);

        const tokenBefore = await page.evaluate(() =>
            window.phiAccessAuth.getAccessToken(),
        );
        expect(tokenBefore).toBeTruthy();
        const dbBefore = readV2DbState(server);
        expect(dbBefore.maxGeneration === 0n).toBe(true);
        expect(dbBefore.consumedHandles === 0).toBe(true);

        const refreshCookieURL = `${server.url}/api/auth/v2/refresh`;
        const previous = (await context.cookies(refreshCookieURL)).find(
            (cookie) => cookie.name === 'phi_access_refresh',
        );
        expect(previous).toBeTruthy();
        if (!previous) throw new Error('refresh cookie is missing');
        const previousCookie = {
            name: previous.name,
            value: previous.value,
            domain: previous.domain,
            path: previous.path,
            expires: previous.expires,
            httpOnly: previous.httpOnly,
            secure: previous.secure,
            sameSite: previous.sameSite,
        };

        let refreshPosts = 0;
        let unrelatedAuthWrites = 0;
        const failedRequests: string[] = [];
        const consoleErrors: string[] = [];
        const pageErrors: string[] = [];
        const unexpectedResponses: string[] = [];
        const authWritePaths = new Set([
            '/api/auth/v2/login',
            '/api/auth/v2/password',
            '/api/auth/v2/logout',
        ]);
        page.on('request', (request) => {
            const path = new URL(request.url()).pathname;
            if (request.method() !== 'POST') return;
            if (path === '/api/auth/v2/refresh') refreshPosts++;
            else if (authWritePaths.has(path)) unrelatedAuthWrites++;
        });
        page.on('requestfailed', (request) => {
            failedRequests.push(
                `${request.method()} ${new URL(request.url()).pathname}`,
            );
        });
        page.on('console', (message) => {
            if (message.type() === 'error') consoleErrors.push(message.text());
        });
        page.on('pageerror', (error) => pageErrors.push(error.name));
        page.on('response', (response) => {
            if (response.status() < 400) return;
            const path = new URL(response.url()).pathname;
            if (
                response.status() === 503 &&
                response.request().method() === 'GET' &&
                path === '/api/update/status'
            ) {
                return;
            }
            unexpectedResponses.push(
                `${response.status()} ${response.request().method()} ${path}`,
            );
        });
        // The background session list must be healthy before dropping a reply.
        expect(
            await page.evaluate(
                async () =>
                    (await fetch('/api/sessions?coder=opencode')).status,
            ),
        ).toBe(200);
        const authWritesBefore = unrelatedAuthWrites;
        let resolveCommit!: (commit: {
            withheld: { token: string; jti: string; refreshHandle: string };
            dbAfterCommit: {
                maxGeneration: bigint;
                consumedHandles: number;
            };
        }) => void;
        let rejectCommit!: (error: unknown) => void;
        const committed = new Promise<{
            withheld: { token: string; jti: string; refreshHandle: string };
            dbAfterCommit: {
                maxGeneration: bigint;
                consumedHandles: number;
            };
        }>((resolve, reject) => {
            resolveCommit = resolve;
            rejectCommit = reject;
        });
        const interceptRefresh = async (route: Route) => {
            try {
                const response = await route.fetch({ maxRetries: 0 });
                const refreshHandle = response
                    .headersArray()
                    .filter(({ name }) => name.toLowerCase() === 'set-cookie')
                    .map(
                        ({ value }) =>
                            /^phi_access_refresh=([^;]+)/.exec(value)?.[1],
                    )
                    .find((value) => value);
                const bundle = (await response.json()) as {
                    token?: unknown;
                };
                if (typeof bundle.token !== 'string' || !refreshHandle) {
                    throw new Error('committed refresh response is incomplete');
                }
                resolveCommit({
                    withheld: {
                        token: bundle.token,
                        jti: jwtJti(bundle.token),
                        refreshHandle,
                    },
                    dbAfterCommit: readV2DbState(server),
                });
                await context.addCookies([previousCookie]);
                await response.dispose();
                await route.abort('failed');
            } catch (error) {
                rejectCommit(error);
                await route.abort('failed').catch(() => undefined);
            }
        };
        await page.route('**/api/auth/v2/refresh', interceptRefresh);

        const firstRefresh = await page.evaluate(async () => {
            const auth = await import(new URL('./auth.js', location.href).href);
            try {
                await auth.__test__.refreshSession();
                return 'resolved';
            } catch {
                return 'unavailable';
            }
        });
        expect(firstRefresh).toBe('unavailable');
        expect(refreshPosts).toBe(1);
        // The abort only fires after the interceptor settles, so this never
        // hangs once the refresh above failed through the interceptor.
        const { withheld, dbAfterCommit } = await committed;
        expect(dbAfterCommit.maxGeneration === 1n).toBe(true);
        expect(dbAfterCommit.consumedHandles === 1).toBe(true);
        expect(
            (await page.evaluate(() =>
                window.phiAccessAuth.getAccessToken(),
            )) === tokenBefore,
        ).toBe(true);
        await expect(page.locator('.access-auth-overlay')).toHaveCount(0);
        expect(
            await page.evaluate(
                async () => (await fetch('/api/coders')).status,
            ),
        ).toBe(200);

        await page.unroute('**/api/auth/v2/refresh', interceptRefresh);
        const replay = await page.evaluate(async () => {
            const auth = await import(new URL('./auth.js', location.href).href);
            await auth.__test__.refreshSession();
            return window.phiAccessAuth.getAccessToken();
        });
        expect(replay === withheld.token).toBe(true);
        expect(
            typeof replay === 'string' && jwtJti(replay) === withheld.jti,
        ).toBe(true);
        const dbAfterReplay = readV2DbState(server);
        expect(
            dbAfterReplay.maxGeneration === dbAfterCommit.maxGeneration,
        ).toBe(true);
        expect(
            dbAfterReplay.consumedHandles === dbAfterCommit.consumedHandles,
        ).toBe(true);
        const replayedCookie = (await context.cookies(refreshCookieURL)).find(
            (cookie) => cookie.name === 'phi_access_refresh',
        );
        expect(replayedCookie?.value === withheld.refreshHandle).toBe(true);

        expect(refreshPosts).toBe(2);
        expect(unrelatedAuthWrites).toBe(authWritesBefore);
        await expect(page.locator('.access-auth-overlay')).toHaveCount(0);
        expect(
            await page.evaluate(
                async () => (await fetch('/api/coders')).status,
            ),
        ).toBe(200);
        expect(await openSocket(page, '/ws/md-events', EVENTS)).toBe('open');
        expect(await openSocket(page, '/ws/control', CONTROL)).toBe('open');
        // The aborted refresh echoes once in the console; nothing else may.
        expect({
            failedRequests,
            consoleErrors,
            pageErrors,
            unexpectedResponses,
        }).toEqual({
            failedRequests: ['POST /api/auth/v2/refresh'],
            consoleErrors: ['Failed to load resource: net::ERR_FAILED'],
            pageErrors: [],
            unexpectedResponses: [],
        });
    } finally {
        await context.close();
    }
}

test.describe('post-commit response loss', () => {
    let phi: PhiServer;

    test.beforeEach(async () => {
        // Auth recovery does not require an OpenCode 2 installation.
        phi = await startPhi({
            config: { sync_coordinator: '', peers: [], opencode_legacy: true },
        });
        await lockServer(phi.url, PASSWORD);
    });

    test.afterEach(async () => {
        await phi.stop();
    });

    for (const profile of [
        {
            name: 'desktop',
            options: { viewport: { width: 1440, height: 900 } },
        },
        {
            name: 'mobile touch',
            options: {
                viewport: { width: 390, height: 844 },
                isMobile: true,
                hasTouch: true,
                deviceScaleFactor: 3,
            },
        },
    ]) {
        test(`/ ${profile.name}`, async ({ browser }) => {
            await provePostCommitRefreshLoss(browser, phi, profile.options);
        });
    }
});

test.describe('two same-origin tabs', () => {
    let phi: PhiServer;

    test.beforeAll(async () => {
        phi = await startPhi({ config: { sync_coordinator: '', peers: [] } });
        await lockServer(phi.url, PASSWORD);
    });

    test.afterAll(async () => {
        await phi.stop();
    });

    test('shares one renewal across tabs and survives a lost refresh', async ({
        browser,
    }) => {
        const context = await browser.newContext();
        const first = await context.newPage();
        await first.goto(phi.url);
        await unlock(first, PASSWORD);
        await expectSignedIn(first);

        const second = await context.newPage();
        await second.goto(phi.url);
        await expectSignedIn(second);
        // The second tab bootstraps from the shared HttpOnly refresh cookie.
        const firstToken = await first.evaluate(() =>
            window.phiAccessAuth.getAccessToken(),
        );
        expect(firstToken).toBeTruthy();

        // A renewal in one tab broadcasts its bundle: the other tab adopts the
        // new token without spending a refresh of its own. The bundle only wins
        // when its deadline is strictly later, and exp has one-second
        // granularity, so cross the second boundary before renewing.
        await first.waitForTimeout(1200);
        let secondRefreshes = 0;
        second.on('request', (request) => {
            if (request.url().includes('/api/auth/v2/refresh')) {
                secondRefreshes += 1;
            }
        });
        const shared = await first.evaluate(async () => {
            const auth = await import(new URL('./auth.js', location.href).href);
            await auth.__test__.refreshSession();
            return window.phiAccessAuth.getAccessToken();
        });
        expect(shared).toBeTruthy();
        await expect
            .poll(() =>
                second.evaluate(() => window.phiAccessAuth.getAccessToken()),
            )
            .toBe(shared);
        expect(secondRefreshes).toBe(0);

        // Both tabs renewing at once stay signed in: the rotation grace window
        // admits the second request instead of revoking the family.
        const refreshPosts: string[] = [];
        context.on('request', (request) => {
            if (request.url().includes('/api/auth/v2/refresh')) {
                refreshPosts.push(request.url());
            }
        });
        const [left, right] = await Promise.all([
            first.evaluate(async () => {
                const auth = await import(
                    new URL('./auth.js', location.href).href
                );
                await auth.__test__.refreshSession();
                return window.phiAccessAuth.getAccessToken();
            }),
            second.evaluate(async () => {
                const auth = await import(
                    new URL('./auth.js', location.href).href
                );
                await auth.__test__.refreshSession();
                return window.phiAccessAuth.getAccessToken();
            }),
        ]);
        expect(left).toBeTruthy();
        expect(right).toBeTruthy();
        expect(refreshPosts.length).toBeLessThanOrEqual(2);
        for (const page of [first, second]) {
            await expect(page.locator('.access-auth-overlay')).toHaveCount(0);
            expect(
                await page.evaluate(
                    async () => (await fetch('/api/coders')).status,
                ),
            ).toBe(200);
        }

        // A lost refresh response keeps the credential, the rendered state, and
        // the backoff retry instead of signing the tab out.
        const surviving = await second.evaluate(() =>
            window.phiAccessAuth.getAccessToken(),
        );
        await second.route('**/api/auth/v2/refresh', (route) =>
            route.abort('failed'),
        );
        expect(
            await second.evaluate(async () => {
                const auth = await import(
                    new URL('./auth.js', location.href).href
                );
                try {
                    await auth.__test__.refreshSession();
                    return 'resolved';
                } catch {
                    return 'retryable';
                }
            }),
        ).toBe('retryable');
        expect(
            await second.evaluate(() => window.phiAccessAuth.getAccessToken()),
        ).toBe(surviving);
        await expect(second.locator('.access-auth-overlay')).toHaveCount(0);
        expect(
            await second.evaluate(
                async () => (await fetch('/api/coders')).status,
            ),
        ).toBe(200);
        await second.unroute('**/api/auth/v2/refresh');
        await context.close();
    });

    test('renews without locks or a broadcast channel', async ({ browser }) => {
        const context = await browser.newContext();
        // A browser without Web Locks or BroadcastChannel still coalesces its
        // own renewal and bootstraps from the cookie.
        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'locks', {
                configurable: true,
                get: () => undefined,
            });
            Object.defineProperty(window, 'BroadcastChannel', {
                configurable: true,
                get: () => undefined,
            });
        });
        const page = await context.newPage();
        await page.goto(phi.url);
        await unlock(page, PASSWORD);
        await expectSignedIn(page);
        expect(await page.evaluate(() => typeof navigator.locks)).toBe(
            'undefined',
        );
        expect(await page.evaluate(() => typeof window.BroadcastChannel)).toBe(
            'undefined',
        );
        const before = await page.evaluate(() =>
            window.phiAccessAuth.getAccessToken(),
        );
        const renewed = await page.evaluate(async () => {
            const auth = await import(new URL('./auth.js', location.href).href);
            await Promise.all([
                auth.__test__.refreshSession(),
                auth.__test__.refreshSession(),
            ]);
            return window.phiAccessAuth.getAccessToken();
        });
        expect(renewed).toBeTruthy();
        expect(renewed).not.toBe(before);
        expect(
            await page.evaluate(
                async () => (await fetch('/api/coders')).status,
            ),
        ).toBe(200);
        await context.close();
    });

    test('replays a renewed read but never a mutation', async ({ browser }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(phi.url);
        await unlock(page, PASSWORD);
        await expectSignedIn(page);

        let reads = 0;
        await page.route('**/api/coders', async (route) => {
            reads += 1;
            if (reads === 1) {
                await route.fulfill({ status: 401, body: 'stale' });
                return;
            }
            await route.continue();
        });
        expect(
            await page.evaluate(
                async () => (await fetch('/api/coders')).status,
            ),
        ).toBe(200);
        expect(reads).toBe(2);

        // The same stale-token 401 on a mutation surfaces to the caller once:
        // a write is never re-sent behind the user's back.
        let writes = 0;
        await page.route('**/api/terminals', async (route) => {
            if (route.request().method() !== 'POST') {
                await route.continue();
                return;
            }
            writes += 1;
            await route.fulfill({ status: 401, body: 'stale' });
        });
        expect(
            await page.evaluate(
                async () =>
                    (
                        await fetch('/api/terminals', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ coder: 'bash' }),
                        })
                    ).status,
            ),
        ).toBe(401);
        expect(writes).toBe(1);
        await context.close();
    });
});

test.describe('session lifecycle and precedence', () => {
    // Ordering matters: logout and password operations retire credentials.
    test.describe.configure({ mode: 'serial' });

    let phi: PhiServer;

    test.beforeAll(async () => {
        phi = await startPhi({ config: { sync_coordinator: '', peers: [] } });
        await lockServer(phi.url, PASSWORD);
    });

    test.afterAll(async () => {
        await phi.stop();
    });

    test('logout closes the admitted socket, drops the credential, and reaches other tabs', async ({
        browser,
    }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(phi.url);
        await unlock(page, PASSWORD);
        await expectSignedIn(page);

        const other = await context.newPage();
        await other.goto(phi.url);
        await expectSignedIn(other);

        // Hold a socket open, then log out current: the server retires every
        // socket this family admitted.
        const closed = page.evaluate(async () => {
            const url = window.phiAccessAuth.webSocketURL(
                new URL('/ws/md-events', location.href),
            );
            return new Promise<string>((resolve) => {
                const ws = new WebSocket(url.href, 'phi.events.protobuf.v1');
                ws.onopen = () => {
                    void import(new URL('./auth.js', location.href).href).then(
                        (auth) => auth.logoutAccess(false),
                    );
                };
                ws.onclose = (event) => resolve(`close:${event.code}`);
                setTimeout(() => resolve('timeout'), 15_000);
            });
        });
        expect(await closed).not.toBe('timeout');
        await expect
            .poll(() =>
                page.evaluate(() => window.phiAccessAuth.getAccessToken()),
            )
            .toBeNull();
        // The other tab was told, without receiving any secret, and prompts.
        await expect(other.locator('.access-auth-overlay')).toBeVisible({
            timeout: 30_000,
        });
        expect(
            await page.evaluate(
                async () => (await fetch('/api/coders')).status,
            ),
        ).toBe(401);
        await context.close();
    });

    test('logout-all ends every v2 session', async ({ browser }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(phi.url);
        await unlock(page, PASSWORD);
        await expectSignedIn(page);
        const token = await page.evaluate(() =>
            window.phiAccessAuth.getAccessToken(),
        );

        const second = await browser.newContext();
        const otherPage = await second.newPage();
        await otherPage.goto(phi.url);
        await unlock(otherPage, PASSWORD);
        await expectSignedIn(otherPage);
        const otherToken = await otherPage.evaluate(() =>
            window.phiAccessAuth.getAccessToken(),
        );

        expect(
            await page.evaluate(async () => {
                const auth = await import(
                    new URL('./auth.js', location.href).href
                );
                return auth.logoutAccess(true);
            }),
        ).toEqual({ ok: true });

        // Every family is gone: both bearers are rejected and the other
        // context cannot refresh back in.
        for (const bearer of [token, otherToken]) {
            expect(
                (
                    await context.request.get(`${phi.url}/api/config`, {
                        headers: { Authorization: `Bearer ${bearer}` },
                    })
                ).status(),
            ).toBe(401);
        }
        expect(
            (
                await second.request.post(`${phi.url}/api/auth/v2/refresh`, {
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Phi-Auth': 'v2',
                    },
                    data: {},
                })
            ).status(),
        ).toBe(401);
        await second.close();
        await context.close();
    });

    test('a late refresh answer never resurrects a logged-out session', async ({
        browser,
    }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(phi.url);
        await unlock(page, PASSWORD);
        await expectSignedIn(page);

        // Hold the refresh answer back until after the logout: the older answer
        // must lose to the newer local state instead of restoring a token.
        await page.route('**/api/auth/v2/refresh', async (route) => {
            await new Promise((resolve) => setTimeout(resolve, 800));
            await route.continue();
        });
        expect(
            await page.evaluate(async () => {
                const auth = await import(
                    new URL('./auth.js', location.href).href
                );
                const refresh = auth.__test__.refreshSession();
                await auth.logoutAccess(false);
                await refresh.catch(() => {});
                return window.phiAccessAuth.getAccessToken();
            }),
        ).toBeNull();
        expect(
            await page.evaluate(
                async () => (await fetch('/api/coders')).status,
            ),
        ).toBe(401);
        await context.close();
    });

    test('a valid family refreshes without a new sign-in, then clearing the password disables auth', async ({
        browser,
    }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(phi.url);
        await unlock(page, PASSWORD);
        await expectSignedIn(page);

        // A live family renews repeatedly without prompting again.
        for (let cycle = 0; cycle < 2; cycle++) {
            await page.evaluate(async () => {
                const auth = await import(
                    new URL('./auth.js', location.href).href
                );
                await auth.__test__.refreshSession();
            });
            await expect(page.locator('.access-auth-overlay')).toHaveCount(0);
            expect(
                await page.evaluate(
                    async () => (await fetch('/api/coders')).status,
                ),
            ).toBe(200);
        }

        // Clearing the password turns enforcement off for the server, so the
        // next bootstrap drops the credential instead of renewing it.
        expect(
            await page.evaluate(async () => {
                const auth = await import(
                    new URL('./auth.js', location.href).href
                );
                return auth.clearAccessPassword();
            }),
        ).toEqual({ enabled: false });
        const status = (await (
            await fetch(`${phi.url}/api/auth/status`)
        ).json()) as { enabled: boolean };
        expect(status.enabled).toBe(false);
        await page.reload();
        await expectSignedIn(page);
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

test.describe('route-local CSRF and credential precedence', () => {
    let phi: PhiServer;
    let bundle: { refresh: string; asset: string; session: string };

    test.beforeAll(async () => {
        phi = await startPhi({ config: { sync_coordinator: '', peers: [] } });
        const res = await fetch(`${phi.url}/api/auth/v2/password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Phi-Auth': 'v2' },
            body: JSON.stringify({ password: PASSWORD }),
        });
        expect(res.status).toBe(200);
        const cookies = res.headers.getSetCookie().join(', ');
        const pick = (name: string) =>
            new RegExp(`${name}=([^;]+)`).exec(cookies)?.[1] ?? '';
        bundle = {
            refresh: pick('phi_access_refresh'),
            asset: pick('phi_access_asset'),
            session: await legacySessionCookie(phi.url, PASSWORD),
        };
        expect(bundle.refresh).toBeTruthy();
        expect(bundle.asset).toBeTruthy();
    });

    test.afterAll(async () => {
        await phi.stop();
    });

    test('rejects every v2 mutation without the route-local CSRF proof', async () => {
        const origin = new URL(phi.url).origin;
        const post = (headers: Record<string, string>) =>
            fetch(`${phi.url}/api/auth/v2/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...headers },
                body: JSON.stringify({ password: PASSWORD }),
            });

        // A missing or wrong proof header is refused outright.
        expect((await post({})).status).toBe(403);
        expect((await post({ 'X-Phi-Auth': 'v1' })).status).toBe(403);
        // A foreign or opaque origin is refused even with the proof header.
        expect(
            (await post({ 'X-Phi-Auth': 'v2', Origin: 'https://evil.example' }))
                .status,
        ).toBe(403);
        expect(
            (await post({ 'X-Phi-Auth': 'v2', Origin: 'null' })).status,
        ).toBe(403);
        // Cross-site fetch metadata is refused for the same reason.
        expect(
            (
                await post({
                    'X-Phi-Auth': 'v2',
                    'Sec-Fetch-Site': 'cross-site',
                })
            ).status,
        ).toBe(403);
        // The intended client passes: proof header, same origin, same-site.
        expect(
            (
                await post({
                    'X-Phi-Auth': 'v2',
                    Origin: origin,
                    'Sec-Fetch-Site': 'same-origin',
                })
            ).status,
        ).toBe(200);
    });

    test('a refresh or asset cookie never authorizes an API call or a socket', async ({
        browser,
    }) => {
        // The asset cookie is scoped to the asset routes, so it cannot
        // authenticate an ordinary API call.
        expect(
            (
                await fetch(`${phi.url}/api/config`, {
                    headers: { Cookie: `phi_access_asset=${bundle.asset}` },
                })
            ).status,
        ).toBe(401);
        // The refresh handle is scoped to its own route and authorizes nothing
        // else, including the mutation routes.
        expect(
            (
                await fetch(`${phi.url}/api/config`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Cookie: `phi_access_refresh=${bundle.refresh}`,
                    },
                    body: JSON.stringify({ sync_coordinator: '' }),
                })
            ).status,
        ).toBe(401);

        // The refresh handle still works on its own route: it is a scoped
        // credential, not a dead one. It simply carries no authority elsewhere.
        expect(
            (
                await fetch(`${phi.url}/api/auth/v2/refresh`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Phi-Auth': 'v2',
                        Cookie: `phi_access_refresh=${bundle.refresh}`,
                    },
                    body: '{}',
                })
            ).status,
        ).toBe(200);

        // A context holding only that path-scoped handle cannot open a socket:
        // the browser does not even send it to the socket path.
        const context = await browser.newContext();
        await context.addCookies([
            {
                name: 'phi_access_refresh',
                value: bundle.refresh,
                domain: new URL(phi.url).hostname,
                path: '/api/auth/v2/refresh',
                httpOnly: true,
            },
        ]);
        const page = await context.newPage();
        await page.goto(`${phi.url}/help.md`);
        expect(
            await page.evaluate(
                async () =>
                    new Promise<string>((resolve) => {
                        const ws = new WebSocket(
                            new URL('/ws/md-events', location.href).href,
                            'phi.events.protobuf.v1',
                        );
                        ws.onopen = () => {
                            ws.close();
                            resolve('open');
                        };
                        ws.onerror = () => resolve('error');
                        ws.onclose = (event) => resolve(`close:${event.code}`);
                        setTimeout(() => resolve('timeout'), 10_000);
                    }),
            ),
        ).not.toBe('open');
        await context.close();
    });

    test('renders without horizontal overflow on desktop and mobile', async ({
        browser,
    }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(phi.url);
        await unlock(page, PASSWORD);
        await expectSignedIn(page);
        for (const viewport of [
            { width: 1440, height: 900 },
            { width: 390, height: 844 },
        ]) {
            await page.setViewportSize(viewport);
            await expectSignedIn(page);
            expect(
                await page.evaluate(
                    () =>
                        document.documentElement.scrollWidth >
                        window.innerWidth,
                ),
                `${viewport.width}px`,
            ).toBe(false);
        }
        await context.close();
    });
});

// The repo's e2e rule also requires console errors and failed network requests
// to be checked, in both a desktop and an emulated mobile/touch context. The
// other groups assert behavior; this group asserts the session is quiet, so a
// regression that only surfaces as a console error or a failed request cannot
// pass unnoticed.
//
// Two expected messages are allowlisted, both by design rather than by defect:
//   - `401 POST /api/auth/v2/refresh` is the one speculative refresh the
//     selection table mandates for an unselected session; its 401 means "no
//     working refresh session", after which the client prompts.
//   - `503 GET /api/update/status` is the update checker being uninitialized in
//     an isolated fixture (api_update.go: `updateChecker == nil`), not an auth
//     path.
// Anything else in either list fails the test.
const EXPECTED_CONSOLE = [
    /^Failed to load resource: the server responded with a status of 401 \(Unauthorized\)$/,
    /^Failed to load resource: the server responded with a status of 503 \(Service Unavailable\)$/,
];
const EXPECTED_RESPONSES = [
    /\/api\/auth\/v2\/refresh$/,
    /\/api\/update\/status$/,
];

function monitorMvpPage(page: Page) {
    const unexpectedConsole: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];
    const unexpectedResponses: string[] = [];
    let restarting = false;

    page.on('console', (message) => {
        if (message.type() !== 'error') return;
        if (!EXPECTED_CONSOLE.some((pattern) => pattern.test(message.text()))) {
            unexpectedConsole.push(message.text());
        }
    });
    page.on('pageerror', (error) => pageErrors.push(error.name));
    page.on('requestfailed', (request) => {
        const pathname = new URL(request.url()).pathname;
        if (restarting && pathname.startsWith('/ws/')) return;
        failedRequests.push(`${request.method()} ${pathname}`);
    });
    page.on('response', (response) => {
        if (response.status() < 400) return;
        const request = response.request();
        const url = new URL(response.url());
        const method = request.method();
        if (
            (response.status() === 401 &&
                method === 'POST' &&
                url.pathname === '/api/auth/v2/refresh') ||
            (response.status() === 401 &&
                method === 'GET' &&
                url.pathname === '/api/coders') ||
            EXPECTED_RESPONSES.some((pattern) =>
                pattern.test(url.pathname + url.search),
            )
        ) {
            return;
        }
        unexpectedResponses.push(
            `${response.status()} ${method} ${url.pathname}`,
        );
    });

    return {
        setRestarting(value: boolean) {
            restarting = value;
        },
        assertQuiet() {
            expect({
                console: unexpectedConsole,
                pageErrors,
                failedRequests,
                responses: unexpectedResponses,
            }).toEqual({
                console: [],
                pageErrors: [],
                failedRequests: [],
                responses: [],
            });
        },
    };
}

test.describe('a signed-in session stays quiet', () => {
    let phi: PhiServer;

    test.beforeAll(async () => {
        // The isolated auth diagnostic does not install OpenCode 2. Select the
        // legacy adapter so the sessions panel returns its normal empty list.
        phi = await startPhi({
            config: {
                sync_coordinator: '',
                peers: [],
                opencode_legacy: true,
            },
        });
        await lockServer(phi.url, PASSWORD);
    });

    test.afterAll(async () => {
        await phi.stop();
    });

    for (const profile of [
        {
            name: 'desktop',
            options: { viewport: { width: 1440, height: 900 } },
        },
        {
            name: 'mobile touch',
            options: {
                viewport: { width: 390, height: 844 },
                isMobile: true,
                hasTouch: true,
                deviceScaleFactor: 3,
            },
        },
    ]) {
        test(`${profile.name}: sign-in and reload raise no unexpected errors`, async ({
            browser,
        }) => {
            const context = await browser.newContext(profile.options);
            const page = await context.newPage();
            const unexpectedConsole: string[] = [];
            const pageErrors: string[] = [];
            const failedRequests: string[] = [];
            const authFailures: string[] = [];
            const refreshStatuses: number[] = [];
            const unexpectedResponses: string[] = [];
            let authenticated = false;
            let watchingReloadRefresh = false;
            page.on('console', (message) => {
                if (message.type() !== 'error') return;
                const text = message.text();
                if (EXPECTED_CONSOLE.some((pattern) => pattern.test(text)))
                    return;
                unexpectedConsole.push(text);
            });
            page.on('pageerror', (error) => pageErrors.push(error.message));
            page.on('requestfailed', (request) =>
                failedRequests.push(
                    `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`,
                ),
            );
            page.on('response', (response) => {
                const url = response.url();
                if (
                    watchingReloadRefresh &&
                    url.includes('/api/auth/v2/refresh')
                ) {
                    refreshStatuses.push(response.status());
                }
                if (response.status() < 400) return;
                if (authenticated && url.includes('/api/auth/')) {
                    authFailures.push(
                        `${response.status()} ${response.request().method()} ${url}`,
                    );
                }
                if (EXPECTED_RESPONSES.some((pattern) => pattern.test(url)))
                    return;
                unexpectedResponses.push(
                    `${response.status()} ${response.request().method()} ${url}`,
                );
            });

            await page.goto(phi.url);
            await unlock(page, PASSWORD);
            authenticated = true;
            await expectSignedIn(page);

            // Reload forces the HttpOnly refresh flow; the event and control
            // sockets then prove the refreshed bearer reaches both protocols.
            watchingReloadRefresh = true;
            await page.reload();
            await expectSignedIn(page);
            await expect.poll(() => refreshStatuses).toContain(200);
            expect(await openSocket(page, '/ws/md-events', EVENTS)).toBe(
                'open',
            );
            expect(await openSocket(page, '/ws/control', CONTROL)).toBe('open');
            expect(
                await page.evaluate(
                    () =>
                        document.documentElement.scrollWidth >
                        window.innerWidth,
                ),
                `${profile.name} horizontal overflow`,
            ).toBe(false);

            expect(unexpectedConsole, 'unexpected console errors').toEqual([]);
            expect(pageErrors, 'page errors').toEqual([]);
            expect(failedRequests, 'failed requests').toEqual([]);
            expect(authFailures, 'failed authenticated auth requests').toEqual(
                [],
            );
            expect(unexpectedResponses, 'unexpected bad responses').toEqual([]);
            await context.close();
        });
    }
});

declare global {
    interface Window {
        phiAccessAuth: {
            webSocketURL: (url: URL | string) => URL;
            getAccessToken: () => string | null;
            installToken: (token: string) => boolean;
            refreshAccessIfDue: () => Promise<unknown>;
        };
    }
}
