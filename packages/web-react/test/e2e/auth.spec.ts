import { hostname } from 'node:os';
import { authTest as test, expect, type ForwardedRequest } from './fixtures.ts';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const serverHostname = () => hostname().toUpperCase();
const loginPosts = (guard: { forwarded: ForwardedRequest[] }) =>
    guard.forwarded.filter(
        ({ route }) =>
            route.startsWith('POST ') && route.endsWith('/api/auth/v2/login'),
    );
const gets = (guard: { forwarded: ForwardedRequest[] }, path: string) =>
    guard.forwarded.filter(
        ({ route }) => route.startsWith('GET ') && route.endsWith(path),
    );

test('M1: real sign-in shows the server hostname from an authorized read', async ({
    page,
    context,
    authStack,
    guard,
}, info) => {
    await authStack.setPassword(`m1-signin-${info.project.name}-secret`);
    await page.goto(authStack.reactUrl);
    await expect(
        page.getByRole('heading', { name: 'Sign in to Phi' }),
    ).toBeVisible();
    await page
        .getByLabel('Password')
        .fill(`m1-signin-${info.project.name}-secret`);
    await page.screenshot({ path: info.outputPath('login.png') });
    await page.getByLabel('Password').press('Enter');
    await expect(page.getByRole('status')).toHaveText('Connected.');
    await expect(page.getByText(serverHostname())).toBeVisible();
    await page.screenshot({ path: info.outputPath('ready.png') });
    expect(page.url()).toBe(`${authStack.reactUrl}/`);
    const posts = loginPosts(guard);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.authorization).toBe(false);
    const configs = gets(guard, '/api/config');
    expect(configs.length).toBeGreaterThanOrEqual(1);
    for (const config of configs) {
        expect(config.authorization).toBe(true);
        expect(config.cookie).toBe(false);
    }
    const refresh = (await context.cookies()).find(
        (cookie) => cookie.name === 'phi_access_refresh',
    );
    expect(refresh?.httpOnly).toBe(true);
    expect(refresh?.path).toBe('/api/auth/v2/refresh');
    await expect(page.getByLabel('Password')).toHaveCount(0);
});

test('M1: wrong password retains input and checks status once', async ({
    page,
    authStack,
    guard,
}) => {
    await authStack.setPassword('m1-wrong-password-secret');
    await page.goto(authStack.reactUrl);
    const field = page.getByLabel('Password');
    await field.fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('Wrong password');
    await expect(field).toHaveValue('wrong-password');
    expect(loginPosts(guard)).toHaveLength(1);
    // Exactly one public-status recheck follows the 401; the Strict Mode
    // remount may send one extra initial check before the login.
    const routes = guard.forwarded.map((entry) => entry.route);
    const loginIndex = routes.findIndex(
        (route) =>
            route.startsWith('POST ') && route.endsWith('/api/auth/v2/login'),
    );
    const rechecks = routes
        .slice(loginIndex + 1)
        .filter(
            (route) =>
                route.startsWith('GET ') &&
                route.endsWith('/api/auth/v2/status'),
        );
    expect(loginIndex).toBeGreaterThanOrEqual(0);
    expect(rechecks).toHaveLength(1);
});

test('M1: owned/disabled server reads its hostname without credentials', async ({
    page,
    authStack,
    guard,
}, info) => {
    await page.goto(authStack.reactUrl);
    await expect(page.getByRole('status')).toHaveText(
        'Connected. Password protection is disabled.',
    );
    await expect(page.getByText(serverHostname())).toBeVisible();
    await page.screenshot({ path: info.outputPath('disabled.png') });
    expect(loginPosts(guard)).toHaveLength(0);
    const configs = gets(guard, '/api/config');
    expect(configs.length).toBeGreaterThanOrEqual(1);
    for (const config of configs) {
        expect(config.authorization).toBe(false);
        expect(config.cookie).toBe(false);
    }
});

test('M1: unsupported server offers no login', async ({
    page,
    authStack,
    authStatusMock,
    guard,
}) => {
    authStatusMock.reply = { status: 404, raw: 'gone' };
    await page.goto(authStack.reactUrl);
    await expect(page.getByRole('status')).toHaveText(
        'This server does not support v2 authentication.',
    );
    await expect(page.getByLabel('Password')).toHaveCount(0);
    expect(loginPosts(guard)).toHaveLength(0);
});

test('M1: slow submit sends one login and keeps the field editable', async ({
    page,
    authStack,
    authFaults,
    guard,
}) => {
    await authStack.setPassword('m1-slow-submit-secret');
    let release = () => {};
    authFaults.loginGate = new Promise<void>((done) => {
        release = done;
    });
    try {
        await page.goto(authStack.reactUrl);
        const field = page.getByLabel('Password');
        await field.fill('m1-slow-submit-secret');
        await page
            .getByRole('button', { name: 'Sign in', exact: true })
            .click();
        await expect(
            page.getByRole('button', { name: 'Signing in…' }),
        ).toBeDisabled();
        await expect(field).toBeEditable();
        await field.press('Enter');
        await expect(
            page.getByRole('button', { name: 'Signing in…' }),
        ).toBeDisabled();
        release();
        await expect(page.getByRole('status')).toHaveText('Connected.');
        await expect(page.getByText(serverHostname())).toBeVisible();
        expect(loginPosts(guard)).toHaveLength(1);
    } finally {
        release();
    }
});

test('M1: short password is rejected locally without a login request', async ({
    page,
    authStack,
    guard,
}) => {
    await authStack.setPassword('m1-short-password-secret');
    await page.goto(authStack.reactUrl);
    await page.getByLabel('Password').fill('short');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(
        'Password must be 8 to 1024 bytes.',
    );
    expect(loginPosts(guard)).toHaveLength(0);
});

