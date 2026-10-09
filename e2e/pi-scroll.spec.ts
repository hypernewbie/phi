import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

// A deterministic PTY app using Pi fullscreen's real DEC/SGR mouse protocol.
// No model calls, credentials, or replacements for xterm parsing/scrolling.
const fixture = `#!/usr/bin/env python3
import os, re, signal, sys, tty
try: tty.setraw(sys.stdin.fileno())
except Exception: pass
position = 180
pending = b''
def draw(*unused):
    cols, rows = os.get_terminal_size()
    out = '\\x1b[H' + ''.join('PI HISTORY ROW %04d\\x1b[K\\r\\n' % (position + i) for i in range(rows-2))
    out += 'Pi fixture: mouse wheel owns history\\x1b[K'
    os.write(1, out.encode())
os.write(1, b'\\x1b[?1049h\\x1b[?1000h\\x1b[?1002h\\x1b[?1006h')
signal.signal(signal.SIGWINCH, draw)
draw()
while True:
    data = os.read(0, 4096)
    if not data: break
    pending += data
    for event in re.finditer(rb'\\x1b\\[<(\\d+);(\\d+);(\\d+)[Mm]', pending):
        button = int(event.group(1))
        if button & 64:
            position = max(0, min(180, position + (3 if button & 1 else -3)))
            draw()
    pending = pending[pending.rfind(b'M')+1:] if b'M' in pending else pending[-100:]
`;
let phi: PhiServer;

test.beforeAll(async () => {
    phi = await startPhi({
        setup(dir) {
            const command = join(dir, 'pi-scroll-fixture');
            writeFileSync(command, fixture, { mode: 0o755 });
            const backends = join(dir, 'home', '.phi', 'backends');
            mkdirSync(backends, { recursive: true });
            writeFileSync(
                join(backends, 'pi.json'),
                JSON.stringify({ id: 'pi', command }),
            );
        },
    });
});
test.afterAll(async () => {
    await phi.stop();
});

async function observeXterm(page: Page): Promise<void> {
    await page.addInitScript(() => {
        type Observed = {
            element?: HTMLElement;
            buffer: {
                active: {
                    type: string;
                    viewportY: number;
                    getLine(
                        i: number,
                    ):
                        | { translateToString(trim?: boolean): string }
                        | undefined;
                };
            };
        };
        type Constructor = new (opts: Record<string, unknown>) => Observed;
        const capture = window as unknown as { piScrollTerms: Observed[] };
        capture.piScrollTerms = [];
        let observedClass: Constructor;
        Object.defineProperty(window, 'Terminal', {
            configurable: true,
            get: () => observedClass,
            set: (base: Constructor) => {
                observedClass = class extends base {
                    constructor(opts: Record<string, unknown>) {
                        super(opts);
                        capture.piScrollTerms.push(this);
                    }
                };
            },
        });
    });
}

async function firstRow(page: Page, pane: string): Promise<string> {
    return page.evaluate((id) => {
        const capture = window as unknown as {
            piScrollTerms: Array<{
                element?: HTMLElement;
                buffer: {
                    active: {
                        viewportY: number;
                        getLine(
                            i: number,
                        ):
                            | { translateToString(trim?: boolean): string }
                            | undefined;
                    };
                };
            }>;
        };
        const term = capture.piScrollTerms.find(
            (t) => t.element?.closest('.term-container')?.id === `term-${id}`,
        );
        return (
            term?.buffer.active
                .getLine(term.buffer.active.viewportY)
                ?.translateToString(true) || ''
        );
    }, pane);
}

