import {
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
    expect,
    test,
    type Locator,
    type Page,
    type Request,
    type Route,
    type TestInfo,
} from '@playwright/test';
import {
    ControlClientFrame,
    ControlServerFrame,
} from '../web/proto/control.js';
import { resultFromWire, stateFromWire } from '../web/chat-pi/control-wire.js';
import type {
    ControlClientFrame as ControlClientMessage,
    ControlServerFrame as ControlServerMessage,
    MessageFns,
    StateChangedEvent,
} from '../web-src/proto/control.js';
import { configToToml, startPhi, type PhiServer } from './_server.js';
import {
    isCancelledSessionListRead,
    isCancelledWorktreeRead,
} from './_session-requests.js';

// The served codec carries no types; bind its runtime decoders to the
// generated declarations so spec-side decoding is fully checked.
const ClientCodec: MessageFns<ControlClientMessage> =
    ControlClientFrame as unknown as MessageFns<ControlClientMessage>;
const ServerCodec: MessageFns<ControlServerMessage> =
    ControlServerFrame as unknown as MessageFns<ControlServerMessage>;

const historyText = 'Known synthetic M1 history entry';
const renamedTitle = 'M1 atomic rename';
const tokenFields = [
    'inputTokens',
    'outputTokens',
    'contextUsedTokens',
    'contextWindowTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
] as const;
const requiredNumericFields = [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
] as const;

type JsonObject = Record<string, unknown>;

type ControlFrame = JsonObject & {
    t?: string;
    id?: string;
    op?: string;
    ok?: boolean;
    error?: string;
    evt?: string;
    sid?: string;
    seq?: number;
    args?: { name?: unknown };
    data?: unknown;
};

type ControlResult = {
    ok: boolean;
    error?: string;
    data?: unknown;
};

type StateJson = JsonObject & {
    title?: string;
    status?: string;
    sessionPath?: string | null;
    inputTokens?: unknown;
    outputTokens?: unknown;
    contextUsedTokens?: unknown;
    contextWindowTokens?: unknown;
    cacheReadTokens?: unknown;
    cacheWriteTokens?: unknown;
};

type SpawnData = JsonObject & {
    sid?: string;
    title?: string;
    state?: StateJson;
    snapshot?: { messages?: unknown[] };
};

type RenameData = JsonObject & { state?: StateJson };

type HydrateData = JsonObject & {
    lastSeq?: number;
    messages?: unknown[];
    state?: StateJson;
};

type ResetData = JsonObject & {
    cancelled?: boolean;
    reset?: boolean;
    state?: StateJson;
};

type Fixture = {
    phi: PhiServer;
    sessionID: string;
    initialTitle: string;
    sessionPath: string;
    cliMarker: string;
    piPidFile: string;
};

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

function piProjectDirectory(home: string, cwd: string): string {
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
    sessionID: string,
    initialTitle: string,
): string {
    const directory = piProjectDirectory(home, cwd);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${sessionID}.jsonl`);
    const entries = [
        { type: 'session', version: 3, id: sessionID, cwd },
        { type: 'session_info', name: initialTitle },
        {
            type: 'message',
            id: `${sessionID}-history-root`,
            parentId: null,
            message: {
                role: 'user',
                content: [{ type: 'text', text: historyText }],
            },
        },
    ];
    writeFileSync(
        path,
        `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );
    return path;
}

// The installed .bin/pi is a shell shim that execs Node with the package's
// bundle. A live child's command line therefore contains the resolved bundle
// path, never the shim. The shim records that target in its final comment.
function piCliMarker(piBin: string): string {
    const shim = readFileSync(piBin, 'utf8');
    const target = /cmd-shim-target=(.+)$/m.exec(shim)?.[1]?.trim();
    if (!target) throw new Error(`cannot read the pi CLI target from ${piBin}`);
    const marker = target.slice(target.indexOf('@'));
    if (!marker.includes('pi-coding-agent')) {
        throw new Error(`unexpected pi CLI target: ${target}`);
    }
    return marker;
}

function requireFrame(
    frames: ControlFrame[],
    match: (frame: ControlFrame) => boolean,
    label: string,
): ControlFrame {
    const found = frames.find(match);
    if (!found) throw new Error(`missing ${label}`);
    return found;
}

function requireState(state: StateJson | undefined, label: string): StateJson {
    if (!state) throw new Error(`${label} carried no state`);
    return state;
}

type WirePayload = string | Buffer;

function frameBytes(payload: WirePayload): Uint8Array {
    return new Uint8Array(
        typeof payload === 'string' ? Buffer.from(payload) : payload,
    );
}

// Typed frames decoded from the generated control codec, projected onto the
// flat view the assertions below read. The JSON envelope is gone from the
// wire, so this projection exists only in this spec.
function clientFrames(frames: WirePayload[]): ControlFrame[] {
    return frames.flatMap((payload): ControlFrame[] => {
        const frame = ClientCodec.decode(frameBytes(payload));
        const body = frame.payload;
        if (body?.$case !== 'call') return [];
        const call = body.value;
        const variant = call.call;
        if (!variant) return [];
        return [
            {
                t: 'call',
                id: call.id,
                op: variant.$case,
                args: { ...(variant.value as JsonObject) },
            },
        ];
    });
}

