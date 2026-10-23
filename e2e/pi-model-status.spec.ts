import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { startPhi } from './_server.js';

// Real-Pi model status: the pinned Pi 1.0.1 TUI boots under a wrapper
// backend with a two-model stub provider (no network: switches never
// complete). Switching models in the TUI must move Phi's existing
// bottom-bar status within 5 seconds, per pane, across reload.
function piWrapperSource(options: {
    nodePath: string;
    cliPath: string;
    agentDir: string;
}): string {
    const q = (s: string) => `"${s}"`;
    return `#!/bin/sh
set -u
endpoint="\${PHI_PI_BRIDGE_ENDPOINT:-}"
tmpdir="\${TMPDIR:-/nonexistent}"
case "$endpoint" in
    "unix:\${tmpdir}/"*) ;;
    *) echo 'pi wrapper: endpoint outside owned root' >&2; exit 3 ;;
esac
printf 'ok\\n' > "$HOME/wrapper-check.txt"
exec /usr/bin/env -i \\
    "PATH=${dirname(options.nodePath)}:/usr/bin:/bin" \\
    "HOME=$HOME" "TMPDIR=$TMPDIR" "TMP=$TMPDIR" "TEMP=$TMPDIR" \\
    "TERM=\${TERM:-xterm-256color}" "LANG=\${LANG:-en_US.UTF-8}" "LC_ALL=\${LC_ALL:-}" "LC_CTYPE=\${LC_CTYPE:-UTF-8}" \\
    "PI_CODING_AGENT_DIR=${q(options.agentDir)}" \\
    "PHI_PI_BRIDGE_ENDPOINT=$PHI_PI_BRIDGE_ENDPOINT" \\
    "PHI_PI_BRIDGE_PANE_ID=$PHI_PI_BRIDGE_PANE_ID" \\
    "PHI_PI_BRIDGE_PROCESS_ID=$PHI_PI_BRIDGE_PROCESS_ID" \\
    "PHI_PI_BRIDGE_TOKEN=$PHI_PI_BRIDGE_TOKEN" \\
    ${q(options.nodePath)} ${q(options.cliPath)} --no-session --approve --no-extensions --no-prompt-templates --no-themes --no-context-files --model e2e-stub/probe-a "$@"
`;
}

