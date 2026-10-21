// Go ↔ TypeScript interop over native Unix IPC. Spawns the Go
// testserver, drives 64 independent synthetic runtimes, and asserts
// auth, lifecycle isolation, slow-peer, and endpoint behavior with
// explicit gRPC codes. No mocks, no TCP, no fake timers.

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { LogicalState, RunOutcome, StateSnapshot } from '../src/gen/bridge.js';
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
    } = {},
): Promise<{ client: BridgeTestClient; process: string }> {
    const { process, token } = await registerPane(pane);
    await control({ op: 'complete', process });
    const client = new BridgeTestClient({
        target,
        pane,
        process,
        token: opts.token ?? token,
        capabilities: opts.capabilities,
        sessionId: opts.sessionId ?? `sess-${pane}`,
        runtimeId: opts.runtimeId ?? `rt-${pane}`,
        state: StateSnapshot.create({
            state: LogicalState.LOGICAL_STATE_IDLE,
            sessionId: opts.sessionId ?? `sess-${pane}`,
            leafId: `leaf-${pane}`,
            stateRevision: 0n,
        }),
    });
    return { client, process };
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
