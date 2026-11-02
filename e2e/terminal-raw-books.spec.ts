import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { TerminalServerFrame } from '../web/proto/terminal.js';
import type {
    MessageFns,
    TerminalServerFrame as TerminalServerMessage,
} from '../web-src/proto/terminal.js';
import { startPhi } from './_server.js';
import { readReplay } from './_terminal-replay.js';

// The served bundle carries no types; bind its runtime codec to the
// generated declarations so spec-side decoding is fully checked.
const ServerCodec: MessageFns<TerminalServerMessage> =
    TerminalServerFrame as unknown as MessageFns<TerminalServerMessage>;

interface StateTerminal {
    element?: HTMLElement;
    buffer: {
        active: {
            length: number;
            getLine(
                i: number,
            ): { translateToString(trim?: boolean): string } | undefined;
        };
    };
    write(data: string | Uint8Array, callback?: () => void): void;
}
interface StateConstructor {
    new (options: Record<string, unknown>): StateTerminal;
}
interface StateWindow {
    stateTerms: StateTerminal[];
    statePending: number;
    Terminal: StateConstructor;
}

// Real raw journal -> browser stream decoder -> xterm, including a split
// glyph in the alternate buffer and the saved primary buffer on return.
test('raw replay preserves alternate screen, split UTF-8 and return to primary', async ({
    page,
    request,
}) => {
    const glyph = Buffer.from('🙂');
    const prefix = Buffer.concat([
        Buffer.from(
            '\x1b[2J\x1b[HPRIMARY_BOOK\x1b[?1049h\x1b[2J\x1b[HALT_BOOK ',
        ),
        glyph.subarray(0, 2),
    ]);
    const phi = await startPhi({
        setup(dir) {
            const command = join(dir, 'state-fixture');
            writeFileSync(
                command,
                `#!/usr/bin/env python3
import os, time
home = os.environ['HOME']
os.write(1, b'archive book payload\\r\\n' * 100000)
os.write(1, bytes(${JSON.stringify([...prefix])}))
while not os.path.exists(os.path.join(home, 'finish-utf8')): time.sleep(0.01)
os.write(1, bytes(${JSON.stringify([...glyph.subarray(2)])}) + b' LIVE_READY')
while not os.path.exists(os.path.join(home, 'return-primary')): time.sleep(0.01)
os.write(1, b'\\x1b[?1049l AFTER_EXIT')
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
        await expect
            .poll(
                async () =>
                    (await readReplay(phi.url, pane)).data.includes(prefix),
                { timeout: 30_000 },
            )
            .toBe(true);
        const sourceBytes = (await readReplay(phi.url, pane)).data.length;
        const attachSizes: number[] = [];
        const browserRecordingRequests: string[] = [];
        const browserReplayRequests: string[] = [];
        page.on('request', (req) => {
            if (req.url().includes(`/api/terminals/${pane}/recording?`))
                browserRecordingRequests.push(req.url());
            if (req.url().includes(`/api/terminals/${pane}/replay?`))
                browserReplayRequests.push(req.url());
        });
        page.on('websocket', (socket) => {
            if (!socket.url().includes(`/ws/pane/${pane}?`)) return;
            socket.on('framereceived', ({ payload }) => {
                if (!Buffer.isBuffer(payload)) return;
                const decoded = ServerCodec.decode(new Uint8Array(payload));
                if (decoded.payload?.$case === 'attach')
                    attachSizes.push(payload.length);
            });
        });
        await page.addInitScript(() => {
            const w = window as unknown as StateWindow;
            w.stateTerms = [];
            w.statePending = 0;
            let Base: StateConstructor;
            Object.defineProperty(window, 'Terminal', {
                configurable: true,
                get: () => Base,
                set: (Original: StateConstructor) => {
                    Base = class extends Original {
                        constructor(options: Record<string, unknown>) {
                            super(options);
                            w.stateTerms.push(this);
                        }
                        write(
                            data: string | Uint8Array,
                            callback?: () => void,
                        ) {
                            w.statePending++;
                            super.write(data, () => {
                                w.statePending--;
                                callback?.();
                            });
                        }
                    };
                },
            });
        });
        const screenText = () =>
            page.evaluate((id) => {
                const w = window as unknown as StateWindow;
                const term = w.stateTerms.find(
                    (t) =>
                        t.element?.closest('.term-container')?.id ===
                        `term-${id}`,
                );
                if (!term || w.statePending !== 0) return '';
                return Array.from(
                    { length: term.buffer.active.length },
                    (_, i) =>
                        term.buffer.active
                            .getLine(i)
                            ?.translateToString(true) ?? '',
                ).join('\n');
            }, pane);
        await page.goto(phi.url);
        await expect.poll(screenText).toContain('ALT_BOOK');
        expect(attachSizes).toHaveLength(1);
        expect(attachSizes[0]).toBeLessThan(sourceBytes / 20);
        expect(browserReplayRequests.length).toBeGreaterThan(0);
        expect(browserRecordingRequests).toHaveLength(0);
        writeFileSync(join(phi.dir, 'home', 'finish-utf8'), 'go');
        await expect.poll(screenText).toContain('ALT_BOOK 🙂 LIVE_READY');
        expect(await screenText()).not.toContain('\ufffd');
        writeFileSync(join(phi.dir, 'home', 'return-primary'), 'go');
        await expect.poll(screenText).toContain('PRIMARY_BOOK AFTER_EXIT');
        await page.reload();
        await expect.poll(screenText).toContain('PRIMARY_BOOK AFTER_EXIT');
        expect(browserRecordingRequests).toHaveLength(0);
    } finally {
        await phi.stop();
    }
});
