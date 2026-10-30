// Test-only bridge IPC forwarder: byte-blind proxy between one owned
// Pi extension socket and Phi's REAL private bridge socket. Lets a spec
// drop/reopen only the bridge stream while the Pi process, PTY, and
// browser socket stay alive. Loopback-local Unix sockets only, no TCP,
// no payload/header inspection, no credential logging: only connection
// counts are recorded. Bundle-safe: no playwright imports.
import { chmodSync, statSync, unlinkSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import net from 'node:net';

// Mirrors Go maxSocketPathBytes: absolute Unix socket paths fit 100 bytes.
const MAX_SOCKET_PATH_BYTES = 100;

export interface BridgeProxy {
    // Total forwarded connections accepted so far (evidence only).
    forwarded: () => number;
    // Reject new connections and destroy both halves of every live
    // forwarded pair. Either endpoint sees EOF; neither process dies.
    drop: () => Promise<void>;
    // Pause Pi-to-Phi bytes without inspecting them. The returned
    // function resumes those bytes. Phi-to-Pi requests still flow.
    pausePiToPhi: () => () => void;
    // Accept connections again on the same socket path.
    resume: () => Promise<void>;
    close: () => Promise<void>;
}

function insideDir(root: string, candidate: string): boolean {
    const rel = relative(root, candidate);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function checkSocketPath(root: string, label: string, p: string): void {
    if (!isAbsolute(p) || !insideDir(root, p)) {
        throw new Error(`bridge proxy ${label} escapes fixture tmp`);
    }
    if (
        p.includes('%') ||
        p.includes('@') ||
        p.includes('://') ||
        p.startsWith('//') ||
        Buffer.byteLength(p) > MAX_SOCKET_PATH_BYTES
    ) {
        throw new Error(`bridge proxy ${label} is not publishable`);
    }
}

// realSocket is Phi's live bridge socket; proxySocket is the owned path
// the test wrapper publishes instead. root is the owned fixture tmp
// both must live under. The real socket must already exist, private.
export function startBridgeProxy(
    root: string,
    realSocket: string,
    proxySocket: string,
): Promise<BridgeProxy> {
    checkSocketPath(root, 'upstream', realSocket);
    checkSocketPath(root, 'proxy', proxySocket);
    const st = statSync(realSocket);
    if (!st.isSocket() || (st.mode & 0o777) !== 0o600) {
        throw new Error('bridge proxy upstream is not a private socket');
    }
    let forwarded = 0;
    let piToPhiPaused = false;
    const pairs = new Set<{ a: net.Socket; b: net.Socket }>();
    const unlinkProxy = () => {
        try {
            unlinkSync(proxySocket);
        } catch {
            // Absent or already removed; close stays idempotent.
        }
    };
    const destroyPairs = () => {
        for (const pair of pairs) {
            pair.a.destroy();
            pair.b.destroy();
        }
        pairs.clear();
    };
    const server = net.createServer((downstream) => {
        const upstream = net.connect(realSocket);
        const pair = { a: downstream, b: upstream };
        pairs.add(pair);
        forwarded += 1;
        const forget = () => {
            pairs.delete(pair);
        };
        downstream.on('close', forget);
        upstream.on('close', forget);
        downstream.on('error', () => {});
        upstream.on('error', () => {});
        downstream.pipe(upstream);
        upstream.pipe(downstream);
        if (piToPhiPaused) downstream.pause();
    });
    server.on('error', () => {
        // Accept-loop errors surface through drop/resume/close callers.
    });
    const listen = () =>
        new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(proxySocket, () => {
                server.removeListener('error', reject);
                chmodSync(proxySocket, 0o600);
                resolve();
            });
        });
    return (async () => {
        unlinkProxy();
        await listen();
        return {
            forwarded: () => forwarded,
            pausePiToPhi: () => {
                piToPhiPaused = true;
                for (const pair of pairs) pair.a.pause();
                let resumed = false;
                return () => {
                    if (resumed) return;
                    resumed = true;
                    piToPhiPaused = false;
                    for (const pair of pairs) pair.a.resume();
                };
            },
            drop: async () => {
                piToPhiPaused = false;
                destroyPairs();
                await new Promise<void>((resolve, reject) => {
                    server.close((err) => (err ? reject(err) : resolve()));
                });
            },
            resume: async () => {
                await listen();
            },
            close: async () => {
                destroyPairs();
                await new Promise<void>((resolve) => {
                    server.close(() => resolve());
                });
                unlinkProxy();
            },
        };
    })();
}
