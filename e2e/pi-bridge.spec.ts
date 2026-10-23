import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { startPhi } from './_server.js';
import { syntheticPiSource } from './_pi-bridge.js';

interface BridgeView {
    state: string;
    reason?: string;
    running?: boolean;
    last_run?: string;
    last_outcome?: string;
}

async function paneBridge(
    request: APIRequestContext,
    url: string,
    paneID: string,
): Promise<BridgeView | undefined> {
    const response = await request.get(`${url}/api/terminals`);
    if (!response.ok()) return undefined;
    const tabs = (await response.json()) as Array<{
        id: string;
        pi_bridge?: BridgeView;
    }>;
    return tabs.find((tab) => tab.id === paneID)?.pi_bridge;
}

async function paneInput(
    request: APIRequestContext,
    url: string,
    paneID: string,
    text: string,
) {
    const response = await request.post(
        `${url}/api/terminals/${paneID}/input`,
        { data: { text } },
    );
    expect(response.ok()).toBe(true);
}

test('Pi bridge reports managed state and rings the bell on settlement', async ({
    page,
    request,
}) => {
    test.setTimeout(180_000);
    const bundlePath = join(
        process.cwd(),
        'bonus',
        'pi-phi',
        'dist',
        'pi-phi-extension.cjs',
    );
    expect(existsSync(bundlePath)).toBe(true);

    const phi = await startPhi({
        setup(dir) {
            // Pi runs in a directory with spaces, distinct from the server
            // cwd (dir) and the bridge endpoint dir (system temp).
            const cwd = join(dir, 'work dir with spaces');
            mkdirSync(cwd, { recursive: true });
            const home = join(dir, 'home');
            const backends = join(home, '.phi', 'backends');
            mkdirSync(backends, { recursive: true });
            const synthetic = join(dir, 'synthetic-pi.cjs');
            writeFileSync(synthetic, syntheticPiSource(bundlePath), {
                mode: 0o755,
            });
            writeFileSync(
                join(backends, 'pi.json'),
                JSON.stringify({ id: 'pi', command: synthetic }),
            );
        },
    });

    try {
        const cwd = join(phi.dir, 'work dir with spaces');
        await page.setViewportSize({ width: 1440, height: 900 });

        // Spawn provisions the bridge before the process starts: the
        // response already carries the managed state for polling.
        const spawned = await request.post(`${phi.url}/api/terminals`, {
            data: { coder: 'pi', cwd, title: 'E2E Pi' },
        });
        expect(spawned.ok()).toBe(true);
        const pane = (await spawned.json()) as {
            pane_id: string;
            session_id: string;
            pi_bridge?: BridgeView;
        };
        expect(pane.pi_bridge?.state).toBe('managed');

        // Listing exposes the same managed state.
        await expect
            .poll(() => paneBridge(request, phi.url, pane.pane_id), {
                timeout: 10_000,
            })
            .toMatchObject({ state: 'managed' });

        // The synthetic backend loads the real bundle and completes the
        // hello handshake: the server reports an idle baseline.
        await expect
            .poll(() => paneBridge(request, phi.url, pane.pane_id), {
                timeout: 15_000,
            })
            .toMatchObject({ state: 'managed', running: false });

        // Reattach to the live session returns the same pane and bridge.
        const reattached = await request.post(`${phi.url}/api/terminals`, {
            data: { coder: 'pi', session_id: pane.session_id },
        });
        expect(reattached.ok()).toBe(true);
        const reattachBody = (await reattached.json()) as {
            pane_id: string;
            pi_bridge?: BridgeView;
        };
        expect(reattachBody.pane_id).toBe(pane.pane_id);
        expect(reattachBody.pi_bridge?.state).toBe('managed');

        // Both tabs must exist before page load: the UI renders the
        // server tab list once at startup. The shell parks in front so
        // the Pi tab is a qualifying background tab for the bell.
        const shell = await request.post(`${phi.url}/api/terminals`, {
            data: { coder: 'bash', cwd, title: 'shell' },
        });
        expect(shell.ok()).toBe(true);
        const shellPane = (await shell.json()) as { pane_id: string };

        // Keep sync polling on this fixture, never the default live port 7070.
        const coordinator = await request.post(
            `${phi.url}/api/config/sync-coordinator`,
            { data: { sync_coordinator: phi.url } },
        );
        expect(coordinator.ok()).toBe(true);
        await page.goto(phi.url);
        const piTab = page.locator(`.tab[data-pane-id="${pane.pane_id}"]`);
        await expect(piTab).toBeVisible({ timeout: 10_000 });

        await page.locator(`.tab[data-pane-id="${shellPane.pane_id}"]`).click();
        await expect(page.locator('.tab.active')).toHaveAttribute(
            'data-pane-id',
            shellPane.pane_id,
        );

        // Output without a settlement never rings for managed panes: the
        // heuristic path stays suppressed past the idle poll window.
        await paneInput(request, phi.url, pane.pane_id, 'say hello output');
        await page.waitForTimeout(4500);
        await expect(piTab).not.toHaveClass(/has-attention/);

        // A full run settles through the bridge and rings once.
        await paneInput(request, phi.url, pane.pane_id, 'start');
        await paneInput(request, phi.url, pane.pane_id, 'settle');
        await expect(piTab).toHaveClass(/has-attention/, { timeout: 10_000 });
        await expect(
            page.locator('.toast-message', {
                hasText: 'Session "E2E Pi" is waiting at a prompt.',
            }),
        ).toBeVisible({ timeout: 10_000 });

        // The server retains the settlement for reattach catch-up.
        await expect
            .poll(() => paneBridge(request, phi.url, pane.pane_id), {
                timeout: 10_000,
            })
            .toMatchObject({
                state: 'managed',
                last_run: '1',
                last_outcome: 'completed',
            });

        const status = piTab.getByRole('img', { name: 'Needs attention' });
        await expect(status).toBeVisible();
        // The static cue must remain after all three two-second pulses.
        await page.waitForTimeout(6500);
        await expect(status).toBeVisible();
        const cue = await piTab.evaluate((el) => {
            const style = getComputedStyle(el);
            return {
                background: style.backgroundColor,
                left: style.borderLeftColor,
                right: style.borderRightColor,
            };
        });
        expect(cue.background).not.toBe('rgba(0, 0, 0, 0)');
        expect(cue.left).not.toBe(cue.right);
        await piTab.click();
        await expect(piTab).not.toHaveClass(/has-attention/);
        await expect(status).toHaveCount(0);

        // Reload establishes a silent baseline, then a new run rings again.
        await page.reload();
        const reloadedTab = page.locator(
            `.tab[data-pane-id="${pane.pane_id}"]`,
        );
        await expect(reloadedTab).toBeVisible({ timeout: 15_000 });
        await page.locator(`.tab[data-pane-id="${shellPane.pane_id}"]`).click();
        await paneInput(request, phi.url, pane.pane_id, 'start');
        await paneInput(request, phi.url, pane.pane_id, 'settle');
        await expect(reloadedTab).toHaveClass(/has-attention/, {
            timeout: 10_000,
        });
        await expect
            .poll(() => paneBridge(request, phi.url, pane.pane_id), {
                timeout: 10_000,
            })
            .toMatchObject({ last_run: '2' });
    } finally {
        await phi.stop();
    }
});
