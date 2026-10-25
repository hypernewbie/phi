import {
    appendFileSync,
    mkdtempSync,
    rmSync,
    mkdirSync,
    writeFileSync,
    accessSync,
    statSync,
    constants as fsConstants,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';

// Shared live-server fixture for e2e specs: builds phi once, runs it
// with cwd + HOME inside a tmp dir (clean config, no access password,
// file tree rooted at the tmp dir).

export interface PhiServer {
    url: string;
    dir: string;
    stop: () => Promise<void>;
    restart: (beforeStart?: () => void | Promise<void>) => Promise<void>;
    logPath: string;
}

// Outer env vars inherited by the fixture Phi child: PATH (+Windows
// exec/platform keys), terminal type, locale. Everything else arrives
// via explicit options.env; owned fixture paths always win. This keeps
// real credentials, proxies, and tool config out of the fixture.
const INHERIT_ENV_KEYS = [
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'COMSPEC',
    'WINDIR',
    'TERM',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'LC_MESSAGES',
    'LANGUAGE',
];

// Mirrors Go maxSocketPathBytes (internal/pibridge/endpoint.go): the
// absolute Unix socket path must fit 100 bytes.
const MAX_SOCKET_PATH_BYTES = 100;

function fixtureEnv(
    home: string,
    runTmp: string,
    overrides?: Record<string, string>,
): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of INHERIT_ENV_KEYS) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
    }
    if (overrides) Object.assign(env, overrides);
    env.HOME = home;
    env.USERPROFILE = home;
    env.APPDATA = home;
    env.TMPDIR = runTmp;
    env.TMP = runTmp;
    env.TEMP = runTmp;
    return env;
}

// checkRuntimeTmp fails before launch when the owned runtime-temp root
// cannot host Phi's bridge socket: it must sit inside the fixture, be
// writable and (on Unix) private, and its absolute
// phi-pi-<16 hex>/bridge.sock candidate must be publishable within
// 100 UTF-8 bytes (mirrors Go publishableTarget). Windows uses named
// pipes with no temp-root bound, so the POSIX mode and socket-budget
// checks are Unix-only. Never rely on the allocator's /tmp fallback:
// an unfit root rejects the fixture instead.
function checkRuntimeTmp(runTmp: string, dir: string): void {
    const rel = relative(dir, runTmp);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`phi fixture temp ${runTmp} escapes ${dir}`);
    }
    accessSync(runTmp, fsConstants.W_OK);
    // Named pipes have no temp-root bound and no POSIX privacy bit.
    if (process.platform === 'win32') return;
    const st = statSync(runTmp);
    if (!st.isDirectory() || (st.mode & 0o777) !== 0o700) {
        throw new Error(`phi fixture temp ${runTmp} is not a private dir`);
    }
    const candidate = join(runTmp, `phi-pi-${'f'.repeat(16)}`, 'bridge.sock');
    const publishable =
        !candidate.includes('%') &&
        !candidate.includes('@') &&
        !candidate.includes('://') &&
        !candidate.startsWith('//');
    const bytes = Buffer.byteLength(candidate);
    if (!publishable || bytes > MAX_SOCKET_PATH_BYTES) {
        throw new Error(
            `phi fixture temp ${runTmp} cannot host a 100-byte bridge socket ` +
                `(candidate ${bytes} bytes); set TMPDIR to a short path`,
        );
    }
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { cwd, stdio: 'ignore' });
        child.on('error', reject);
        child.on('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
        );
    });
}

function freePort(): Promise<number> {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const port = (srv.address() as net.AddressInfo).port;
            srv.close(() => resolve(port));
        });
    });
}

async function waitForHealth(port: number): Promise<void> {
    const deadline = Date.now() + 90_000;
    for (;;) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/healthz`);
            if (res.ok) return;
        } catch {
            // Server still compiling/starting.
        }
        if (Date.now() > deadline) throw new Error('phi server never came up');
        await new Promise((r) => setTimeout(r, 500));
    }
}

export async function startPhi(
    options: {
        config?: Record<string, unknown>;
        setup?: (dir: string) => void | Promise<void>;
        env?: Record<string, string>;
        web?: string;
    } = {},
): Promise<PhiServer> {
    // Short prefix: the owned runtime-temp socket candidate must fit the
    // 100-byte Unix bound even under a long macOS TMPDIR.
    const dir = mkdtempSync(join(tmpdir(), 'pe-'));
    // Cleanup is installed before anything else can fail: every failure
    // below reaps the owned child (if any) and removes the owned dir.
    let server: ChildProcess | null = null;
    let disposed = false;
    const removeDir = () => {
        // Best-effort: the binary can stay briefly locked on Windows.
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {
            // Tmp dirs are reaped by the OS; never fail on cleanup.
        }
    };
    // A signal kill records signalCode with exitCode null; either one
    // means the exit event already fired and must not be awaited.
    const alreadyExited = (child: ChildProcess): boolean =>
        child.exitCode !== null || child.signalCode !== null;
    const terminate = async (child: ChildProcess | null) => {
        if (!child || alreadyExited(child)) return;
        const exited = new Promise<void>((resolve) =>
            child.once('exit', () => resolve()),
        );
        child.kill();
        await Promise.race([
            exited,
            new Promise((resolve) => setTimeout(resolve, 10_000)),
        ]);
        if (!alreadyExited(child)) {
            child.kill('SIGKILL');
            await exited;
        }
    };
    const fail = async (err: unknown): Promise<never> => {
        const child = server;
        server = null;
        await terminate(child);
        if (!disposed) {
            disposed = true;
            removeDir();
        }
        throw err;
    };

    const home = join(dir, 'home');
    const runTmp = join(dir, 't');
    try {
        mkdirSync(home, { recursive: true });
        mkdirSync(runTmp, { mode: 0o700 });
        checkRuntimeTmp(runTmp, dir);
        if (options.config) {
            mkdirSync(join(home, '.phi'), { recursive: true });
            writeFileSync(
                join(home, '.phi', 'config.json'),
                JSON.stringify(options.config),
            );
        }

        await options.setup?.(dir);
        const port = await freePort();
        const bin = join(dir, process.platform === 'win32' ? 'phi.exe' : 'phi');
        await run('go', ['build', '-o', bin, '.'], process.cwd());
        const args = ['--port', String(port), '--ip', '127.0.0.1'];
        if (options.web !== undefined) args.push('--web', options.web);
        const launch = (): ChildProcess =>
            spawn(bin, args, {
                cwd: dir,
                env: fixtureEnv(home, runTmp, options.env),
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        const logPath = join(dir, 'server.log');
        const capture = (child: ChildProcess) => {
            child.stdout?.on('data', (data) => appendFileSync(logPath, data));
            child.stderr?.on('data', (data) => appendFileSync(logPath, data));
            return child;
        };
        server = capture(launch());
        await waitForHealth(port);

        return {
            url: `http://127.0.0.1:${port}`,
            logPath,
            dir,
            restart: async (beforeStart) => {
                if (disposed) throw new Error('phi fixture already disposed');
                const old = server;
                server = null;
                await terminate(old);
                try {
                    await beforeStart?.();
                    server = capture(launch());
                    await waitForHealth(port);
                } catch (err) {
                    await fail(err);
                }
            },
            stop: async () => {
                const child = server;
                server = null;
                await terminate(child);
                if (!disposed) {
                    disposed = true;
                    removeDir();
                }
            },
        };
    } catch (err) {
        return fail(err);
    }
}
