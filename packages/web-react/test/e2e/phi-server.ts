import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    accessSync,
    chmodSync,
    constants as fsConstants,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const pause = (milliseconds: number) =>
    new Promise<void>((done) => setTimeout(done, milliseconds));

// Fixed synthetic password for --manual-auth inspection only. Enabled
// through the private Node setup helper; never printed or seeded
// into a browser. Tests use their own synthetic values per case.
export const MANUAL_AUTH_PASSWORD = 'phi-manual-auth-fixture-01';

const IDENTITY_TIMEOUT_MS = 5_000;
const SETUP_TIMEOUT_MS = 15_000;
const MAX_SOCKET_PATH_BYTES = 100;

function identityEnv(): NodeJS.ProcessEnv {
    return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' };
}

function lsofBin(): string {
    return existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof';
}

export function buildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { GOENV: 'off' };
    for (const key of [
        'PATH',
        'HOME',
        'TMPDIR',
        'LANG',
        'LC_ALL',
        'GOCACHE',
        'GOMODCACHE',
        'GOPATH',
        'SDKROOT',
    ]) {
        if (source[key] !== undefined) env[key] = source[key];
    }
    return env;
}

export function runtimeEnvironment(
    source: NodeJS.ProcessEnv,
    dir: string,
): NodeJS.ProcessEnv {
    const runTmp = join(dir, 't');
    const env: NodeJS.ProcessEnv = {
        PATH: `${join(dir, 'bin')}:${source.PATH ?? '/usr/bin:/bin'}`,
        HOME: join(dir, 'home'),
        USERPROFILE: join(dir, 'home'),
        APPDATA: join(dir, 'home'),
        XDG_CONFIG_HOME: join(dir, 'home'),
        XDG_CACHE_HOME: join(dir, 'cache'),
        TMPDIR: runTmp,
        TMP: runTmp,
        TEMP: runTmp,
    };
    for (const key of ['LANG', 'LC_ALL'])
        if (source[key] !== undefined) env[key] = source[key];
    return env;
}

export interface OwnedIdentity {
    pid: number;
    startTime: string;
    executable: string;
    bindAddress: string;
    port: number;
}

interface OwnedChild {
    child: ChildProcess;
    name: string;
    log: Buffer;
    ended: boolean;
    failure?: Error;
    done: Promise<void>;
    identity?: OwnedIdentity;
}

function sameExecutable(a: string, b: string): boolean {
    try {
        return realpathSync(a) === realpathSync(b);
    } catch {
        return resolve(a) === resolve(b);
    }
}

function processStartTime(pid: number): string {
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8',
        timeout: IDENTITY_TIMEOUT_MS,
        env: identityEnv(),
    }).trim();
}

function processExecutables(pid: number): string[] {
    let raw: string;
    try {
        raw = execFileSync(
            lsofBin(),
            ['-a', '-p', String(pid), '-d', 'txt', '-Fn'],
            {
                encoding: 'utf8',
                timeout: IDENTITY_TIMEOUT_MS,
                env: identityEnv(),
            },
        );
    } catch (error) {
        if ((error as NodeJS.ErrnoException & { status?: number }).status === 1)
            return [];
        throw error;
    }
    return raw
        .split(/\r?\n/)
        .filter((line) => line.startsWith('n'))
        .map((line) => line.slice(1));
}

// PIDs listening on the exact loopback socket. lsof exits 1 on no match.
function socketListeners(bindAddress: string, port: number): number[] {
    let raw: string;
    try {
        raw = execFileSync(
            lsofBin(),
            [
                '-nP',
                '-a',
                `-iTCP@${bindAddress}:${port}`,
                '-sTCP:LISTEN',
                '-Fp',
            ],
            {
                encoding: 'utf8',
                timeout: IDENTITY_TIMEOUT_MS,
                env: identityEnv(),
            },
        );
    } catch (error) {
        if ((error as NodeJS.ErrnoException & { status?: number }).status === 1)
            return [];
        throw error;
    }
    return [...raw.matchAll(/^p(\d+)$/gm)].map((match) => Number(match[1]));
}

function ownedSocketListener(identity: OwnedIdentity): boolean {
    let raw: string;
    try {
        raw = execFileSync(
            lsofBin(),
            [
                '-nP',
                '-a',
                '-p',
                String(identity.pid),
                `-iTCP@${identity.bindAddress}:${identity.port}`,
                '-sTCP:LISTEN',
                '-Fp',
            ],
            {
                encoding: 'utf8',
                timeout: IDENTITY_TIMEOUT_MS,
                env: identityEnv(),
            },
        );
    } catch (error) {
        if ((error as NodeJS.ErrnoException & { status?: number }).status === 1)
            return false;
        throw error;
    }
    return raw.split(/\r?\n/).includes(`p${identity.pid}`);
}

