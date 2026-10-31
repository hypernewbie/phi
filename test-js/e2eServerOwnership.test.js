import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { stopOwnedServer, waitForOwnedServer } from '../e2e/_server.ts';

vi.mock('node:child_process', () => ({
    execFile: vi.fn(),
    spawn: vi.fn(),
}));

const identity = {
    pid: 42,
    startTime: 'Fri Oct 30 12:00:00 2026',
    executable: '/tmp/owned/phi',
    buildRevision: 'synthetic-revision',
    buildDirty: false,
    binarySha256: 'synthetic-hash',
    goVersion: 'go version go1.27.2',
    bindAddress: '127.0.0.1',
    port: 45678,
    directory: '/tmp/owned',
};

class FakeChild {
    constructor(pid = identity.pid) {
        this.pid = pid;
        this.exitCode = null;
        this.signalCode = null;
        this.killCalls = [];
        this.handlers = new Map();
    }

    on(event, callback) {
        const listeners = this.handlers.get(event) ?? [];
        listeners.push(callback);
        this.handlers.set(event, listeners);
        return this;
    }

    once(event, callback) {
        const wrapped = (...args) => {
            this.off(event, wrapped);
            callback(...args);
        };
        return this.on(event, wrapped);
    }

    off(event, callback) {
        this.handlers.set(
            event,
            (this.handlers.get(event) ?? []).filter(
                (item) => item !== callback,
            ),
        );
        return this;
    }

    emit(event, ...args) {
        if (event === 'exit') {
            this.exitCode = args[0];
            this.signalCode = args[1];
        }
        for (const callback of [...(this.handlers.get(event) ?? [])]) {
            callback(...args);
        }
    }

    kill(signal = 'SIGTERM') {
        this.killCalls.push(signal);
        this.emit('exit', null, signal);
        return true;
    }
}

let processStartTime;
let processExecutable;
let listenerPid;
let listenerQueryError;
let realFetch;

function noMatch() {
    return Object.assign(new Error('no matching process'), { code: 1 });
}

beforeEach(() => {
    vi.clearAllMocks();
    realFetch = global.fetch;
    processStartTime = identity.startTime;
    processExecutable = identity.executable;
    listenerPid = identity.pid;
    listenerQueryError = false;
    execFile.mockImplementation((command, args, _options, callback) => {
        let stdout = '';
        let error = null;
        if (command === 'ps') {
            stdout = `${processStartTime}\n`;
        } else if (command === 'lsof' && args.includes('-d')) {
            stdout = `p${identity.pid}\nf txt\nn${processExecutable}\n`;
        } else if (command === 'lsof' && args.includes('-Fp')) {
            if (listenerQueryError) {
                error = Object.assign(new Error('permission denied'), {
                    code: 1,
                    stderr: 'permission denied',
                });
            } else {
                stdout = listenerPid === null ? '' : `p${listenerPid}\n`;
                if (!stdout) error = noMatch();
            }
        } else if (command === 'lsof' && args.includes('-sTCP:LISTEN')) {
            stdout = `p${identity.pid}\nf3\nn127.0.0.1:${identity.port}\n`;
        }
        callback(error, stdout, '');
        return {};
    });
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
});

afterEach(() => {
    global.fetch = realFetch;
    vi.useRealTimers();
});

async function flushMicrotasks() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('owned e2e server checks', () => {
    test('child exit interrupts a hanging health request', async () => {
        vi.useFakeTimers();
        const child = new FakeChild();
        let signal;
        global.fetch = vi.fn((_url, options) => {
            signal = options.signal;
            return new Promise(() => {});
        });
        const pending = waitForOwnedServer(child, identity, '/tmp', 30_000);
        await flushMicrotasks();
        expect(global.fetch).toHaveBeenCalledTimes(1);
        child.emit('exit', 1, null);
        await expect(pending).rejects.toThrow('exited before health');
        await vi.advanceTimersByTimeAsync(2_000);
        expect(signal.aborted).toBe(true);
    });

    test('a hanging health request is aborted after two seconds', async () => {
        vi.useFakeTimers();
        const child = new FakeChild();
        let signal;
        global.fetch = vi.fn((_url, options) => {
            signal = options.signal;
            return new Promise(() => {});
        });
        const pending = waitForOwnedServer(child, identity, '/tmp', 10_000);
        await flushMicrotasks();
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const assertion = expect(pending).rejects.toThrow(
            'exited before health',
        );
        await vi.advanceTimersByTimeAsync(2_000);
        expect(signal.aborted).toBe(true);
        child.emit('exit', 1, null);
        await assertion;
        await vi.advanceTimersByTimeAsync(500);
    });

    test('process start-time mismatch blocks readiness', async () => {
        processStartTime = 'different process';
        const child = new FakeChild();
        await expect(
            waitForOwnedServer(child, identity, '/tmp', 100),
        ).rejects.toThrow('process identity mismatch');
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('foreign listener blocks readiness', async () => {
        listenerPid = 99;
        const child = new FakeChild();
        await expect(
            waitForOwnedServer(child, identity, '/tmp', 100),
        ).rejects.toThrow('foreign listener PID 99');
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('listener query errors fail readiness closed', async () => {
        listenerQueryError = true;
        const child = new FakeChild();
        await expect(
            waitForOwnedServer(child, identity, '/tmp', 100),
        ).rejects.toThrow('permission denied');
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('cleanup refuses a reused PID', async () => {
        processStartTime = 'different process';
        const child = new FakeChild();
        await expect(stopOwnedServer(child, identity, '/tmp')).rejects.toThrow(
            'process identity mismatch',
        );
        expect(child.killCalls).toEqual([]);
    });

    test('cleanup refuses to signal a child when a foreign listener owns its port', async () => {
        listenerPid = 99;
        const child = new FakeChild();
        await expect(stopOwnedServer(child, identity, '/tmp')).rejects.toThrow(
            'foreign listener PID 99',
        );
        expect(child.killCalls).toEqual([]);
    });
});