function serverFrames(frames: WirePayload[]): ControlFrame[] {
    return frames.flatMap((payload): ControlFrame[] => {
        const frame = ServerCodec.decode(frameBytes(payload));
        const body = frame.payload;
        if (body?.$case === 'response') {
            const response = body.value;
            const result = response.result;
            if (!result) return [];
            if (result.$case === 'error')
                return [
                    {
                        t: 'res',
                        id: response.id,
                        ok: false,
                        error: result.value.reason,
                    },
                ];
            return [
                {
                    t: 'res',
                    id: response.id,
                    ok: true,
                    data: resultFromWire(result.$case, response),
                },
            ];
        }
        if (body?.$case === 'event') {
            const event = body.value;
            const variant = event.event;
            if (!variant) return [];
            const change =
                variant.$case === 'stateChanged'
                    ? (variant.value as StateChangedEvent).change
                    : undefined;
            return [
                {
                    t: 'evt',
                    sid: event.sid,
                    seq: Number(event.seq),
                    evt: variant.$case,
                    data:
                        change?.$case === 'state'
                            ? stateFromWire(change.value)
                            : variant.value,
                },
            ];
        }
        return [];
    });
}

function stateMetadata(
    state: StateJson,
): Record<(typeof tokenFields)[number], number | null> {
    const metadata = {} as Record<(typeof tokenFields)[number], number | null>;
    for (const field of requiredNumericFields) {
        const value = state[field];
        expect(
            value,
            `${field} must be numeric without a provider call`,
        ).toEqual(expect.any(Number));
        metadata[field] = value as number;
    }
    for (const field of ['contextUsedTokens', 'contextWindowTokens'] as const) {
        const value = state[field];
        expect(value === null || typeof value === 'number').toBe(true);
        metadata[field] = value as number | null;
    }
    return metadata;
}

function controlSocketUrl(url: string): string {
    return `${url.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')}/ws/control`;
}

// callControl runs one hello/call exchange from the page against the fixture
// server. It is supplemental protocol evidence; the UI flow above it stays
// untouched and no state is injected into the page.
async function callControl(
    page: Page,
    url: string,
    op: string,
    sid: string,
    args: JsonObject,
): Promise<ControlResult> {
    return page.evaluate(
        async ({ socketUrl, opName, sessionSid, callArgs }) => {
            // The page loads the served modules, so this supplemental client
            // speaks exactly the wire the UI speaks. The specifiers stay in
            // variables so the compiler does not resolve them as files.
            const codecUrl: string = '/proto/control.js';
            const wireUrl: string = '/chat-pi/control-wire.js';
            const { ControlClientFrame, ControlServerFrame } = await import(
                codecUrl
            );
            const { resultFromWire } = await import(wireUrl);
            return await new Promise<ControlResult>((resolve, reject) => {
                const socket = new WebSocket(
                    socketUrl,
                    'phi.control.protobuf.v1',
                );
                socket.binaryType = 'arraybuffer';
                const id = `m2-${opName}`;
                const timer = window.setTimeout(() => {
                    socket.close();
                    reject(new Error(`timed out waiting for ${opName}`));
                }, 15_000);
                const finish = (
                    error: Error | null,
                    result?: ControlResult,
                ): void => {
                    window.clearTimeout(timer);
                    socket.close();
                    if (error) reject(error);
                    else if (result) resolve(result);
                    else reject(new Error(`${opName} returned no result`));
                };
                socket.onerror = () =>
                    finish(new Error(`${opName} WebSocket failed`));
                socket.onopen = () =>
                    socket.send(
                        ControlClientFrame.encode({
                            payload: { $case: 'hello', value: { version: 1 } },
                        }).finish(),
                    );
                socket.onmessage = (event) => {
                    const frame = ControlServerFrame.decode(
                        new Uint8Array(event.data as ArrayBuffer),
                    );
                    if (frame.payload?.$case === 'welcome') {
                        socket.send(
                            ControlClientFrame.encode({
                                payload: {
                                    $case: 'call',
                                    value: {
                                        id,
                                        call: {
                                            $case: opName as never,
                                            value: {
                                                ...callArgs,
                                                sid: sessionSid,
                                            },
                                        },
                                    },
                                },
                            }).finish(),
                        );
                        return;
                    }
                    if (frame.payload?.$case !== 'response') return;
                    const response = frame.payload.value;
                    if (response.id !== id) return;
                    const result = response.result;
                    if (!result) {
                        finish(new Error(`${opName} returned no result`));
                        return;
                    }
                    if (result.$case === 'error') {
                        finish(null, { ok: false, error: result.value.reason });
                        return;
                    }
                    finish(null, {
                        ok: true,
                        data: resultFromWire(
                            result.$case,
                            response,
                        ) as ControlResult['data'],
                    });
                };
            });
        },
        {
            socketUrl: controlSocketUrl(url),
            opName: op,
            sessionSid: sid,
            callArgs: args,
        },
    );
}

