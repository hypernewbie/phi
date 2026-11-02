import { hostname } from 'node:os';
import type { Page } from '@playwright/test';
import { authTest as test, expect, type ForwardedRequest } from './fixtures.ts';
import type { FoundationStack } from './phi-server.ts';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const serverHostname = () => hostname().toUpperCase();

async function login(page: Page, authStack: FoundationStack, secret: string) {
    await authStack.setPassword(secret);
    await page.goto(authStack.reactUrl);
    await page.getByLabel('Password').fill(secret);
    await page.getByLabel('Password').press('Enter');
    await expect(page.getByRole('status')).toHaveText('Connected.');
}

const gets = (guard: { forwarded: ForwardedRequest[] }, path: string) =>
    guard.forwarded.filter(
        ({ route }) => route.startsWith('GET ') && route.endsWith(path),
    );

test('M1: settings shows About from an authorized config read', async ({
    page,
    authStack,
    guard,
}) => {
    await login(page, authStack, 'm1-settings-about-secret');
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByText(`Hostname: ${serverHostname()}`)).toBeVisible();
    await expect(page.getByText(/Workspaces: \d+/)).toBeVisible();
    const configs = gets(guard, '/api/config');
    expect(configs.length).toBeGreaterThanOrEqual(1);
    for (const config of configs) {
        expect(config.authorization).toBe(true);
        expect(config.cookie).toBe(false);
    }
    const versions = gets(guard, '/api/version');
    expect(versions.length).toBeGreaterThanOrEqual(1);
    for (const version of versions) {
        expect(version.authorization).toBe(true);
        expect(version.cookie).toBe(false);
    }
});

test('M1: failed refresh keeps cached About with a stale note', async ({
    page,
    authStack,
    authFaults,
}) => {
    await login(page, authStack, 'm1-settings-stale-secret');
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByText(`Hostname: ${serverHostname()}`)).toBeVisible();
    authFaults.offline = true;
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(
        page.getByText('Showing saved settings. Retry to refresh.'),
    ).toBeVisible();
    await expect(page.getByText(`Hostname: ${serverHostname()}`)).toBeVisible();
    authFaults.offline = false;
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(
        page.getByText('Showing saved settings. Retry to refresh.'),
    ).toHaveCount(0);
});

test('M2: toggling pi-offline persists across reload', async ({
    page,
    authStack,
}) => {
    await login(page, authStack, 'm2-settings-toggle-secret');
    await page.getByRole('button', { name: 'Settings' }).click();
    const toggle = page.getByLabel('Start pi with --offline (new tabs only)');
    await expect(toggle).toBeEnabled();
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(toggle).toBeChecked();
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('Connected.');
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(
        page.getByLabel('Start pi with --offline (new tabs only)'),
    ).toBeChecked();
    await page.getByLabel('Start pi with --offline (new tabs only)').uncheck();
});

test('M2: offline save keeps the optimistic state', async ({
    page,
    authStack,
    authFaults,
}) => {
    await login(page, authStack, 'm2-settings-offline-secret');
    await page.getByRole('button', { name: 'Settings' }).click();
    const toggle = page.getByLabel(
        'Harmonise Agy terminal colours with active Phi theme',
    );
    await expect(toggle).toBeEnabled();
    authFaults.offline = true;
    await toggle.check();
    await expect(toggle).toBeChecked();
    authFaults.offline = false;
});

test('M2: behavior controls stay disabled until the config loads', async ({
    page,
    authStack,
    configMock,
}) => {
    await login(page, authStack, 'm2-settings-gated-secret');
    let release = () => {};
    configMock.reply = {
        body: {
            hostname: 'DELAYED',
            workspaces: [],
            use_hidden_terminal: false,
            use_existing_terminal_tab: false,
            auto_reconnect: 'off',
            fast_mode: false,
            pi_offline: true,
            pi_bridge_no_inject: false,
            claude_dangerously_skip_permissions: false,
            agy_theme_ansi: false,
            opencode_idle_stop_minutes: 15,
        },
        wait: new Promise<void>((done) => {
            release = done;
        }),
    };
    try {
        await page.getByRole('button', { name: 'Settings' }).click();
        const toggle = page.getByLabel(
            'Start pi with --offline (new tabs only)',
        );
        await expect(toggle).toBeDisabled();
        release();
        await expect(toggle).toBeEnabled();
        await expect(toggle).toBeChecked();
        await expect(
            page.getByLabel(
                'Auto-reconnect disconnected terminals (all tabs when visible)',
            ),
        ).not.toBeChecked();
    } finally {
        release();
    }
});

test('M1: settings nav is disabled before sign-in', async ({
    page,
    authStack,
}) => {
    await authStack.setPassword('m1-settings-gated-secret');
    await page.goto(authStack.reactUrl);
    await expect(
        page.getByRole('heading', { name: 'Sign in to Phi' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Settings' })).toBeDisabled();
});
