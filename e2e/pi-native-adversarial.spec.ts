import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { startPhi } from './_server.js';

interface Observed {
    element?: HTMLElement;
    buffer: {
        active: {
            length: number;
            getLine(
                i: number,
            ): { translateToString(trim?: boolean): string } | undefined;
        };
    };
}
async function observe(page: Page) {
    await page.addInitScript(() => {
        const w = window as unknown as { stressTerms: Observed[] };
        w.stressTerms = [];
        type Constructor = new (opts: Record<string, unknown>) => Observed;
        let ctor: Constructor;
        Object.defineProperty(window, 'Terminal', {
            configurable: true,
            get: () => ctor,
            set: (base: Constructor) => {
                ctor = class extends base {
                    constructor(opts: Record<string, unknown>) {
                        super(opts);
                        w.stressTerms.push(this);
                    }
                };
            },
        });
    });
}
// The whole scrollback, not the viewport: a restore can leave the pane scrolled
// up, and live output keeps that position, so viewport rows are not a proof.
async function view(page: Page, pane: string) {
    return page.evaluate((id) => {
        const t = (
            window as unknown as { stressTerms: Observed[] }
        ).stressTerms.find(
            (x) => x.element?.closest('.term-container')?.id === `term-${id}`,
        );
        if (!t) return '';
        const lines: string[] = [];
        for (let i = 0; i < t.buffer.active.length; i++)
            lines.push(
                t.buffer.active.getLine(i)?.translateToString(true) ?? '',
            );
        return lines.join('\n');
    }, pane);
}

for (const mode of ['regular', 'fullscreen'])
    for (const action of ['inactive-producer', 'offline-producer']) {
        test(`real Pi ${mode}: ${action}; narrow viewport`, async ({
            page,
            context,
            request,
        }, info) => {
            test.setTimeout(90000);
            const id = '2348b9b7-23b3-4ab6-b148-ff2227ba0191';
            const phi = await startPhi({
                env: { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
                setup(dir) {
                    const cwd = realpathSync(dir);
                    const agent = join(dir, 'home', '.pi', 'agent');
                    mkdirSync(agent, { recursive: true });
                    writeFileSync(
                        join(agent, 'settings.json'),
                        JSON.stringify({
                            tuiMode: mode,
                            defaultProjectTrust: 'never',
                            quietStartup: true,
                            enableInstallTelemetry: false,
                            cacheWarming: 'off',
                        }),
                    );
                    const project = join(
                        agent,
                        'sessions',
                        `--${cwd.replace(/^\//, '').replaceAll('/', '-')}--`,
                    );
                    mkdirSync(project, { recursive: true });
                    const timestamp = '2026-10-03T00:00:00.000Z';
                    const entries: Record<string, unknown>[] = [
                        { type: 'session', version: 3, id, timestamp, cwd },
                    ];
                    for (let i = 0; i < 300; i++)
                        entries.push({
                            type: 'message',
                            id: `m${i}`,
                            parentId: i ? `m${i - 1}` : null,
                            timestamp,
                            message: {
                                role: 'user',
                                content: `STRESS HISTORY ${String(i).padStart(4, '0')}\n${'wide UTF-8 界 é transcript '.repeat(8)}`,
                                timestamp: 1790985600000 + i,
                            },
                        });
                    writeFileSync(
                        join(project, `2026-10-03T00-00-00-000Z_${id}.jsonl`),
                        `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`,
                    );
                    const command = join(dir, 'real-pi');
                    const bin = join(
                        process.cwd(),
                        'node_modules',
                        '.bin',
                        'pi',
                    ).replaceAll("'", "'\\''");
                    writeFileSync(
                        command,
                        `#!/bin/sh\nexec '${bin}' --no-extensions --no-skills --no-prompt-templates --no-context-files --no-approve --model anthropic/claude-sonnet-4-5 "$@"\n`,
                        { mode: 0o755 },
                    );
                    const profiles = join(dir, 'home', '.phi', 'backends');
                    mkdirSync(profiles, { recursive: true });
                    writeFileSync(
                        join(profiles, 'pi.json'),
                        JSON.stringify({ id: 'pi', command }),
                    );
                },
            });
            try {
                await observe(page);
                // Select through the visible desktop tab strip before
                // stressing the narrow layout's terminal rendering.
                await page.setViewportSize({ width: 1440, height: 1000 });
                const response = await request.post(
                    `${phi.url}/api/terminals`,
                    {
                        data: {
                            coder: 'pi',
                            cwd: realpathSync(phi.dir),
                            session_id: id,
                        },
                    },
                );
                expect(response.ok()).toBe(true);
                const pane = (await response.json()).pane_id as string;
                let link: WebSocketRoute | undefined;
                let blockReconnect = false;
                await page.routeWebSocket(`**/ws/pane/${pane}?*`, (socket) => {
                    if (blockReconnect) {
                        socket.close();
                        return;
                    }
                    link = socket;
                    socket.connectToServer();
                });
                await page.goto(phi.url);
                await page.locator(`.tab[data-pane-id="${pane}"]`).click();
                // A 1200-line scrollback need not restore pinned to its newest
                // row, and viewport rows depend on scroll position. Require only
                // that the stress transcript reached the buffer.
                await expect
                    .poll(
                        async () =>
                            (await view(page, pane)).includes(
                                'STRESS HISTORY ',
                            ),
                        { timeout: 20000 },
                    )
                    .toBe(true);
                await page
                    .locator('#input-textarea')
                    .fill('unsent draft must survive stress');
                if (action === 'inactive-producer') {
                    await page
                        .locator(
                            '#coder-selector .coder-tab[data-coder="bash"]',
                        )
                        .click();
                    await expect(
                        page.locator('.tab.active .tab-favicon'),
                    ).toHaveAttribute('alt', 'bash');
                } else {
                    // Offline emulation alone does not close an
                    // existing WebSocket. Drop the real bridge.
                    blockReconnect = true;
                    link?.close();
                    await expect(
                        page.locator(`.tab[data-pane-id="${pane}"]`),
                    ).toHaveClass(/dead/);
                }
                const marker = `LIVE_${mode}_narrow`;
                // Native !! executes a local shell without sending a model
                // prompt. Exact output-line checks cannot pass on editor echo.
                const sent = await request.post(
                    `${phi.url}/api/terminals/${pane}/input`,
                    { data: { text: `!!echo ${marker}` } },
                );
                expect(sent.ok()).toBe(true);
                await page.setViewportSize({
                    width: 420,
                    height: 800,
                });
                if (action === 'offline-producer') blockReconnect = false;
                await page.setViewportSize({
                    width: 1440,
                    height: 1000,
                });
                await page.locator(`.tab[data-pane-id="${pane}"]`).click();
                await page.setViewportSize({
                    width: 720,
                    height: 1000,
                });
                await expect
                    .poll(
                        async () =>
                            (await view(page, pane))
                                .split('\n')
                                .some((line) => line.trim() === marker),
                        { timeout: 25000 },
                    )
                    .toBe(true);
                await expect(page.locator('#input-textarea')).toHaveValue(
                    'unsent draft must survive stress',
                );
                await page.screenshot({
                    path: info.outputPath('native-stressed.png'),
                });
            } finally {
                try {
                    await context.setOffline(false);
                } catch {
                    /* context may already be closed during timeout teardown */
                }
                await phi.stop();
            }
        });
    }
