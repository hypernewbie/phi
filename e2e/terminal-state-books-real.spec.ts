import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startPhi } from './_server.js';
interface BookTerminal {
    element?: HTMLElement;
    cols: number;
    rows: number;
    buffer: {
        active: {
            length: number;
            getLine(n: number):
                | {
                      translateToString(trim?: boolean): string;
                      getCell(n: number): { getFgColor(): number } | undefined;
                  }
                | undefined;
        };
    };
    write(data: string | Uint8Array, callback?: () => void): void;
}
interface BookWindow {
    bookTerms: BookTerminal[];
    pendingBooks: number;
    Terminal: new (options: Record<string, unknown>) => BookTerminal;
}

test('real server books preserve inherited rendition and return live without replaying the browsing backlog', async ({
    page,
    request,
}) => {
    const phi = await startPhi({
        setup(dir) {
            const script = join(dir, 'book-fixture');
            writeFileSync(
                script,
                `#!/usr/bin/env python3
import os, signal, time
home = os.environ['HOME']
def write(data):
    while data:
        n = os.write(1, data)
        data = data[n:]
write(b'\\x1b[31m')
write(''.join('BOOK%08d 你🙂 text\\r\\n' % n for n in range(50000)).encode())
count = 0
def paint(*args):
    global count
    count += 1
    cols, rows = os.get_terminal_size(1)
    write(('\\x1b[0m\\x1b[2J\\x1b[HCURRENT_SCREEN REDRAW_%d GRID_%dx%d\\x1b[%d;1HEDGE' % (count, cols, rows, rows)).encode())
signal.signal(signal.SIGWINCH, paint)
paint()
while not os.path.exists(os.path.join(home, 'new-library')): time.sleep(0.01)
write(b'NEW_BROWSING_LIBRARY\\r\\n' * 400000)
paint()
write(b'\\r\\nBROWSING_DONE')
while True: time.sleep(1)
`,
                { mode: 0o755 },
            );
            const backends = join(dir, 'home', '.phi', 'backends');
            mkdirSync(backends, { recursive: true });
            writeFileSync(
                join(backends, 'pi.json'),
                JSON.stringify({ id: 'pi', command: script }),
            );
        },
    });
    try {
        const response = await request.post(`${phi.url}/api/terminals`, {
            data: { coder: 'pi', cwd: phi.dir },
        });
        expect(response.ok()).toBe(true);
        const id = (await response.json()).pane_id as string;
        const archiveSize =
            Buffer.byteLength('BOOK00000000 你🙂 text\r\n') * 50000;
        await expect
            .poll(async () => {
                const r = await request.get(
                    `${phi.url}/api/terminals/${id}/recording?from=${archiveSize - 256}&through=18446744073709551615`,
                );
                return (
                    r.ok() &&
                    (await r.body()).includes(Buffer.from('CURRENT_SCREEN'))
                );
            })
            .toBe(true);
        const ranges: { from: number; end: number; bytes: number }[] = [];
        const states: string[] = [];
        page.on('request', (r) => {
            if (r.url().includes(`/api/terminals/${id}/state?`))
                states.push(r.url());
        });
        page.on('response', async (r) => {
            if (!r.url().includes(`/api/terminals/${id}/recording?`) || !r.ok())
                return;
            const bytes = await r.body();
            const size = bytes.readUInt32BE(0);
            const h = JSON.parse(bytes.subarray(4, size + 4).toString());
            ranges.push({
                from: h.start,
                end: h.end,
                bytes: bytes.length - 4 - size,
            });
        });
        await page.addInitScript(() => {
            const w = window as unknown as BookWindow;
            w.bookTerms = [];
            w.pendingBooks = 0;
            let Constructor: typeof w.Terminal;
            Object.defineProperty(window, 'Terminal', {
                configurable: true,
                get: () => Constructor,
                set: (Base: typeof w.Terminal) => {
                    Constructor = class extends Base {
                        constructor(options: Record<string, unknown>) {
                            super(options);
                            w.bookTerms.push(this);
                        }
                        write(
                            data: string | Uint8Array,
                            callback?: () => void,
                        ) {
                            w.pendingBooks++;
                            super.write(data, () => {
                                w.pendingBooks--;
                                callback?.();
                            });
                        }
                    };
                },
            });
        });
        const probe = () =>
            page.evaluate((pane) => {
                const w = window as unknown as BookWindow;
                const term = w.bookTerms.find(
                    (t) =>
                        t.element?.closest('.term-container')?.id ===
                        `term-${pane}`,
                );
                if (!term || w.pendingBooks) return null;
                const lines = Array.from(
                    { length: term.buffer.active.length },
                    (_, i) =>
                        term.buffer.active
                            .getLine(i)
                            ?.translateToString(true) || '',
                );
                const first = lines.findIndex((line) => /^BOOK\d+/.test(line));
                return {
                    lines,
                    color:
                        first < 0
                            ? -1
                            : term.buffer.active
                                  .getLine(first)
                                  ?.getCell(0)
                                  ?.getFgColor(),
                };
            }, id);
        await page.goto(phi.url);
        await expect
            .poll(async () =>
                (await probe())?.lines.some((line) =>
                    line.includes('CURRENT_SCREEN'),
                ),
            )
            .toBe(true);
        expect(ranges).toHaveLength(0);
        const older = async () => {
            const button = page.locator(`#term-${id} .load-history-btn`);
            await expect(button).toBeEnabled();
            await button.click();
        };
        await older();
        await expect.poll(async () => (await probe())?.color).toBe(1);
        await expect.poll(() => ranges.length).toBeGreaterThan(0);
        const before = await probe();
        expect(before?.lines.join('\n')).not.toContain('\ufffd');
        expect(
            ranges.every(
                (r) => r.bytes === r.end - r.from && r.bytes <= (2 << 20) / 20,
            ),
        ).toBe(true);
        // A second book progresses into the older source, not a whole replay.
        await older();
        await expect.poll(() => ranges.length).toBeGreaterThan(1);
        expect(ranges[1].from).toBeLessThan(ranges[0].from);
        expect(ranges[1].end).toBeGreaterThanOrEqual(ranges[0].from);
        writeFileSync(join(phi.dir, 'home', 'new-library'), 'go');
        const liveBytes =
            Buffer.byteLength('NEW_BROWSING_LIBRARY\r\n') * 400000;
        await expect
            .poll(async () => {
                const r = await request.get(
                    `${phi.url}/api/terminals/${id}/recording?from=${archiveSize + liveBytes - 1024}&through=18446744073709551615`,
                );
                return (
                    r.ok() &&
                    (await r.body()).includes(Buffer.from('BROWSING_DONE'))
                );
            })
            .toBe(true);
        const count = ranges.length;
        await page
            .locator(`#term-${id} .scroll-to-bottom-btn`)
            .dispatchEvent('click');
        await expect
            .poll(() => states.some((url) => url.includes('through=latest')))
            .toBe(true);
        await expect
            .poll(async () =>
                (await probe())?.lines.some((line) =>
                    line.includes('CURRENT_SCREEN'),
                ),
            )
            .toBe(true);
        expect(
            ranges.slice(count).reduce((sum, r) => sum + r.bytes, 0),
        ).toBeLessThan(liveBytes / 20);
        // Same-size explicit refresh must reach the real Unix foreground TUI.
        const text = (await probe())?.lines.join('\n');
        await page.locator('#refresh-console-btn').dispatchEvent('click');
        await expect
            .poll(async () => (await probe())?.lines.join('\n'))
            .not.toBe(text);
        await expect
            .poll(async () =>
                (await probe())?.lines.some((line) => line.includes('GRID_')),
            )
            .toBe(true);
    } finally {
        await phi.stop();
    }
});
