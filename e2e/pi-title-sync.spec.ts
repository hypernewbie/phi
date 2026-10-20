import {
    appendFileSync,
    existsSync,
    mkdirSync,
    realpathSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import { join, sep } from 'node:path';
import {
    expect,
    test,
    type APIRequestContext,
    type WebSocketRoute,
} from '@playwright/test';
import { startPhi } from './_server.js';

const secondSessionID = 'e2e-second-worktree-native-id';
const promptTitle = 'Implement Pi title synchronization';

function piProjectDirectory(home: string, cwd: string) {
    const normalized = realpathSync(cwd).replaceAll('\\', '/');
    const encoded = normalized
        .replace(/^\/+|\/+$/g, '')
        .replace(/:/g, '-')
        .replace(/\//g, '-');
    return join(home, '.pi', 'agent', 'sessions', `--${encoded}--`);
}

function writeSession(
    home: string,
    cwd: string,
    id: string,
    entries: Record<string, unknown>[],
) {
    const directory = piProjectDirectory(home, cwd);
    mkdirSync(directory, { recursive: true });
    const header = { type: 'session', version: 3, id, cwd };
    const path = join(directory, 'not-a-timestamp-name.jsonl');
    writeFileSync(
        path,
        [header, ...entries].map((entry) => JSON.stringify(entry)).join('\n') +
            '\n',
    );
    return path;
}

function appendSessionRecord(path: string, entry: Record<string, unknown>) {
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

async function apiTitle(
    request: APIRequestContext,
    url: string,
    paneID: string,
) {
    const response = await request.get(`${url}/api/terminals`);
    if (!response.ok()) return undefined;
    const tabs = (await response.json()) as Array<{
        id: string;
        title: string;
    }>;
    return tabs.find((tab) => tab.id === paneID)?.title;
}

test('Pi terminal labels follow native file titles through reload and reconnect', async ({
    page,
    request,
}) => {
    test.setTimeout(180_000);
    const worktreeA = 'pi-title-worktree-a';
    const worktreeB = 'pi-title-worktree-b';
    const phi = await startPhi({
        setup(dir) {
            const home = join(dir, 'home');
            const cwdA = join(dir, worktreeA);
            const cwdB = join(dir, worktreeB);
            mkdirSync(cwdA, { recursive: true });
            mkdirSync(cwdB, { recursive: true });
            const backends = join(home, '.phi', 'backends');
            mkdirSync(backends, { recursive: true });
            writeFileSync(
                join(home, '.phi', 'config.json'),
                JSON.stringify({
                    workspaces: [realpathSync(cwdA), realpathSync(cwdB)],
                    theme_color: 'purple',
                }),
            );
            const command = join(dir, 'fake-pi');
            writeFileSync(
                command,
                `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/pi-launch.log"
printf 'fake Pi ready\\r\\n'
while IFS= read -r line; do
  printf '%s\\n' "$line" >> "$HOME/pi-input.log"
done
`,
                { mode: 0o755 },
            );
            writeFileSync(
                join(backends, 'pi.json'),
                JSON.stringify({ id: 'pi', command }),
            );
            // This second worktree has a known, already-persisted session.
            // The first fresh terminal's session directory is deliberately
            // absent until the browser test writes it after watcher setup.
            writeSession(home, realpathSync(cwdB), secondSessionID, [
                { type: 'session_info', name: 'Second worktree title' },
            ]);
        },
    });

    try {
        const home = join(phi.dir, 'home');
        const cwdA = realpathSync(join(phi.dir, worktreeA));
        const cwdB = realpathSync(join(phi.dir, worktreeB));
        const builtServer = realpathSync(
            join(phi.dir, process.platform === 'win32' ? 'phi.exe' : 'phi'),
        );
        const sourceCheckout = realpathSync(process.cwd());
        expect(builtServer.startsWith(`${sourceCheckout}${sep}`)).toBe(false);
        await page.setViewportSize({ width: 1440, height: 900 });

        const fresh = await request.post(`${phi.url}/api/terminals`, {
            data: { coder: 'pi', cwd: cwdA, title: '+ Pi' },
        });
        expect(fresh.ok()).toBe(true);
        const freshPane = (await fresh.json()) as {
            pane_id: string;
            session_id: string;
        };
        const second = await request.post(`${phi.url}/api/terminals`, {
            data: {
                coder: 'pi',
                cwd: cwdB,
                session_id: secondSessionID,
                title: '+ Pi',
            },
        });
        expect(second.ok()).toBe(true);
        const secondPane = (await second.json()) as { pane_id: string };
        expect(freshPane.pane_id).not.toBe(secondPane.pane_id);

        let freshSocket: WebSocketRoute | undefined;
        await page.routeWebSocket(`**/ws/pane/${freshPane.pane_id}?*`, (ws) => {
            freshSocket = ws;
            ws.connectToServer();
        });
        await page.routeWebSocket(
            `**/ws/pane/${secondPane.pane_id}?*`,
            (ws) => {
                ws.connectToServer();
            },
        );
        await page.goto(phi.url);
        const freshLabel = page.locator(
            `.tab[data-pane-id="${freshPane.pane_id}"] .tab-title`,
        );
        const secondLabel = page.locator(
            `.tab[data-pane-id="${secondPane.pane_id}"] .tab-title`,
        );
        await expect(freshLabel).toHaveText('+ Pi');
        await expect(secondLabel).toHaveText('Second worktree title', {
            timeout: 10_000,
        });
        const longSkill =
            '<skill name="large" location="/skills/large.md">\n' +
            'private instruction text '.repeat(700) +
            '\n</skill>\n/skill:build\n' +
            promptTitle;
        const freshSessionFile = writeSession(
            home,
            cwdA,
            freshPane.session_id,
            [
                {
                    type: 'message',
                    message: { role: 'user', content: longSkill },
                },
                {
                    type: 'message',
                    message: {
                        role: 'user',
                        content: 'A later request must not replace this title',
                    },
                },
            ],
        );
        await expect
            .poll(() => apiTitle(request, phi.url, freshPane.pane_id), {
                timeout: 35_000,
                intervals: [250, 500, 1000, 2000],
            })
            .toBe(promptTitle);
        await expect(freshLabel).toHaveText(promptTitle, { timeout: 10_000 });
        expect(await apiTitle(request, phi.url, secondPane.pane_id)).toBe(
            'Second worktree title',
        );

        // Switch the active terminal and the sidebar coder away from Pi. The
        // backend title stream must update the inactive Pi tab independently.
        await secondLabel.click();
        await expect(page.locator('.tab.active')).toHaveAttribute(
            'data-pane-id',
            secondPane.pane_id,
        );
        await page
            .locator('#coder-selector .coder-tab[data-coder="bash"]')
            .click();
        appendSessionRecord(freshSessionFile, {
            type: 'session_info',
            name: 'Native name one',
        });
        await expect(freshLabel).toHaveText('Native name one', {
            timeout: 10_000,
        });
        expect(await apiTitle(request, phi.url, secondPane.pane_id)).toBe(
            'Second worktree title',
        );
        appendSessionRecord(freshSessionFile, {
            type: 'session_info',
            name: 'Native name two',
        });
        await expect(freshLabel).toHaveText('Native name two', {
            timeout: 10_000,
        });

        // Exercise the existing theme swatches and narrow responsive tab bar.
        for (const color of ['white', 'purple']) {
            await page.locator('#header-config-pill .pill-label').click();
            await page
                .locator(`.settings-swatch[data-color="${color}"]`)
                .click();
            await expect(page.locator('html')).toHaveAttribute(
                'data-theme-color',
                color,
            );
            await page.locator('.settings-overlay .modal-close-btn').click();
            await expect(freshLabel).toHaveText('Native name two');
        }
        await page.emulateMedia({ colorScheme: 'light' });
        await freshLabel.click();
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(freshLabel).toHaveText('Native name two');
        await expect(page.locator('.terminal-tabs-bar')).toBeHidden();
        await page.setViewportSize({ width: 800, height: 844 });
        await expect(freshLabel).toBeVisible();
        await page.emulateMedia({ colorScheme: 'dark' });
        await expect(freshLabel).toHaveText('Native name two');
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.reload();
        await expect(freshLabel).toHaveText('Native name two', {
            timeout: 10_000,
        });

        appendSessionRecord(freshSessionFile, {
            type: 'session_info',
            name: null,
        });
        await expect(freshLabel).toHaveText(promptTitle, { timeout: 10_000 });

        // Disconnect the current socket, let the server resolve a newer title
        // while offline, then reconnect and accept the current attach snapshot.
        freshSocket?.close();
        await expect(
            page.locator(`.tab[data-pane-id="${freshPane.pane_id}"]`),
        ).toHaveClass(/dead/);
        appendSessionRecord(freshSessionFile, {
            type: 'session_info',
            name: 'Offline native update',
        });
        await expect
            .poll(() => apiTitle(request, phi.url, freshPane.pane_id), {
                timeout: 10_000,
            })
            .toBe('Offline native update');
        await page.locator(`#term-${freshPane.pane_id} .reconnect-btn`).click();
        await expect(freshLabel).toHaveText('Offline native update', {
            timeout: 10_000,
        });

        // Enter delivers one backend request; the label stays native until
        // the next JSONL acknowledgment. Escape cancels without another write.
        await freshLabel.dblclick();
        const cancelInput = page.locator(
            `.tab[data-pane-id="${freshPane.pane_id}"] input.rename-input`,
        );
        await cancelInput.fill('Cancelled rename');
        await cancelInput.press('Escape');
        await expect(freshLabel).toHaveText('Offline native update');

        await freshLabel.dblclick();
        const renameInput = page.locator(
            `.tab[data-pane-id="${freshPane.pane_id}"] input.rename-input`,
        );
        await renameInput.fill('Browser requested name');
        await renameInput.press('Enter');
        await expect(freshLabel).toHaveText('Offline native update');
        const inputLog = join(home, 'pi-input.log');
        await expect
            .poll(
                () =>
                    existsSync(inputLog) ? readFileSync(inputLog, 'utf8') : '',
                {
                    timeout: 10_000,
                },
            )
            .toBe('/name Browser requested name\n');
        appendSessionRecord(freshSessionFile, {
            type: 'session_info',
            name: 'Browser acknowledged name',
        });
        await expect(freshLabel).toHaveText('Browser acknowledged name', {
            timeout: 10_000,
        });
    } finally {
        await phi.stop();
    }
});
