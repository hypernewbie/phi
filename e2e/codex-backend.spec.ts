import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

let phi: PhiServer;
function launchArgs(): string | null {
    const path = join(phi.dir, 'home', 'codex-args.txt');
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
}
test.beforeAll(async () => {
    phi = await startPhi({
        setup(dir) {
            const command = join(dir, 'codex-fixture');
            writeFileSync(
                command,
                '#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/codex-args.txt"\nprintf "codex ready\\r\\n"\nexec cat\n',
                { mode: 0o755 },
            );
            const backends = join(dir, 'home', '.phi', 'backends');
            mkdirSync(backends, { recursive: true });
            writeFileSync(
                join(backends, 'codex.json'),
                JSON.stringify({ id: 'codex', command }),
            );
        },
    });
});
test.afterAll(async () => {
    await phi.stop();
});

test('Codex launches safely and Models sends only the native picker command', async ({
    page,
    request,
}) => {
    const input: string[] = [];
    const output: string[] = [];
    page.on('websocket', (socket) => {
        socket.on('framesent', (event) =>
            input.push(
                typeof event.payload === 'string'
                    ? event.payload
                    : event.payload.toString('utf8'),
            ),
        );
        socket.on('framereceived', (event) =>
            output.push(
                typeof event.payload === 'string'
                    ? event.payload
                    : event.payload.toString('utf8'),
            ),
        );
    });
    await page.goto(phi.url);
    await page
        .locator('#coder-selector .coder-tab[data-coder="codex"]')
        .click();
    const spawned = page.waitForResponse(
        (response) =>
            response.url().endsWith('/api/terminals') &&
            response.request().method() === 'POST',
    );
    await page.locator('#new-session-btn').click();
    const reply = await spawned;
    expect(reply.ok()).toBe(true);
    const pane = await reply.json();
    await expect.poll(launchArgs).toBe('--no-alt-screen\n');
    await expect(page.locator(`#term-${pane.pane_id} .xterm`)).toBeVisible();
    // hot-v1 attaches live-only. Startup output can precede attachment,
    // so check the authoritative recording instead of racing the socket.
    await expect
        .poll(async () => {
            const recording = await request.get(
                `${phi.url}/api/terminals/${pane.pane_id}/recording?from=0&through=65536`,
            );
            return recording.ok() ? recording.text() : '';
        })
        .toContain('codex ready');
    await page
        .locator('#presets-container button', { hasText: '🤖 Models' })
        .click();
    await expect
        .poll(() => input.join(''))
        .toContain('\x1b[200~/model\x1b[201~\r');
    expect(input.join('')).not.toMatch(/gpt-[0-9]/);
    await expect.poll(() => output.join('')).toContain('/model');
    const resumed = await request.post(`${phi.url}/api/terminals`, {
        data: {
            coder: 'codex',
            cwd: phi.dir,
            session_id: '01984de2-8f74-7c91-a3b2-5c5e937cf318',
        },
    });
    expect(resumed.ok()).toBe(true);
    await expect
        .poll(launchArgs)
        .toBe(
            '--no-alt-screen\nresume\n01984de2-8f74-7c91-a3b2-5c5e937cf318\n',
        );
});
