// Helpers for the addressed-message mesh: the listener address the server
// logged, and the fixture that publishes one message over the real wire.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Read the mesh port the server logged when it bound the listener. The log
 * is written asynchronously, so this waits instead of assuming the line landed.
 */
export async function meshAddrFromLog(logPath: string): Promise<string> {
    const deadline = Date.now() + 30_000;
    let last = '';
    while (Date.now() < deadline) {
        try {
            last = readFileSync(logPath, 'utf8');
        } catch {
            last = '';
        }
        const match = /sync mesh listening"?\s+addr=(\S+)/.exec(last);
        if (match?.[1]) return match[1];
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const tail = last.split('\n').slice(-15).join('\n');
    throw new Error(`no mesh listener in ${logPath}\ntail:\n${tail}`);
}

/** Publish one addressed message over the real mesh wire. */
export function publishToMesh(
    addr: string,
    recipient: string,
    value: string,
): string {
    return execFileSync(
        'go',
        [
            'run',
            './e2e/fixtures/syncpush',
            '-addr',
            addr,
            '-recipient',
            recipient,
            '-value',
            value,
        ],
        { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000 },
    ).trim();
}