async function hydrateOverControl(
    page: Page,
    url: string,
    sid: string,
): Promise<HydrateData> {
    const result = await callControl(page, url, 'hydrate', sid, {});
    if (!result.ok)
        throw new Error(`hydrate failed: ${result.error ?? 'unknown'}`);
    return result.data as HydrateData;
}

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function processCommand(pid: number): string {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
    }).trim();
}

async function waitForExit(pid: number, deadlineMs: number): Promise<boolean> {
    const deadline = Date.now() + deadlineMs;
    while (processAlive(pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !processAlive(pid);
}

// reapChild runs after the fixture stopped Phi. Phi's shutdown owns the Pi
// child, so the expected result is that it already exited; a survivor is
// signalled only when its command line matches the recorded identity.
async function reapChild(
    pid: number,
    cliMarker: string,
    sessionPath: string,
): Promise<string> {
    if (await waitForExit(pid, 10_000)) {
        return `Pi child ${pid} exited with the Phi fixture`;
    }
    const identity = processCommand(pid);
    if (
        !identity.includes(cliMarker) ||
        !identity.includes('--mode') ||
        !identity.includes('rpc') ||
        !identity.includes(sessionPath)
    ) {
        throw new Error(
            `refusing to signal unverified PID ${pid}: ${identity}`,
        );
    }
    process.kill(pid, 'SIGTERM');
    if (!(await waitForExit(pid, 5_000))) {
        if (processCommand(pid) !== identity) {
            throw new Error(`PID ${pid} changed ownership before cleanup`);
        }
        process.kill(pid, 'SIGKILL');
        if (!(await waitForExit(pid, 5_000))) {
            throw new Error(`verified Pi child ${pid} did not exit`);
        }
    }
    return `verified Pi child ${pid} exited after a signal`;
}

async function startFixture(sessionID: string): Promise<Fixture> {
    const initialTitle = `${sessionID} synthetic session`;
    const piBin = realpathSync(
        join(process.cwd(), 'node_modules', '.bin', 'pi'),
    );
    const cliMarker = piCliMarker(piBin);
    const fixtureEnv: Record<string, string> = {
        PI_OFFLINE: '1',
        PI_SKIP_VERSION_CHECK: '1',
        PATH: process.env.PATH ?? '',
    };
    let sessionPath = '';
    const phi = await startPhi({
        env: fixtureEnv,
        setup(dir) {
            const home = join(dir, 'home');
            const fixtureCwd = realpathSync(dir);
            const piBinDir = join(dir, 'bin');
            mkdirSync(piBinDir, { recursive: true });
            fixtureEnv.PATH = `${piBinDir}:${process.env.PATH ?? ''}`;
            writeFileSync(
                join(piBinDir, 'pi'),
                `#!/bin/sh\nprintf '%s\\n' "$$" > "$HOME/pi-child.pid"\nexec ${shellQuote(piBin)} --offline --no-extensions --no-skills --no-prompt-templates --no-context-files --no-approve --model anthropic/claude-sonnet-4-5 "$@"\n`,
                { mode: 0o755 },
            );
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
                join(home, '.phi', 'config.toml'),
                configToToml({
                    workspaces: [fixtureCwd],
                    active_cwd: fixtureCwd,
                }),
            );
            sessionPath = writeSession(
                home,
                fixtureCwd,
                sessionID,
                initialTitle,
            );
        },
    });
    return {
        phi,
        sessionID,
        initialTitle,
        sessionPath,
        cliMarker,
        piPidFile: join(phi.dir, 'home', 'pi-child.pid'),
    };
}

async function openPiSession(
    page: Page,
    fixture: Fixture,
    afterCoderSelect?: () => Promise<void>,
): Promise<Locator> {
    await page.locator('#coder-selector .coder-tab[data-coder="pi"]').click();
    await afterCoderSelect?.();
    const sessionRow = page.locator(
        `.session-item[data-session-id="${fixture.sessionID}"]`,
    );
    await expect(sessionRow.locator('.review-btn')).toHaveAttribute(
        'aria-label',
        'Open Pi RPC',
    );
    await expect(sessionRow.locator('.session-title')).toHaveText(
        fixture.initialTitle,
    );
    // The action bar is hover-only (opacity/pointer-events), so hover the row
    // first exactly as a user does before clicking Open Pi RPC.
    await sessionRow.hover();
    await sessionRow.locator('.review-btn').click();
    const paneId = `pi-rpc:session:${encodeURIComponent(fixture.sessionPath)}`;
    const tab = page.locator(`.tab[data-pane-id="${paneId}"]`);
    await expect(tab.locator('.tab-title')).toHaveText(fixture.initialTitle);
    await expect(page.locator('.review-chat-wrapper')).toContainText(
        historyText,
    );
    return tab;
}

async function waitForSpawn(
    sentFrames: WirePayload[],
    receivedFrames: WirePayload[],
): Promise<SpawnData> {
    await expect
        .poll(() => {
            const calls = clientFrames(sentFrames);
            const responses = serverFrames(receivedFrames);
            const spawn = calls.find(
                (frame) => frame.t === 'call' && frame.op === 'spawn',
            );
            return spawn &&
                responses.find(
                    (frame) =>
                        frame.t === 'res' && frame.id === spawn.id && frame.ok,
                )
                ? 'spawn response observed'
                : '';
        })
        .toBe('spawn response observed');
    const spawnCall = clientFrames(sentFrames)
        .filter((frame) => frame.t === 'call' && frame.op === 'spawn')
        .at(-1);
    const spawnResponse = serverFrames(receivedFrames).find(
        (frame) => frame.t === 'res' && frame.id === spawnCall?.id && frame.ok,
    );
    if (!spawnResponse)
        throw new Error('real control spawn response is missing');
    return spawnResponse.data as SpawnData;
}

async function finishFixture(
    testInfo: TestInfo,
    fixture: Fixture | undefined,
    piPid: number | undefined,
    summary: JsonObject,
    browserErrors: JsonObject & {
        consoleErrors: string[];
        pageErrors: string[];
        failedRequests: string[];
        nonLoopbackRequests: string[];
    },
): Promise<void> {
    // Browser health is sampled while the fixture still serves requests:
    // stopping the server makes the page's periodic polls fail, which is
    // teardown noise rather than a product error. The samples are asserted
    // after cleanup so a failing check cannot leak the fixture.
    const observed = {
        consoleErrors: [...browserErrors.consoleErrors],
        pageErrors: [...browserErrors.pageErrors],
        failedRequests: [...browserErrors.failedRequests],
        nonLoopbackRequests: [...browserErrors.nonLoopbackRequests],
    };

    const serverLog =
        fixture && existsSync(fixture.phi.logPath)
            ? readFileSync(fixture.phi.logPath, 'utf8')
            : '';
    await testInfo.attach('server.log', {
        body: serverLog,
        contentType: 'text/plain',
    });
    let cleanup = 'fixture was not started';
    if (fixture) {
        try {
            // Phi owns the Pi child: stop the server first and let its
            // shutdown reap the child before any fallback signal.
            await fixture.phi.stop();
            cleanup = piPid
                ? await reapChild(piPid, fixture.cliMarker, fixture.sessionPath)
                : 'Pi child was not started';
        } catch (error) {
            summary.cleanupError = String(error);
        }
    }
    summary.cleanup = cleanup;
    Object.assign(summary, observed);
    await testInfo.attach('summary', {
        body: JSON.stringify(summary, null, 2),
        contentType: 'application/json',
    });
    expect(observed.consoleErrors, 'browser console errors').toEqual([]);
    expect(observed.pageErrors, 'browser page errors').toEqual([]);
    expect(observed.failedRequests, 'failed browser requests').toEqual([]);
    expect(observed.nonLoopbackRequests, 'requests outside loopback').toEqual(
        [],
    );
    expect(summary.cleanupError, 'owned process cleanup').toBeUndefined();
}

test('M1 real offline Pi rename keeps metadata and the later hydrate coherent', async ({
    page,
    request,
}, testInfo) => {
    test.setTimeout(180_000);
    const sentFrames: WirePayload[] = [];
    const receivedFrames: WirePayload[] = [];
    const browserErrors: JsonObject & {
        consoleErrors: string[];
        pageErrors: string[];
        failedRequests: string[];
        nonLoopbackRequests: string[];
    } = {
        consoleErrors: [],
        pageErrors: [],
        failedRequests: [],
        nonLoopbackRequests: [],
    };
    const summary: JsonObject = { assertions: [] };
    let cleanupFixture: Fixture | undefined;
    let piPid: number | undefined;
    try {
        const fixture = await startFixture('m1-state-session');
        cleanupFixture = fixture;
        const updatedEnv = await request.post(
            `${fixture.phi.url}/api/config/sync-coordinator`,
            {
                data: { sync_coordinator: fixture.phi.url },
            },
        );
        expect(updatedEnv.ok()).toBe(true);
        page.on('websocket', (socket) => {
            if (new URL(socket.url()).pathname !== '/ws/control') return;
            socket.on('framesent', (event) => sentFrames.push(event.payload));
            socket.on('framereceived', (event) =>
                receivedFrames.push(event.payload),
            );
        });
        page.on('console', (message) => {
            if (message.type() !== 'error') return;
            const url = new URL(message.location().url || fixture.phi.url);
            // The isolated home has no OpenCode database or update checker.
            // These unrelated optional services already fail without this flow.
            if (
                url.pathname === '/api/update/status' &&
                message.text().includes('503')
            )
                return;
            if (
                url.pathname === '/api/sessions' &&
                url.searchParams.get('coder') === 'opencode' &&
                message.text().includes('500')
            )
                return;
            browserErrors.consoleErrors.push(message.text());
        });
        page.on('pageerror', (error) =>
            browserErrors.pageErrors.push(error.message),
        );
        page.on('requestfailed', (failed) => {
            if (
                isCancelledSessionListRead(failed, fixture.phi.url) ||
                isCancelledWorktreeRead(failed, fixture.phi.url)
            )
                return;
            browserErrors.failedRequests.push(
                `${failed.method()} ${failed.url()} ${failed.failure()?.errorText ?? ''}`,
            );
        });
        await page.route('**/*', async (route) => {
            const url = new URL(route.request().url());
            if (url.hostname !== '127.0.0.1') {
                browserErrors.nonLoopbackRequests.push(route.request().url());
                await route.abort();
                return;
            }
            await route.continue();
        });

        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(fixture.phi.url);
        const tab = await openPiSession(page, fixture);
        await expect
            .poll(() => existsSync(fixture.piPidFile), { timeout: 20_000 })
            .toBe(true);
        piPid = Number(readFileSync(fixture.piPidFile, 'utf8').trim());
        expect(Number.isSafeInteger(piPid) && piPid > 0).toBe(true);

        const spawnData = await waitForSpawn(sentFrames, receivedFrames);
        const stateBefore = requireState(spawnData.state, 'spawn response');
        expect(spawnData.title).toBe(stateBefore.title);
        // M4: the opening title is Pi's native session name, hydrated from the
        // first get_state, not a phi-owned label.
        expect(stateBefore.title).toBe(fixture.initialTitle);
        const metadataBefore = stateMetadata(stateBefore);
        expect(JSON.stringify(spawnData.snapshot?.messages ?? [])).toContain(
            historyText,
        );

        const tabTitle = tab.locator('.tab-title');
        await tabTitle.dblclick();
        const renameInput = tab.locator('input.rename-input.tab-title');
        await expect(renameInput).toBeVisible();
        await renameInput.fill(renamedTitle);
        const sentBeforeRename = sentFrames.length;
        await renameInput.press('Enter');
        await expect(tab.locator('.tab-title')).toHaveText(renamedTitle);

        await expect
            .poll(() => {
                const calls = clientFrames(sentFrames.slice(sentBeforeRename));
                return (
                    calls.find(
                        (frame) =>
                            frame.t === 'call' &&
                            frame.op === 'setSessionName' &&
                            frame.args?.name === renamedTitle,
                    )?.id ?? ''
                );
            })
            .not.toBe('');
        const renameCall = requireFrame(
            clientFrames(sentFrames.slice(sentBeforeRename)),
            (frame) =>
                frame.t === 'call' &&
                frame.op === 'setSessionName' &&
                frame.args?.name === renamedTitle,
            'setSessionName call',
        );
        await expect
            .poll(() => {
                const response = serverFrames(receivedFrames).find(
                    (frame) => frame.t === 'res' && frame.id === renameCall.id,
                );
                return response
                    ? response.ok
                        ? ((response.data as RenameData).state?.title ?? '')
                        : `error:${response.error}`
                    : '';
            })
            .toBe(renamedTitle);
        const renameAck = requireFrame(
            serverFrames(receivedFrames),
            (frame) => frame.t === 'res' && frame.id === renameCall.id,
            'setSessionName acknowledgement',
        );
        expect(renameAck.ok).toBe(true);
        const ackState = requireState(
            (renameAck.data as RenameData).state,
            'rename response',
        );
        expect(ackState.title).toBe(renamedTitle);
        expect(stateMetadata(ackState)).toEqual(metadataBefore);

        // M4: the label change arrives as a sequenced native state event that
        // agrees with the control response. Publication before the response is
        // asserted deterministically in pkg/rpc, not by frame arrival order:
        // events and responses can travel on different sockets.
        const hasRenameEvent = (frame: ControlFrame): boolean =>
            frame.t === 'evt' &&
            frame.evt === 'stateChanged' &&
            (frame.data as StateJson | undefined)?.title === renamedTitle;
        await expect
            .poll(() => {
                const frames = serverFrames(receivedFrames);
                const event = frames.find(hasRenameEvent);
                const ack = frames.find(
                    (frame) => frame.t === 'res' && frame.id === renameCall.id,
                );
                return event && ack ? 'both' : '';
            })
            .toBe('both');
        const renameEvent = requireFrame(
            serverFrames(receivedFrames),
            hasRenameEvent,
            'native rename stateChanged',
        );
        expect(renameEvent.sid).toBe(String(spawnData.sid));
        expect(renameEvent.seq).toEqual(expect.any(Number));
        expect((renameEvent.data as StateJson).title).toBe(ackState.title);

        // The accepted title reaches saved Pi RPC tab storage.
        const savedTabs = await page.evaluate(() =>
            JSON.parse(localStorage.getItem('phi_pi_rpc_tabs') ?? '[]'),
        );
        expect(savedTabs).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ title: renamedTitle }),
            ]),
        );

        const sid = String(spawnData.sid);
        expect(sid).not.toBe('');
        const hydrate = await hydrateOverControl(page, fixture.phi.url, sid);
        expect(hydrate.state?.title).toBe(renamedTitle);
        expect(
            stateMetadata(requireState(hydrate.state, 'hydrate response')),
        ).toEqual(metadataBefore);
        expect(hydrate.lastSeq).toEqual(expect.any(Number));
        expect(JSON.stringify(hydrate.messages ?? [])).toContain(historyText);
        await page.screenshot({
            path: testInfo.outputPath('m1-real-pi-rename.png'),
            fullPage: true,
        });

        // A reload must restore the same native title from saved tab storage and
        // the resume transcript from the session file.
        const paneId = await tab.getAttribute('data-pane-id');
        expect(paneId).toBeTruthy();
        await page.reload();
        const reloadedTab = page.locator(`.tab[data-pane-id="${paneId}"]`);
        await expect(reloadedTab.locator('.tab-title')).toHaveText(
            renamedTitle,
        );
        await expect(page.locator('.review-chat-wrapper')).toContainText(
            historyText,
        );

        summary.assertions = [
            'Open Pi RPC from the actual session list',
            'the opening title is the native session name from get_state',
            'real offline Pi accepted correlated setSessionName',
            'a sequenced native state event agrees with the control response',
            'tab title, response State title, numeric metadata, and final hydrate agree',
            'the accepted title is saved in Pi RPC tab storage',
            'a reload restores the native title and the resume transcript',
            'resume transcript remains in the paired final hydrate',
        ];
        summary.sessionId = fixture.sessionID;
        summary.renameCallId = renameCall.id;
        summary.sid = sid;
        summary.metadata = metadataBefore;
        summary.hydrateLastSeq = hydrate.lastSeq;
    } finally {
        await finishFixture(
            testInfo,
            cleanupFixture,
            piPid,
            summary,
            browserErrors,
        );
    }
});

