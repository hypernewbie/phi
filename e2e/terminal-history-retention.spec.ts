import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startPhi } from './_server.js';
import { readReplay, terminalHead } from './_terminal-replay.js';

for (const situation of [
    'history disabled',
    'tiny RAM window',
    'Phi server restart',
]) {
    test(`RAM history honors its lifetime: ${situation}`, async ({
        request,
    }) => {
        const phi = await startPhi({
            config: {
                replay_buffer_bytes:
                    situation === 'history disabled'
                        ? 0
                        : situation === 'tiny RAM window'
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
                return (await readReplay(phi.url, pane)).data.toString('utf8');
            };
            // Disabled history cannot retain a completion marker. The head
            // still advances as the child emits its hundred rows.
            await expect
                .poll(async () => (await terminalHead(phi.url, pane)).head)
                .toBeGreaterThan(1000);
            if (situation === 'history disabled') {
                expect(await recording()).toBe('');
                return;
            }
            await expect.poll(recording).toContain('LAST');
            if (situation === 'Phi server restart') {
                expect(await recording()).toContain('LIFETIME 1 FIRST');
                const old = await terminalHead(phi.url, pane);
                await phi.restart();
                await expect.poll(recording).toContain('LIFETIME 2 FIRST');
                const oldRead = await request.get(
                    `${phi.url}/api/terminals/${pane}/replay?epoch=${old.epoch}&from=0&through=latest`,
                );
                expect([404, 409]).toContain(oldRead.status());
                const bytes = await recording();
                expect(bytes).not.toContain('LIFETIME 1 FIRST');
                expect(bytes).toContain('history row 0000');
                expect(bytes).toContain('history row 0099');
            } else {
                const tail = await readReplay(phi.url, pane);
                expect(tail.oldest).toBeGreaterThan(0);
                expect(tail.data.length).toBeLessThanOrEqual(64);
                expect(tail.data.toString('utf8')).not.toContain(
                    'history row 0000',
                );
                expect(tail.data.toString('utf8')).toContain(
                    'history row 0099',
                );
            }
        } finally {
            await phi.stop();
        }
    });
}
