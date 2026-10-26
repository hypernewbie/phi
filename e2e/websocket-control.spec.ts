import { execFileSync } from 'node:child_process';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startPhi } from './_server.js';
import {
    ControlClientFrame,
    ControlServerFrame,
} from '../web/proto/control.js';

// M3 chat gate: the real browser UI drives the real `/ws/control` endpoint
// against a fixture `pi --mode rpc` child. The fixture answers typed calls,
// streams one assistant turn with a tool result, and rejects two operations
// on purpose. No provider is called; the fixture PATH is fixture-owned.

interface FixtureEntry {
    kind: string;
    argv?: string[];
    path?: string;
    type?: string;
}

function readFixtureLog(path: string): FixtureEntry[] {
    let raw = '';
    try {
        raw = readFileSync(path, 'utf8');
    } catch {
        return [];
    }
    return raw
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as FixtureEntry);
}

async function waitForFixture(
    path: string,
    match: (entry: FixtureEntry) => boolean,
    timeout = 20_000,
): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (readFixtureLog(path).some(match)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`fixture log never recorded the expected entry: ${path}`);
}

function piSessionProjectDir(cwd: string): string {
    const normalized = cwd.replaceAll('\\', '/').replaceAll(':', '-');
    return `--${normalized.replace(/^\/+|\/+$/g, '').replaceAll('/', '-')}--`;
}

