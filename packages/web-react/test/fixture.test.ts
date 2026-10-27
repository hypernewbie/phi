import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
    nextPid: 810000,
    nextPort: 18000,
    mode: '',
    children: [] as Array<
        EventEmitter & {
            pid: number;
            stdout: PassThrough;
            stderr: PassThrough;
            exitCode: number | null;
        }
    >,
    groups: new Set<number>(),
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

beforeEach(() => {
    fake.children.length = 0;
    fake.groups.clear();
    fake.mode = '';
    fake.execFileSync.mockReset().mockReturnValue('');
    fake.spawn.mockReset().mockImplementation((command: string) => {
        const child = Object.assign(new EventEmitter(), {
            pid: ++fake.nextPid,
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            exitCode: null as number | null,
        });
        fake.children.push(child);
        fake.groups.add(child.pid);
        queueMicrotask(() => {
            if (fake.mode === `${command}-error`) {
                fake.groups.delete(child.pid);
                child.emit('error', new Error('mock spawn failed'));
            } else if (command === 'go' && fake.mode !== 'build-timeout') {
                child.exitCode = fake.mode === 'build-failure' ? 1 : 0;
                fake.groups.delete(child.pid);
                child.emit('exit', child.exitCode, null);
            } else if (
                command !== 'go' &&
                command !== 'pnpm' &&
                fake.mode === 'phi-exit'
            ) {
                child.exitCode = 1;
                fake.groups.delete(child.pid);
                child.emit('exit', 1, null);
            } else if (command === 'pnpm') {
                if (fake.mode === 'foreign-vite') {
                    child.exitCode = 1;
                    fake.groups.delete(child.pid);
                    child.emit('exit', 1, null);
                } else if (fake.mode !== 'vite-timeout')
                    child.stdout.write('Local: http://127.0.0.1:5173/');
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
        TMPDIR: '/fixture/tmp',
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

it('owns local coordinator/config, sanitized children, bounded logs, and idempotent cleanup', async () => {
    const stack = await startFoundationStack();
    expect(stack.reactUrl).toBe('http://127.0.0.1:5173');
    const phiOptions = fake.spawn.mock.calls[1]?.[2];
    const dir = join(phiOptions.cwd, '..');
    const config = JSON.parse(
        readFileSync(join(dir, 'home/.phi/config.json'), 'utf8'),
    );
    expect(config).toMatchObject({
        auto_reconnect: 'off',
        peers: [],
        pushover_enabled: false,
        webhook_enabled: false,
        simplepush_enabled: false,
    });
    expect(config.sync_coordinator).toMatch(/^http:\/\/127\.0\.0\.1:18\d+$/);
    expect(config.sync_coordinator).not.toContain(':7070');
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
    expect(fake.spawn.mock.calls[2]?.[2]?.env.PHI_PORT).toBe(
        new URL(stack.phiUrl).port,
    );
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
    'pnpm-error',
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
        if (mode === 'phi-timeout')
            vi.mocked(fetch).mockResolvedValue(
                new Response('not ready', { status: 503 }),
            );
        const result = startFoundationStack();
        const assertion = expect(result).rejects.toThrow(/timed out/);
        await vi.advanceTimersByTimeAsync(milliseconds);
        await assertion;
        expect(fake.groups.size).toBe(0);
    },
);

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
        fake.execFileSync.mockReturnValue('810999 Z\n991234 S\n');
        await expect(stopOwnedGroup(810999)).resolves.toBeUndefined();
        expect(process.kill).toHaveBeenCalledExactlyOnceWith(-810999, 0);
        fake.execFileSync.mockReturnValue('810999 S\n');
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
