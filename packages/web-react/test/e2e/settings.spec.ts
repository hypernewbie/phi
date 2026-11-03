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
    await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Retry' })
        .click();
    await expect(
        page.getByText('Showing saved settings. Retry to refresh.'),
    ).toBeVisible();
    await expect(page.getByText(`Hostname: ${serverHostname()}`)).toBeVisible();
    authFaults.offline = false;
    await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Retry' })
        .click();
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

test('full-M1: settings opens as a modal with trap and Escape', async ({
    page,
    authStack,
}) => {
    await login(page, authStack, 'full-m1-modal-secret');
    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    for (let i = 0; i < 40; i++) await page.keyboard.press('Tab');
    expect(
        await page.evaluate(() => {
            const modal = document.querySelector('[role="dialog"]');
            return modal?.contains(document.activeElement) ?? false;
        }),
    ).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Settings' })).toBeFocused();
});

test('full-M1: behavior broadcasts carry the sync owner', async ({
    page,
    authStack,
}) => {
    await page.addInitScript(() => {
        const log: Array<unknown> = [];
        (window as unknown as Record<string, unknown>).__syncLog = log;
        const channel = new BroadcastChannel('phi_config_sync');
        channel.onmessage = (event) => {
            log.push(event.data);
        };
    });
    await login(page, authStack, 'full-m1-owner-secret');
    await page.getByRole('button', { name: 'Settings' }).click();
    const toggle = page.getByLabel('Use separate hidden terminal for commands');
    await expect(toggle).toBeEnabled();
    await toggle.check();
    const origin = new URL(authStack.reactUrl).origin;
    await expect
        .poll(async () =>
            page.evaluate(
                () =>
                    (window as unknown as Record<string, Array<unknown>>)
                        .__syncLog,
            ),
        )
        .toContainEqual({
            type: 'behavior',
            owner: JSON.stringify([origin, '', origin]),
        });
    await toggle.uncheck();
});

test('full-M1: hostname label persists through the appearance mirror', async ({
    page,
    authStack,
    guard,
}) => {
    await login(page, authStack, 'full-m1-hostname-secret');
    await page.getByRole('button', { name: 'Settings' }).click();
    const input = page.getByLabel(/Hostname label/);
    await expect(input).toBeEnabled();
    await input.fill('europa');
    await expect
        .poll(
            () =>
                guard.forwarded.filter(
                    ({ route }) =>
                        route.startsWith('POST ') &&
                        route.endsWith('/api/config/appearance'),
                ).length,
        )
        .toBeGreaterThanOrEqual(1);
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('Connected.');
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByLabel(/Hostname label/)).toHaveValue('europa');
    await page.getByLabel(/Hostname label/).fill('');
});

test('full-M2: appearance edits land in the legacy local key with the owner', async ({
    page,
    authStack,
}) => {
    await page.addInitScript(() => {
        const log: Array<unknown> = [];
        (window as unknown as Record<string, unknown>).__syncLog = log;
        const channel = new BroadcastChannel('phi_config_sync');
        channel.onmessage = (event) => {
            log.push(event.data);
        };
    });
    await login(page, authStack, 'full-m2-appearance-secret');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.locator('#settings-ui-font').selectOption('Inter');
    await page.locator('#settings-ui-font-size').fill('18');
    const stored = await page.evaluate(() =>
        JSON.parse(window.localStorage.getItem('phi_appearance') ?? ''),
    );
    expect(stored).toMatchObject({
        ui_font_family: 'Inter, system-ui, sans-serif',
        ui_font_size: 18,
    });
    const origin = new URL(authStack.reactUrl).origin;
    await expect
        .poll(async () =>
            page.evaluate(
                () =>
                    (window as unknown as Record<string, Array<unknown>>)
                        .__syncLog,
            ),
        )
        .toContainEqual({
            type: 'appearance',
            owner: JSON.stringify([origin, '', origin]),
        });
    await page.getByRole('button', { name: 'Reset appearance' }).click();
});

