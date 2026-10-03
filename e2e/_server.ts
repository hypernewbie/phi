import {
    appendFileSync,
    mkdtempSync,
    rmSync,
    mkdirSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';

// Shared live-server fixture for e2e specs: builds phi once, runs it
// with cwd + HOME inside a tmp dir (clean config, no access password,
// file tree rooted at the tmp dir).

export interface PhiServer {
    url: string;
    dir: string;
    stop: () => Promise<void>;
    restart: () => Promise<void>;
    logPath: string;
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
    } = {},
): Promise<PhiServer> {
    const dir = mkdtempSync(join(tmpdir(), 'phi-e2e-'));
    mkdirSync(join(dir, 'home'), { recursive: true });
    if (options.config) {
        mkdirSync(join(dir, 'home', '.phi'), { recursive: true });
        writeFileSync(
            join(dir, 'home', '.phi', 'config.json'),
            JSON.stringify(options.config),
        );
    }

    await options.setup?.(dir);
    const port = await freePort();
    const bin = join(dir, process.platform === 'win32' ? 'phi.exe' : 'phi');
    await run('go', ['build', '-o', bin, '.'], process.cwd());
    const launch = (): ChildProcess =>
        spawn(bin, ['--port', String(port), '--ip', '127.0.0.1'], {
            cwd: dir,
            env: {
                ...process.env,
                HOME: join(dir, 'home'),
                USERPROFILE: join(dir, 'home'),
                APPDATA: join(dir, 'home'),
                ...options.env,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    const logPath = join(dir, 'server.log');
    const capture = (child: ChildProcess) => {
        child.stdout?.on('data', (data) => appendFileSync(logPath, data));
        child.stderr?.on('data', (data) => appendFileSync(logPath, data));
        return child;
    };
    let server = capture(launch());
    await waitForHealth(port);

    const terminate = async () => {
        if (server.exitCode !== null) return;
        const exited = new Promise<void>((resolve) =>
            server.once('exit', () => resolve()),
        );
        server.kill();
        await Promise.race([
            exited,
            new Promise((resolve) => setTimeout(resolve, 10_000)),
        ]);
        if (server.exitCode === null) {
            server.kill('SIGKILL');
            await exited;
        }
    };

    return {
        url: `http://127.0.0.1:${port}`,
        logPath,
        dir,
        restart: async () => {
            await terminate();
            server = capture(launch());
            await waitForHealth(port);
        },
        stop: async () => {
            await terminate();
            // Best-effort: the binary can stay briefly locked on Windows.
            try {
                rmSync(dir, { recursive: true, force: true });
            } catch {
                // Tmp dirs are reaped by the OS; never fail on cleanup.
            }
        },
    };
}