test('M2 real offline Pi reset invalidates the old boundary exactly once', async ({
    page,
    request,
}, testInfo) => {
    test.setTimeout(180_000);
    const sentFrames: WirePayload[] = [];
    const receivedFrames: WirePayload[] = [];
    const browserErrors: JsonObject & {
        consoleErrors: string[];
        pageErrors: string[];
        failedRequests: string[];
        nonLoopbackRequests: string[];
    } = {
        consoleErrors: [],
        pageErrors: [],
        failedRequests: [],
        nonLoopbackRequests: [],
    };
    const summary: JsonObject = { assertions: [] };
    let cleanupFixture: Fixture | undefined;
    let piPid: number | undefined;
    try {
        const fixture = await startFixture('m2-state-session');
        cleanupFixture = fixture;
        const updatedEnv = await request.post(
            `${fixture.phi.url}/api/config/sync-coordinator`,
            {
                data: { sync_coordinator: fixture.phi.url },
            },
        );
        expect(updatedEnv.ok()).toBe(true);
        page.on('websocket', (socket) => {
            if (new URL(socket.url()).pathname !== '/ws/control') return;
            socket.on('framesent', (event) => sentFrames.push(event.payload));
            socket.on('framereceived', (event) =>
                receivedFrames.push(event.payload),
            );
        });
        page.on('console', (message) => {
            if (message.type() !== 'error') return;
            const url = new URL(message.location().url || fixture.phi.url);
            // The isolated home has no OpenCode database or update checker.
            // These unrelated optional services already fail without this flow.
            if (
                url.pathname === '/api/update/status' &&
                message.text().includes('503')
            )
                return;
            if (
                url.pathname === '/api/sessions' &&
                url.searchParams.get('coder') === 'opencode' &&
                message.text().includes('500')
            )
                return;
            browserErrors.consoleErrors.push(message.text());
        });
        page.on('pageerror', (error) =>
            browserErrors.pageErrors.push(error.message),
        );
        page.on('requestfailed', (failed) => {
            if (
                isCancelledSessionListRead(failed, fixture.phi.url) ||
                isCancelledWorktreeRead(failed, fixture.phi.url)
            )
                return;
            browserErrors.failedRequests.push(
                `${failed.method()} ${failed.url()} ${failed.failure()?.errorText ?? ''}`,
            );
        });
        await page.route('**/*', async (route) => {
            if (new URL(route.request().url()).hostname !== '127.0.0.1') {
                browserErrors.nonLoopbackRequests.push(route.request().url());
                await route.abort();
                return;
            }
            await route.continue();
        });

        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(fixture.phi.url);
        await openPiSession(page, fixture);
        await expect
            .poll(() => existsSync(fixture.piPidFile), { timeout: 20_000 })
            .toBe(true);
        piPid = Number(readFileSync(fixture.piPidFile, 'utf8').trim());
        expect(Number.isSafeInteger(piPid) && piPid > 0).toBe(true);

        const spawnData = await waitForSpawn(sentFrames, receivedFrames);
        const sid = String(spawnData.sid);
        expect(sid).not.toBe('');

        const before = await hydrateOverControl(page, fixture.phi.url, sid);
        const beforeSeq = Number(before.lastSeq);
        expect(Number.isSafeInteger(beforeSeq)).toBe(true);
        expect(JSON.stringify(before.messages ?? [])).toContain(historyText);
        expect(before.state?.sessionPath).toBe(fixture.sessionPath);

        const reset = await callControl(
            page,
            fixture.phi.url,
            'newSession',
            sid,
            {},
        );
        expect(reset.ok, `reset error: ${reset.error ?? ''}`).toBe(true);
        const resetData = reset.data as ResetData;
        expect(resetData.cancelled).toBe(false);
        expect(resetData.reset).toBe(true);

        const after = await hydrateOverControl(page, fixture.phi.url, sid);
        const afterSeq = Number(after.lastSeq);
        expect(afterSeq).toBeGreaterThan(beforeSeq);
        expect(JSON.stringify(after.messages ?? [])).not.toContain(historyText);
        expect(after.state?.sessionPath ?? '').toBe('');

        const resetEvents = serverFrames(receivedFrames).filter(
            (frame) =>
                frame.t === 'evt' &&
                frame.sid === sid &&
                frame.evt === 'transcriptReset',
        );
        expect(resetEvents).toHaveLength(1);
        expect(Number(resetEvents[0].seq)).toBeGreaterThan(beforeSeq);
        await page.screenshot({
            path: testInfo.outputPath('m2-real-pi-reset.png'),
            fullPage: true,
        });

        summary.assertions = [
            'real offline Pi session opened from the session list',
            'pre-reset hydrate carried the resume path and the synthetic transcript',
            'real control newSession returned cancelled:false reset:true',
            'the later hydrate shows one reset boundary, no old transcript, no stale path',
        ];
        summary.sessionId = fixture.sessionID;
        summary.sid = sid;
        summary.beforeSeq = beforeSeq;
        summary.afterSeq = afterSeq;
        summary.resetSeq = resetEvents[0].seq;
    } finally {
        await finishFixture(
            testInfo,
            cleanupFixture,
            piPid,
            summary,
            browserErrors,
        );
    }
});

