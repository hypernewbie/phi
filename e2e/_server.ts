import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
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

export async function startPhi(): Promise<PhiServer> {
    const dir = mkdtempSync(join(tmpdir(), 'phi-e2e-'));
    mkdirSync(join(dir, 'home'), { recursive: true });

    const port = await freePort();
    const bin = join(dir, process.platform === 'win32' ? 'phi.exe' : 'phi');
    await run('go', ['build', '-o', bin, '.'], process.cwd());
    const server: ChildProcess = spawn(
        bin,
        ['--port', String(port), '--ip', '127.0.0.1'],
        {
            cwd: dir,
            env: {
                ...process.env,
                HOME: join(dir, 'home'),
                USERPROFILE: join(dir, 'home'),
                APPDATA: join(dir, 'home'),
            },
            stdio: 'ignore',
        },
    );
    await waitForHealth(port);

    return {
        url: `http://127.0.0.1:${port}`,
        dir,
        stop: async () => {
            if (server.exitCode === null) {
                const exited = new Promise<void>((resolve) =>
                    server.once('exit', () => resolve()),
                );
                server.kill();
                await Promise.race([
                    exited,
                    new Promise((r) => setTimeout(r, 5_000)),
                ]);
            }
            // Best-effort: the binary can stay briefly locked on Windows.
            try {
                rmSync(dir, { recursive: true, force: true });
            } catch {
                // Tmp dirs are reaped by the OS; never fail on cleanup.
            }
        },
    };
}