const refreshPosts = (guard: { forwarded: ForwardedRequest[] }) =>
    guard.forwarded.filter(
        ({ route }) =>
            route.startsWith('POST ') && route.endsWith('/api/auth/v2/refresh'),
    );

test('M2: reload restores the session without a password', async ({
    page,
    context,
    authStack,
    guard,
}, info) => {
    await authStack.setPassword(`m2-reload-${info.project.name}-secret`);
    await page.goto(authStack.reactUrl);
    await page
        .getByLabel('Password')
        .fill(`m2-reload-${info.project.name}-secret`);
    await page.getByLabel('Password').press('Enter');
    await expect(page.getByRole('status')).toHaveText('Connected.');
    await expect(page.getByText(serverHostname())).toBeVisible();
    expect(loginPosts(guard)).toHaveLength(1);
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('Connected.');
    await expect(page.getByText(serverHostname())).toBeVisible();
    await page.screenshot({ path: info.outputPath('restored.png') });
    expect(loginPosts(guard)).toHaveLength(1);
    expect(refreshPosts(guard).length).toBeGreaterThanOrEqual(1);
    const refresh = (await context.cookies()).find(
        (cookie) => cookie.name === 'phi_access_refresh',
    );
    expect(refresh?.httpOnly).toBe(true);
    expect(refresh?.path).toBe('/api/auth/v2/refresh');
    await expect(page.getByLabel('Password')).toHaveCount(0);
});

test('M2: password rotation revokes the session and returns to Login', async ({
    page,
    authStack,
    guard,
}, info) => {
    await authStack.setPassword(`m2-first-${info.project.name}-secret`);
    await page.goto(authStack.reactUrl);
    await page
        .getByLabel('Password')
        .fill(`m2-first-${info.project.name}-secret`);
    await page.getByLabel('Password').press('Enter');
    await expect(page.getByRole('status')).toHaveText('Connected.');
    await authStack.setPassword(`m2-second-${info.project.name}-secret`);
    await page.reload();
    await expect(
        page.getByRole('heading', { name: 'Sign in to Phi' }),
    ).toBeVisible();
    expect(refreshPosts(guard).length).toBeGreaterThanOrEqual(1);
    await page
        .getByLabel('Password')
        .fill(`m2-second-${info.project.name}-secret`);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Connected.');
    await expect(page.getByText(serverHostname())).toBeVisible();
    expect(loginPosts(guard)).toHaveLength(2);
});

test('M2: a second tab restores through the shared session', async ({
    page,
    context,
    authStack,
    guard,
}) => {
    await authStack.setPassword('m2-second-tab-secret');
    await page.goto(authStack.reactUrl);
    await page.getByLabel('Password').fill('m2-second-tab-secret');
    await page.getByLabel('Password').press('Enter');
    await expect(page.getByRole('status')).toHaveText('Connected.');
    const second = await context.newPage();
    try {
        await second.goto(authStack.reactUrl);
        await expect(second.getByRole('status')).toHaveText('Connected.');
        await expect(second.getByText(serverHostname())).toBeVisible();
        await expect(second.getByLabel('Password')).toHaveCount(0);
        await expect(page.getByRole('status')).toHaveText('Connected.');
        expect(loginPosts(guard)).toHaveLength(1);
        expect(refreshPosts(guard).length).toBeGreaterThanOrEqual(1);
    } finally {
        await second.close();
    }
});

test('M2: sign-in without a stored refresh cookie cannot restore after reload', async ({
    page,
    context,
    authStack,
    authFaults,
    guard,
}) => {
    authFaults.stripSetCookie = true;
    await authStack.setPassword('m2-no-cookie-secret');
    await page.goto(authStack.reactUrl);
    await page.getByLabel('Password').fill('m2-no-cookie-secret');
    await page.getByLabel('Password').press('Enter');
    await expect(page.getByRole('status')).toHaveText('Connected.');
    expect(
        (await context.cookies()).some(
            (cookie) => cookie.name === 'phi_access_refresh',
        ),
    ).toBe(false);
    await page.reload();
    await expect(
        page.getByRole('heading', { name: 'Sign in to Phi' }),
    ).toBeVisible();
    expect(loginPosts(guard)).toHaveLength(1);
    expect(refreshPosts(guard).length).toBeGreaterThanOrEqual(1);
});

test('M2: storage denial signs in for this visit only', async ({
    page,
    context,
    authStack,
    guard,
}) => {
    await context.addInitScript(() => {
        const denied = () => {
            throw new Error('storage denied for this visit');
        };
        Object.defineProperty(window, 'localStorage', {
            value: {
                getItem: denied,
                setItem: denied,
                removeItem: denied,
                clear: denied,
                key: denied,
                length: 0,
            },
            configurable: true,
        });
    });
    await authStack.setPassword('m2-denied-storage-secret');
    await page.goto(authStack.reactUrl);
    await expect(page.getByRole('alert')).toHaveText(
        'This browser blocks storage, so sign-in lasts for this visit only.',
    );
    await page.getByLabel('Password').fill('m2-denied-storage-secret');
    await page.getByLabel('Password').press('Enter');
    await expect(page.getByRole('status')).toHaveText('Connected.');
    await expect(
        page.getByText(
            'This browser blocks storage, so sign-in lasts for this visit only.',
        ),
    ).toBeVisible();
    await page.reload();
    await expect(
        page.getByRole('heading', { name: 'Sign in to Phi' }),
    ).toBeVisible();
    expect(refreshPosts(guard)).toHaveLength(0);
    expect(loginPosts(guard)).toHaveLength(1);
});
