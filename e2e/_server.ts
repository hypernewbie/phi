import { createHash } from 'node:crypto';
import {
    appendFileSync,
    mkdtempSync,
    rmSync,
    mkdirSync,
    writeFileSync,
    readFileSync,
    realpathSync,
    accessSync,
    statSync,
    constants as fsConstants,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, resolve } from 'node:path';
import {
    execFile,
    execFileSync,
    spawn,
    type ChildProcess,
    type ExecFileException,
} from 'node:child_process';
import net from 'node:net';

// Shared live-server fixture for e2e specs: builds phi once, runs it
// with cwd + HOME inside a tmp dir (clean config, no access password,
// file tree rooted at the tmp dir).

export function configToToml(config: Record<string, unknown>): string {
    return `${Object.entries(config)
        .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
        .join('\n')}\n`;
}

export interface PhiServerIdentity {
    pid: number;
    startTime: string;
    executable: string;
    buildRevision: string;
    buildDirty: boolean;
    binarySha256: string;
    goVersion: string;
    bindAddress: '127.0.0.1';
    port: number;
    directory: string;
    binaryPath: string;
    binaryHash: string;
    dirtyBuild: boolean;
    dir: string;
}

export interface PhiServer {
    url: string;
    dir: string;
    stop: () => Promise<void>;
    restart: (beforeStart?: () => void | Promise<void>) => Promise<void>;
    logPath: string;
    readonly identity: PhiServerIdentity;
    /** Live owned-child PID for spec-side listener checks. */
    pid: () => number | undefined;
    /** Synchronous identity check for legacy spec-side ownership assertions. */
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

export interface ElectronFixturePaths {
    home: string;
    appData: string;
    config: string;
    cache: string;
    data: string;
    state: string;
    temp: string;
}

/** The server's minimal inherited environment, plus only GUI variables. */
export function electronFixtureEnv(
    paths: ElectronFixturePaths,
): Record<string, string> {
    const env = fixtureEnv(paths.home, paths.temp);
    for (const key of [
        'DISPLAY',
        'WAYLAND_DISPLAY',
        'XDG_RUNTIME_DIR',
        'DBUS_SESSION_BUS_ADDRESS',
    ]) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
    }
    env.APPDATA = paths.appData;
    env.XDG_CONFIG_HOME = paths.config;
    env.XDG_CACHE_HOME = paths.cache;
    env.XDG_DATA_HOME = paths.data;
    env.XDG_STATE_HOME = paths.state;
    env.PHI_DESKTOP_LOW_MEMORY = '0';
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

const COMMAND_TIMEOUT_MS = 5_000;
const HEALTH_TIMEOUT_MS = 2_000;
const READY_TIMEOUT_MS = 90_000;

interface ProcessSnapshot {
    startTime: string;
    executables: string[];
}

interface ListenerRecord {
    pid: number;
    address: string;
    port: number;
}

function alreadyExited(child: ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null;
}

function output(cmd: string, args: string[], cwd: string): Promise<string> {
    return new Promise((resolveOutput, reject) => {
        execFile(
            cmd,
            args,
            {
                cwd,
                encoding: 'utf8',
                timeout: COMMAND_TIMEOUT_MS,
                maxBuffer: 4 * 1024 * 1024,
            },
            (error, stdout) => {
                if (error) reject(error);
                else resolveOutput(stdout);
            },
        );
    });
}

async function outputOrNoMatch(
    cmd: string,
    args: string[],
    cwd: string,
): Promise<string> {
    try {
        return await output(cmd, args, cwd);
    } catch (error) {
        const commandError = error as ExecFileException & {
            stdout?: string | Buffer;
            stderr?: string | Buffer;
        };
        if (
            commandError.code === 1 &&
            !String(commandError.stdout ?? '').trim() &&
            !String(commandError.stderr ?? '').trim()
        ) {
            return '';
        }
        throw error;
    }
}

function sameExecutable(a: string, b: string): boolean {
    const clean = (value: string) =>
        resolve(value.startsWith('\\\\?\\') ? value.slice(4) : value);
    const left = clean(a);
    const right = clean(b);
    return process.platform === 'win32'
        ? left.toLowerCase() === right.toLowerCase()
        : left === right;
}

async function processSnapshot(
    pid: number,
    cwd: string,
): Promise<ProcessSnapshot> {
    if (process.platform === 'win32') {
        const script =
            `$ErrorActionPreference = 'Stop'; ` +
            `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; ` +
            `if ($null -eq $p) { exit 1 }; ` +
            `$p | Select-Object ProcessId,CreationDate,ExecutablePath | ConvertTo-Json -Compress`;
        const raw = await output(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', script],
            cwd,
        );
        const processInfo = JSON.parse(raw) as {
            CreationDate?: string;
            ExecutablePath?: string;
        };
        if (!processInfo.CreationDate || !processInfo.ExecutablePath) {
            throw new Error(`cannot identify fixture process ${pid}`);
        }
        return {
            startTime: processInfo.CreationDate,
            executables: [processInfo.ExecutablePath],
        };
    }

    const startTime = (
        await output('ps', ['-p', String(pid), '-o', 'lstart='], cwd)
    ).trim();
    const raw = await outputOrNoMatch(
        'lsof',
        ['-a', '-p', String(pid), '-d', 'txt', '-Fn'],
        cwd,
    );
    const executables = raw
        .split(/\r?\n/)
        .filter((line) => line.startsWith('n'))
        .map((line) => line.slice(1));
    if (!startTime) throw new Error(`cannot identify fixture process ${pid}`);
    return { startTime, executables };
}

async function listenerRecords(
    port: number,
    cwd: string,
): Promise<ListenerRecord[]> {
    if (process.platform === 'win32') {
        const script =
            `$ErrorActionPreference = 'Stop'; ` +
            `$rows = @(Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' ` +
            `-LocalPort ${port} | ` +
            `Select-Object OwningProcess,LocalAddress,LocalPort); ` +
            `ConvertTo-Json -InputObject $rows -Compress`;
        const raw = await output(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', script],
            cwd,
        );
        const parsed = JSON.parse(raw || '[]') as
            | { OwningProcess: number; LocalAddress: string; LocalPort: number }
            | {
                  OwningProcess: number;
                  LocalAddress: string;
                  LocalPort: number;
              }[]
            | null;
        if (parsed === null) return [];
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        return rows.map((row) => ({
            pid: Number(row.OwningProcess),
            address: row.LocalAddress,
            port: Number(row.LocalPort),
        }));
    }

    const raw = await outputOrNoMatch(
        'lsof',
        ['-nP', `-iTCP@127.0.0.1:${port}`, '-sTCP:LISTEN', '-Fp'],
        cwd,
    );
    return [...raw.matchAll(/^p(\d+)$/gm)].map((match) => ({
        pid: Number(match[1]),
        address: '127.0.0.1',
        port,
    }));
}

async function assertServerIdentity(
    identity: PhiServerIdentity,
    cwd: string,
    requireListener: boolean,
): Promise<void> {
    const processInfo = await processSnapshot(identity.pid, cwd);
    if (
        processInfo.startTime !== identity.startTime ||
        !processInfo.executables.some((path) =>
            sameExecutable(path, identity.executable),
        )
    ) {
        throw new Error(
            `fixture process identity mismatch for PID ${identity.pid}`,
        );
    }

    const listeners = await listenerRecords(identity.port, cwd);
    const mismatched = listeners.find(
        (listener) =>
            listener.address !== identity.bindAddress ||
            listener.port !== identity.port,
    );
    if (mismatched) {
        throw new Error(
            `fixture listener address mismatch on port ${identity.port}`,
        );
    }
    const foreign = listeners.find((listener) => listener.pid !== identity.pid);
    if (foreign) {
        throw new Error(
            `foreign listener PID ${foreign.pid} owns 127.0.0.1:${identity.port}`,
        );
    }
    const owned = listeners.some((listener) => listener.pid === identity.pid);
    if (requireListener && !owned) {
        throw new Error(
            `fixture PID ${identity.pid} does not own its listener`,
        );
    }
    if (owned && process.platform !== 'win32') {
        const raw = await output(
            'lsof',
            [
                '-nP',
                '-a',
                '-p',
                String(identity.pid),
                `-iTCP@127.0.0.1:${identity.port}`,
                '-sTCP:LISTEN',
                '-Fp',
            ],
            cwd,
        );
        if (!raw.split(/\r?\n/).includes(`p${identity.pid}`)) {
            throw new Error(
                `fixture listener identity mismatch for PID ${identity.pid}`,
            );
        }
    }
}

async function captureProcessIdentity(
    child: ChildProcess,
    executable: string,
    cwd: string,
): Promise<{ pid: number; startTime: string }> {
    const pid = child.pid;
    if (!pid) throw new Error('fixture server has no child PID');
    const deadline = Date.now() + 5_000;
    const poll = async () => {
        for (;;) {
            if (alreadyExited(child)) {
                throw new Error(
                    `fixture server exited before identity check (PID ${pid})`,
                );
            }
            let snapshot: ProcessSnapshot;
            try {
                snapshot = await processSnapshot(pid, cwd);
            } catch (error) {
                const commandError = error as ExecFileException & {
                    stdout?: string | Buffer;
                    stderr?: string | Buffer;
                };
                if (
                    commandError.code !== 1 ||
                    String(commandError.stdout ?? '').trim() ||
                    String(commandError.stderr ?? '').trim()
                ) {
                    throw error;
                }
                if (Date.now() >= deadline) {
                    throw new Error(
                        `fixture process identity unavailable for PID ${pid}`,
                    );
                }
                await new Promise((resolveDelay) =>
                    setTimeout(resolveDelay, 100),
                );
                continue;
            }
            if (alreadyExited(child)) {
                throw new Error(
                    `fixture server exited during identity check (PID ${pid})`,
                );
            }
            if (
                snapshot.executables.some((path) =>
                    sameExecutable(path, executable),
                )
            ) {
                return { pid, startTime: snapshot.startTime };
            }
            if (Date.now() >= deadline) {
                throw new Error(
                    `fixture executable identity unavailable for PID ${pid}`,
                );
            }
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
        }
    };
    let rejectChild!: (error: Error) => void;
    const childFailure = new Promise<never>((_, reject) => {
        rejectChild = reject;
    });
    const onError = (error: Error) => rejectChild(error);
    child.on('error', onError);
    try {
        return await Promise.race([poll(), childFailure]);
    } finally {
        child.off('error', onError);
    }
}

function fetchHealth(port: number, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error('health request timed out'));
        }, timeoutMs);
    });
    return Promise.race([
        fetch(`http://127.0.0.1:${port}/healthz`, {
            signal: controller.signal,
        }),
        timeout,
    ]).finally(() => clearTimeout(timer));
}

