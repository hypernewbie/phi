import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { windowsListenerScript } from '../e2e/_server.ts';

// The Windows listener query, run through the real PowerShell. A port
// nobody listens on must answer an empty list: the fixture asks on every
// teardown, after its server has already released the port. Any other
// query failure must still fail the command, so readiness and teardown
// fail closed when they cannot see the listener.
const skip = process.platform !== 'win32';

function query(address, port) {
    const raw = execFileSync(
        'powershell.exe',
        [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            windowsListenerScript(address, port),
        ],
        // stderr is captured on the thrown error instead of leaking into
        // the suite output.
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [parsed];
}

async function listening() {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        port: server.address().port,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

describe.skipIf(skip)('Windows listener query', () => {
    test('a port nobody listens on is an empty list, not a query error', async () => {
        const probe = await listening();
        const port = probe.port;
        await probe.close();
        expect(query('127.0.0.1', port)).toEqual([]);
    });

    test('a listener is reported with its owning PID', async () => {
        const server = await listening();
        try {
            expect(query('127.0.0.1', server.port)).toEqual([
                {
                    OwningProcess: process.pid,
                    LocalAddress: '127.0.0.1',
                    LocalPort: server.port,
                },
            ]);
        } finally {
            await server.close();
        }
    });

    test('any other query failure still fails the command', () => {
        expect(() => query('127.0.0.1', 99999)).toThrow();
    });
});
