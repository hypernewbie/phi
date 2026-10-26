import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startPhi } from './_server.js';

// A prompt typed while the control socket is down must appear in the
// transcript at once, survive the outage, and reach Pi when the link returns.
// The unit suites approximate this with a fake WebSocket; this is the
// browser-level proof of the same contract.
const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

const sessionID = 'offline-send-session';
const sessionTitle = 'Offline send session';

function piProjectDirectory(home: string, cwd: string): string {
    const normalized = realpathSync(cwd).replaceAll('\\', '/');
    const encoded = normalized
        .replace(/^\/+|\/+$/g, '')
        .replace(/:/g, '-')
        .replace(/\//g, '-');
    return join(home, '.pi', 'agent', 'sessions', `--${encoded}--`);
}

function writeSession(home: string, cwd: string): string {
    const directory = piProjectDirectory(home, cwd);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${sessionID}.jsonl`);
    const entries = [
        { type: 'session', version: 3, id: sessionID, cwd },
        { type: 'session_info', name: sessionTitle },
    ];
    writeFileSync(
        path,
        `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );
    return path;
}

test('a prompt typed while the control socket is down is queued and delivered', async ({
    page,
}) => {
    test.setTimeout(240_000);
    let sessionPath = '';
    const phi = await startPhi({
        config: { auto_reconnect: 'off' },
        env: { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
        setup(dir) {
            const home = join(dir, 'home');
            const fixtureCwd = realpathSync(dir);
            const agent = join(home, '.pi', 'agent');
            mkdirSync(agent, { recursive: true });
            writeFileSync(
                join(agent, 'settings.json'),
                JSON.stringify({
                    defaultProjectTrust: 'never',
                    quietStartup: true,
                    enableInstallTelemetry: false,
                    cacheWarming: 'off',
                }),
            );
            mkdirSync(join(home, '.phi'), { recursive: true });
            writeFileSync(
                join(home, '.phi', 'config.json'),
                JSON.stringify({
                    workspaces: [fixtureCwd],
                    active_cwd: fixtureCwd,
                }),
            );
            const piBinDir = join(dir, 'bin');
            mkdirSync(piBinDir, { recursive: true });
            const binary = join(process.cwd(), 'node_modules', '.bin', 'pi');
            writeFileSync(
                join(piBinDir, 'pi'),
                `#!/bin/sh\nexec ${shellQuote(binary)} --offline --no-extensions --no-skills --no-prompt-templates --no-context-files --no-approve --model anthropic/claude-sonnet-4-5 "$@"\n`,
                { mode: 0o755 },
            );
            sessionPath = writeSession(home, fixtureCwd);
        },
    });

    try {
        const pageErrors: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));

        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(phi.url);

        // Open the Pi chat from its session row, as the user does.
        await page
            .locator('#coder-selector .coder-tab[data-coder="pi"]')
            .click();
        const sessionRow = page.locator(
            `.session-item[data-session-id="${sessionID}"]`,
        );
        await sessionRow.hover();
        await sessionRow.locator('.review-btn').click();
        const paneId = `pi-rpc:session:${encodeURIComponent(sessionPath)}`;
        const tab = page.locator(`.tab[data-pane-id="${paneId}"]`);
        await expect(tab).toBeVisible({ timeout: 30_000 });
        await tab.click();
        const composer = page.locator('#input-textarea');
        await expect(composer).toBeVisible({ timeout: 30_000 });
        // Ready means the pane bootstrapped over a live socket.
        await expect(
            page.locator('.review-header-bar .review-header-coder').last(),
        ).toHaveText('Ready', { timeout: 30_000 });

        // Drop the link, then type: the row must appear without a round trip.
        const prompt = `offline queue ${Date.now()}`;
        const transcript = page.locator('.review-chat-wrapper');
        const optimisticRow = transcript
            .locator('[data-pi-optimistic-message="true"]')
            .filter({ hasText: prompt });
        const deliveredRow = transcript
            .locator('.user-message:not([data-pi-optimistic-message])')
            .filter({ hasText: prompt });
        // DevTools-style offline mode: the browser is a machine that lost its
        // link, which is what the far side of the world looks like.
        await page.context().setOffline(true);
        await composer.fill(prompt);
        const started = Date.now();
        await composer.press('Enter');
        await expect(optimisticRow).toBeVisible({ timeout: 3_000 });
        expect(Date.now() - started).toBeLessThan(2_000);
        await expect(composer).toHaveValue('');

        // Narrow layout keeps the queued row inside the viewport.
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(optimisticRow).toBeVisible();
        const overflow = await page.evaluate(() => ({
            inner: window.innerWidth,
            scroll: document.documentElement.scrollWidth,
        }));
        expect(overflow.scroll).toBeLessThanOrEqual(overflow.inner);
        await page.setViewportSize({ width: 1440, height: 900 });

        // The link returns: the queued prompt reaches Pi, and the row stops
        // claiming doubt — either the server accepted it or its user message
        // arrived in the transcript.
        await page.context().setOffline(false);
        await expect
            .poll(
                async () => {
                    const delivered = await deliveredRow.count();
                    const accepted = await transcript
                        .locator('[data-pi-optimistic-message="true"]')
                        .filter({ hasText: `Sent to Pi: ${prompt}` })
                        .count();
                    return delivered + accepted;
                },
                { timeout: 90_000 },
            )
            .toBe(1);

        expect(pageErrors).toEqual([]);
    } finally {
        await phi.stop();
    }
});
