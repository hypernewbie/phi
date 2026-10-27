import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const pause = (milliseconds: number) =>
    new Promise<void>((done) => setTimeout(done, milliseconds));

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
    const env: NodeJS.ProcessEnv = {
        PATH: `${join(dir, 'bin')}:${source.PATH ?? '/usr/bin:/bin'}`,
        HOME: join(dir, 'home'),
        USERPROFILE: join(dir, 'home'),
        APPDATA: join(dir, 'home'),
        XDG_CONFIG_HOME: join(dir, 'home'),
        XDG_CACHE_HOME: join(dir, 'cache'),
        TMPDIR: join(dir, 'tmp'),
        TMP: join(dir, 'tmp'),
        TEMP: join(dir, 'tmp'),
    };
    for (const key of ['LANG', 'LC_ALL'])
        if (source[key] !== undefined) env[key] = source[key];
    return env;
}

interface OwnedChild {
    child: ChildProcess;
    name: string;
    log: Buffer;
    ended: boolean;
    failure?: Error;
    done: Promise<void>;
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
export async function stopOwnedGroup(pid: number): Promise<void> {
    if (!groupExists(pid)) return;
    try {
        process.kill(-pid, 'SIGTERM');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    const deadline = Date.now() + 10_000;
    while (groupExists(pid) && Date.now() < deadline) await pause(50);
    if (!groupExists(pid)) return;
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
    requireAnnouncement = false,
): Promise<void> {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
        if (owned.failure) throw owned.failure;
        if (owned.ended)
            throw new Error(`${owned.name} exited before readiness.`);
        if (
            !requireAnnouncement ||
            owned.log.toString().includes('http://127.0.0.1:5173/')
        ) {
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
        }
        await pause(100);
    }
    throw new Error(`${owned.name} readiness timed out.`);
}

export interface FoundationStack {
    reactUrl: string;
    phiUrl: string;
    stop(): Promise<void>;
}

export async function startFoundationStack(): Promise<FoundationStack> {
    if (process.platform === 'win32')
        throw new Error('This fixture requires POSIX process groups.');
    const dir = mkdtempSync(join(tmpdir(), 'phi-web-react-'));
    const artifacts = join(root, 'test-results/web-react', basename(dir));
    const cleanups: Array<() => Promise<void>> = [];
    const stubLog = join(dir, 'coder-invocations.log');
    let stopped: Promise<void> | undefined;
    const stop = () => {
        stopped ??= (async () => {
            const errors: unknown[] = [];
            for (const cleanup of cleanups.splice(0).reverse()) {
                try {
                    await cleanup();
                } catch (error) {
                    errors.push(error);
                }
            }
            if (errors.length)
                throw new AggregateError(
                    errors,
                    'Foundation fixture cleanup failed.',
                );
        })();
        return stopped;
    };
    cleanups.push(async () => {
        const invocations = existsSync(stubLog)
            ? readFileSync(stubLog, 'utf8')
            : '';
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
                if (child.pid !== undefined) await stopOwnedGroup(child.pid);
            } finally {
                writeFileSync(join(artifacts, `${name}.log`), owned.log);
            }
        });
        writeFileSync(
            join(artifacts, `${name}-owner.json`),
            JSON.stringify({ pid: child.pid, processGroup: child.pid }),
        );
        return owned;
    };
    try {
        mkdirSync(artifacts, { recursive: true });
        for (const name of ['home/.phi', 'bin', 'cache', 'tmp', 'work'])
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
        writeFileSync(
            join(dir, 'home/.phi/config.json'),
            JSON.stringify({
                auto_reconnect: 'off',
                peers: [],
                workspaces: [join(dir, 'work')],
                markdown_dirs: [],
                sync_coordinator: `http://127.0.0.1:${coordinatorPort}`,
                pushover_enabled: false,
                webhook_enabled: false,
                simplepush_enabled: false,
            }),
        );
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
        );
        const phiUrl = `http://127.0.0.1:${phiPort}`;
        await waitUntilReady(phi, `${phiUrl}/healthz`, 90_000);
        const vite = launch(
            'vite',
            'pnpm',
            ['--dir', 'packages/web-react', 'dev'],
            root,
            { ...runtime, PHI_PORT: String(phiPort) },
        );
        const reactUrl = 'http://127.0.0.1:5173';
        await waitUntilReady(vite, reactUrl, 30_000, true);
        return { reactUrl, phiUrl, stop };
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
    console.log(
        `React: ${stack.reactUrl}\nPhi: ${stack.phiUrl}\nObservational comparison only. Press Ctrl-C to stop.`,
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
