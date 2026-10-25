// Go ↔ TypeScript interop over native Unix IPC. Spawns the Go
// testserver, drives 64 independent synthetic runtimes, and asserts
// auth, lifecycle isolation, slow-peer, and endpoint behavior with
// explicit gRPC codes. No mocks, no TCP, no fake timers.

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { status as GrpcStatus } from '@grpc/grpc-js';
import {
    CompactOutcome,
    LogicalState,
    RunOutcome,
    StateSnapshot,
} from '../src/gen/bridge.js';
import { CAPABILITY_COMPACT, CAPABILITY_LIFECYCLE } from '../src/protocol.js';
import { BridgeTestClient } from '../src/test-client.js';

interface ControlResponse {
    ok: boolean;
    error?: string;
    code?: number;
    process?: string;
    token?: string;
    sent?: number;
    active?: number;
    leases?: number;
    hasPeer?: boolean;
    hasState?: boolean;
    state?: number;
    revision?: string;
    journalFirst?: string;
    journalLast?: string;
    journalGap?: boolean;
    generation?: string;
    pubRev?: string;
    call?: string;
    outcome?: string;
    reason?: string;
    requestId?: string;
}

let server: ReturnType<typeof spawn>;
let target = '';
let socketPath = '';
let socketDir = '';
const pendingLines: string[] = [];
const lineWaiters: Array<(line: string) => void> = [];

function onLine(line: string): void {
    const waiter = lineWaiters.shift();
    if (waiter) waiter(line);
    else pendingLines.push(line);
}

function readLine(timeoutMs = 10_000): Promise<string> {
    const queued = pendingLines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error('control read timeout')),
            timeoutMs,
        );
        lineWaiters.push((line: string) => {
            clearTimeout(timer);
            resolve(line);
        });
    });
}

async function control(op: Record<string, unknown>): Promise<ControlResponse> {
    if (!server.stdin) throw new Error('testserver stdin unavailable');
    server.stdin.write(`${JSON.stringify(op)}\n`);
    const line = await readLine();
    return JSON.parse(line) as ControlResponse;
}

async function registerPane(
    pane: string,
): Promise<{ process: string; token: string }> {
    const res = await control({ op: 'register', pane });
    expect(res.ok, `register ${pane}: ${res.error}`).toBe(true);
    return { process: res.process!, token: res.token! };
}

async function makeClient(
    pane: string,
    opts: {
        token?: string;
        capabilities?: string[];
        sessionId?: string;
        runtimeId?: string;
        state?: StateSnapshot;
    } = {},
): Promise<{ client: BridgeTestClient; process: string; token: string }> {
    const { process, token } = await registerPane(pane);
    await control({ op: 'complete', process });
    const sessionId = opts.sessionId ?? `sess-${pane}`;
    const client = new BridgeTestClient({
        target,
        pane,
        process,
        token: opts.token ?? token,
        capabilities: opts.capabilities,
        sessionId,
        runtimeId: opts.runtimeId ?? `rt-${pane}`,
        state:
            opts.state ??
            StateSnapshot.create({
                state: LogicalState.LOGICAL_STATE_IDLE,
                sessionId,
                leafId: `leaf-${pane}`,
                stateRevision: 0n,
            }),
    });
    return { client, process, token };
}

beforeAll(async () => {
    const bin = process.env.PI_PHI_TESTSERVER;
    expect(
        bin,
        'PI_PHI_TESTSERVER must point at the testserver binary',
    ).toBeTruthy();
    server = spawn(bin!, { stdio: ['pipe', 'pipe', 'inherit'] });
    if (!server.stdin || !server.stdout)
        throw new Error('testserver stdio unavailable');
    let buffer = '';
    server.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        for (;;) {
            const idx = buffer.indexOf('\n');
            if (idx < 0) break;
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (line.length > 0) onLine(line);
        }
    });
    const readyLine = await readLine(15_000);
    const ready = JSON.parse(readyLine) as { ready: boolean; target: string };
    expect(ready.ready).toBe(true);
    target = ready.target;
    expect(target.startsWith('unix:/')).toBe(true);
    expect(target).not.toContain('://');
    socketPath = target.slice('unix:'.length);
    socketDir = socketPath.slice(0, socketPath.lastIndexOf('/'));
}, 30_000);

afterAll(async () => {
    if (server && server.exitCode === null) {
        try {
            await control({ op: 'shutdown' });
        } catch {
            server.kill();
        }
        await new Promise((resolve) => server.once('exit', resolve));
    }
    // Socket and directory must be gone after shutdown.
    if (socketPath) {
        expect(() => statSync(socketPath)).toThrow();
        expect(() => statSync(socketDir)).toThrow();
    }
});

