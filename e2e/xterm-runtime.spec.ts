import { expect, test } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

let phi: PhiServer;

test.beforeAll(async () => {
    phi = await startPhi();
});

test.afterAll(async () => {
    await phi.stop();
});

test('xterm preserves ASCII and CJK text in the browser buffer', async ({
    page,
}) => {
    await page.goto(phi.url);
    const visibleText = await page.evaluate(async () => {
        const globals = window as unknown as {
            Terminal: new (options: {
                cols: number;
                rows: number;
            }) => {
                open(element: HTMLElement): void;
                write(data: string, callback: () => void): void;
                buffer: {
                    active: {
                        getLine(index: number): {
                            translateToString(trimRight?: boolean): string;
                        } | null;
                    };
                };
                dispose(): void;
            };
        };
        const terminal = new globals.Terminal({ cols: 80, rows: 5 });
        const host = document.createElement('div');
        document.body.append(host);
        terminal.open(host);
        const expected = 'ASCII line — CJK 中文 日本語 한국어';
        await new Promise<void>((resolve) => terminal.write(expected, resolve));
        const line = terminal.buffer.active.getLine(0);
        const result = line?.translateToString(true) ?? '';
        terminal.dispose();
        host.remove();
        return result;
    });

    expect(visibleText).toContain('ASCII line');
    expect(visibleText).toContain('CJK 中文 日本語 한국어');
});

test('real browser xterm recovers a gap and overlaps across a split UTF-8 bootstrap', async ({
    page,
}) => {
    const text = '你好 🙂 \x1b[31mcolored — terminal output\x1b[0m\r\nEND\r\n';
    const bytes = Buffer.from(text);
    const ranges: string[] = [];
    await page.route('**/api/terminals/recovery-test/recording?*', (route) => {
        const params = new URL(route.request().url()).searchParams;
        const from = Number(params.get('from'));
        const through = Number(params.get('through'));
        ranges.push(`${from}:${through}`);
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
            body: Buffer.concat([length, json, bytes.subarray(from, through)]),
        });
    });
    await page.routeWebSocket('**/ws/pane/recovery-test?*', (route) => {
        const json = Buffer.from(
            JSON.stringify({ epoch: 7, oldest: 0, head: 1 }),
        );
        const header = Buffer.alloc(5);
        header[0] = 0x08;
        header.writeUInt32BE(json.length, 1);
        route.send(Buffer.concat([header, json]));
        for (const [start, end] of [
            [1, 25],
            [20, 40],
            [45, bytes.length],
        ]) {
            const frame = Buffer.alloc(9);
            frame[0] = 0x09;
            frame.writeBigUInt64BE(BigInt(start), 1);
            route.send(Buffer.concat([frame, bytes.subarray(start, end)]));
        }
    });
    await page.goto(phi.url);
    const result = await page.evaluate(async () => {
        const wsPath = '/ws.js';
        const terminalPath = '/terminal.js';
        const { PTYWebSocket } = await import(wsPath);
        const { TabManager } = await import(terminalPath);
        const globals = window as unknown as {
            Terminal: new (options: {
                cols: number;
                rows: number;
            }) => {
                open(element: HTMLElement): void;
                buffer: {
                    active: {
                        length: number;
                        getLine(index: number): {
                            translateToString(trim?: boolean): string;
                        };
                    };
                };
                dispose(): void;
            };
        };
        const term = new globals.Terminal({ cols: 80, rows: 5 });
        const host = document.createElement('div');
        document.body.append(host);
        term.open(host);
        const manager = Object.assign(Object.create(TabManager.prototype), {
            updateDocumentTitle() {},
            _scheduleCheckpointUpload() {},
        });
        const tab = {
            paneId: 'recovery-test',
            paneEpoch: 7,
            isDead: false,
            isBusy: true,
            writeBuffer: '',
            writePending: false,
            queuedSeq: 0,
            drainedSeq: 0,
            userFollowBottom: false,
            term,
            ws: undefined as unknown,
        };
        let received = '';
        let resolveFinished: () => void = () => {};
        const finished = new Promise<void>((resolve) => {
            resolveFinished = resolve;
        });
        const socket = new PTYWebSocket(
            'recovery-test',
            (output: string) => {
                manager._paneData(tab, output);
                received += output;
                if (received.includes('END\r\n')) resolveFinished();
            },
            null,
            null,
            null,
            {
                onAttachHead(info: { epoch: number; head: number }) {
                    tab.paneEpoch = info.epoch;
                    manager._bootstrappedRelease(tab, socket, 0, info.head);
                },
                onGap(from: number, to: number) {
                    return manager._onLiveGap(tab, from, to);
                },
            },
        );
        tab.ws = socket;
        try {
            await finished;
            await manager._drainSettled(tab);
            return {
                rows: Array.from(
                    { length: term.buffer.active.length },
                    (_, i) =>
                        term.buffer.active.getLine(i).translateToString(true),
                ),
                seq: socket.liveSeq,
                drained: tab.drainedSeq,
            };
        } finally {
            socket.close();
            term.dispose();
            host.remove();
        }
    });
    expect(result.rows[0]).toBe('你好 🙂 colored — terminal output');
    expect(result.rows[1]).toBe('END');
    expect(result.rows.join('\n')).not.toMatch(/output bytes dropped|�/);
    expect(result.seq).toBe(bytes.length);
    expect(result.drained).toBe(bytes.length);
    expect(ranges).toEqual(['0:1', '40:45']);
});
