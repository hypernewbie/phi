import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
    existsSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
    nextPid: 810000,
    nextPort: 18000,
    mode: '',
    revision: '0123456789abcdef0123456789abcdef01234567',
    modified: 'false',
    psAxo: '',
    children: [] as Array<
        EventEmitter & {
            pid: number;
            exe: string;
            stdout: PassThrough;
            stderr: PassThrough;
            exitCode: number | null;
        }
    >,
    groups: new Set<number>(),
    listeners: new Map<number, number>(),
    foreignListeners: new Set<number>(),
    starts: new Map<number, string>(),
    spawn: vi.fn(),
    execFileSync: vi.fn(),
    createServer: vi.fn(),
}));
vi.mock('node:child_process', () => ({
    spawn: fake.spawn,
    execFileSync: fake.execFileSync,
}));
vi.mock('node:http', () => ({ createServer: fake.createServer }));

import {
    buildEnvironment,
    runtimeEnvironment,
    startFoundationStack,
    stopOwnedGroup,
} from './e2e/phi-server.ts';

const isViteSpawn = (command: string, args: string[]) =>
    command === process.execPath && (args[0] ?? '').endsWith('vite.js');

const socketPort = (args: string[]): number => {
    const arg = args.find((entry) => entry.startsWith('-iTCP@')) ?? '';
    return Number(arg.split(':')[1] ?? NaN);
};

beforeEach(() => {
    fake.children.length = 0;
    fake.groups.clear();
    fake.listeners.clear();
    fake.foreignListeners.clear();
    fake.starts.clear();
    fake.mode = '';
    fake.modified = 'false';
    fake.psAxo = '';
    fake.execFileSync
        .mockReset()
        .mockImplementation((command: string, args: string[]) => {
            if (command === 'git') return `${fake.revision}\n`;
            if (command === 'go')
                return (
                    `\tbuild\tvcs.revision=${fake.revision}\n` +
                    `\tbuild\tvcs.modified=${fake.modified}\n`
                );
            if (command === '/bin/ps' && args[0] === '-axo') return fake.psAxo;
            if (command === '/bin/ps') {
                const pid = Number(args[1]);
                return fake.starts.get(pid) ?? `fixture start ${pid}\n`;
            }
            const flag = args.indexOf('-p');
            if (args.includes('-d')) {
                const pid = Number(args[flag + 1]);
                const child = fake.children.find((entry) => entry.pid === pid);
                const exe = child?.exe ?? '';
                return exe ? `p${pid}\nn${exe}\n` : '';
            }
            if (args.includes('-sTCP:LISTEN')) {
                if (flag >= 0) {
                    const pid = Number(args[flag + 1]);
                    return fake.listeners.has(pid) ? `p${pid}\n` : '';
                }
                const port = socketPort(args);
                const owned = [...fake.listeners]
                    .filter(([, listenPort]) => listenPort === port)
                    .map(([pid]) => pid);
                return [...owned, ...fake.foreignListeners]
                    .map((pid) => `p${pid}\n`)
                    .join('');
            }
            return '';
        });
    fake.spawn
        .mockReset()
        .mockImplementation((command: string, args: string[] = []) => {
            const child = Object.assign(new EventEmitter(), {
                pid: ++fake.nextPid,
                exe:
                    command === 'go'
                        ? command
                        : isViteSpawn(command, args)
                          ? realpathSync(process.execPath)
                          : realpathSync(command),
                stdout: new PassThrough(),
                stderr: new PassThrough(),
                exitCode: null as number | null,
            });
            fake.children.push(child);
            fake.groups.add(child.pid);
            const vite = isViteSpawn(command, args);
            const portIndex = args.indexOf('--port');
            if (portIndex >= 0)
                fake.listeners.set(child.pid, Number(args[portIndex + 1]));
            queueMicrotask(() => {
                const fail = (message: string) => {
                    fake.groups.delete(child.pid);
                    fake.listeners.delete(child.pid);
                    child.emit('error', new Error(message));
                };
                const exit = (code: number, signal: null | string = null) => {
                    fake.groups.delete(child.pid);
                    fake.listeners.delete(child.pid);
                    child.exitCode = code;
                    child.emit('exit', code, signal);
                };
                if (
                    fake.mode === `${command}-error` ||
                    (vite && fake.mode === 'vite-error')
                ) {
                    fail('mock spawn failed');
                } else if (command === 'go' && fake.mode !== 'build-timeout') {
                    if (fake.mode === 'build-failure') exit(1);
                    else {
                        const out = args[args.indexOf('-o') + 1];
                        if (out) writeFileSync(out, 'mock-phi-binary');
                        exit(0);
                    }
                } else if (vite) {
                    if (fake.mode === 'foreign-vite') exit(1);
                } else if (command !== 'go' && fake.mode === 'phi-exit') {
                    exit(1);
                }
            });
            return child;
        });
    fake.createServer.mockReset().mockImplementation(() => {
        const server = Object.assign(new EventEmitter(), {
            listen: vi.fn((_port: number, _host: string, done: () => void) => {
                queueMicrotask(() =>
                    fake.mode === 'listen-error'
                        ? server.emit('error', new Error('listen failed'))
                        : done(),
                );
            }),
            address: () => ({ port: ++fake.nextPort }),
            closeAllConnections: vi.fn(),
            close: vi.fn((done: (error?: Error) => void) => done()),
        });
        return server;
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (!fake.groups.has(-pid))
            throw Object.assign(new Error('no group'), { code: 'ESRCH' });
        if (signal !== 0) {
            fake.groups.delete(-pid);
            fake.listeners.delete(-pid);
            const child = fake.children.find((entry) => entry.pid === -pid);
            if (child) {
                child.exitCode = 0;
                child.emit('exit', 0, signal);
            }
        }
        return true;
    });
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
});

