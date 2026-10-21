import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { startPhi } from './_server.js';

// Synthetic Pi backend: loads the REAL committed bridge bundle and drives
// it with a minimal mock Pi host. Stdin lines map to lifecycle edges:
//   start       -> agent_start
//   settle      -> agent_end (stop) then agent_settled (completed)
//   abort       -> agent_settled (aborted)
//   say <text>  -> terminal output without any bridge event
//   exit        -> session_shutdown and process exit
// The script speaks the real generated protocol through the real Runtime;
// only the Pi host API surface is faked.
function syntheticPiSource(bundlePath: string): string {
    return `#!/usr/bin/env node
const factory = require(${JSON.stringify(bundlePath)});
const handlers = new Map();
const mockPi = {
    on(event, handler) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event).push(handler);
        return () => {};
    },
};
const mockCtx = () => ({
    sessionManager: {
        getSessionId: () => 'e2e-bridge-session',
        getLeafId: () => 'e2e-leaf-1',
    },
    model: { provider: 'e2e-provider', id: 'e2e-model' },
});
const emit = (event, payload) => {
    for (const handler of handlers.get(event) || []) handler(payload, mockCtx());
};
factory(mockPi);
emit('session_start', { type: 'session_start', reason: 'startup' });
console.log('synthetic pi ready');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.search(/[\\r\\n]/)) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        if (line === 'start') {
            emit('agent_start', { type: 'agent_start' });
            console.log('run started');
        } else if (line === 'settle') {
            emit('agent_end', { type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'stop' }] });
            emit('agent_settled', { type: 'agent_settled', aborted: false });
            console.log('run settled');
        } else if (line === 'abort') {
            emit('agent_settled', { type: 'agent_settled', aborted: true });
            console.log('run aborted');
        } else if (line.startsWith('say ')) {
            console.log(line.slice(4));
        } else if (line === 'exit') {
            emit('session_shutdown', { type: 'session_shutdown' });
            process.exit(0);
        }
    }
});
process.stdin.on('end', () => process.exit(0));
`;
}

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
