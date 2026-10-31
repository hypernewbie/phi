import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { syntheticPiSource } from './_pi-bridge.js';
import { paneBridgeReload, paneRecording } from './_pi-reload.js';
import { startPhi } from './_server.js';

// Real Phi, bundle, IPC, HTTP and WebSocket paths. Only the Pi editor
// is synthetic: these cases do not launch Pi or make provider calls.
test('Reload restores status and handles focus refusal and delayed receipts', async ({
    browser,
    request,
}) => {
    const phi = await startPhi({
        setup(dir) {
            const backends = join(dir, 'home', '.phi', 'backends');
            mkdirSync(backends, { recursive: true });
            const command = join(dir, 'synthetic-pi.cjs');
            writeFileSync(
                command,
                syntheticPiSource(
                    join(
                        process.cwd(),
                        'bonus/pi-phi/dist/pi-phi-extension.cjs',
                    ),
                    { reload: true },
                ),
                { mode: 0o755 },
            );
            writeFileSync(
                join(backends, 'pi.json'),
                JSON.stringify({ id: 'pi', command }),
            );
        },
    });
    try {
        for (const mobile of [false, true]) {
            const created = await request.post(`${phi.url}/api/terminals`, {
                data: { coder: 'pi', cwd: phi.dir },
            });
            expect(created.ok()).toBe(true);
            const pane = ((await created.json()) as { pane_id: string })
                .pane_id;
            await expect
                .poll(() => paneBridgeReload(request, phi.url, pane))
                .toMatchObject({
                    connected: true,
                    capabilities: expect.arrayContaining(['pi.reload.v1']),
                });
            const view = await paneBridgeReload(request, phi.url, pane);
            if (!view) throw new Error('missing bridge view');
            const page = await browser.newPage({
                viewport: mobile
                    ? { width: 390, height: 844 }
                    : { width: 1440, height: 900 },
                isMobile: mobile,
                hasTouch: mobile,
            });
            try {
                const pageErrors: string[] = [];
                page.on('pageerror', (error) => pageErrors.push(error.message));
                await page.route('**/api/update/status', (route) =>
                    route.fulfill({
                        json: { current: 'dev', update_available: false },
                    }),
                );
                await page.route('**/api/sessions?coder=opencode*', (route) =>
                    route.fulfill({ json: [] }),
                );
                await page.goto(phi.url);
                await page.evaluate(
                    ({ pane, view }) => {
                        localStorage.setItem(
                            `phi.piBridge.reload.v1.${pane}`,
                            JSON.stringify({
                                v: 1,
                                id: 'restored-flight',
                                phase: 'sending',
                                paneId: pane,
                                processId: view.process_id,
                                generation: view.generation,
                                pubRev: view.telemetry_revision,
                                runId: view.run_id,
                                contextRevision: view.context_revision,
                                requestId: null,
                            }),
                        );
                    },
                    { pane, view },
                );
                await page.reload();
                if (mobile) {
                    await page.locator('#mobile-sidebar-toggle').tap();
                    await page
                        .locator(
                            `#drawer-tabs-body .hostname-dropdown-row[data-pane-id="${pane}"] .hostname-dropdown-select-btn`,
                        )
                        .tap();
                } else {
                    await page.locator(`.tab[data-pane-id="${pane}"]`).click();
                }
                const cmds = page.getByRole('button', { name: 'Cmds ▾' });
                const menu = page.locator('#quick-commands-dropup');
                const reload = menu.getByRole('button', {
                    name: '/reload',
                    exact: true,
                });
                const activate = async (target: typeof cmds) => {
                    if (mobile) await target.tap();
                    else {
                        await target.focus();
                        await page.keyboard.press('Enter');
                    }
                };
                await activate(cmds);
                await expect(menu.locator('#pi-reload-status')).toHaveText(
                    'Reload unconfirmed — check Pi. Not retried.',
                );
                await activate(
                    menu.getByRole('button', { name: 'Dismiss reload status' }),
                );
                await expect(reload).toBeFocused();

                const input = async (text: string) => {
                    const response = await request.post(
                        `${phi.url}/api/terminals/${pane}/input`,
                        { data: { text: `${text}\n` } },
                    );
                    expect(response.ok()).toBe(true);
                };
                await input('focus-selector');
                await expect
                    .poll(() => paneRecording(request, phi.url, pane))
                    .toContain('focus is now focus-selector');
                const refusal = page.waitForResponse((res) =>
                    res.url().endsWith('/api/pi-bridge/reload'),
                );
                await activate(reload);
                expect((await refusal).status()).toBe(409);
                await expect(
                    page.locator('.toast', {
                        hasText: 'Reload refused: unavailable',
                    }),
                ).toBeVisible();
                expect(
                    await paneRecording(request, phi.url, pane),
                ).not.toContain('native command entered: /reload');

                await input('focus-editor');
                await expect
                    .poll(() => paneRecording(request, phi.url, pane))
                    .toContain('focus is now focus-editor');
                let releaseReceipt: () => void = () => {};
                const receiptGate = new Promise<void>((resolve) => {
                    releaseReceipt = resolve;
                });
                await page.route('**/api/pi-bridge/reload', async (route) => {
                    const response = await route.fetch();
                    await receiptGate;
                    await route.fulfill({ response });
                });
                try {
                    await activate(cmds);
                    await activate(reload);
                    await expect
                        .poll(() => paneBridgeReload(request, phi.url, pane))
                        .toMatchObject({ reload_pending: true });
                    await activate(cmds);
                    await reload.focus();
                    await expect(reload).toHaveAttribute(
                        'title',
                        'Reload sending…',
                    );
                    await input('release-reload');
                    await expect
                        .poll(() => paneBridgeReload(request, phi.url, pane))
                        .toMatchObject({ reload_pending: false });
                    await expect(reload).toBeFocused();
                    releaseReceipt();
                    await expect(reload).not.toHaveAttribute('title', /Reload/);
                    await expect(reload).toBeFocused();
                    await expect(
                        menu.getByRole('button', {
                            name: 'Dismiss reload status',
                        }),
                    ).toHaveCount(0);
                    const recording = await paneRecording(
                        request,
                        phi.url,
                        pane,
                    );
                    expect(
                        recording.match(/native command entered: \/reload/g),
                    ).toHaveLength(1);
                    expect(
                        await page.evaluate(
                            () =>
                                document.documentElement.scrollWidth <=
                                innerWidth,
                        ),
                    ).toBe(true);
                    expect(pageErrors).toEqual([]);
                } finally {
                    releaseReceipt();
                }
            } finally {
                await page.close();
            }
        }
    } finally {
        await phi.stop();
    }
});