test('manual history button fetches output omitted by a valid compact checkpoint', async ({
    page,
}) => {
    await observeXterm(page);
    const pane = 'compact-history';
    const history = Array.from(
        { length: 300 },
        (_, i) => `ARCHIVE ROW ${String(i).padStart(4, '0')}\r\n`,
    ).join('');
    const bytes = Buffer.from(history);
    const checkpoint = Buffer.from(
        history.split('\r\n').slice(-7).join('\r\n'),
    );
    const fetched: Array<{ from: number; through: number }> = [];
    await page.route('**/api/terminals', (route) =>
        route.fulfill({
            json: [
                {
                    id: pane,
                    title: 'History',
                    coder: 'pi',
                    cwd: phi.dir,
                    workspace: phi.dir,
                    session_id: '',
                    pinned: false,
                },
            ],
        }),
    );
    await page.route('**/api/terminals/compact-history/**', (route) =>
        route.fulfill({ json: {} }),
    );
    await page.route(
        '**/api/terminals/compact-history/recording?*',
        (route) => {
            const query = new URL(route.request().url()).searchParams;
            const from = Number(query.get('from'));
            const through = Math.min(
                Number(query.get('through')),
                bytes.length,
            );
            fetched.push({ from, through });
            const json = Buffer.from(
                JSON.stringify({
                    epoch: 7,
                    start: from,
                    end: through,
                    resizes: [],
                }),
            );
            const length = Buffer.alloc(4);
            length.writeUInt32BE(json.length);
            return route.fulfill({
                contentType: 'application/octet-stream',
                body: Buffer.concat([
                    length,
                    json,
                    bytes.subarray(from, through),
                ]),
            });
        },
    );
    await page.routeWebSocket('**/ws/pane/compact-history?*', (socket) => {
        const json = Buffer.from(
            JSON.stringify({
                epoch: 7,
                oldest: 0,
                head: bytes.length,
                ckpt: {
                    through: bytes.length,
                    cols: 80,
                    rows: 24,
                    len: checkpoint.length,
                },
            }),
        );
        const frame = Buffer.alloc(5);
        frame[0] = 0x08;
        frame.writeUInt32BE(json.length, 1);
        socket.send(Buffer.concat([frame, json, checkpoint]));
    });
    await page.goto(phi.url);
    await page.locator(`.tab[data-pane-id="${pane}"]`).click();
    await expect.poll(() => firstRow(page, pane)).toBe('ARCHIVE ROW 0294');
    // The compact checkpoint must remain the fast-paint path.
    expect(fetched).toHaveLength(0);
    await page.locator(`#term-${pane} .xterm-screen`).hover();
    await page.mouse.wheel(0, -1200);
    const historyButton = page.locator(`#term-${pane} .load-history-btn`);
    await expect(historyButton).toBeEnabled();
    expect(fetched).toHaveLength(0);
    await historyButton.click();
    await expect
        .poll(() => fetched.some((range) => range.from === 0))
        .toBe(true);
    await expect.poll(() => firstRow(page, pane)).toBe('ARCHIVE ROW 0000');
    await expect(historyButton).toHaveClass(/hidden/);
});

for (const situation of [
    'new pane',
    'page reload',
    'return from an inactive tab',
]) {
    test(`Pi scroll-up reaches older rows in staged mode: ${situation}`, async ({
        page,
        request,
    }) => {
        await observeXterm(page);
        const response = await request.post(`${phi.url}/api/terminals`, {
            data: { coder: 'pi', cwd: phi.dir, title: `Pi ${situation}` },
        });
        expect(response.ok()).toBe(true);
        const pane = (await response.json()).pane_id as string;
        await page.goto(phi.url);
        await page.locator(`.tab[data-pane-id="${pane}"]`).click();
        await expect
            .poll(() => firstRow(page, pane))
            .toBe('PI HISTORY ROW 0180');
        if (situation === 'page reload') {
            await page.reload();
            await page.locator(`.tab[data-pane-id="${pane}"]`).click();
        } else if (situation === 'return from an inactive tab') {
            await page
                .locator('#coder-selector .coder-tab[data-coder="bash"]')
                .click();
            await expect(
                page.locator('.tab.active .tab-favicon'),
            ).toHaveAttribute('alt', 'bash');
            await page.locator(`.tab[data-pane-id="${pane}"]`).click();
        }
        await expect
            .poll(() => firstRow(page, pane))
            .toBe('PI HISTORY ROW 0180');
        // Leave an unsent prompt: scrolling must not need Direct Mode or send it.
        await page.locator('#input-textarea').fill('keep this unsent draft');
        await page.locator(`#term-${pane} .xterm-screen`).hover();
        await page.mouse.wheel(0, -240);
        await expect
            .poll(async () => {
                const match = /^PI HISTORY ROW (\d{4})$/.exec(
                    await firstRow(page, pane),
                );
                return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
            })
            .toBeLessThan(180);
        await expect(page.locator('#input-textarea')).toHaveValue(
            'keep this unsent draft',
        );
        await expect(page.locator('#direct-mode-toggle')).not.toHaveClass(
            /active/,
        );
    });
}