test('M3 real offline Pi UI reset clears the transcript, keeps narrow and keyboard behavior', async ({
    page,
    request,
}, testInfo) => {
    test.setTimeout(180_000);
    const sentFrames: WirePayload[] = [];
    const receivedFrames: WirePayload[] = [];
    const browserErrors: JsonObject & {
        consoleErrors: string[];
        pageErrors: string[];
        failedRequests: string[];
        nonLoopbackRequests: string[];
    } = {
        consoleErrors: [],
        pageErrors: [],
        failedRequests: [],
        nonLoopbackRequests: [],
    };
    const summary: JsonObject = { assertions: [] };
    let cleanupFixture: Fixture | undefined;
    let piPid: number | undefined;
    let heldSessionRequest: Request | undefined;
    let heldSessionFailure:
        | { method: string; url: string; errorText: string }
        | undefined;
    let releaseHeldSessionRead = () => {};
    const heldSessionReadRelease = new Promise<void>((resolve) => {
        releaseHeldSessionRead = resolve;
    });
    let holdOldCoderSessionRead: ((route: Route) => Promise<void>) | undefined;
    try {
        const fixture = await startFixture('m3-state-session');
        cleanupFixture = fixture;
        const updatedEnv = await request.post(
            `${fixture.phi.url}/api/config/sync-coordinator`,
            {
                data: { sync_coordinator: fixture.phi.url },
            },
        );
        expect(updatedEnv.ok()).toBe(true);
        page.on('websocket', (socket) => {
            if (new URL(socket.url()).pathname !== '/ws/control') return;
            socket.on('framesent', (event) => sentFrames.push(event.payload));
            socket.on('framereceived', (event) =>
                receivedFrames.push(event.payload),
            );
        });
        page.on('console', (message) => {
            if (message.type() !== 'error') return;
            const url = new URL(message.location().url || fixture.phi.url);
            if (
                url.pathname === '/api/update/status' &&
                message.text().includes('503')
            )
                return;
            if (
                url.pathname === '/api/sessions' &&
                url.searchParams.get('coder') === 'opencode' &&
                message.text().includes('500')
            )
                return;
            browserErrors.consoleErrors.push(message.text());
        });
        page.on('pageerror', (error) =>
            browserErrors.pageErrors.push(error.message),
        );
        holdOldCoderSessionRead = async (route) => {
            const request = route.request();
            const url = new URL(request.url());
            if (
                heldSessionRequest === undefined &&
                request.method() === 'GET' &&
                url.origin === new URL(fixture.phi.url).origin &&
                url.pathname === '/api/sessions' &&
                url.searchParams.get('coder') === 'opencode'
            ) {
                heldSessionRequest = request;
                await heldSessionReadRelease;
            }
            await route.fallback();
        };
        page.on('requestfailed', (failed) => {
            if (failed === heldSessionRequest) {
                heldSessionFailure = {
                    method: failed.method(),
                    url: failed.url(),
                    errorText: failed.failure()?.errorText ?? '',
                };
            }
            if (
                isCancelledSessionListRead(failed, fixture.phi.url) ||
                isCancelledWorktreeRead(failed, fixture.phi.url)
            )
                return;
            browserErrors.failedRequests.push(
                `${failed.method()} ${failed.url()} ${failed.failure()?.errorText ?? ''}`,
            );
        });
        await page.route('**/*', async (route) => {
            if (new URL(route.request().url()).hostname !== '127.0.0.1') {
                browserErrors.nonLoopbackRequests.push(route.request().url());
                await route.abort();
                return;
            }
            await route.continue();
        });
        if (!holdOldCoderSessionRead)
            throw new Error('M3 session-read hold route was not initialized');
        await page.route('**/*', holdOldCoderSessionRead);

        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(fixture.phi.url);
        await expect
            .poll(() => heldSessionRequest?.url() ?? '', { timeout: 10_000 })
            .not.toBe('');
        const oldCoderRequest = heldSessionRequest;
        if (!oldCoderRequest)
            throw new Error('M3 old-coder session request was not held');
        expect(oldCoderRequest.method()).toBe('GET');
        const oldCoderUrl = new URL(oldCoderRequest.url());
        expect(oldCoderUrl.origin).toBe(new URL(fixture.phi.url).origin);
        expect(oldCoderUrl.pathname).toBe('/api/sessions');
        expect(oldCoderUrl.searchParams.get('coder')).toBe('opencode');
        await openPiSession(page, fixture, async () => {
            releaseHeldSessionRead();
            await expect
                .poll(() => heldSessionFailure?.errorText ?? '', {
                    timeout: 10_000,
                })
                .toBe('net::ERR_ABORTED');
        });
        expect(heldSessionFailure?.method).toBe('GET');

        await expect
            .poll(() => existsSync(fixture.piPidFile), { timeout: 20_000 })
            .toBe(true);
        piPid = Number(readFileSync(fixture.piPidFile, 'utf8').trim());

        const spawnData = await waitForSpawn(sentFrames, receivedFrames);
        const sid = String(spawnData.sid);
        const paneId = `pi-rpc:session:${encodeURIComponent(fixture.sessionPath)}`;
        const tab = page.locator(`.tab[data-pane-id="${paneId}"]`);
        const wrapper = page.locator('.review-chat-wrapper');
        await expect(wrapper).toContainText(historyText);

        // Escape cancels the rename editor without a control call.
        await tab.locator('.tab-title').dblclick();
        const renameInput = tab.locator('input.rename-input.tab-title');
        await expect(renameInput).toBeVisible();
        await renameInput.fill('M3 cancelled rename');
        await renameInput.press('Escape');
        await expect(tab.locator('.tab-title')).toHaveText(
            fixture.initialTitle,
        );
        expect(
            clientFrames(sentFrames).filter(
                (frame) =>
                    frame.t === 'call' &&
                    frame.op === 'setSessionName' &&
                    frame.args?.name === 'M3 cancelled rename',
            ),
        ).toHaveLength(0);

        // Narrow layout keeps the pane and its reset control usable.
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(wrapper).toBeVisible();
        const resetButton = page.locator('.pi-rpc-reset-btn');
        await expect(resetButton).toBeVisible();
        await expect(resetButton).toHaveAttribute(
            'title',
            'Reset Chat — fresh conversation',
        );
        await page.setViewportSize({ width: 1440, height: 900 });

        const before = await hydrateOverControl(page, fixture.phi.url, sid);
        const beforeSeq = Number(before.lastSeq);
        expect(JSON.stringify(before.messages ?? [])).toContain(historyText);
        expect(before.state?.sessionPath).toBe(fixture.sessionPath);

        // Reset through the existing preset control, as a user does.
        page.once('dialog', (dialog) => {
            void dialog.accept();
        });
        const resetCallBefore = clientFrames(sentFrames).filter(
            (frame) => frame.op === 'newSession',
        ).length;
        await resetButton.click();
        await expect(wrapper).not.toContainText(historyText);
        await expect
            .poll(
                () =>
                    clientFrames(sentFrames).filter(
                        (frame) => frame.op === 'newSession',
                    ).length,
            )
            .toBe(resetCallBefore + 1);

        const after = await hydrateOverControl(page, fixture.phi.url, sid);
        expect(Number(after.lastSeq)).toBeGreaterThan(beforeSeq);
        expect(JSON.stringify(after.messages ?? [])).not.toContain(historyText);
        expect(after.state?.sessionPath ?? '').toBe('');
        await expect(wrapper).not.toContainText(historyText);
        await page.screenshot({
            path: testInfo.outputPath('m3-real-pi-ui-reset.png'),
            fullPage: true,
        });

        summary.assertions = [
            'the held old-coder GET ended with net::ERR_ABORTED after coder selection',
            'Escape cancelled the rename without a control call',
            'the reset control stayed visible at a 390-pixel viewport',
            'UI Clear drove a real newSession and cleared the transcript',
            'the later hydrate has no old transcript and no stale resume path',
        ];
        summary.heldSessionListRead = heldSessionFailure;
        summary.sessionId = fixture.sessionID;
        summary.sid = sid;
        summary.beforeSeq = beforeSeq;
    } finally {
        try {
            releaseHeldSessionRead();
        } finally {
            try {
                if (holdOldCoderSessionRead)
                    await page.unroute('**/*', holdOldCoderSessionRead);
            } finally {
                summary.heldSessionListRead = heldSessionFailure ?? null;
                await finishFixture(
                    testInfo,
                    cleanupFixture,
                    piPid,
                    summary,
                    browserErrors,
                );
            }
        }
    }
});
