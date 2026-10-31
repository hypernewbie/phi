import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, accessSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { startPhi } from '../e2e/_server.ts';

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        mkdtempSync: vi.fn(),
        mkdirSync: vi.fn(),
        writeFileSync: vi.fn(),
        appendFileSync: vi.fn(),
        rmSync: vi.fn(),
        accessSync: vi.fn(),
        statSync: vi.fn(),
        readFileSync: vi.fn(() => Buffer.from('fixture binary')),
        realpathSync: vi.fn((path) => path),
    };
});

vi.mock('node:os', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, tmpdir: vi.fn() };
});

vi.mock('node:net', () => ({
    default: { createServer: vi.fn() },
    createServer: vi.fn(),
}));

vi.mock('node:child_process', () => ({
    spawn: vi.fn(),
    execFileSync: vi.fn(),
}));
let nextPid = 100;

class FakeChild {
    constructor() {
        this.pid = nextPid++;
        queueMicrotask(() => this.emit('spawn'));
        this.exitCode = null;
        this.signalCode = null;
        this.killCalls = [];
        this.handlers = new Map();
        this.stdout = { on: vi.fn() };
        this.stderr = { on: vi.fn() };
    }

    on(event, cb) {
        const list = this.handlers.get(event) || [];
        list.push(cb);
        this.handlers.set(event, list);
        return this;
    }

    once(event, cb) {
        const list = this.handlers.get(event) || [];
        list.push((...args) => {
            this.handlers.set(
                event,
                (this.handlers.get(event) || []).filter((h) => h !== cb),
            );
            cb(...args);
        });
        this.handlers.set(event, list);
        return this;
    }

    emit(event, ...args) {
        for (const cb of [...(this.handlers.get(event) || [])]) cb(...args);
    }

    kill(signal) {
        const sig = signal === undefined ? 'SIGTERM' : signal;
        this.killCalls.push(sig);
        // Like Node: a signal kill leaves exitCode null and sets
        // signalCode; killing a dead child emits nothing.
        if (this.exitCode === null && this.signalCode === null) {
            this.signalCode = sig;
            this.emit('exit', null, sig);
        }
        return true;
    }
}

// Native join: the fixture builds these with node:path, so the
// expectations must use native separators on Windows too.
const DIR = join('/fake-tmp', 'pe-ABCDEF');
const HOME = join(DIR, 'home');
const RUNTMP = join(DIR, 't');

let realFetch;

beforeEach(() => {
    vi.clearAllMocks();
    realFetch = global.fetch;
    tmpdir.mockReturnValue('/fake-tmp');
    mkdtempSync.mockImplementation((prefix) => `${prefix}ABCDEF`);
    mkdirSync.mockReturnValue(undefined);
    accessSync.mockReturnValue(undefined);
    statSync.mockReturnValue({ isDirectory: () => true, mode: 0o40700 });
    execFileSync.mockImplementation((cmd, args) => {
        if (cmd === 'git')
            return args[0] === 'status' ? '' : 'fixture-revision';
        if (cmd === 'go') return 'fixture-go-build';
        if (cmd === 'ps') return `start-${args[1]}`;
        if (args.includes('-d')) return `n${join(DIR, 'phi')}\n`;
        return 'n127.0.0.1:45678\n';
    });
    net.createServer.mockImplementation(() => ({
        listen: (_port, _host, cb) => cb(),
        address: () => ({ port: 45678 }),
        close: (cb) => cb(),
    }));
    spawn.mockImplementation((cmd) => {
        const child = new FakeChild();
        if (cmd === 'go') queueMicrotask(() => child.emit('exit', 0));
        return child;
    });
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
});

afterEach(() => {
    global.fetch = realFetch;
    delete process.env.F1_PROBE_OUTER;
    vi.useRealTimers();
});

function serverSpawn() {
    const call = spawn.mock.calls.find(([cmd]) => cmd !== 'go');
    expect(call).toBeDefined();
    return call;
}

