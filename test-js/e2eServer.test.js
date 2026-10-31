import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    mkdtempSync,
    mkdirSync,
    rmSync,
    accessSync,
    statSync,
    writeFileSync,
    readFileSync,
    realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { startPhi } from '../e2e/_server.ts';

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        mkdtempSync: vi.fn(),
        mkdirSync: vi.fn(),
        writeFileSync: vi.fn(),
        appendFileSync: vi.fn(),
        readFileSync: vi.fn(),
        realpathSync: vi.fn(),
        rmSync: vi.fn(),
        accessSync: vi.fn(),
        statSync: vi.fn(),
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
    execFile: vi.fn(),
    execFileSync: vi.fn(),
    spawn: vi.fn(),
}));

let nextPid = 100;
const fakeChildren = new Map();

class FakeChild {
    constructor(executable) {
        this.pid = nextPid++;
        this.executable = executable;
        fakeChildren.set(this.pid, this);
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
        const wrapped = (...args) => {
            this.off(event, wrapped);
            cb(...args);
        };
        return this.on(event, wrapped);
    }

    off(event, cb) {
        this.handlers.set(
            event,
            (this.handlers.get(event) || []).filter(
                (handler) => handler !== cb,
            ),
        );
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
    fakeChildren.clear();
    nextPid = 100;
    realFetch = global.fetch;
    tmpdir.mockReturnValue('/fake-tmp');
    mkdtempSync.mockImplementation((prefix) => `${prefix}ABCDEF`);
    mkdirSync.mockReturnValue(undefined);
    accessSync.mockReturnValue(undefined);
    statSync.mockReturnValue({ isDirectory: () => true, mode: 0o40700 });
    readFileSync.mockReturnValue(Buffer.from('fixture binary'));
    realpathSync.mockImplementation((path) => path);
    execFileSync.mockImplementation((cmd, args) => {
        if (cmd === 'ps') return `start-${args[1]}\n`;
        if (cmd === 'lsof' && args.includes('-d')) {
            const pid = Number(args[args.indexOf('-p') + 1]);
            const child = fakeChildren.get(pid);
            return child ? `p${pid}\nf txt\nn${child.executable}\n` : '';
        }
        if (cmd === 'lsof' && args.includes('-Fp')) {
            const pid = Number(args[args.indexOf('-p') + 1]);
            return fakeChildren.has(pid) ? `p${pid}\n` : '';
        }
        throw new Error(`unexpected execFileSync: ${cmd}`);
    });
    net.createServer.mockImplementation(() => ({
        listen: (_port, _host, cb) => cb(),
        address: () => ({ port: 45678 }),
        close: (cb) => cb(),
    }));
    execFile.mockImplementation((cmd, args, _options, callback) => {
        let stdout = '';
        let error = null;
        if (cmd === 'git' && args[0] === 'rev-parse') {
            stdout = 'fixture-revision\n';
        } else if (cmd === 'git' && args[0] === 'status') {
            stdout = '';
        } else if (cmd === 'go' && args[0] === 'version') {
            stdout = 'go version go1.27.2 fixture\n';
        } else if (cmd === 'ps') {
            const pid = Number(args[1]);
            stdout = `start-${pid}\n`;
        } else if (cmd === 'lsof' && args.includes('-d')) {
            const pid = Number(args[args.indexOf('-p') + 1]);
            const child = fakeChildren.get(pid);
            stdout = child ? `p${pid}\nf txt\nn${child.executable}\n` : '';
            if (!stdout)
                error = Object.assign(new Error('no process'), { code: 1 });
        } else if (cmd === 'lsof' && args.includes('-Fp')) {
            const portArg = args.find((arg) =>
                arg.startsWith('-iTCP@127.0.0.1:'),
            );
            const port = Number(portArg?.split(':').at(-1));
            const child = [...fakeChildren.values()].find(
                (entry) =>
                    entry.executable !== 'go' &&
                    entry.exitCode === null &&
                    entry.signalCode === null &&
                    entry.port === port,
            );
            stdout = child ? `p${child.pid}\n` : '';
            if (!stdout)
                error = Object.assign(new Error('no listener'), { code: 1 });
        } else if (cmd === 'lsof' && args.includes('-sTCP:LISTEN')) {
            const pid = Number(args[args.indexOf('-p') + 1]);
            const child = fakeChildren.get(pid);
            stdout = child
                ? `p${pid}\nf3\nn127.0.0.1:${args
                      .find((arg) => arg.startsWith('-iTCP@'))
                      ?.split(':')
                      .at(-1)}\n`
                : '';
            if (!stdout)
                error = Object.assign(new Error('no listener'), { code: 1 });
        } else if (cmd === 'powershell.exe') {
            const script = args.at(-1);
            if (script.includes('Get-CimInstance')) {
                const pid = Number(/ProcessId = (\d+)/.exec(script)?.[1]);
                const child = fakeChildren.get(pid);
                stdout = JSON.stringify({
                    CreationDate: `start-${pid}`,
                    ExecutablePath: child?.executable ?? '',
                });
            } else {
                const port = Number(/-LocalPort (\d+)/.exec(script)?.[1]);
                const child = [...fakeChildren.values()].find(
                    (entry) =>
                        entry.executable !== 'go' &&
                        entry.exitCode === null &&
                        entry.signalCode === null &&
                        entry.port === port,
                );
                stdout = JSON.stringify(
                    child
                        ? [
                              {
                                  OwningProcess: child.pid,
                                  LocalAddress: '127.0.0.1',
                                  LocalPort: port,
                              },
                          ]
                        : [],
                );
            }
        }
        if (error) callback(error, '', '');
        else callback(null, stdout, '');
        return {};
    });
    spawn.mockImplementation((cmd, args = []) => {
        const child = new FakeChild(cmd);
        if (cmd === 'go') queueMicrotask(() => child.emit('exit', 0));
        else child.port = Number(args[args.indexOf('--port') + 1]);
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
    test('setup failure retains the dir and spawns nothing', async () => {
        const boom = new Error('setup boom');
        await expect(
            startPhi({ setup: () => Promise.reject(boom) }),
        ).rejects.toThrow('setup boom');
        expect(spawn).not.toHaveBeenCalled();
        expect(rmSync).not.toHaveBeenCalled();
        rmSync(DIR, { recursive: true, force: true });
        expect(rmSync).toHaveBeenCalledWith(
            DIR,
            expect.objectContaining({ recursive: true }),
        );
    });

    test('build failure retains the dir and never launches', async () => {
        spawn.mockImplementation((cmd) => {
            const child = new FakeChild(cmd);
            if (cmd === 'go') queueMicrotask(() => child.emit('exit', 1));
            return child;
        });
        await expect(startPhi()).rejects.toThrow('go exited 1');
        expect(spawn.mock.calls.every(([cmd]) => cmd === 'go')).toBe(true);
        expect(rmSync).not.toHaveBeenCalled();
        rmSync(DIR, { recursive: true, force: true });
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
            expect(rmSync).not.toHaveBeenCalled();
            rmSync(DIR, { recursive: true, force: true });
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
        expect(rmSync).not.toHaveBeenCalled();
        rmSync(DIR, { recursive: true, force: true });
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
            expect(rmSync).not.toHaveBeenCalled();
            rmSync(DIR, { recursive: true, force: true });
        },
    );

    test('health failure reaps the child and retains the dir without a handle', async () => {
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
        expect(rmSync).not.toHaveBeenCalled();
        rmSync(DIR, { recursive: true, force: true });
    });

    test('startup child exit retains evidence without signaling', async () => {
        let serverChild;
        spawn.mockImplementation((cmd, args = []) => {
            const child = new FakeChild(cmd);
            if (cmd === 'go') queueMicrotask(() => child.emit('exit', 0));
            else {
                child.port = Number(args[args.indexOf('--port') + 1]);
                serverChild = child;
                // The OS reaped the child before identity capture:
                // signalCode is set and the exit event has fired.
                queueMicrotask(() => {
                    child.signalCode = 'SIGTERM';
                    child.emit('exit', null, 'SIGTERM');
                });
            }
            return child;
        });
        const pending = startPhi();
        await expect(pending).rejects.toThrow('fixture server exited');
        expect(serverChild.killCalls).toEqual([]);
        expect(rmSync).not.toHaveBeenCalled();
        rmSync(DIR, { recursive: true, force: true });
    });

    test('server env is allowlisted with owned paths winning', async () => {
        process.env.F1_PROBE_OUTER = 'leak';
        const phi = await startPhi({
            env: {
                PHI_SHUTDOWN_GRACE: '1s',
                HOME: '/evil',
                TMPDIR: '/evil',
            },
        });
        const [executable, args, opts] = serverSpawn();
        const child = spawn.mock.results[1].value;
        expect(phi.identity).toMatchObject({
            pid: child.pid,
            executable,
            binaryPath: executable,
            binaryHash: phi.identity.binarySha256,
            dirtyBuild: false,
            dir: DIR,
            buildRevision: 'fixture-revision',
            buildDirty: false,
            goVersion: 'go version go1.27.2 fixture',
            bindAddress: '127.0.0.1',
            port: Number(args[args.indexOf('--port') + 1]),
            directory: DIR,
        });
        expect(phi.identity.binarySha256).toMatch(/^[a-f0-9]{64}$/);
        const identityRecord = writeFileSync.mock.calls.find(([path]) =>
            String(path).endsWith('server-identity.json'),
        );
        expect(identityRecord).toBeDefined();
        expect(JSON.parse(identityRecord[1])).toEqual(phi.identity);
        expect(identityRecord[2]).toEqual({ mode: 0o600 });
        expect(opts.env.PATH).toBe(process.env.PATH);
        expect(opts.env.F1_PROBE_OUTER).toBeUndefined();
        expect(opts.env.PHI_SHUTDOWN_GRACE).toBe('1s');
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

    test('pid and verify follow the owned child across restart', async () => {
        const phi = await startPhi();
        const first = spawn.mock.results[1].value;
        expect(phi.pid()).toBe(first.pid);
        expect(() => phi.verify()).not.toThrow();
        await phi.restart();
        const second = spawn.mock.results[2].value;
        expect(phi.pid()).toBe(second.pid);
        expect(() => phi.verify()).not.toThrow();
        await phi.stop();
        expect(phi.pid()).toBeUndefined();
        expect(() => phi.verify()).toThrow('phi fixture is not running');
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
        expect(phi.identity.pid).toBe(second.pid);
        await phi.stop();
        expect(second.killCalls).toEqual(['SIGTERM']);
        expect(rmSync).toHaveBeenCalledTimes(1);
    });

    test('failed restart reaps the new child and retains the dir until stop', async () => {
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
        expect(rmSync).not.toHaveBeenCalled();
        await phi.stop();
        expect(rmSync).toHaveBeenCalledTimes(1);
        await expect(phi.restart()).rejects.toThrow('already disposed');
    });

    test.skipIf(process.platform === 'win32')(
        'foreign listener cannot pass readiness',
        async () => {
            const runCommand = execFile.getMockImplementation();
            execFile.mockImplementation((cmd, args, options, callback) => {
                if (cmd === 'lsof' && args.includes('-Fp')) {
                    callback(null, 'p9999\n', '');
                    return {};
                }
                return runCommand(cmd, args, options, callback);
            });
            await expect(startPhi()).rejects.toThrow(/foreign listener/);
            expect(global.fetch).not.toHaveBeenCalled();
            expect(spawn.mock.results[1].value.killCalls).toEqual([]);
            expect(rmSync).not.toHaveBeenCalled();
        },
    );

    test.skipIf(process.platform === 'win32')(
        'identity change prevents cleanup from signaling or deleting',
        async () => {
            const phi = await startPhi();
            const runCommand = execFile.getMockImplementation();
            execFile.mockImplementation((cmd, args, options, callback) => {
                if (cmd === 'ps') {
                    callback(null, 'reused-pid-start', '');
                    return {};
                }
                return runCommand(cmd, args, options, callback);
            });
            await expect(phi.stop()).rejects.toThrow(/identity mismatch/);
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
        await expect(startPhi()).rejects.toThrow(/exited before health/);
        expect(rmSync).not.toHaveBeenCalled();
    });

    test('restart after stop fails fast without spawning', async () => {
        const phi = await startPhi();
        await phi.stop();
        const calls = spawn.mock.calls.length;
        await expect(phi.restart()).rejects.toThrow('already disposed');
        expect(spawn.mock.calls.length).toBe(calls);
    });
});