describe('endpoint', () => {
    it('uses a private socket with strict modes', () => {
        const sock = statSync(socketPath);
        expect(sock.mode & 0o777).toBe(0o600);
        const dir = statSync(socketDir);
        expect(dir.mode & 0o777).toBe(0o700);
        expect(socketPath.length).toBeLessThanOrEqual(100);
    });
    it('ignores proxy env for local IPC', async () => {
        process.env.https_proxy = 'http://127.0.0.1:9';
        process.env.http_proxy = 'http://127.0.0.1:9';
        try {
            const { client } = await makeClient('pane-proxy');
            const accepted = await client.connect();
            expect(accepted.protocolVersion).toBe(1);
            await client.close();
        } finally {
            delete process.env.https_proxy;
            delete process.env.http_proxy;
        }
    }, 20_000);
});

describe('auth and protocol', () => {
    it('rejects a wrong token', async () => {
        const { process } = await registerPane('pane-bad-token');
        await control({ op: 'complete', process });
        const client = new BridgeTestClient({
            target,
            pane: 'pane-bad-token',
            process,
            token: '0'.repeat(64),
        });
        await expect(client.connect()).rejects.toMatchObject({
            code: GrpcStatus.UNAUTHENTICATED,
        });
        await client.close();
    }, 20_000);
    it('rejects a pane mismatch', async () => {
        const { process, token } = await registerPane('pane-real');
        await control({ op: 'complete', process });
        const client = new BridgeTestClient({
            target,
            pane: 'pane-other',
            process,
            token,
        });
        await expect(client.connect()).rejects.toMatchObject({
            code: GrpcStatus.PERMISSION_DENIED,
        });
        await client.close();
    }, 20_000);
    it('rejects an unsupported version', async () => {
        const { client } = await makeClient('pane-badver');
        client.withHelloOverride({ protocolVersion: 999 });
        await expect(client.connect()).rejects.toMatchObject({
            code: GrpcStatus.FAILED_PRECONDITION,
        });
        await client.close();
    }, 20_000);
});

describe('lifecycle isolation', () => {
    it('runs 64 independent channels with 2048 events', async () => {
        const N = 64;
        const PER = 32;
        const clients: BridgeTestClient[] = [];
        const processes: string[] = [];
        for (let i = 0; i < N; i++) {
            const pane = `pane-iso-${i}`;
            const { client, process } = await makeClient(pane);
            clients.push(client);
            processes.push(process);
        }
        await Promise.all(clients.map((c) => c.connect()));
        for (let i = 0; i < N; i++) {
            for (let seq = 1; seq <= PER; seq++) {
                const run = BigInt(seq);
                if (seq % 2 === 1) clients[i]!.sendStarted(BigInt(seq), run);
                else
                    clients[i]!.sendSettled(
                        BigInt(seq),
                        run - 1n,
                        RunOutcome.RUN_OUTCOME_COMPLETED,
                    );
                if (seq % 8 === 0) await clients[i]!.drain();
            }
        }
        await Promise.all(clients.map((c) => c.drain()));
        // Allow the server to drain all streams.
        await new Promise((r) => setTimeout(r, 1500));
        for (let i = 0; i < N; i++) {
            const view = await control({
                op: 'inspect',
                process: processes[i],
            });
            expect(view.ok).toBe(true);
            expect(view.journalLast).toBe(String(PER));
        }
        const stats = await control({ op: 'stats' });
        expect(stats.active).toBeGreaterThanOrEqual(N);
        await Promise.all(clients.map((c) => c.close()));
    }, 120_000);
});

const COMPACT_CAPABILITIES = [CAPABILITY_LIFECYCLE, CAPABILITY_COMPACT];

function idleReadyState(sessionId: string, leafId: string): StateSnapshot {
    return StateSnapshot.create({
        state: LogicalState.LOGICAL_STATE_IDLE,
        sessionId,
        leafId,
        model: { provider: 'test-provider', model: 'test-model' },
        compactReadiness: {
            idle: true,
            hasPendingMessages: false,
            compactionActive: false,
            bridgePending: false,
        },
        stateRevision: 0n,
    });
}

async function makeCompactClient(pane: string): Promise<{
    client: BridgeTestClient;
    process: string;
    token: string;
}> {
    return makeClient(pane, {
        capabilities: COMPACT_CAPABILITIES,
        state: idleReadyState(`sess-${pane}`, `leaf-${pane}`),
    });
}

async function compactStamps(
    process: string,
): Promise<{ generation: number; pubRev: number }> {
    const view = await control({ op: 'inspect', process });
    expect(view.ok, `stamps: ${view.error}`).toBe(true);
    return {
        generation: Number(view.generation),
        pubRev: Number(view.pubRev),
    };
}