export async function waitForOwnedServer(
    child: ChildProcess,
    identity: PhiServerIdentity,
    cwd = process.cwd(),
    timeoutMs = READY_TIMEOUT_MS,
): Promise<void> {
    const onError = (error: Error) => rejectChild(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
        rejectChild(
            new Error(
                `fixture server exited before health (PID ${identity.pid}, code ${code}, signal ${signal})`,
            ),
        );
    let rejectChild = (_error: Error) => {};
    const childFailure = new Promise<never>((_, reject) => {
        rejectChild = reject;
    });
    child.on('error', onError);
    child.on('exit', onExit);

    const deadline = Date.now() + timeoutMs;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadlineFailure = new Promise<never>((_, reject) => {
        timeout = setTimeout(
            () => reject(new Error('phi server never came up')),
            timeoutMs,
        );
    });
    const poll = async () => {
        for (;;) {
            if (alreadyExited(child)) {
                throw new Error(
                    `fixture server exited before health (PID ${identity.pid})`,
                );
            }
            await assertServerIdentity(identity, cwd, false);
            const listeners = await listenerRecords(identity.port, cwd);
            const foreign = listeners.find(
                (listener) => listener.pid !== identity.pid,
            );
            if (foreign) {
                throw new Error(
                    `foreign listener PID ${foreign.pid} owns 127.0.0.1:${identity.port}`,
                );
            }
            if (listeners.some((listener) => listener.pid === identity.pid)) {
                await assertServerIdentity(identity, cwd, true);
                let response: Response | undefined;
                try {
                    response = await fetchHealth(
                        identity.port,
                        Math.min(
                            HEALTH_TIMEOUT_MS,
                            Math.max(1, deadline - Date.now()),
                        ),
                    );
                } catch {
                    // Health is not ready yet. Ownership checks remain fatal.
                }
                if (response?.ok) {
                    await assertServerIdentity(identity, cwd, true);
                    return;
                }
            }
            if (Date.now() >= deadline) {
                throw new Error('phi server never came up');
            }
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
        }
    };

    try {
        await Promise.race([poll(), childFailure, deadlineFailure]);
    } finally {
        if (timeout) clearTimeout(timeout);
        child.off('error', onError);
        child.off('exit', onExit);
    }
}

async function waitForExit(
    child: ChildProcess,
    timeoutMs: number,
): Promise<boolean> {
    if (alreadyExited(child)) return true;
    return new Promise((resolveExit) => {
        const finish = (exited: boolean) => {
            clearTimeout(timer);
            child.off('exit', onExit);
            resolveExit(exited);
        };
        const onExit = () => finish(true);
        const timer = setTimeout(() => finish(false), timeoutMs);
        child.once('exit', onExit);
    });
}

async function waitForPortClear(
    identity: PhiServerIdentity,
    cwd: string,
): Promise<void> {
    const deadline = Date.now() + 2_000;
    for (;;) {
        const listeners = await listenerRecords(identity.port, cwd);
        if (listeners.length === 0) return;
        const foreign = listeners.find(
            (listener) => listener.pid !== identity.pid,
        );
        if (foreign) {
            throw new Error(
                `foreign listener PID ${foreign.pid} owns 127.0.0.1:${identity.port}`,
            );
        }
        if (Date.now() >= deadline) {
            throw new Error(
                `fixture listener did not stop on port ${identity.port}`,
            );
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
}

export async function stopOwnedServer(
    child: ChildProcess,
    identity: PhiServerIdentity,
    cwd = process.cwd(),
): Promise<void> {
    if (child.pid !== identity.pid) {
        throw new Error(`fixture child PID mismatch for ${identity.pid}`);
    }
    if (!alreadyExited(child)) {
        await assertServerIdentity(identity, cwd, false);
        child.kill();
        if (!(await waitForExit(child, 10_000))) {
            await assertServerIdentity(identity, cwd, false);
            child.kill('SIGKILL');
            if (!(await waitForExit(child, 10_000))) {
                throw new Error(`fixture PID ${identity.pid} did not exit`);
            }
        }
    }
    await waitForPortClear(identity, cwd);
}

function verifyOwnedServer(
    child: ChildProcess,
    identity: PhiServerIdentity,
): void {
    if (child.pid !== identity.pid || alreadyExited(child)) {
        throw new Error(`phi fixture PID ${identity.pid} is not running`);
    }
    const opts = { encoding: 'utf8' as const, timeout: COMMAND_TIMEOUT_MS };
    if (process.platform === 'win32') {
        const processScript =
            `$ErrorActionPreference = 'Stop'; ` +
            `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${identity.pid}'; ` +
            `if ($null -eq $p) { exit 1 }; ` +
            `$p | Select-Object CreationDate,ExecutablePath | ConvertTo-Json -Compress`;
        const current = JSON.parse(
            execFileSync(
                'powershell.exe',
                ['-NoProfile', '-NonInteractive', '-Command', processScript],
                opts,
            ),
        ) as { CreationDate?: string; ExecutablePath?: string };
        if (
            current.CreationDate !== identity.startTime ||
            !current.ExecutablePath ||
            !sameExecutable(current.ExecutablePath, identity.executable)
        ) {
            throw new Error('phi fixture PID was reused');
        }
        const listenerScript =
            `$ErrorActionPreference = 'Stop'; ` +
            `$rows = @(Get-NetTCPConnection -State Listen -LocalAddress '${identity.bindAddress}' ` +
            `-LocalPort ${identity.port} | ` +
            `Select-Object OwningProcess,LocalAddress,LocalPort); ` +
            `ConvertTo-Json -InputObject $rows -Compress`;
        const listeners = JSON.parse(
            execFileSync(
                'powershell.exe',
                ['-NoProfile', '-NonInteractive', '-Command', listenerScript],
                opts,
            ),
        ) as
            | {
                  OwningProcess: number;
                  LocalAddress: string;
                  LocalPort: number;
              }
            | {
                  OwningProcess: number;
                  LocalAddress: string;
                  LocalPort: number;
              }[];
        const rows = Array.isArray(listeners) ? listeners : [listeners];
        if (
            !rows.some(
                (row) =>
                    Number(row.OwningProcess) === identity.pid &&
                    row.LocalAddress === identity.bindAddress &&
                    Number(row.LocalPort) === identity.port,
            )
        ) {
            throw new Error('phi fixture does not own its listener');
        }
        return;
    }

    const startTime = execFileSync(
        'ps',
        ['-p', String(identity.pid), '-o', 'lstart='],
        opts,
    ).trim();
    const images = execFileSync(
        'lsof',
        ['-nP', '-a', '-p', String(identity.pid), '-d', 'txt', '-Fn'],
        opts,
    );
    const executables = images
        .split(/\r?\n/)
        .filter((line) => line.startsWith('n'))
        .map((line) => line.slice(1));
    if (
        startTime !== identity.startTime ||
        !executables.some((path) => sameExecutable(path, identity.executable))
    ) {
        throw new Error('phi fixture PID was reused');
    }
    const listeners = execFileSync(
        'lsof',
        [
            '-nP',
            '-a',
            '-p',
            String(identity.pid),
            `-iTCP@${identity.bindAddress}:${identity.port}`,
            '-sTCP:LISTEN',
            '-Fp',
        ],
        opts,
    );
    if (!listeners.split(/\r?\n/).includes(`p${identity.pid}`)) {
        throw new Error('phi fixture does not own its listener');
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
    let server: ChildProcess | null = null;
    let serverIdentity: PhiServerIdentity | null = null;
    let disposed = false;
    const logPath = join(dir, 'server.log');
    const identityPath = join(dir, 'server-identity.json');
    const removeDir = () => rmSync(dir, { recursive: true, force: true });
    const fail = async (err: unknown): Promise<never> => {
        let cleanupNote = '';
        if (server && serverIdentity) {
            try {
                await stopOwnedServer(server, serverIdentity, process.cwd());
                server = null;
                serverIdentity = null;
            } catch (cleanupError) {
                cleanupNote = `; cleanup refused: ${String(cleanupError)}`;
            }
        }
        const child = server?.pid ? ` child PID ${server.pid}` : '';
        throw new Error(
            `${String(err)}${child}${cleanupNote}; fixture evidence retained at ${dir}; log=${logPath}`,
            { cause: err },
        );
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
                join(home, '.phi', 'config.toml'),
                configToToml(options.config),
            );
        }

        await options.setup?.(dir);
        const port = await freePort();
        const bin = join(dir, process.platform === 'win32' ? 'phi.exe' : 'phi');
        await run('go', ['build', '-o', bin, '.'], process.cwd());
        const executable = realpathSync(bin);
        const [revision, status, goVersion] = await Promise.all([
            output('git', ['rev-parse', 'HEAD'], process.cwd()),
            output(
                'git',
                ['status', '--porcelain', '--untracked-files=all'],
                process.cwd(),
            ),
            output('go', ['version', '-m', bin], process.cwd()),
        ]);
        const buildRevision = revision.trim();
        const buildDirty = status.trim() !== '';
        const binarySha256 = createHash('sha256')
            .update(readFileSync(bin))
            .digest('hex');
        const args = ['--port', String(port), '--ip', '127.0.0.1'];
        if (options.web !== undefined) args.push('--web', options.web);
        const launch = (): ChildProcess =>
            spawn(bin, args, {
                cwd: dir,
                env: fixtureEnv(home, runTmp, options.env),
                stdio: ['ignore', 'pipe', 'pipe'],
            });
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
        const startOwned = async () => {
            const child = capture(launch());
            server = child;
            let startupError: Error | null = null;
            const onError = (error: Error) => {
                startupError = error;
            };
            child.on('error', onError);
            try {
                const processInfo = await captureProcessIdentity(
                    child,
                    executable,
                    process.cwd(),
                );
                if (startupError) throw startupError;
                serverIdentity = {
                    pid: processInfo.pid,
                    startTime: processInfo.startTime,
                    executable,
                    buildRevision,
                    buildDirty,
                    binarySha256,
                    goVersion: goVersion.trim(),
                    bindAddress: '127.0.0.1',
                    port,
                    directory: dir,
                    binaryPath: executable,
                    binaryHash: binarySha256,
                    dirtyBuild: buildDirty,
                    dir,
                };
                writeFileSync(
                    identityPath,
                    JSON.stringify(serverIdentity, null, 2),
                    { mode: 0o600 },
                );
                await waitForOwnedServer(child, serverIdentity, process.cwd());
                if (startupError) throw startupError;
            } catch (error) {
                // Drop an unidentified child only after exit and listener checks.
                if (!serverIdentity && alreadyExited(child)) {
                    const listeners = await listenerRecords(
                        port,
                        process.cwd(),
                    );
                    if (listeners.length === 0) server = null;
                }
                throw error;
            } finally {
                child.off('error', onError);
            }
        };
        await startOwned();
        if (!serverIdentity)
            throw new Error('fixture server identity was not recorded');

        return {
            url: `http://127.0.0.1:${port}`,
            logPath,
            dir,
            get identity() {
                if (!server || alreadyExited(server) || !serverIdentity) {
                    throw new Error('phi fixture is not running');
                }
                return serverIdentity;
            },
            pid: () => server?.pid,
            verify: () => {
                if (!server || !serverIdentity) {
                    throw new Error('phi fixture is not running');
                }
                verifyOwnedServer(server, serverIdentity);
            },
            restart: async (beforeStart) => {
                if (disposed) throw new Error('phi fixture already disposed');
                const old = server;
                const oldIdentity = serverIdentity;
                if (!old || !oldIdentity) {
                    throw new Error('fixture server ownership is unavailable');
                }
                try {
                    await stopOwnedServer(old, oldIdentity, process.cwd());
                    server = null;
                    serverIdentity = null;
                    await beforeStart?.();
                    await startOwned();
                } catch (err) {
                    await fail(err);
                }
            },
            stop: async () => {
                if (disposed) return;
                if (server && serverIdentity) {
                    await stopOwnedServer(
                        server,
                        serverIdentity,
                        process.cwd(),
                    );
                } else if (server) {
                    throw new Error(
                        `fixture cleanup refused without a process identity; evidence retained at ${dir}`,
                    );
                }
                server = null;
                serverIdentity = null;
                removeDir();
                disposed = true;
            },
        };
    } catch (err) {
        return fail(err);
    }
}