// Throws when the recorded PID is not the spawned process or a foreign
// listener owns the socket. Health alone never proves ownership.
export function assertOwnedIdentity(
    identity: OwnedIdentity,
    requireListener: boolean,
): void {
    const startTime = processStartTime(identity.pid);
    const executables = processExecutables(identity.pid);
    if (
        !startTime ||
        startTime !== identity.startTime ||
        !executables.some((path) => sameExecutable(path, identity.executable))
    ) {
        throw new Error(
            `Fixture process identity mismatch for PID ${identity.pid}.`,
        );
    }
    const foreign = socketListeners(identity.bindAddress, identity.port).find(
        (pid) => pid !== identity.pid,
    );
    if (foreign !== undefined) {
        throw new Error(
            `Foreign listener PID ${foreign} owns ${identity.bindAddress}:${identity.port}.`,
        );
    }
    if (requireListener && !ownedSocketListener(identity)) {
        throw new Error(
            `Fixture PID ${identity.pid} does not own its listener.`,
        );
    }
}

function groupExists(pid: number): boolean {
    try {
        process.kill(-pid, 0);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
        if (
            process.platform === 'darwin' &&
            (error as NodeJS.ErrnoException).code === 'EPERM'
        ) {
            // Darwin can report EPERM while a terminated group contains only zombies.
            // Inspect only the recorded group; never signal a discovered process.
            const rows = execFileSync('/bin/ps', ['-axo', 'pgid=,stat='], {
                encoding: 'utf8',
                timeout: 1_000,
                env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
            })
                .trim()
                .split('\n')
                .map((row) => row.trim().split(/\s+/));
            const members = rows.filter(([group]) => group === String(pid));
            if (members.every(([, state]) => state?.startsWith('Z')))
                return false;
        }
        throw error;
    }
}

// Only a PID returned by this fixture's detached spawn may reach this function.
// Checkpoints run before TERM and before KILL; a checkpoint failure
// must retain state instead of signaling.
export async function stopOwnedGroup(
    pid: number,
    checkpoints: { beforeTerm?: () => void; beforeKill?: () => void } = {},
): Promise<void> {
    if (!groupExists(pid)) return;
    checkpoints.beforeTerm?.();
    try {
        process.kill(-pid, 'SIGTERM');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    const deadline = Date.now() + 10_000;
    while (groupExists(pid) && Date.now() < deadline) await pause(50);
    if (!groupExists(pid)) return;
    checkpoints.beforeKill?.();
    try {
        process.kill(-pid, 'SIGKILL');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    const killedDeadline = Date.now() + 1_000;
    while (groupExists(pid) && Date.now() < killedDeadline) await pause(50);
    if (groupExists(pid))
        throw new Error(`Owned process group ${pid} did not stop.`);
}

async function stopOwnedChild(owned: OwnedChild): Promise<void> {
    const identity = owned.identity;
    if (owned.child.pid === undefined || identity === undefined) {
        if (owned.child.pid !== undefined)
            await stopOwnedGroup(owned.child.pid);
        return;
    }
    const pid = identity.pid;
    await stopOwnedGroup(pid, {
        beforeTerm: () => assertOwnedIdentity(identity, true),
        beforeKill: () => assertOwnedIdentity(identity, false),
    });
    await Promise.race([owned.done, pause(5_000)]);
    if (!owned.ended)
        throw new Error(`Owned process group ${pid} did not stop.`);
    const deadline = Date.now() + 5_000;
    while (
        socketListeners(identity.bindAddress, identity.port).length > 0 &&
        Date.now() < deadline
    )
        await pause(50);
    if (socketListeners(identity.bindAddress, identity.port).length > 0)
        throw new Error(`Owned socket on port ${identity.port} did not close.`);
}

function listen(server: Server): Promise<number> {
    return new Promise((done, fail) => {
        server.once('error', fail);
        server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', fail);
            const address = server.address();
            if (!address || typeof address === 'string')
                return fail(new Error('Missing loopback port.'));
            done(address.port);
        });
    });
}

function closeServer(server: Server): Promise<void> {
    server.closeAllConnections();
    return new Promise((done, fail) =>
        server.close((error) => {
            if (
                error &&
                (error as NodeJS.ErrnoException).code !==
                    'ERR_SERVER_NOT_RUNNING'
            )
                fail(error);
            else done();
        }),
    );
}

