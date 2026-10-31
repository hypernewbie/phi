import {
    appendFileSync,
    mkdtempSync,
    rmSync,
    mkdirSync,
    writeFileSync,
    accessSync,
    statSync,
    readFileSync,
    realpathSync,
    constants as fsConstants,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import net from 'node:net';

// Shared live-server fixture for e2e specs: builds phi once, runs it
// with cwd + HOME inside a tmp dir (clean config, no access password,
// file tree rooted at the tmp dir).

export function configToToml(config: Record<string, unknown>): string {
    return (
        Object.entries(config)
            .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
            .join('\n') + '\n'
    );
}

export interface PhiServer {
    url: string;
    dir: string;
    stop: () => Promise<void>;
    restart: (beforeStart?: () => void | Promise<void>) => Promise<void>;
    logPath: string;
    /** Live owned-child PID for spec-side listener checks. */
    pid: () => number | undefined;
    verify: () => void;
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

// A signal kill records signalCode with exitCode null; either one
// means the exit event already fired and must not be awaited.
function childExited(child: ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null;
}

interface ProcessIdentity {
    pid: number;
    start: string;
    binary: string;
}

function inspectProcess(child: ChildProcess, binary: string): ProcessIdentity {
    if (!child.pid || childExited(child))
        throw new Error('phi fixture child exited during startup');
    const opts = { encoding: 'utf8' as const, timeout: 5_000 };
    const start = execFileSync(
        'ps',
        ['-p', String(child.pid), '-o', 'lstart='],
        opts,
    ).trim();
    const images = execFileSync(
        'lsof',
        ['-nP', '-a', '-p', String(child.pid), '-d', 'txt', '-Fn'],
        opts,
    );
    if (!start || !images.split('\n').includes(`n${binary}`)) {
        throw new Error(
            `phi fixture identity mismatch for PID ${child.pid}; leaving resources intact`,
        );
    }
    return { pid: child.pid, start, binary };
}

function ownsListener(child: ChildProcess, port: number): boolean {
    try {
        const sockets = execFileSync(
            'lsof',
            [
                '-nP',
                '-a',
                '-p',
                String(child.pid),
                '-iTCP',
                '-sTCP:LISTEN',
                '-Fn',
            ],
            {
                encoding: 'utf8',
                timeout: 5_000,
                stdio: ['ignore', 'pipe', 'pipe'],
            },
        );
        return sockets.split('\n').includes(`n127.0.0.1:${port}`);
    } catch (err) {
        // lsof returns 1 while a live child has no listening socket yet.
        if ((err as { status?: number }).status === 1) return false;
        throw err;
    }
}

async function waitForHealth(
    port: number,
    child: ChildProcess,
    verify: () => void,
): Promise<void> {
    const deadline = Date.now() + 90_000;
    for (;;) {
        // The owned child must stay alive while polling: a foreign listener
        // answering /healthz after our bind failed or child exited must not
        // pass readiness for this fixture.
        if (childExited(child)) {
            throw new Error(
                `phi fixture child (pid ${child.pid}) exited during startup`,
            );
        }
        verify();
        // Never probe a foreign listener, including the bind-race window
        // before Node has observed the owned child's exit event.
        if (process.platform === 'win32' || ownsListener(child, port)) {
            let healthy = false;
            try {
                const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
                    signal: AbortSignal.timeout(2_000),
                });
                healthy = res.ok;
                await res.body?.cancel();
            } catch {
                /* Server still starting. */
            }
            if (healthy) {
                if (childExited(child))
                    throw new Error('phi fixture child exited during startup');
                verify();
                if (process.platform === 'win32' || ownsListener(child, port))
                    return;
            }
        }
        if (Date.now() > deadline) throw new Error('phi server never came up');
        await new Promise((r) => setTimeout(r, 500));
    }
}

