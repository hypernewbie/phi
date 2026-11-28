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
        {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 10_000,
        },
    );
    return JSON.parse(raw);
}

async function listening() {
    const server = createServer();
    await new Promise((resolve, reject) =>
        server.once('error', reject).listen(0, '127.0.0.1', resolve),
    );
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
    }, 15_000);

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
    }, 15_000);

    test('a parameter error still fails the command', () => {
        expect(() => query('127.0.0.1', 99999)).toThrow(
            expect.objectContaining({
                status: 1,
                stderr: expect.stringContaining(
                    'ParameterArgumentTransformationError',
                ),
            }),
        );
    }, 15_000);
});