async function waitUntilReady(
    owned: OwnedChild,
    url: string,
    milliseconds: number,
): Promise<void> {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
        if (owned.failure) throw owned.failure;
        if (owned.ended)
            throw new Error(`${owned.name} exited before readiness.`);
        try {
            const response = await fetch(url, {
                signal: AbortSignal.timeout(1_000),
                redirect: 'error',
            });
            const ok = response.ok;
            await response.body?.cancel();
            if (owned.failure) throw owned.failure;
            if (ok && !owned.ended) return;
        } catch {
            /* Retry until the bounded deadline or owned child exit. */
        }
        await pause(100);
    }
    throw new Error(`${owned.name} readiness timed out.`);
}

function sha256File(path: string): string {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function worktreeRevision(): string {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        timeout: IDENTITY_TIMEOUT_MS,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' },
    }).trim();
}

function builtRevision(binary: string): { revision: string; modified: string } {
    const info = execFileSync('go', ['version', '-m', binary], {
        encoding: 'utf8',
        timeout: IDENTITY_TIMEOUT_MS,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' },
    });
    const revision = info.match(/^\s*build\s+vcs\.revision=(\S+)$/m)?.[1] ?? '';
    const modified = info.match(/^\s*build\s+vcs\.modified=(\S+)$/m)?.[1] ?? '';
    return { revision, modified };
}

function checkRuntimeTmp(runTmp: string): void {
    accessSync(runTmp, fsConstants.W_OK);
    const st = statSync(runTmp);
    if (!st.isDirectory() || (st.mode & 0o777) !== 0o700)
        throw new Error(`Phi fixture temp ${runTmp} is not a private dir.`);
    const candidate = join(runTmp, `phi-pi-${'f'.repeat(16)}`, 'bridge.sock');
    const publishable =
        !candidate.includes('%') &&
        !candidate.includes('@') &&
        !candidate.includes('://') &&
        !candidate.startsWith('//');
    const bytes = Buffer.byteLength(candidate);
    if (!publishable || bytes > MAX_SOCKET_PATH_BYTES) {
        throw new Error(
            `Phi fixture temp ${runTmp} cannot host a 100-byte bridge socket ` +
                `(candidate ${bytes} bytes); set TMPDIR to a short path.`,
        );
    }
}

function resolveViteBin(): string {
    const pkgPath = join(
        root,
        'packages/web-react/node_modules/vite/package.json',
    );
    let bin: unknown;
    try {
        bin = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { bin?: unknown })
            .bin;
    } catch {
        throw new Error('Missing Vite launcher for the fixture.');
    }
    const entry =
        typeof bin === 'string'
            ? bin
            : (bin as { vite?: unknown } | null)?.vite;
    if (typeof entry !== 'string') throw new Error('Missing Vite launcher.');
    const viteBin = resolve(
        join(root, 'packages/web-react/node_modules/vite'),
        entry,
    );
    if (!existsSync(viteBin)) throw new Error('Missing Vite launcher.');
    return viteBin;
}

export interface FoundationStack {
    reactUrl: string;
    phiUrl: string;
    setPassword(password: string): Promise<void>;
    stop(): Promise<void>;
}

