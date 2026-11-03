import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';
import { seedSyncboardPi, startPushProvider } from './_pi-syncboard.js';

const MARKER = 'PHI_SYNCBOARD_PUSH_9f42';
const PUSH_TEXT = `Pushed by another agent. Marker ${MARKER}.`;

/**
 * Read the mesh port the server logged when it bound the listener. The log is
 * written asynchronously, so this waits instead of assuming the line landed.
 */
async function meshAddrFromLog(logPath: string): Promise<string> {
    const deadline = Date.now() + 30_000;
    let last = '';
    while (Date.now() < deadline) {
        try {
            last = readFileSync(logPath, 'utf8');
        } catch {
            last = '';
        }
        const match = /sync mesh listening"?\s+addr=(\S+)/.exec(last);
        if (match) return match[1]!;
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const tail = last.split('\n').slice(-15).join('\n');
    throw new Error(`no mesh listener in ${logPath}\ntail:\n${tail}`);
}

function publish(addr: string, recipient: string, value: string): string {
    return execFileSync(
        'go',
        [
            'run',
            './e2e/fixtures/syncpush',
            '-addr',
            addr,
            '-recipient',
            recipient,
            '-value',
            value,
        ],
        { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000 },
    ).trim();
}

test('a pushed message reaches the receiving Pi model without a tool call', async () => {
    test.setTimeout(180_000);
    const provider = await startPushProvider();
    let phi: PhiServer | undefined;
    try {
        phi = await startPhi({
            config: { auto_reconnect: 'off', sync_mesh: true },
            env: { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
            setup(dir) {
                seedSyncboardPi(dir, provider.port);
            },
        });
        const owner = phi;

        const created = await request(owner, 'POST', '/api/terminals', {
            coder: 'pi',
            cwd: owner.dir,
        });
        const pane = created.pane_id;

        // The pane must be live under the bridge with the push capability,
        // or the message has nowhere to go.
        await expect
            .poll(
                async () => (await bridgeOf(owner, pane))?.capabilities ?? [],
                { timeout: 60_000 },
            )
            .toContain('pi.syncboard.push.v1');
        await expect
            .poll(async () => (await bridgeOf(owner, pane))?.connected, {
                timeout: 60_000,
            })
            .toBe(true);

        const addr = await meshAddrFromLog(owner.logPath);
        const result = JSON.parse(publish(addr, pane, PUSH_TEXT)) as {
            seq: number;
        };
        expect(result.seq).toBeGreaterThan(0);

        // The proof: the receiving model's own request body carries the text.
        await provider.waitForContent(MARKER, 60_000);

        // The proof is the injected message itself: the marker and its
        // phi-syncboard header must arrive in the same request, so the text is
        // not present by coincidence and did not come from a tool call.
        const carrying = provider
            .bodies()
            .filter(
                (body) => body.includes(MARKER) && body.includes('phi-syncboard'),
            );
        expect(carrying.length).toBeGreaterThan(0);
        // Nothing was delivered through the tool: the receiver never called
        // syncboard, so the only source of the text is the injection itself.
        expect(provider.bodies().some(syncboardToolUse)).toBe(false);
    } finally {
        await phi?.stop();
        await provider.close();
    }
});

/** True when a request body contains a syncboard tool call. */
function syncboardToolUse(body: string): boolean {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return false;
    }
    const messages =
        typeof parsed === 'object' && parsed !== null
            ? (parsed as { messages?: unknown }).messages
            : undefined;
    if (!Array.isArray(messages)) return false;
    return messages.some(
        (message) =>
            typeof message === 'object' &&
            message !== null &&
            Array.isArray((message as { content?: unknown }).content) &&
            (message as { content: unknown[] }).content.some(
                (block) =>
                    typeof block === 'object' &&
                    block !== null &&
                    (block as { type?: string }).type === 'tool_use' &&
                    (block as { name?: string }).name === 'syncboard',
            ),
    );
}

interface TerminalView {
    id: string;
    pi_bridge?: { connected: boolean; capabilities: string[] };
}

async function bridgeOf(
    server: PhiServer,
    pane: string,
): Promise<TerminalView['pi_bridge']> {
    const response = await fetch(`${server.url}/api/terminals`);
    if (!response.ok) throw new Error(`terminals: ${response.status}`);
    const tabs = (await response.json()) as TerminalView[];
    return tabs.find((tab) => tab.id === pane)?.pi_bridge;
}

async function request(
    server: PhiServer,
    method: string,
    path: string,
    body: unknown,
): Promise<{ pane_id: string }> {
    const response = await fetch(`${server.url}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        throw new Error(`${method} ${path}: ${response.status}`);
    }
    return (await response.json()) as { pane_id: string };
}