it('imports without starting any process or network listener', () => {
    expect(fake.spawn).not.toHaveBeenCalled();
    expect(fake.createServer).not.toHaveBeenCalled();
});

it('allowlists build and runtime environments instead of inheriting credentials/endpoints', () => {
    const source = {
        PATH: '/bin',
        HOME: '/real-home',
        SDKROOT: '/sdk',
        GOCACHE: '/go-cache',
        LANG: 'en_US.UTF-8',
        OPENAI_API_KEY: 'secret',
        HTTPS_PROXY: 'http://foreign.invalid',
        PHI_PORT: '7070',
        GOFLAGS: '-tags=release',
        DEVELOPER_DIR: '/other',
    };
    expect(buildEnvironment(source)).toEqual({
        PATH: '/bin',
        HOME: '/real-home',
        SDKROOT: '/sdk',
        GOCACHE: '/go-cache',
        LANG: 'en_US.UTF-8',
        GOENV: 'off',
    });
    const runtime = runtimeEnvironment(source, '/fixture');
    expect(runtime).toMatchObject({
        HOME: '/fixture/home',
        PATH: '/fixture/bin:/bin',
        TMPDIR: '/fixture/t',
        TMP: '/fixture/t',
        TEMP: '/fixture/t',
    });
    for (const key of [
        'SDKROOT',
        'OPENAI_API_KEY',
        'HTTPS_PROXY',
        'PHI_PORT',
        'GOFLAGS',
        'DEVELOPER_DIR',
        'GOCACHE',
    ])
        expect(runtime).not.toHaveProperty(key);
});