export async function startFoundationStack(): Promise<FoundationStack> {
    if (process.platform === 'win32')
        throw new Error('This fixture requires POSIX process groups.');
    const dir = mkdtempSync(join(tmpdir(), 'pwr-'));
    const runTmp = join(dir, 't');
    mkdirSync(runTmp, { recursive: true, mode: 0o700 });
    chmodSync(runTmp, 0o700);
    checkRuntimeTmp(runTmp);
    const artifacts = join(root, 'test-results/web-react', basename(dir));
    const cleanups: Array<() => Promise<void>> = [];
    const stopErrors: unknown[] = [];
    const stubLog = join(dir, 'coder-invocations.log');
    let stopped: Promise<void> | undefined;
    const stop = () => {
        stopped ??= (async () => {
            for (const cleanup of cleanups.splice(0).reverse()) {
                try {
                    await cleanup();
                } catch (error) {
                    stopErrors.push(error);
                }
            }
            if (stopErrors.length)
                throw new AggregateError(
                    stopErrors,
                    'Foundation fixture cleanup failed.',
                );
        })();
        return stopped;
    };
    cleanups.push(async () => {
        const invocations = existsSync(stubLog)
            ? readFileSync(stubLog, 'utf8')
            : '';
        if (stopErrors.length) {
            const reasons = stopErrors
                .map((error) =>
                    error instanceof Error ? error.message : String(error),
                )
                .join('; ');
            throw new Error(
                `Retained owned state at ${dir}: ${reasons}` +
                    (invocations
                        ? `; Unexpected coder invocation: ${invocations}`
                        : ''),
            );
        }
        rmSync(dir, { recursive: true, force: true });
        if (invocations)
            throw new Error(`Unexpected coder invocation: ${invocations}`);
    });
    const launch = (
        name: string,
        command: string,
        args: string[],
        cwd: string,
        env: NodeJS.ProcessEnv,
        executable?: string,
        port?: number,
    ): OwnedChild => {
        const child: ChildProcess = spawn(command, args, {
            cwd,
            env,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const owned: OwnedChild = {
            child,
            name,
            log: Buffer.alloc(0),
            ended: false,
            done: Promise.resolve(),
        };
        owned.done = new Promise((done) => {
            child.once('error', (error) => {
                owned.failure = error;
                owned.ended = true;
                done();
            });
            child.once('exit', (code, signal) => {
                owned.ended = true;
                if (code !== 0)
                    owned.failure = new Error(
                        `${name} exited (${code ?? signal}).`,
                    );
                done();
            });
        });
        const capture = (data: Buffer) => {
            owned.log = Buffer.from(
                Buffer.concat([owned.log, data]).subarray(-65_536),
            );
        };
        child.stdout?.on('data', capture);
        child.stderr?.on('data', capture);
        cleanups.push(async () => {
            try {
                await stopOwnedChild(owned);
            } finally {
                writeFileSync(join(artifacts, `${name}.log`), owned.log);
            }
        });
        // Capture identity only after cleanup is registered: a failed
        // check must still stop the spawned child, never leak it.
        if (child.pid !== undefined && executable !== undefined) {
            owned.identity = {
                pid: child.pid,
                startTime: processStartTime(child.pid),
                executable: realpathSync(executable),
                bindAddress: '127.0.0.1',
                port: port ?? 0,
            };
            assertOwnedIdentity(owned.identity, false);
        }
        writeFileSync(
            join(artifacts, `${name}-owner.json`),
            JSON.stringify({
                pid: child.pid,
                processGroup: child.pid,
                startTime: owned.identity?.startTime,
                executable: owned.identity?.executable,
                bindAddress: owned.identity?.bindAddress,
                port: owned.identity?.port,
                dir,
            }),
        );
        return owned;
    };
    try {
        mkdirSync(artifacts, { recursive: true });
        for (const name of ['home/.phi', 'bin', 'cache', 'work'])
            mkdirSync(join(dir, name), { recursive: true });
        for (const coder of ['pi', 'codex', 'opencode', 'claude', 'agy']) {
            const quotedLog = `'${stubLog.replaceAll("'", "'\\''")}'`;
            writeFileSync(
                join(dir, 'bin', coder),
                `#!/bin/sh\nprintf '%s\\n' '${coder}' >> ${quotedLog}\nexit 97\n`,
                { mode: 0o755 },
            );
        }
        const coordinator = createServer((request, response) => {
            if (
                request.method === 'GET' &&
                request.url?.startsWith('/api/sync/messages')
            ) {
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end('[]');
            } else {
                response.writeHead(404);
                response.end();
            }
        });
        cleanups.push(() => closeServer(coordinator));
        const coordinatorPort = await listen(coordinator);
        const configToml = `${Object.entries({
            auto_reconnect: 'off',
            peers: [],
            workspaces: [join(dir, 'work')],
            markdown_dirs: [],
            sync_coordinator: `http://127.0.0.1:${coordinatorPort}`,
            pushover_enabled: false,
            webhook_enabled: false,
            simplepush_enabled: false,
        })
            .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
            .join('\n')}\n`;
        writeFileSync(join(dir, 'home/.phi/config.toml'), configToml);
        const expectedRevision = worktreeRevision();
        const binary = join(dir, 'phi');
        const build = launch(
            'build',
            'go',
            ['build', '-o', binary, '.'],
            root,
            buildEnvironment(process.env),
        );
        let buildTimeout: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                build.done,
                new Promise<never>((_, fail) => {
                    buildTimeout = setTimeout(
                        () => fail(new Error('Go build timed out.')),
                        300_000,
                    );
                }),
            ]);
            if (build.failure) throw build.failure;
        } finally {
            clearTimeout(buildTimeout);
        }
        const built = builtRevision(binary);
        if (!built.revision || built.revision !== expectedRevision)
            throw new Error('Built phi revision does not match the worktree.');
        const binarySha256 = sha256File(binary);
        const canonicalBinary = realpathSync(binary);
        const portReservation = createServer();
        cleanups.push(() => closeServer(portReservation));
        const phiPort = await listen(portReservation);
        await closeServer(portReservation);
        const runtime = runtimeEnvironment(process.env, dir);
        const phi = launch(
            'phi',
            binary,
            ['--ip', '127.0.0.1', '--port', String(phiPort)],
            join(dir, 'work'),
            runtime,
            canonicalBinary,
            phiPort,
        );
        const phiUrl = `http://127.0.0.1:${phiPort}`;
        await waitUntilReady(phi, `${phiUrl}/healthz`, 90_000);
        if (!phi.identity) throw new Error('Missing phi identity.');
        assertOwnedIdentity(phi.identity, true);
        writeFileSync(
            join(artifacts, 'phi-owner.json'),
            JSON.stringify({
                pid: phi.identity.pid,
                processGroup: phi.identity.pid,
                startTime: phi.identity.startTime,
                executable: phi.identity.executable,
                revision: built.revision,
                modified: built.modified,
                sha256: binarySha256,
                bindAddress: phi.identity.bindAddress,
                port: phi.identity.port,
                dir,
            }),
        );
        const viteReservation = createServer();
        cleanups.push(() => closeServer(viteReservation));
        const vitePort = await listen(viteReservation);
        await closeServer(viteReservation);
        const viteBin = resolveViteBin();
        const vite = launch(
            'vite',
            process.execPath,
            [viteBin, '--port', String(vitePort)],
            join(root, 'packages/web-react'),
            { ...runtime, PHI_PORT: String(phiPort) },
            process.execPath,
            vitePort,
        );
        const reactUrl = `http://127.0.0.1:${vitePort}`;
        await waitUntilReady(vite, reactUrl, 30_000);
        if (!vite.identity) throw new Error('Missing vite identity.');
        assertOwnedIdentity(vite.identity, true);
        let setupBearer: string | null = null;
        const setPassword = async (password: string): Promise<void> => {
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'X-Phi-Auth': 'v2',
            };
            if (setupBearer) headers.Authorization = `Bearer ${setupBearer}`;
            let status = 0;
            let body: unknown;
            try {
                const response = await fetch(`${phiUrl}/api/auth/v2/password`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ password }),
                    redirect: 'error',
                    signal: AbortSignal.timeout(SETUP_TIMEOUT_MS),
                });
                status = response.status;
                body =
                    status === 200
                        ? await response.json()
                        : await response.text().catch(() => '');
            } catch {
                status = 0;
            }
            const record =
                body !== null &&
                typeof body === 'object' &&
                !Array.isArray(body)
                    ? (body as Record<string, unknown>)
                    : null;
            const confirmed =
                status === 200 &&
                record !== null &&
                (password === ''
                    ? record.enabled === false
                    : record.enabled === true &&
                      typeof record.token === 'string' &&
                      record.token.length > 0);
            if (!confirmed) {
                // Teardown rethrows the same idempotent stop on failure.
                await stop().catch(() => {});
                throw new Error(
                    'Password setup was not confirmed; stopped the fixture attempt.',
                );
            }
            if (password === '') setupBearer = null;
            else setupBearer = (record as Record<string, string>).token;
        };
        return { reactUrl, phiUrl, setPassword, stop };
    } catch (error) {
        try {
            await stop();
        } catch (cleanupError) {
            throw new AggregateError(
                [error, cleanupError],
                'Foundation startup and cleanup failed.',
            );
        }
        throw error;
    }
}

if (
    process.argv[1] &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
    process.argv.includes('--manual')
) {
    const stack = await startFoundationStack();
    if (process.argv.includes('--manual-auth'))
        await stack.setPassword(MANUAL_AUTH_PASSWORD);
    const authLine = process.argv.includes('--manual-auth')
        ? 'Auth: enabled via MANUAL_AUTH_PASSWORD (constant in phi-server.ts).\n'
        : '';
    console.log(
        `React: ${stack.reactUrl}\nPhi: ${stack.phiUrl}\n${authLine}Observational comparison only. Press Ctrl-C to stop.`,
    );
    const shutdown = () => {
        void stack.stop().catch((error: unknown) => {
            console.error(error);
            process.exitCode = 1;
        });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
}