export async function startPhi(
    options: {
        config?: Record<string, unknown>;
        // configAfterPort merges extra startup config once the loopback
        // port is known (e.g. a DSH preview origin). It still lands in
        // config.toml before the build and spawn, like config.
        configAfterPort?: (
            dir: string,
            port: number,
        ) => Record<string, unknown>;
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
    const identities = new WeakMap<ChildProcess, ProcessIdentity>();
    const verifyIdentity = (child: ChildProcess) => {
        if (process.platform === 'win32') return;
        const expected = identities.get(child);
        if (!expected)
            throw new Error(
                'phi fixture identity unavailable; leaving resources intact',
            );
        const current = inspectProcess(child, expected.binary);
        if (current.start !== expected.start)
            throw new Error(
                'phi fixture PID was reused; leaving resources intact',
            );
    };
    const removeDir = () => {
        // Best-effort: the binary can stay briefly locked on Windows.
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {
            // Tmp dirs are reaped by the OS; never fail on cleanup.
        }
    };
    const alreadyExited = childExited;
    const terminate = async (child: ChildProcess | null) => {
        if (!child || !child.pid || alreadyExited(child)) return;
        verifyIdentity(child);
        const exited = new Promise<void>((resolve) =>
            child.once('exit', () => resolve()),
        );
        child.kill();
        await Promise.race([
            exited,
            new Promise((resolve) => setTimeout(resolve, 10_000)),
        ]);
        if (!alreadyExited(child)) {
            verifyIdentity(child);
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
        const port = await freePort();
        // Startup config lands after the port is known but before the
        // build and spawn. Callers without configAfterPort see the same
        // bytes as before.
        if (options.config || options.configAfterPort) {
            const merged = {
                ...options.config,
                ...options.configAfterPort?.(dir, port),
            };
            mkdirSync(join(home, '.phi'), { recursive: true });
            writeFileSync(
                join(home, '.phi', 'config.toml'),
                configToToml(merged),
            );
        }
        await options.setup?.(dir);
        const bin = join(dir, process.platform === 'win32' ? 'phi.exe' : 'phi');
        // The carrier is opt-in behind -tags dsh; the fixture enables the
        // preview, so its server must be built with the tag.
        await run('go', ['build', '-tags', 'dsh', '-o', bin, '.'], process.cwd());
        const args = ['--port', String(port), '--ip', '127.0.0.1'];
        if (options.web !== undefined) args.push('--web', options.web);
        const launch = (): ChildProcess =>
            spawn(bin, args, {
                cwd: dir,
                env: fixtureEnv(home, runTmp, options.env),
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        const logPath = join(dir, 'server.log');
        // A final chunk can arrive after 'exit' while the owned dir is already
        // removed; only that post-teardown case is benign. Any other write
        // failure is a fixture bug and must surface.
        const append = (data: Buffer) => {
            try {
                appendFileSync(logPath, data);
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
            }
        };
        const capture = (child: ChildProcess) => {
            child.stdout?.on('data', append);
            child.stderr?.on('data', append);
            return child;
        };
        const binary = realpathSync(bin);
        const build = {
            revision: execFileSync('git', ['rev-parse', 'HEAD'], {
                encoding: 'utf8',
            }).trim(),
            sha256: createHash('sha256')
                .update(readFileSync(bin))
                .digest('hex'),
        };
        const boot = async () => {
            const child = capture(launch());
            server = child;
            await new Promise<void>((resolve, reject) => {
                child.once('spawn', resolve);
                child.once('error', reject);
            });
            if (process.platform !== 'win32')
                identities.set(child, inspectProcess(child, binary));
            append(
                Buffer.from(
                    `${JSON.stringify({ ...build, ...identities.get(child), bind: `127.0.0.1:${port}`, dir })}\n`,
                ),
            );
            await waitForHealth(port, child, () => verifyIdentity(child));
        };
        await boot();

        return {
            url: `http://127.0.0.1:${port}`,
            logPath,
            dir,
            pid: () => server?.pid,
            verify: () => {
                if (!server || childExited(server))
                    throw new Error('phi fixture is not running');
                verifyIdentity(server);
                if (process.platform !== 'win32' && !ownsListener(server, port))
                    throw new Error('phi fixture does not own its listener');
            },
            restart: async (beforeStart) => {
                if (disposed) throw new Error('phi fixture already disposed');
                const old = server;
                server = null;
                await terminate(old);
                try {
                    await beforeStart?.();
                    await boot();
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