test('full-M2: swatch saves the theme and applies it locally', async ({
    page,
    authStack,
    guard,
}) => {
    await login(page, authStack, 'full-m2-theme-secret');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('radio', { name: 'teal' }).click();
    await expect
        .poll(
            () =>
                guard.forwarded.filter(
                    ({ route }) =>
                        route.startsWith('POST ') &&
                        route.endsWith('/api/config/theme'),
                ).length,
        )
        .toBeGreaterThanOrEqual(1);
    await expect(page.getByRole('radio', { name: 'teal' })).toBeChecked();
    expect(
        await page.evaluate(() =>
            document.documentElement.getAttribute('data-theme-color'),
        ),
    ).toBe('teal');
    expect(
        await page.evaluate(() =>
            window.localStorage.getItem('phi_theme_color'),
        ),
    ).toBe('teal');
    await page.getByRole('radio', { name: 'purple' }).click();
});

test('full-M2: reset posts font zeros and keeps the hostname label', async ({
    page,
    authStack,
    guard,
}) => {
    await login(page, authStack, 'full-m2-reset-secret');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.locator('#settings-term-font-size').fill('20');
    await page.getByLabel(/Hostname label/).fill('reset-kept');
    await page.getByRole('button', { name: 'Reset appearance' }).click();
    await expect(page.locator('#settings-term-font-size')).toHaveValue('14');
    await expect(page.getByLabel(/Hostname label/)).toHaveValue('reset-kept');
    const zeros = JSON.stringify({
        ui_font_family: '',
        ui_font_size: 0,
        terminal_font_family: '',
        terminal_font_size: 0,
    });
    await expect
        .poll(() =>
            guard.forwarded
                .filter(
                    ({ route }) =>
                        route.startsWith('POST ') &&
                        route.endsWith('/api/config/appearance'),
                )
                .map(({ body }) => body),
        )
        .toContainEqual(zeros);
    await page.getByLabel(/Hostname label/).fill('');
});

test('full-M3: password set rotates the session and clear disables protection', async ({
    page,
    authStack,
    guard,
}) => {
    await login(page, authStack, 'full-m3-first-secret');
    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    // Local rules first: a blank submit never reaches the network.
    await dialog.getByRole('button', { name: 'Update password' }).click();
    await expect(dialog.getByRole('alert')).toHaveText(
        'At least 8 characters.',
    );
    const passwords = () =>
        guard.forwarded.filter(({ route }) =>
            route.endsWith('/api/auth/v2/password'),
        );
    expect(passwords()).toHaveLength(0);
    // Rotate to a new secret: the adopted bundle keeps the session alive.
    await page.locator('#settings-access-new').fill('full-m3-second-secret');
    await page
        .locator('#settings-access-confirm')
        .fill('full-m3-second-secret');
    await dialog.getByRole('button', { name: 'Update password' }).click();
    await expect(dialog.getByText('Password updated')).toBeVisible();
    await expect.poll(() => passwords().length).toBeGreaterThanOrEqual(1);
    for (const post of passwords()) expect(post.authorization).toBe(true);
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('Connected.');
    // Remove the password behind two distinct clicks.
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(dialog.getByText('Enabled')).toBeVisible();
    await dialog.getByRole('button', { name: 'Remove password' }).click();
    await dialog.getByRole('button', { name: 'Confirm remove' }).click();
    await expect(dialog.getByText('Password removed')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('status')).toHaveText(
        'Connected. Password protection is disabled.',
    );
});

