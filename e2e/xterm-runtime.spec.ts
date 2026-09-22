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
