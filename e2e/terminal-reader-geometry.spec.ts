import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startPhi } from './_server.js';

interface ReaderTab {
    paneId: string;
    _bootstrapGate?: Promise<unknown>;
    ws: { sendResize(cols: number, rows: number): boolean };
    term: {
        cols: number;
        rows: number;
        scrollToLine(line: number): void;
        buffer: {
            active: {
                viewportY: number;
                getLine(
                    line: number,
                ): { translateToString(trim: boolean): string } | undefined;
            };
        };
    };
}
interface ReaderProbe {
    readerProbe?: (action: 'prepare' | 'resize' | 'state') => Promise<{
        ready: boolean;
        resizes: number;
        top: string;
    }>;
}

for (const mobile of [false, true]) {
    test.describe(mobile ? 'touch' : 'desktop', () => {
        test.use({
            viewport: mobile
                ? { width: 390, height: 844 }
                : { width: 1440, height: 900 },
            isMobile: mobile,
            hasTouch: mobile,
        });
        test('live geometry preserves the reading row', async ({ page }) => {
            const phi = await startPhi({
                setup(dir) {
                    const backends = join(dir, 'home', '.phi', 'backends');
                    mkdirSync(backends, { recursive: true });
                    const command = join(dir, 'reader-backend');
                    writeFileSync(command, '#!/bin/sh\nseq 1 350\nexec cat\n', {
                        mode: 0o755,
                    });
                    writeFileSync(
                        join(backends, 'bash.json'),
                        JSON.stringify({ id: 'bash', command }),
                    );
                },
            });
            try {
                const response = await page.request.post(
                    `${phi.url}/api/terminals`,
                    { data: { coder: 'bash' } },
                );
                expect(response.ok()).toBe(true);
                const pane = (await response.json()).pane_id as string;
                // Observe the real manager without replacing resize/scroll logic.
                // Headless xterm does not have the browser's cached pixel offset.
                await page.addInitScript(async (id) => {
                    const path = '/terminal.js';
                    const { TabManager } = await import(path);
                    const resize = TabManager.prototype._resizeWithReaderAnchor;
                    const win = window as unknown as ReaderProbe;
                    let resizes = 0;
                    TabManager.prototype._resizeWithReaderAnchor = function (
                        this: {
                            _cancelScrollFollowForUserScroll(
                                tab: ReaderTab,
                            ): void;
                            _captureReaderAnchor(tab: ReaderTab): void;
                        },
                        tab: ReaderTab,
                        update: () => void,
                    ) {
                        if (tab.paneId === id) {
                            resizes++;
                            win.readerProbe = async (action) => {
                                if (action === 'prepare') {
                                    this._cancelScrollFollowForUserScroll(tab);
                                    tab.term.scrollToLine(110);
                                } else if (
                                    action === 'resize' &&
                                    !tab.ws.sendResize(
                                        tab.term.cols,
                                        tab.term.rows - 2,
                                    )
                                ) {
                                    throw new Error('resize was not sent');
                                }
                                for (let i = 0; i < 2; i++)
                                    await new Promise<void>((resolve) =>
                                        requestAnimationFrame(() => resolve()),
                                    );
                                if (action === 'prepare')
                                    this._captureReaderAnchor(tab);
                                return {
                                    ready: !tab._bootstrapGate,
                                    resizes,
                                    top:
                                        tab.term.buffer.active
                                            .getLine(
                                                tab.term.buffer.active
                                                    .viewportY,
                                            )
                                            ?.translateToString(true) ?? '',
                                };
                            };
                        }
                        return resize.call(this, tab, update);
                    };
                }, pane);
                await page.goto(`${phi.url}/?pane=${pane}`);
                await expect
                    .poll(() =>
                        page.evaluate(() =>
                            (window as unknown as ReaderProbe).readerProbe?.(
                                'state',
                            ),
                        ),
                    )
                    .toMatchObject({ ready: true });
                const before = await page.evaluate(() =>
                    (window as unknown as ReaderProbe).readerProbe!('prepare'),
                );
                expect(before.top).toBe('111');
                await page.evaluate(() =>
                    (window as unknown as ReaderProbe).readerProbe!('resize'),
                );
                await expect
                    .poll(
                        async () =>
                            (
                                await page.evaluate(() =>
                                    (window as unknown as ReaderProbe)
                                        .readerProbe!('state'),
                                )
                            ).resizes,
                    )
                    .toBeGreaterThan(before.resizes);
                await expect
                    .poll(
                        async () =>
                            (
                                await page.evaluate(() =>
                                    (window as unknown as ReaderProbe)
                                        .readerProbe!('state'),
                                )
                            ).top,
                    )
                    .toBe(before.top);
            } finally {
                await phi.stop();
            }
        });
    });
}
