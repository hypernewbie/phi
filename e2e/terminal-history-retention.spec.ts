import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startPhi } from './_server.js';

// Read the real backend envelope, not a browser stub or a fake scrollback.
function output(body: Buffer): string {
    const headerSize = body.readUInt32BE(0);
    return body.subarray(4 + headerSize).toString('utf8');
}

for (const situation of [
    'replay cache disabled',
    'tiny replay cache',
    'Phi server restart',
]) {
    test(`cold terminal bytes stay available: ${situation}`, async ({
        request,
    }) => {
        const phi = await startPhi({
            config: {
                replay_buffer_bytes:
                    situation === 'replay cache disabled'
                        ? 0
                        : situation === 'tiny replay cache'
                          ? 64
                          : 8192,
            },
            setup(dir) {
                const command = join(dir, 'history-fixture');
                writeFileSync(
                    command,
                    `#!/usr/bin/env python3
import os, time
path = os.path.join(os.environ['HOME'], 'launch-count')
try:
    with open(path) as f: count = int(f.read()) + 1
except FileNotFoundError: count = 1
with open(path, 'w') as f: f.write(str(count))
os.write(1, ('LIFETIME %d FIRST\\r\\n' % count).encode())
for i in range(100): os.write(1, ('history row %04d\\r\\n' % i).encode())
os.write(1, b'LAST\\r\\n')
while True: time.sleep(1)
`,
                    { mode: 0o755 },
                );
                const backends = join(dir, 'home', '.phi', 'backends');
                mkdirSync(backends, { recursive: true });
                writeFileSync(
                    join(backends, 'pi.json'),
                    JSON.stringify({ id: 'pi', command }),
                );
            },
        });
        try {
            const spawned = await request.post(`${phi.url}/api/terminals`, {
                data: { coder: 'pi', cwd: phi.dir },
            });
            expect(spawned.ok()).toBe(true);
            const pane = (await spawned.json()).pane_id as string;
            const recording = async () => {
                const response = await request.get(
                    `${phi.url}/api/terminals/${pane}/recording?from=0&through=18446744073709551615`,
                );
                return response.ok() ? output(await response.body()) : '';
            };
            await expect.poll(recording).toContain('LAST');
            if (situation === 'Phi server restart') {
                expect(await recording()).toContain('LIFETIME 1 FIRST');
                await phi.restart();
                await expect.poll(recording).toContain('LIFETIME 2 FIRST');
            }
            const bytes = await recording();
            expect(
                bytes,
                'replay caps and restart must not erase the cold recording',
            ).toContain('LIFETIME 1 FIRST');
            expect(bytes).toContain('history row 0000');
            expect(bytes).toContain('history row 0099');
        } finally {
            await phi.stop();
        }
    });
}
