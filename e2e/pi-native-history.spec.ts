import {
    appendFileSync,
    mkdirSync,
    realpathSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startPhi } from './_server.js';

// Real, pinned Pi CLI. No model requests, user sessions, global extensions,
// Python stand-in for the renderer, or "not equal" checks that accept blanks.
const sessionID = '48b8b9b7-23b3-4ab6-b148-ff2227ba0191';
const timestamp = '2026-10-03T00:00:00.000Z';
const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
interface ObservedTerminal {
    element?: HTMLElement;
    rows: number;
    buffer: {
        active: {
            viewportY: number;
            getLine(
                i: number,
            ): { translateToString(trim?: boolean): string } | undefined;
        };
    };
}
async function observe(page: Page) {
    await page.addInitScript(() => {
        type Constructor = new (
            opts: Record<string, unknown>,
        ) => ObservedTerminal;
        const w = window as unknown as { nativeTerms: ObservedTerminal[] };
        w.nativeTerms = [];
        let ctor: Constructor;
        Object.defineProperty(window, 'Terminal', {
            configurable: true,
            get: () => ctor,
            set: (base: Constructor) => {
                ctor = class extends base {
                    constructor(opts: Record<string, unknown>) {
                        super(opts);
                        w.nativeTerms.push(this);
                    }
                };
            },
        });
    });
}
async function view(page: Page, pane: string) {
    return page.evaluate((id) => {
        const w = window as unknown as { nativeTerms: ObservedTerminal[] };
        const t = w.nativeTerms.find(
            (term) =>
                term.element?.closest('.term-container')?.id === `term-${id}`,
        );
        if (!t) return '';
        return Array.from(
            { length: t.rows },
            (_, i) =>
                t.buffer.active
                    .getLine(t.buffer.active.viewportY + i)
                    ?.translateToString(true) || '',
        ).join('\n');
    }, pane);
}
async function oldestVisible(page: Page, pane: string) {
    const ids = Array.from(
        (await view(page, pane)).matchAll(/NATIVE HISTORY (\d{4})/g),
        (match) => Number(match[1]),
    );
    return ids.length ? Math.min(...ids) : Number.POSITIVE_INFINITY;
}

for (const mode of ['fullscreen', 'regular']) {
    test(`native Pi ${mode}: populated resume, wheel, reload, and server restart`, async ({
        page,
        request,
    }, info) => {
        test.setTimeout(90000);
        let sessionFile = '';
        const phi = await startPhi({
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
                sessionFile = join(
                    project,
                    `2026-10-03T00-00-00-000Z_${sessionID}.jsonl`,
                );
                const entries: Record<string, unknown>[] = [
                    {
                        type: 'session',
                        version: 3,
                        id: sessionID,
                        timestamp,
                        cwd,
                    },
                ];
                for (let i = 0; i < 100; i++)
                    entries.push({
                        type: 'message',
                        id: `msg${i}`,
                        parentId: i ? `msg${i - 1}` : null,
                        timestamp,
                        message: {
                            role: 'user',
                            content: `NATIVE HISTORY ${String(i).padStart(4, '0')}\n${'deterministic transcript content '.repeat(5)}`,
                            timestamp: 1790985600000 + i,
                        },
                    });
                writeFileSync(
                    sessionFile,
                    entries.map((entry) => JSON.stringify(entry)).join('\n') +
                        '\n',
                );
                const command = join(dir, 'native-pi');
                const binary = join(
                    process.cwd(),
                    'node_modules',
                    '.bin',
                    'pi',
                );
                writeFileSync(
                    command,
                    `#!/bin/sh\nexec ${shellQuote(binary)} --no-extensions --no-skills --no-prompt-templates --no-context-files --no-approve --model anthropic/claude-sonnet-4-5 "$@"\n`,
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
            await observe(page);
            const response = await request.post(`${phi.url}/api/terminals`, {
                data: {
                    coder: 'pi',
                    cwd: realpathSync(phi.dir),
                    session_id: sessionID,
                },
            });
            expect(response.ok()).toBe(true);
            const pane = (await response.json()).pane_id as string;
            // Pi must render BEFORE browser attachment. Otherwise all output
            // starts in the fitted grid and a pre-attach resize path is untested.
            await expect
                .poll(
                    async () => {
                        const output = await request.get(
                            `${phi.url}/api/terminals/${pane}/recording?from=0&through=2097152`,
                        );
                        return output.ok()
                            ? (await output.body()).toString('utf8')
                            : '';
                    },
                    { timeout: 20000 },
                )
                .toContain('NATIVE HISTORY 0099');
            await page.goto(phi.url);
            await page.locator(`.tab[data-pane-id="${pane}"]`).click();
            await expect
                .poll(() => view(page, pane), { timeout: 20000 })
                .toContain('NATIVE HISTORY 0099');
            await page.screenshot({ path: info.outputPath('fresh.png') });
            const freshOldest = await oldestVisible(page, pane);
            await page
                .locator(`#term-${pane} .xterm-screen`)
                .hover({ position: { x: 100, y: 60 } });
            for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -500);
            await expect
                .poll(() => oldestVisible(page, pane), { timeout: 8000 })
                .toBeLessThan(freshOldest);
            // Distinguish stale replay from Pi correctly retaining its own
            // chosen transcript position. Return the native app to latest.
            if (mode === 'fullscreen') {
                await request.post(`${phi.url}/api/terminals/${pane}/input`, {
                    data: { text: '\x1b[F' },
                });
                await expect
                    .poll(() => view(page, pane), { timeout: 10000 })
                    .toContain('NATIVE HISTORY 0099');
            }
            await page.reload();
            await page.locator(`.tab[data-pane-id="${pane}"]`).click();
            await expect
                .poll(() => view(page, pane), { timeout: 20000 })
                .toContain('NATIVE HISTORY 0099');
            await page.screenshot({ path: info.outputPath('reload.png') });
            const reloadOldest = await oldestVisible(page, pane);
            await page
                .locator(`#term-${pane} .xterm-screen`)
                .hover({ position: { x: 100, y: 60 } });
            for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -500);
            await expect
                .poll(() => oldestVisible(page, pane), { timeout: 8000 })
                .toBeLessThan(reloadOldest);
            appendFileSync(
                sessionFile,
                JSON.stringify({
                    type: 'message',
                    id: 'newlatest',
                    parentId: 'msg99',
                    timestamp,
                    message: {
                        role: 'user',
                        content: 'NATIVE LATEST AFTER RESTART',
                        timestamp: 1790985660000,
                    },
                }) + '\n',
            );
            await phi.restart();
            await page.reload();
            await page.locator(`.tab[data-pane-id="${pane}"]`).click();
            await expect
                .poll(() => view(page, pane), { timeout: 20000 })
                .toContain('NATIVE LATEST AFTER RESTART');
        } finally {
            await phi.stop();
        }
    });
}