test('chat control endpoint spawns, streams, reports errors, and rehydrates', async ({
    page,
}) => {
    test.setTimeout(120_000);

    // Fixture-owned PATH and interpreter: the phi child resolves `pi` to
    // this launcher only, and the launcher points at the checked node
    // binary. Nothing from the developer PATH is reachable.
    const fixtureRoot = mkdtempSync(join(realpathSync(tmpdir()), 'pi-ctl-'));
    const bin = join(fixtureRoot, 'bin');
    const fixtureScript = join(fixtureRoot, 'pi-rpc-fixture.cjs');
    const fixtureLog = join(fixtureRoot, 'fixture.log');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
        fixtureScript,
        readFileSync(
            join(process.cwd(), 'e2e', 'fixtures', 'pi-rpc-fixture.cjs'),
        ),
    );
    const launcher = join(bin, 'pi');
    writeFileSync(
        launcher,
        `#!/bin/sh\nexec "${process.execPath}" "${fixtureScript}" "$@"\n`,
        { mode: 0o755 },
    );

    // Fixture PATH contract, checked before the server starts: `pi`
    // resolves to the fixture launcher and nothing else, and an empty
    // fixture bin makes resolution fail instead of finding a real install.
    const resolvePi = (path: string): string =>
        execFileSync('/bin/sh', ['-c', 'command -v pi'], {
            env: { PATH: path },
            encoding: 'utf8',
        }).trim();
    expect(resolvePi(bin)).toBe(launcher);
    const emptyBin = mkdtempSync(join(fixtureRoot, 'empty-'));
    expect(() => resolvePi(emptyBin)).toThrow();

    const phi = await startPhi({
        env: {
            PATH: bin,
            PI_FIXTURE_LOG: fixtureLog,
        },
        setup(dir) {
            const backends = join(dir, 'home', '.phi', 'backends');
            mkdirSync(backends, { recursive: true });
            writeFileSync(
                join(backends, 'pi.json'),
                JSON.stringify({ id: 'pi', command: join(bin, 'pi') }),
            );
            // One Pi session for the server workspace so the sidebar lists
            // a resumable session for the chat action.
            const cwd = realpathSync(dir);
            const sessions = join(
                dir,
                'home',
                '.pi',
                'agent',
                'sessions',
                piSessionProjectDir(cwd),
            );
            mkdirSync(sessions, { recursive: true });
            writeFileSync(
                join(sessions, 'fixture.jsonl'),
                `${JSON.stringify({
                    type: 'session',
                    version: 3,
                    id: 'fixture-session',
                    cwd,
                })}\n${JSON.stringify({
                    type: 'message',
                    id: 'm1',
                    parentId: null,
                    message: {
                        role: 'user',
                        content: [{ type: 'text', text: 'resume seed' }],
                    },
                })}\n`,
            );
        },
    });

    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('response', (response) => {
        if (response.status() >= 400)
            failedRequests.push(`${response.status()} ${response.url()}`);
    });
    page.on('requestfailed', (request) => {
        failedRequests.push(`${request.url()} ${request.failure()?.errorText}`);
    });

    // Real socket proxy: forward both directions, count client hydrate
    // requests, and drop exactly one sequenced tool-result event so the
    // client hits a sequence gap and rehydrates from the server snapshot.
    let hydrateRequests = 0;
    let hydrateCallId = '';
    const hydrateResponses: Array<{ id: string; messages: number }> = [];
    let toolEventsSeen = 0;
    let droppedToolEvent = false;
    await page.routeWebSocket('**/ws/control', (pageSocket) => {
        const serverSocket = pageSocket.connectToServer();
        pageSocket.onMessage((message) => {
            if (Buffer.isBuffer(message)) {
                const frame = ControlClientFrame.decode(
                    new Uint8Array(message),
                ) as {
                    payload?: {
                        $case?: string;
                        value?: { id?: string; call?: { $case?: string } };
                    };
                };
                const call = frame.payload?.value;
                if (
                    frame.payload?.$case === 'call' &&
                    call?.call?.$case === 'hydrate'
                ) {
                    hydrateRequests += 1;
                    hydrateCallId = call.id ?? '';
                }
            }
            serverSocket.send(message);
        });
        serverSocket.onMessage((message) => {
            if (Buffer.isBuffer(message)) {
                const frame = ControlServerFrame.decode(
                    new Uint8Array(message),
                ) as {
                    payload?: {
                        $case?: string;
                        value?: {
                            event?: {
                                $case?: string;
                                value?: { message?: { toolName?: string } };
                            };
                        };
                    };
                };
                if (frame.payload?.$case === 'response') {
                    const response = frame.payload.value as {
                        id?: string;
                        result?: {
                            $case?: string;
                            value?: { session?: { messages?: unknown[] } };
                        };
                    };
                    if (
                        typeof response.id === 'string' &&
                        response.result?.$case === 'hydrate'
                    )
                        hydrateResponses.push({
                            id: response.id,
                            messages:
                                response.result.value?.session?.messages
                                    ?.length ?? 0,
                        });
                }
                const event = frame.payload?.value?.event;
                const endedTool =
                    event?.$case === 'messageEnd' &&
                    event.value?.message?.toolName === 'bash';
                if (endedTool) {
                    toolEventsSeen += 1;
                    if (toolEventsSeen === 2 && !droppedToolEvent) {
                        droppedToolEvent = true;
                        return;
                    }
                }
            }
            pageSocket.send(message);
        });
    });

    try {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(phi.url);

        // Open the Pi chat tab for the resumable session.
        await page.locator('#coder-selector [data-coder="pi"]').click();
        const sessionRow = page.locator('.session-item').first();
        await expect(sessionRow).toContainText('resume seed', {
            timeout: 20_000,
        });
        // Row actions are hover-revealed (web/style.css .session-actions).
        await sessionRow.hover();
        await sessionRow.locator('.review-btn').click();

        const chat = page.locator('.review-chat-wrapper');
        await expect(chat).toBeVisible({ timeout: 20_000 });
        // Spawn reached the fixture through the fixture-owned PATH, and the
        // resume path was passed to the real child.
        await waitForFixture(fixtureLog, (entry) => entry.kind === 'start');
        await waitForFixture(
            fixtureLog,
            (entry) =>
                entry.kind === 'session' &&
                typeof entry.path === 'string' &&
                entry.path.endsWith('fixture.jsonl'),
        );
        await expect(page.locator('#pi-rpc-status-bar')).toContainText(
            'fixture-model',
            { timeout: 20_000 },
        );

        // Prompt -> streamed text and tool-result metadata over generated
        // protobuf events.
        const prompt = async (text: string) => {
            const input = page.locator('#input-textarea');
            await input.fill(text);
            await page.locator('#send-input-btn').click();
        };
        await prompt('hello fixture');
        await expect(chat).toContainText('Fixture reply.', {
            timeout: 20_000,
        });
        await expect(chat).toContainText('fixture tool output');
        await expect(
            chat.locator('.user-message', { hasText: 'hello fixture' }),
        ).toBeVisible();

        // Correlated error: the fixture rejects the 'low' thinking level.
        const thinkingTrigger = page.locator(
            '#presets-container button.pi-rpc-thinking-trigger',
        );
        await thinkingTrigger.click();
        const thinkingDropup = page.locator('#pi-rpc-thinking-dropup');
        await expect(
            thinkingDropup.locator('.dropup-model-btn', { hasText: 'low' }),
        ).toBeVisible({ timeout: 10_000 });
        await thinkingDropup
            .locator('.dropup-model-btn', { hasText: 'low' })
            .click();
        await expect(
            page.locator('.toast', {
                hasText: 'thinking level is rejected by the fixture',
            }),
        ).toBeVisible({ timeout: 10_000 });

        // Successful control action on the same connection: 'high' is
        // accepted and lands in the status bar through a state result.
        // The rejected attempt leaves the dropup open; only re-open when
        // the error path closed it.
        if (!(await thinkingDropup.isVisible())) await thinkingTrigger.click();
        await expect(
            thinkingDropup.locator('.dropup-model-btn', { hasText: 'high' }),
        ).toBeVisible({ timeout: 10_000 });
        await thinkingDropup
            .locator('.dropup-model-btn', { hasText: 'high' })
            .click();
        await expect(page.locator('#pi-rpc-status-bar')).toContainText('high', {
            timeout: 10_000,
        });

        // Gap recovery: the second turn's tool-result event is dropped on
        // the proxied real socket, so the client must ask for a hydrate and
        // restore the transcript from the server snapshot.
        const hydratesBefore = hydrateRequests;
        await prompt('second turn');
        await expect
            .poll(() => droppedToolEvent, { timeout: 20_000 })
            .toBe(true);
        await expect
            .poll(() => hydrateRequests, { timeout: 20_000 })
            .toBeGreaterThan(hydratesBefore);
        await expect(chat).toContainText('second turn', {
            timeout: 20_000,
        });
        // Seeded resume message plus both prompts, restored from the
        // server snapshot after the gap.
        await expect(chat.locator('.user-message')).toHaveCount(3, {
            timeout: 20_000,
        });
        expect(toolEventsSeen).toBeGreaterThanOrEqual(2);
        // The recovery ran on the real socket: a hydrate call was sent and
        // its generated response carried the authoritative transcript.
        expect(hydrateCallId).not.toBe('');
        const recovered = hydrateResponses.filter(
            (response) => response.id === hydrateCallId,
        );
        expect(recovered.length).toBeGreaterThan(0);
        expect(recovered[0].messages).toBeGreaterThanOrEqual(4);

        // The fixture PATH is deliberately isolated from the developer
        // machine, so unrelated probes (/api/update/status, the opencode
        // coder tab) can answer 503/500 without involving this surface.
        // Assert the control surface itself is clean: no script errors, no
        // failed /ws/ request, no console error from the chat transport.
        const controlConsoleErrors = consoleErrors.filter((text) =>
            /control|protobuf|hydrate|websocket|\/ws\//i.test(text),
        );
        expect(pageErrors).toEqual([]);
        expect(controlConsoleErrors).toEqual([]);
        expect(
            failedRequests.filter((entry) => entry.includes('/ws/')),
        ).toEqual([]);
    } finally {
        await phi.stop();
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
});
