import { hostname } from 'node:os';
import { authTest as test, expect, type ForwardedRequest } from './fixtures.ts';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const serverHostname = () => hostname().toUpperCase();
const loginPosts = (guard: { forwarded: ForwardedRequest[] }) =>
    guard.forwarded.filter(
        ({ route }) =>
            route.startsWith('POST ') && route.endsWith('/api/auth/v2/login'),
    );
const refreshPosts = (guard: { forwarded: ForwardedRequest[] }) =>
    guard.forwarded.filter(
        ({ route }) =>
            route.startsWith('POST ') && route.endsWith('/api/auth/v2/refresh'),
    );

test('M3: delayed sign-in keeps the field editable and sends once', async ({
    page,
    authStack,
    authFaults,
    guard,
}) => {
    await authStack.setPassword('m3-delayed-secret');
    await page.clock.install();
    let release!: () => void;
    authFaults.loginGate = new Promise<void>((resolve) => {
        release = resolve;
    });
    try {
        await page.goto(authStack.reactUrl);
        await page.getByLabel('Password').fill('m3-delayed-secret');
        await page
            .getByRole('button', { name: 'Sign in', exact: true })
            .click();
        await page.clock.fastForward(8_000);
        await expect(
            page.getByRole('button', { name: 'Signing in…' }),
        ).toBeVisible();
        expect(loginPosts(guard)).toHaveLength(0);
        await page.getByLabel('Password').fill('m3-delayed-edited');
        release();
        await expect(page.getByRole('status')).toHaveText('Connected.');
        await expect(page.getByText(serverHostname())).toBeVisible();
        expect(loginPosts(guard)).toHaveLength(1);
    } finally {
        release();
    }
});

test('M3: login held past 15 seconds is unconfirmed without a second send', async ({
    page,
    authStack,
    authFaults,
    guard,
}) => {
    await authStack.setPassword('m3-held-login-secret');
    await page.clock.install();
    let release!: () => void;
    authFaults.loginGate = new Promise<void>((resolve) => {
        release = resolve;
    });
    try {
        await page.goto(authStack.reactUrl);
        await page.getByLabel('Password').fill('m3-held-login-secret');
        await page
            .getByRole('button', { name: 'Sign in', exact: true })
            .click();
        await expect(
            page.getByRole('button', { name: 'Signing in…' }),
        ).toBeVisible();
        await page.clock.fastForward(16_000);
        await expect(page.getByRole('alert')).toHaveText(
            'Sign-in was not confirmed. Try again.',
        );
        expect(loginPosts(guard)).toHaveLength(0);
        release();
        await page.clock.fastForward(1_000);
        await expect(
            page.getByRole('heading', { name: 'Sign in to Phi' }),
        ).toBeVisible();
        // The late response may or may not reach the server through the
        // aborted route, but the app never sends again.
        expect(loginPosts(guard).length).toBeLessThanOrEqual(1);
        await page.reload();
        await expect(
            page.getByRole('heading', { name: 'Sign in to Phi' }),
        ).toBeVisible();
    } finally {
        release();
    }
});

test('M3: offline renewal waits and recovers on return', async ({
    page,
    context,
    authStack,
    authFaults,
    guard,
}, info) => {
    await authStack.setPassword('m3-offline-renewal-secret');
    await page.clock.install();
    await page.goto(authStack.reactUrl);
    await page.getByLabel('Password').fill('m3-offline-renewal-secret');
    await page.getByLabel('Password').press('Enter');
    await expect(page.getByRole('status')).toHaveText('Connected.');
    await expect(page.getByText(serverHostname())).toBeVisible();
    expect(refreshPosts(guard)).toHaveLength(0);
    await context.setOffline(true);
    authFaults.offline = true;
    await page.clock.fastForward(3_540_000);
    await expect(
        page.getByText('Showing the last known server. Retry to refresh.'),
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath('stale.png') });
    const forwardedWhileOnline = guard.forwarded.length;
    await page.clock.fastForward(60_000);
    expect(guard.forwarded).toHaveLength(forwardedWhileOnline);
    await context.setOffline(false);
    authFaults.offline = false;
    await page.clock.fastForward(40_000);
    // Eventual recovery: under parallel-suite load a slow exchange can
    // cost one backoff cycle before the fresh read lands.
    await expect(
        page.getByText('Showing the last known server. Retry to refresh.'),
    ).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByRole('status')).toHaveText('Connected.');
    await expect(page.getByText(serverHostname())).toBeVisible();
    expect(refreshPosts(guard).length).toBeGreaterThanOrEqual(1);
});

test('M3: login 503 with a long Retry-After cools down without resending', async ({
    page,
    authStack,
    authFaults,
    guard,
}) => {
    await authStack.setPassword('m3-long-wait-secret');
    await page.clock.install();
    authFaults.loginFault = { status: 503, retryAfter: '600' };
    await page.goto(authStack.reactUrl);
    await page.getByLabel('Password').fill('m3-long-wait-secret');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(
        'Too many attempts. Wait and try again.',
    );
    const submit = page.getByRole('button', { name: 'Sign in', exact: true });
    await expect(submit).toBeDisabled();
    expect(loginPosts(guard)).toHaveLength(0);
    await page.clock.fastForward(599_000);
    await expect(submit).toBeDisabled();
    expect(loginPosts(guard)).toHaveLength(0);
    authFaults.loginFault = undefined;
    await page.clock.fastForward(1_000);
    await expect(submit).toBeEnabled();
    await page.getByLabel('Password').fill('m3-long-wait-secret');
    await submit.click();
    await expect(page.getByRole('status')).toHaveText('Connected.');
    expect(loginPosts(guard)).toHaveLength(1);
});

test('M3: protected-read 403 keeps the session without logging out', async ({
    page,
    authStack,
    configMock,
    guard,
}) => {
    void guard;
    await authStack.setPassword('m3-read-403-secret');
    await page.goto(authStack.reactUrl);
    await page.getByLabel('Password').fill('m3-read-403-secret');
    await page.getByLabel('Password').press('Enter');
    await expect(page.getByRole('status')).toHaveText('Connected.');
    configMock.reply = { status: 403, body: {} };
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(
        page.getByText('Showing the last known server. Retry to refresh.'),
    ).toBeVisible();
    await expect(page.getByRole('status')).toHaveText('Connected.');
    await expect(
        page.getByRole('heading', { name: 'Sign in to Phi' }),
    ).toHaveCount(0);
    configMock.reply = undefined;
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(
        page.getByText('Showing the last known server. Retry to refresh.'),
    ).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveText('Connected.');
    await expect(page.getByText(serverHostname())).toBeVisible();
});