// Dispatch returns immediately with a call id; the caller collects the
// terminal/refused/unknown outcome via waitCompact. Split phases let
// tests hold one op while issuing a second dispatch.
async function dispatchCompact(
    process: string,
    generation: number,
    pubRev: number,
    timeoutMs = 5000,
): Promise<string> {
    const res = await control({
        op: 'compact',
        process,
        generation,
        revision: pubRev,
        timeoutMs,
    });
    expect(res.ok, `dispatch: ${res.error}`).toBe(true);
    return res.call!;
}

async function waitCompact(
    call: string,
    timeoutMs = 10000,
): Promise<ControlResponse> {
    return control({ op: 'compact-wait', call, timeoutMs });
}

describe('compact', () => {
    it('refuses dispatch without the compact capability', async () => {
        const { client, process } = await makeClient('pane-compact-nocap');
        await client.connect();
        const call = await dispatchCompact(process, 0, 0);
        const res = await waitCompact(call);
        expect(res.ok).toBe(false);
        expect(res.error).toContain('capability not negotiated');
        expect(client.receivedCompactRequests()).toBe(0);
        await client.close();
    }, 20_000);

    it('correlates the server ID verbatim and releases on terminal result', async () => {
        const pane = 'pane-compact-echo';
        const { client, process } = await makeCompactClient(pane);
        await client.connect();
        const { generation, pubRev } = await compactStamps(process);
        const call = await dispatchCompact(process, generation, pubRev, 15000);
        const req = await client.awaitCompactRequest();
        expect(req.requestId).toMatch(/^[1-9][0-9]*$/);
        expect(req.expectedSessionId).toBe(`sess-${pane}`);
        expect(req.expectedLeafId).toBe(`leaf-${pane}`);
        expect(req.expectedModel).toMatchObject({
            provider: 'test-provider',
            model: 'test-model',
        });
        // A mistyped ID is dropped: the op stays held and a second
        // dispatch is refused before reaching the host.
        client.sendCompactResult(
            '999999999999',
            CompactOutcome.COMPACT_OUTCOME_COMPLETED,
        );
        await client.drain();
        const dup = await dispatchCompact(process, generation, pubRev, 2000);
        expect((await waitCompact(dup)).error).toBe('refusal:pending');
        expect(client.receivedCompactRequests()).toBe(1);
        // The verbatim echo completes the original waiter.
        client.sendCompactResult(
            req.requestId,
            CompactOutcome.COMPACT_OUTCOME_COMPLETED,
        );
        const res = await waitCompact(call);
        expect(res.ok).toBe(true);
        expect(res.outcome).toBe('COMPACT_OUTCOME_COMPLETED');
        expect(res.requestId).toBe(req.requestId);
        // Released: a fresh dispatch is admitted (it expires unknown
        // with no further result).
        const again = await dispatchCompact(process, generation, pubRev, 500);
        const againRes = await waitCompact(again);
        expect(againRes.ok).toBe(false);
        expect(againRes.error).toMatch(/^unknown:/);
        expect(client.receivedCompactRequests()).toBe(2);
        await client.close();
    }, 30_000);

    it('coerces a foreign result reason to the safe vocabulary', async () => {
        const { client, process } = await makeCompactClient(
            'pane-compact-reason',
        );
        await client.connect();
        const { generation, pubRev } = await compactStamps(process);
        const call = await dispatchCompact(process, generation, pubRev, 15000);
        const req = await client.awaitCompactRequest();
        client.sendCompactResult(
            req.requestId,
            CompactOutcome.COMPACT_OUTCOME_FAILED,
            'not-in-vocab!!',
        );
        const res = await waitCompact(call);
        expect(res.ok).toBe(true);
        expect(res.outcome).toBe('COMPACT_OUTCOME_FAILED');
        // Empty coerces to absent over the JSON control surface.
        expect(res.reason ?? '').toBe('');
        await client.close();
    }, 30_000);

    it('keeps a later request after an expired wait', async () => {
        const { client, process } = await makeCompactClient(
            'pane-compact-expired-wait',
        );
        await client.connect();
        const { generation, pubRev } = await compactStamps(process);
        // Expire a wait BEFORE anything is dispatched: without dropping
        // the dead waiter from the queue, the real request resolves that
        // already-rejected promise and the fresh wait never sees it.
        await expect(client.awaitCompactRequest(50)).rejects.toThrow(
            /deadline/,
        );
        const call = await dispatchCompact(process, generation, pubRev, 15000);
        const req = await client.awaitCompactRequest();
        expect(req.requestId).toMatch(/^[1-9][0-9]*$/);
        expect(client.receivedCompactRequests()).toBe(1);
        client.sendCompactResult(
            req.requestId,
            CompactOutcome.COMPACT_OUTCOME_COMPLETED,
        );
        const res = await waitCompact(call);
        expect(res.ok).toBe(true);
        await client.close();
    }, 30_000);

    it('retains pending across a caller timeout without replay', async () => {
        const { client, process } = await makeCompactClient(
            'pane-compact-timeout',
        );
        await client.connect();
        const { generation, pubRev } = await compactStamps(process);
        const call = await dispatchCompact(process, generation, pubRev, 500);
        const res = await waitCompact(call);
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/^unknown:/);
        expect(res.requestId).toMatch(/^[1-9][0-9]*$/);
        // The op stays unresolved: a retry is refused before the host.
        const retry = await dispatchCompact(process, generation, pubRev, 2000);
        expect((await waitCompact(retry)).error).toBe('refusal:pending');
        expect(client.receivedCompactRequests()).toBe(1);
        await client.close();
    }, 30_000);

    it('retains the op across peer loss and accepts the late result on reconnect', async () => {
        const pane = 'pane-compact-reconnect';
        const sessionId = `sess-${pane}`;
        const runtimeId = `rt-${pane}`;
        const { client, process, token } = await makeCompactClient(pane);
        await client.connect();
        const { generation, pubRev } = await compactStamps(process);
        const call = await dispatchCompact(process, generation, pubRev, 30000);
        const req = await client.awaitCompactRequest();
        await client.close();
        // Peer loss resolves the waiter unknown...
        const lost = await waitCompact(call);
        expect(lost.ok).toBe(false);
        expect(lost.error).toBe(`unknown:${req.requestId}`);
        // ...but a same-generation reconnect keeps the generation and
        // the op, and the server never resends the request.
        const client2 = new BridgeTestClient({
            target,
            pane,
            process,
            token,
            capabilities: COMPACT_CAPABILITIES,
            sessionId,
            runtimeId,
            state: idleReadyState(sessionId, `leaf-${pane}`),
        });
        await client2.connect();
        expect(client2.receivedCompactRequests()).toBe(0);
        const re = await control({ op: 'inspect', process });
        expect(re.generation).toBe('1');
        const stamps2 = await compactStamps(process);
        const retry = await dispatchCompact(
            process,
            stamps2.generation,
            stamps2.pubRev,
            2000,
        );
        expect((await waitCompact(retry)).error).toBe('refusal:pending');
        // The late result on the new stream releases the op.
        client2.sendCompactResult(
            req.requestId,
            CompactOutcome.COMPACT_OUTCOME_COMPLETED,
        );
        await client2.drain();
        let admitted = false;
        for (let i = 0; i < 25 && !admitted; i++) {
            const probe = await dispatchCompact(
                process,
                stamps2.generation,
                stamps2.pubRev,
                200,
            );
            const r = await waitCompact(probe, 5000);
            if (r.ok || r.error?.startsWith('unknown:')) admitted = true;
            else {
                expect(r.error).toBe('refusal:pending');
                await new Promise((r2) => setTimeout(r2, 100));
            }
        }
        expect(admitted, 'late result never released the op').toBe(true);
        // Only the fresh probe request arrived: a new ID, never a resend.
        expect(client2.receivedCompactRequests()).toBe(1);
        const fresh = await client2.awaitCompactRequest();
        expect(fresh.requestId).not.toBe(req.requestId);
        await client2.close();
    }, 60_000);

    it('refuses a duplicate dispatch before host invocation', async () => {
        const { client, process } = await makeCompactClient('pane-compact-dup');
        await client.connect();
        const { generation, pubRev } = await compactStamps(process);
        const first = await dispatchCompact(process, generation, pubRev, 15000);
        const req = await client.awaitCompactRequest();
        const second = await dispatchCompact(process, generation, pubRev, 2000);
        expect((await waitCompact(second)).error).toBe('refusal:pending');
        expect(client.receivedCompactRequests()).toBe(1);
        client.sendCompactResult(
            req.requestId,
            CompactOutcome.COMPACT_OUTCOME_COMPLETED,
        );
        expect((await waitCompact(first)).ok).toBe(true);
        await client.close();
    }, 30_000);
});

describe('slow peer', () => {
    it('bounds one slow reader while others continue', async () => {
        const slow = await makeClient('pane-slow');
        const healthy = await makeClient('pane-healthy');
        await slow.client.connect();
        await healthy.client.connect();
        slow.client.pause();
        const flood = await control({
            op: 'flood',
            process: slow.process,
            count: 32,
        });
        expect(flood.ok).toBe(true);
        const status = await slow.client.awaitStatus();
        expect(status?.code).toBe(GrpcStatus.RESOURCE_EXHAUSTED);
        // Healthy peer continues lifecycle traffic.
        for (let seq = 1; seq <= 4; seq++) {
            healthy.client.sendStarted(BigInt(seq), BigInt(seq));
        }
        await new Promise((r) => setTimeout(r, 500));
        const view = await control({ op: 'inspect', process: healthy.process });
        expect(view.journalLast).toBe('4');
        await slow.client.close();
        await healthy.client.close();
    }, 30_000);
});