test('full-M4: mobile size edit saves bearer-authed and restores across reload', async ({
    page,
    authStack,
    guard,
}) => {
    await login(page, authStack, 'full-m4-mobile-secret');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.locator('#settings-mobile-view').click();
    await page.locator('#settings-mobile-ui-font-size').fill('19');
    const posts = () =>
        guard.forwarded.filter(
            ({ route }) =>
                route.startsWith('POST ') &&
                route.endsWith('/api/config/mobile-appearance'),
        );
    await expect.poll(() => posts().length).toBeGreaterThanOrEqual(1);
    const last = posts().at(-1);
    if (!last) throw new Error('mobile save never reached the server');
    expect(last.authorization).toBe(true);
    expect(last.cookie).toBe(false);
    expect(JSON.parse(last.body ?? '')).toEqual({
        revision: expect.any(Number),
        fields: { ui_font_size: 19 },
    });
    await expect(page.locator('#settings-mobile-status')).toHaveText('Saved');
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('Connected.');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.locator('#settings-mobile-view').click();
    await expect(page.locator('#settings-mobile-ui-font-size')).toHaveValue(
        '19',
    );
});

test('full-M4: page switch moves the scrollback row', async ({
    page,
    authStack,
}) => {
    await login(page, authStack, 'full-m4-page-secret');
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.locator('#settings-ui-font')).toBeVisible();
    await expect(page.locator('#settings-mobile-scrollback')).toHaveCount(1);
    await page.locator('#settings-mobile-view').click();
    await expect(page.locator('#settings-mobile-appearance')).toBeVisible();
    await expect(page.locator('#settings-mobile-scrollback')).toHaveCount(1);
    await expect(page.locator('#settings-ui-font')).toHaveCount(0);
    await expect(page.getByText('Shared appearance')).toBeVisible();
    await page.locator('#settings-desktop-view').click();
    await expect(page.locator('#settings-ui-font')).toBeVisible();
    await expect(page.locator('#settings-mobile-scrollback')).toHaveCount(1);
});

test('full-M4: invalid mobile size blocks the save', async ({
    page,
    authStack,
    guard,
}) => {
    await login(page, authStack, 'full-m4-invalid-secret');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.locator('#settings-mobile-view').click();
    const input = page.locator('#settings-mobile-ui-font-size');
    await expect(input).toBeVisible();
    await input.fill('99');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#settings-mobile-status')).toHaveText(
        'Enter a whole number in the allowed range.',
    );
    // Past the 300 ms debounce: the invalid edit must never dispatch.
    await page.waitForTimeout(600);
    expect(
        guard.forwarded.filter(
            ({ route }) =>
                route.startsWith('POST ') &&
                route.endsWith('/api/config/mobile-appearance'),
        ),
    ).toHaveLength(0);
});

test('full-M4: offline mobile edits are retained as drafts across reload', async ({
    page,
    authStack,
    authFaults,
}) => {
    const secret = 'full-m4-draft-secret';
    await login(page, authStack, secret);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.locator('#settings-mobile-view').click();
    await expect(page.locator('#settings-mobile-status')).toHaveText('Saved');
    authFaults.offline = true;
    await page.locator('#settings-mobile-ui-font-size').fill('21');
    await expect(page.locator('#settings-mobile-status')).toHaveText(
        'Pending changes',
    );
    // Reload offline so the debounced flush can never consume the draft;
    // the retained IndexedDB draft survives the fresh store.
    await page.reload();
    authFaults.offline = false;
    await page.waitForFunction(
        () =>
            document.body.textContent?.includes('Connected.') === true ||
            document.querySelector('input[type="password"]') !== null,
    );
    const password = page.getByLabel('Password');
    if ((await password.count()) > 0) {
        try {
            await password.fill(secret, { timeout: 3000 });
            await password.press('Enter');
        } catch {
            // The session recovered on its own; the form is gone.
        }
    }
    await expect(page.getByRole('status')).toHaveText('Connected.');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.locator('#settings-mobile-view').click();
    await expect(page.locator('#settings-mobile-drafts')).toContainText(
        'Retained draft',
    );
    await page
        .locator('#settings-mobile-drafts button', { hasText: 'Restore' })
        .click();
    await expect(page.locator('#settings-mobile-ui-font-size')).toHaveValue(
        '21',
    );
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