it('owns local coordinator/config, verified children, bounded logs, and idempotent cleanup', async () => {
    const stack = await startFoundationStack();
    const phiPort = new URL(stack.phiUrl).port;
    const vitePort = new URL(stack.reactUrl).port;
    expect(stack.reactUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(vitePort).not.toBe('5173');
    expect(vitePort).not.toBe(phiPort);
    expect(fake.spawn).toHaveBeenCalledTimes(3);
    const phiOptions = fake.spawn.mock.calls[1]?.[2];
    const dir = join(phiOptions.cwd, '..');
    expect(statSync(join(dir, 't')).mode & 0o777).toBe(0o700);
    expect(
        Buffer.byteLength(
            join(join(dir, 't'), `phi-pi-${'f'.repeat(16)}`, 'bridge.sock'),
        ),
    ).toBeLessThanOrEqual(100);
    const config = readFileSync(join(dir, 'home/.phi/config.toml'), 'utf8');
    const value = (key: string) =>
        config.match(new RegExp(`^${key}\\s*=\\s*(.*)$`, 'm'))?.[1];
    expect(value('auto_reconnect')).toBe('"off"');
    expect(value('peers')).toBe('[]');
    expect(value('pushover_enabled')).toBe('false');
    expect(value('webhook_enabled')).toBe('false');
    expect(value('simplepush_enabled')).toBe('false');
    const coordinatorUrl = JSON.parse(value('sync_coordinator') ?? 'null');
    expect(coordinatorUrl).toMatch(/^http:\/\/127\.0\.0\.1:18\d+$/);
    expect(coordinatorUrl).not.toContain(':7070');
    const coordinator = fake.createServer.mock.calls[0]?.[0];
    const response = { writeHead: vi.fn(), end: vi.fn() };
    coordinator({ method: 'GET', url: '/api/sync/messages' }, response);
    expect(response.end).toHaveBeenCalledWith('[]');
    expect(fake.spawn.mock.calls[0]?.[1]).toEqual([
        'build',
        '-o',
        join(dir, 'phi'),
        '.',
    ]);
    for (const call of fake.spawn.mock.calls)
        expect(call[2]).toMatchObject({ detached: true });
    // Vite launches directly under this Node, not through a pnpm wrapper.
    const viteCall = fake.spawn.mock.calls[2];
    expect(viteCall?.[0]).toBe(process.execPath);
    expect(viteCall?.[1]?.[0] ?? '').toMatch(/bin\/vite\.js$/);
    expect(viteCall?.[1]).toContain('--port');
    expect(viteCall?.[1]).toContain(vitePort);
    expect(viteCall?.[2]?.cwd ?? '').toMatch(/packages\/web-react$/);
    expect(viteCall?.[2]?.env?.PHI_PORT).toBe(phiPort);
    expect(fake.spawn.mock.calls.some(([command]) => command === 'pnpm')).toBe(
        false,
    );
    const owner = JSON.parse(
        readFileSync(
            new URL(
                `../../../test-results/web-react/${basename(dir)}/phi-owner.json`,
                import.meta.url,
            ),
            'utf8',
        ),
    );
    expect(owner.pid).toBe(fake.children[1]?.pid);
    expect(owner.processGroup).toBe(fake.children[1]?.pid);
    expect(owner.startTime).toBe(`fixture start ${owner.pid}`);
    expect(owner.executable).toBe(realpathSync(join(dir, 'phi')));
    expect(owner.revision).toBe(fake.revision);
    expect(owner.modified).toBe('false');
    expect(owner.sha256).toBe(
        createHash('sha256').update('mock-phi-binary').digest('hex'),
    );
    expect(owner.bindAddress).toBe('127.0.0.1');
    expect(String(owner.port)).toBe(phiPort);
    expect(owner.dir).toBe(dir);
    fake.children[2]?.stdout.write(Buffer.alloc(100_000, 'x'));
    const stop = stack.stop();
    expect(stack.stop()).toBe(stop);
    await stop;
    expect(existsSync(dir)).toBe(false);
    const log = new URL(
        `../../../test-results/web-react/${basename(dir)}/vite.log`,
        import.meta.url,
    );
    expect(readFileSync(log).byteLength).toBe(65_536);
    expect(fake.groups.size).toBe(0);
    expect(fake.listeners.size).toBe(0);
    const signals = vi.mocked(process.kill).mock.calls;
    expect(
        signals.every(
            ([pid]) =>
                pid < 0 && fake.children.some((child) => child.pid === -pid),
        ),
    ).toBe(true);
});

it.each([
    'build-failure',
    'go-error',
    'listen-error',
    'foreign-vite',
    'vite-error',
    'phi-exit',
])(
    'cleans earlier resources after %s without touching foreign processes',
    async (mode) => {
        fake.mode = mode;
        const foreignPid = 991234;
        fake.groups.add(foreignPid);
        await expect(startFoundationStack()).rejects.toThrow();
        expect(fake.groups).toEqual(new Set([foreignPid]));
        expect(
            vi
                .mocked(process.kill)
                .mock.calls.some(([pid]) => pid === -foreignPid),
        ).toBe(false);
        const runtime = fake.spawn.mock.calls.find(
            ([command]) => command !== 'go',
        )?.[2]?.env;
        if (runtime) expect(existsSync(join(runtime.HOME, '..'))).toBe(false);
    },
);

it.each([
    ['build-timeout', 300_001],
    ['vite-timeout', 30_500],
    ['phi-timeout', 90_500],
] as const)(
    'bounds %s and cleans owned children',
    async (mode, milliseconds) => {
        vi.useFakeTimers();
        fake.mode = mode;
        if (mode !== 'build-timeout')
            vi.mocked(fetch).mockImplementation((input) => {
                const ready =
                    mode === 'vite-timeout' &&
                    String(input).endsWith('/healthz');
                return Promise.resolve(
                    new Response('mock', { status: ready ? 200 : 503 }),
                );
            });
        const result = startFoundationStack();
        const assertion = expect(result).rejects.toThrow(/timed out/);
        await vi.advanceTimersByTimeAsync(milliseconds);
        await assertion;
        expect(fake.groups.size).toBe(0);
    },
);

it('rejects a foreign listener on the fixture port and retains state without signaling it', async () => {
    const foreignPid = 991234;
    fake.groups.add(foreignPid);
    fake.foreignListeners.add(foreignPid);
    const error = await startFoundationStack().catch(
        (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect(aggregateMessages(error).join('\n')).toContain(
        `Foreign listener PID ${foreignPid}`,
    );
    expect(
        vi.mocked(process.kill).mock.calls.some(([pid]) => pid === -foreignPid),
    ).toBe(false);
    const runtime = fake.spawn.mock.calls.find(
        ([command]) => command !== 'go',
    )?.[2]?.env;
    if (runtime) {
        const dir = join(runtime.HOME, '..');
        expect(existsSync(dir)).toBe(true);
        rmSync(dir, { recursive: true, force: true });
    }
});

it('retains owned state when a live group reports EPERM instead of stopping', async () => {
    const stack = await startFoundationStack();
    const dir = join(fake.spawn.mock.calls[1]?.[2]?.cwd, '..');
    const phiPid = fake.children[1]?.pid ?? 0;
    const vitePid = fake.children[2]?.pid ?? 0;
    fake.psAxo = `${phiPid} S\n${vitePid} S\n`;
    vi.mocked(process.kill).mockImplementation(() => {
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    const error = await stack.stop().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(aggregateMessages(error).join('\n')).toContain(
        'Retained owned state',
    );
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, 'phi'))).toBe(true);
    expect(
        vi
            .mocked(process.kill)
            .mock.calls.some(
                ([, signal]) => signal === 'SIGTERM' || signal === 'SIGKILL',
            ),
    ).toBe(false);
    rmSync(dir, { recursive: true, force: true });
});

it('sends no signal when the recorded PID no longer matches its start time', async () => {
    const stack = await startFoundationStack();
    const dir = join(fake.spawn.mock.calls[1]?.[2]?.cwd, '..');
    const phiPid = fake.children[1]?.pid ?? 0;
    fake.starts.set(phiPid, 'reused pid start\n');
    const error = await stack.stop().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(aggregateMessages(error).join('\n')).toContain('identity mismatch');
    expect(existsSync(dir)).toBe(true);
    expect(
        vi
            .mocked(process.kill)
            .mock.calls.some(
                ([pid, signal]) =>
                    pid === -phiPid &&
                    (signal === 'SIGTERM' || signal === 'SIGKILL'),
            ),
    ).toBe(false);
    rmSync(dir, { recursive: true, force: true });
});

it('sends no signal when the recorded listener is gone before TERM', async () => {
    const stack = await startFoundationStack();
    const dir = join(fake.spawn.mock.calls[1]?.[2]?.cwd, '..');
    const phiPid = fake.children[1]?.pid ?? 0;
    fake.listeners.delete(phiPid);
    const error = await stack.stop().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(aggregateMessages(error).join('\n')).toContain(
        'does not own its listener',
    );
    expect(existsSync(dir)).toBe(true);
    expect(
        vi
            .mocked(process.kill)
            .mock.calls.some(
                ([pid, signal]) =>
                    pid === -phiPid &&
                    (signal === 'SIGTERM' || signal === 'SIGKILL'),
            ),
    ).toBe(false);
    rmSync(dir, { recursive: true, force: true });
});

it('enables, rotates, and clears the password with a private setup bearer', async () => {
    const stack = await startFoundationStack();
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.mocked(fetch).mockImplementation((input, init) => {
        const url = String(input);
        if (!url.endsWith('/api/auth/v2/password'))
            return Promise.resolve(new Response('ok'));
        const headers = { ...(init?.headers as Record<string, string>) };
        seen.push({ url, headers });
        const body = JSON.parse(String(init?.body)) as { password: string };
        expect(init?.method).toBe('POST');
        expect(init?.redirect).toBe('error');
        if (body.password === '')
            return Promise.resolve(
                new Response(JSON.stringify({ enabled: false })),
            );
        return Promise.resolve(
            new Response(
                JSON.stringify({
                    enabled: true,
                    token: `token-${seen.length}`,
                }),
            ),
        );
    });
    await stack.setPassword('first-secret');
    await stack.setPassword('second-secret');
    await stack.setPassword('');
    await stack.setPassword('third-secret');
    expect(seen).toHaveLength(4);
    for (const request of seen) {
        expect(request.url).toBe(`${stack.phiUrl}/api/auth/v2/password`);
        expect(request.headers['Content-Type']).toBe('application/json');
        expect(request.headers['X-Phi-Auth']).toBe('v2');
        expect(request.headers).not.toHaveProperty('Cookie');
    }
    expect(seen[0]?.headers).not.toHaveProperty('Authorization');
    expect(seen[1]?.headers.Authorization).toBe('Bearer token-1');
    expect(seen[2]?.headers.Authorization).toBe('Bearer token-2');
    expect(seen[3]?.headers).not.toHaveProperty('Authorization');
    const dir = join(fake.spawn.mock.calls[1]?.[2]?.cwd, '..');
    await stack.stop();
    expect(existsSync(dir)).toBe(false);
});

it('stops the fixture attempt when password setup is unconfirmed', async () => {
    const stack = await startFoundationStack();
    const dir = join(fake.spawn.mock.calls[1]?.[2]?.cwd, '..');
    vi.mocked(fetch).mockImplementation((input) => {
        if (String(input).endsWith('/api/auth/v2/password'))
            return Promise.resolve(new Response('denied', { status: 500 }));
        return Promise.resolve(new Response('ok'));
    });
    await expect(stack.setPassword('secret')).rejects.toThrow(
        'Password setup was not confirmed; stopped the fixture attempt.',
    );
    expect(existsSync(dir)).toBe(false);
    expect(fake.groups.size).toBe(0);
});

it('fails the stage if a coder stub runs, even after successful startup', async () => {
    const stack = await startFoundationStack();
    const dir = join(fake.spawn.mock.calls[1]?.[2]?.cwd, '..');
    writeFileSync(join(dir, 'coder-invocations.log'), 'pi\n');
    await expect(stack.stop()).rejects.toThrow(
        'Foundation fixture cleanup failed.',
    );
    expect(existsSync(dir)).toBe(false);
    expect(fake.groups.size).toBe(0);
});

it.skipIf(process.platform !== 'darwin')(
    'distinguishes zombie-only groups from live permission failures',
    async () => {
        vi.mocked(process.kill).mockImplementation(() => {
            throw Object.assign(new Error('denied'), { code: 'EPERM' });
        });
        fake.psAxo = '810999 Z\n991234 S\n';
        await expect(stopOwnedGroup(810999)).resolves.toBeUndefined();
        expect(process.kill).toHaveBeenCalledExactlyOnceWith(-810999, 0);
        fake.psAxo = '810999 S\n';
        await expect(stopOwnedGroup(810999)).rejects.toThrow('denied');
    },
);

it('escalates only the recorded owned group after ten seconds', async () => {
    vi.useFakeTimers();
    fake.groups.add(810999);
    vi.mocked(process.kill).mockImplementation((pid, signal) => {
        if (!fake.groups.has(-pid))
            throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        if (signal === 'SIGKILL') fake.groups.delete(-pid);
        return true;
    });
    const stop = stopOwnedGroup(810999);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(process.kill).not.toHaveBeenCalledWith(-810999, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(1);
    await stop;
    expect(process.kill).toHaveBeenCalledWith(-810999, 'SIGTERM');
    expect(process.kill).toHaveBeenCalledWith(-810999, 'SIGKILL');
});

function aggregateMessages(error: unknown): string[] {
    const nested = (value: unknown): string[] => {
        if (value instanceof AggregateError)
            return value.errors.flatMap(nested);
        return [value instanceof Error ? value.message : String(value)];
    };
    return nested(error);
}