describe('startPhi fixture isolation', () => {
    test('setup failure removes the dir and spawns nothing', async () => {
        const boom = new Error('setup boom');
        await expect(
            startPhi({ setup: () => Promise.reject(boom) }),
        ).rejects.toThrow('setup boom');
        expect(spawn).not.toHaveBeenCalled();
        expect(rmSync).toHaveBeenCalledTimes(1);
        expect(rmSync).toHaveBeenCalledWith(
            DIR,
            expect.objectContaining({ recursive: true }),
        );
    });

    test('build failure removes the dir and never launches', async () => {
        spawn.mockImplementation((cmd) => {
            const child = new FakeChild();
            if (cmd === 'go') queueMicrotask(() => child.emit('exit', 1));
            return child;
        });
        await expect(startPhi()).rejects.toThrow('go exited 1');
        expect(spawn.mock.calls.every(([cmd]) => cmd === 'go')).toBe(true);
        expect(rmSync).toHaveBeenCalledTimes(1);
    });

    // Unix-only: Windows uses named pipes with no socket budget.
    test.skipIf(process.platform === 'win32')(
        'long temp root rejects before any spawn',
        async () => {
            tmpdir.mockReturnValue(`/${'l'.repeat(200)}`);
            await expect(startPhi()).rejects.toThrow(
                /cannot host a 100-byte bridge socket/,
            );
            expect(spawn).not.toHaveBeenCalled();
            expect(rmSync).toHaveBeenCalledTimes(1);
        },
    );

    test('windows skips POSIX mode and socket-budget checks', async () => {
        const realPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32' });
        try {
            // Both reject on Unix; named pipes need neither check.
            tmpdir.mockReturnValue(`/${'l'.repeat(200)}`);
            statSync.mockReturnValue({
                isDirectory: () => true,
                mode: 0o40755,
            });
            const phi = await startPhi();
            expect(phi.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
            await phi.stop();
            expect(statSync).not.toHaveBeenCalled();
        } finally {
            Object.defineProperty(process, 'platform', {
                value: realPlatform,
            });
        }
    });

    test('unwritable temp root rejects before any spawn', async () => {
        accessSync.mockImplementation(() => {
            throw new Error('EACCES');
        });
        await expect(startPhi()).rejects.toThrow('EACCES');
        expect(spawn).not.toHaveBeenCalled();
        expect(rmSync).toHaveBeenCalledTimes(1);
    });

    // Unix-only: Windows has no POSIX privacy bit.
    test.skipIf(process.platform === 'win32')(
        'non-private temp root rejects before any spawn',
        async () => {
            statSync.mockReturnValue({
                isDirectory: () => true,
                mode: 0o40755,
            });
            await expect(startPhi()).rejects.toThrow(/not a private dir/);
            expect(spawn).not.toHaveBeenCalled();
            expect(rmSync).toHaveBeenCalledTimes(1);
        },
    );

    test('health failure reaps the child, removes the dir, returns no handle', async () => {
        vi.useFakeTimers();
        global.fetch = vi.fn().mockRejectedValue(new Error('down'));
        const pending = startPhi();
        const assertion = expect(pending).rejects.toThrow(
            'phi server never came up',
        );
        await vi.advanceTimersByTimeAsync(91_000);
        await assertion;
        const [, , opts] = serverSpawn();
        expect(opts.cwd).toBe(DIR);
        const child = spawn.mock.results
            .map((r) => r.value)
            .find((c) => c.killCalls.length > 0);
        expect(child).toBeDefined();
        expect(child.killCalls).toEqual(['SIGTERM']);
        expect(rmSync).toHaveBeenCalledTimes(1);
    });

    test('health failure after a signal exit still removes the dir', async () => {
        vi.useFakeTimers();
        global.fetch = vi.fn().mockRejectedValue(new Error('down'));
        let serverChild;
        spawn.mockImplementation((cmd) => {
            const child = new FakeChild();
            if (cmd === 'go') queueMicrotask(() => child.emit('exit', 0));
            else {
                serverChild = child;
                // The OS reaped the child by signal before health
                // failed: exitCode stays null, signalCode is set, and
                // the exit event already fired.
                queueMicrotask(() => {
                    child.signalCode = 'SIGTERM';
                    child.emit('exit', null, 'SIGTERM');
                });
            }
            return child;
        });
        const pending = startPhi();
        const assertion = expect(pending).rejects.toThrow(
            /exited during startup/,
        );
        await vi.advanceTimersByTimeAsync(91_000);
        await assertion;
        expect(serverChild.killCalls).toEqual([]);
        expect(rmSync).toHaveBeenCalledTimes(1);
    });

    test('server env is allowlisted with owned paths winning', async () => {
        process.env.F1_PROBE_OUTER = 'leak';
        const phi = await startPhi({
            env: {
                PHI_SHUTDOWN_GRACE: '1s',
                PHI_E2E_VERIFY_OWNERSHIP: '1',
                HOME: '/evil',
                TMPDIR: '/evil',
            },
        });
        const [, , opts] = serverSpawn();
        expect(opts.env.PATH).toBe(process.env.PATH);
        expect(opts.env.F1_PROBE_OUTER).toBeUndefined();
        expect(opts.env.PHI_SHUTDOWN_GRACE).toBe('1s');
        expect(opts.env.PHI_E2E_VERIFY_OWNERSHIP).toBeUndefined();
        expect(opts.env.HOME).toBe(HOME);
        expect(opts.env.USERPROFILE).toBe(HOME);
        expect(opts.env.APPDATA).toBe(HOME);
        expect(opts.env.TMPDIR).toBe(RUNTMP);
        expect(opts.env.TMP).toBe(RUNTMP);
        expect(opts.env.TEMP).toBe(RUNTMP);
        const buildCall = spawn.mock.calls.find(([cmd]) => cmd === 'go');
        expect(buildCall).toBeDefined();
        expect('env' in buildCall[2]).toBe(false);
        await phi.stop();
    });

    test('stop terminates the child and removes the dir exactly once', async () => {
        const phi = await startPhi();
        const child = serverSpawn() && spawn.mock.results[1].value;
        await phi.stop();
        await phi.stop();
        expect(child.killCalls).toEqual(['SIGTERM']);
        expect(rmSync).toHaveBeenCalledTimes(1);
    });

    test('restart replaces the child and stop still cleans once', async () => {
        const phi = await startPhi();
        const first = spawn.mock.results[1].value;
        expect(phi.pid()).toBe(first.pid);
        expect(phi.identity.pid).toBe(first.pid);
        const before = phi.identity;
        await phi.restart();
        expect(first.killCalls).toEqual(['SIGTERM']);
        expect(spawn).toHaveBeenCalledTimes(3);
        const second = spawn.mock.results[2].value;
        expect(phi.pid()).toBe(second.pid);
        expect(phi.identity).toEqual({
            ...before,
            pid: second.pid,
            startTime: `start-${second.pid}`,
        });
        expect(second.exitCode).toBeNull();
        await phi.stop();
        expect(second.killCalls).toEqual(['SIGTERM']);
        expect(rmSync).toHaveBeenCalledTimes(1);
    });

    test('failed restart reaps the new child and removes the dir', async () => {
        const phi = await startPhi();
        vi.useFakeTimers();
        global.fetch = vi.fn().mockRejectedValue(new Error('down'));
        const pending = phi.restart();
        const assertion = expect(pending).rejects.toThrow(
            'phi server never came up',
        );
        await vi.advanceTimersByTimeAsync(91_000);
        await assertion;
        const second = spawn.mock.results[2].value;
        expect(second.killCalls).toEqual(['SIGTERM']);
        expect(rmSync).toHaveBeenCalledTimes(1);
        await phi.stop();
        expect(rmSync).toHaveBeenCalledTimes(1);
        await expect(phi.restart()).rejects.toThrow('already disposed');
    });

    test.skipIf(process.platform === 'win32')(
        'foreign listener cannot pass readiness',
        async () => {
            vi.useFakeTimers();
            execFileSync.mockImplementation((cmd, args) => {
                if (cmd === 'git')
                    return args[0] === 'status' ? '' : 'revision';
                if (cmd === 'go') return 'fixture-go-build';
                if (cmd === 'ps') return `start-${args[1]}`;
                if (args.includes('-d')) return `n${join(DIR, 'phi')}\n`;
                const err = new Error('owned child has no listener');
                err.status = 1;
                throw err;
            });
            const pending = startPhi();
            const assertion = expect(pending).rejects.toThrow(
                /exited during startup/,
            );
            await vi.advanceTimersByTimeAsync(500);
            const child = spawn.mock.results[1].value;
            child.signalCode = 'SIGTERM';
            child.emit('exit', null, 'SIGTERM');
            await vi.advanceTimersByTimeAsync(500);
            await assertion;
            expect(global.fetch).not.toHaveBeenCalled();
            expect(child.killCalls).toEqual([]);
            expect(rmSync).toHaveBeenCalledOnce();
        },
    );

    test.skipIf(process.platform === 'win32')(
        'identity change prevents cleanup from signaling or deleting',
        async () => {
            const phi = await startPhi();
            execFileSync.mockImplementation((cmd, args) =>
                cmd === 'ps' ? 'reused-pid-start' : `n${join(DIR, 'phi')}\n`,
            );
            await expect(phi.stop()).rejects.toThrow(/PID was reused/);
            expect(spawn.mock.results[1].value.killCalls).toEqual([]);
            expect(rmSync).not.toHaveBeenCalled();
        },
    );

    test('child exit while health is in flight cannot pass readiness', async () => {
        global.fetch = vi.fn().mockImplementation(async () => {
            const child = spawn.mock.results[1].value;
            child.signalCode = 'SIGTERM';
            child.emit('exit', null, 'SIGTERM');
            return { ok: true };
        });
        await expect(startPhi()).rejects.toThrow(/exited during startup/);
        expect(rmSync).toHaveBeenCalledOnce();
    });

    test('restart after stop fails fast without spawning', async () => {
        const phi = await startPhi();
        await phi.stop();
        const calls = spawn.mock.calls.length;
        await expect(phi.restart()).rejects.toThrow('already disposed');
        expect(spawn.mock.calls.length).toBe(calls);
    });
});