interface BridgeView {
    state: string;
    model?: string;
    telemetry_revision?: string;
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

async function paneModel(
    request: APIRequestContext,
    url: string,
    paneID: string,
): Promise<string | undefined> {
    return (await paneBridge(request, url, paneID))?.model;
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

test('Pi PTY model status follows real TUI model switches', async ({
    page,
    request,
}) => {
    test.setTimeout(240_000);
    const cliPath = join(
        process.cwd(),
        'node_modules',
        '@earendil-works',
        'pi-coding-agent',
        'dist',
        'bundle',
        'cli.js',
    );
    expect(existsSync(cliPath)).toBe(true);

    const bridgeErrors: string[] = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error') bridgeErrors.push(msg.text());
    });
    page.on('pageerror', (err) => bridgeErrors.push(String(err)));

    const phi = await startPhi({
        setup(dir) {
            const home = join(dir, 'home');
            const agentDir = join(dir, 'agent');
            mkdirSync(agentDir, { recursive: true });
            writeFileSync(
                join(agentDir, 'models.json'),
                JSON.stringify({
                    providers: {
                        'e2e-stub': {
                            baseUrl: 'http://127.0.0.1:1/v1',
                            api: 'openai-completions',
                            apiKey: 'e2e-dummy',
                            models: [{ id: 'probe-a' }, { id: 'probe-b' }],
                        },
                    },
                }),
            );
            const wrapper = join(dir, 'pi-wrapper.sh');
            writeFileSync(
                wrapper,
                piWrapperSource({
                    nodePath: process.execPath,
                    cliPath,
                    agentDir,
                }),
                { mode: 0o755 },
            );
            const backends = join(home, '.phi', 'backends');
            mkdirSync(backends, { recursive: true });
            writeFileSync(
                join(backends, 'pi.json'),
                JSON.stringify({ id: 'pi', command: wrapper }),
            );
        },
    });

    try {
        const cwd = join(phi.dir, 'work dir with spaces');
        mkdirSync(cwd, { recursive: true });
        await page.setViewportSize({ width: 1440, height: 900 });

        const spawned = await request.post(`${phi.url}/api/terminals`, {
            data: { coder: 'pi', cwd, title: 'E2E Pi One' },
        });
        expect(spawned.ok()).toBe(true);
        const pane1 = (await spawned.json()) as {
            pane_id: string;
            pi_bridge?: BridgeView;
        };
        // Spawn carries an ordered baseline: managed with a
        // revision. The model may or may not be present yet — Pi's
        // Hello races the response — so only the poll below asserts
        // it. (Empty pre-Hello baselines are covered by the
        // controlled Go tests instead.)
        expect(pane1.pi_bridge?.state).toBe('managed');
        expect(pane1.pi_bridge?.telemetry_revision).toMatch(/^[1-9][0-9]*$/);

        // The wrapper proved endpoint containment before exec. The
        // marker carries only the result, never credentials.
        await expect
            .poll(() => paneModel(request, phi.url, pane1.pane_id), {
                timeout: 30_000,
            })
            .toBe('e2e-stub/probe-a');
        expect(
            readFileSync(join(phi.dir, 'home', 'wrapper-check.txt'), 'utf8'),
        ).toBe('ok\n');

        // Both Pi panes and the shell must exist before page load: the
        // UI renders the server tab list once at startup.
        const spawned2 = await request.post(`${phi.url}/api/terminals`, {
            data: { coder: 'pi', cwd, title: 'E2E Pi Two' },
        });
        expect(spawned2.ok()).toBe(true);
        const pane2 = (await spawned2.json()) as { pane_id: string };
        await expect
            .poll(() => paneModel(request, phi.url, pane2.pane_id), {
                timeout: 30_000,
            })
            .toBe('e2e-stub/probe-a');
        const shell = await request.post(`${phi.url}/api/terminals`, {
            data: { coder: 'bash', cwd, title: 'shell' },
        });
        expect(shell.ok()).toBe(true);
        const shellPane = (await shell.json()) as { pane_id: string };

        await page.goto(phi.url);
        const tab1 = page.locator(`.tab[data-pane-id="${pane1.pane_id}"]`);
        await expect(tab1).toBeVisible({ timeout: 10_000 });
        await tab1.click();
        const modelLabel = page.locator(
            '#pi-rpc-status-bar .pi-rpc-status-model',
        );
        await expect(modelLabel).toHaveText(/probe-a/, { timeout: 10_000 });
        // The Pi preset row and input bar are untouched by F1.
        await expect(
            page.locator('#presets-container button', { hasText: '/model' }),
        ).toBeVisible();
        await expect(page.locator('#input-bar-container')).toBeVisible();

        // One pasted line plus Enter: the TUI switches without the
        // autocomplete dropdown ever opening.
        await paneInput(request, phi.url, pane1.pane_id, '/model e2e-stub/probe-b');
        await expect
            .poll(() => paneModel(request, phi.url, pane1.pane_id), {
                timeout: 30_000,
            })
            .toBe('e2e-stub/probe-b');
        // Phi reflects the confirmed switch within 5 seconds.
        await expect(modelLabel).toHaveText(/probe-b/, { timeout: 5_000 });

        // A second pane keeps its own model; each tab shows its own.
        const tab2 = page.locator(`.tab[data-pane-id="${pane2.pane_id}"]`);
        await expect(tab2).toBeVisible({ timeout: 10_000 });
        await tab2.click();
        await expect(modelLabel).toHaveText(/probe-a/, { timeout: 10_000 });
        await tab1.click();
        await expect(modelLabel).toHaveText(/probe-b/, { timeout: 5_000 });

        // Panes without a bridge keep the bar hidden.
        const shellTab = page.locator(`.tab[data-pane-id="${shellPane.pane_id}"]`);
        await expect(shellTab).toBeVisible({ timeout: 10_000 });
        await shellTab.click();
        await expect(page.locator('#pi-rpc-status-bar')).toBeHidden();

        // Reload re-shows the retained model with no new Pi input:
        // the HTTP baseline plus the equal attach is enough.
        await page.reload();
        const reloadedTab1 = page.locator(
            `.tab[data-pane-id="${pane1.pane_id}"]`,
        );
        await expect(reloadedTab1).toBeVisible({ timeout: 15_000 });
        await reloadedTab1.click();
        await expect(modelLabel).toHaveText(/probe-b/, { timeout: 10_000 });

        const failures = bridgeErrors.filter((text) =>
            /pi.bridge|telemetry/i.test(text),
        );
        expect(failures).toEqual([]);
    } finally {
        const dir = phi.dir;
        await phi.stop();
        expect(existsSync(dir)).toBe(false);
    }
});
