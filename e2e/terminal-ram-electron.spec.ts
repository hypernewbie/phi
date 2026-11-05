import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect, test, type Page } from '@playwright/test';
import { TerminalServerFrame } from '../web/proto/terminal.js';
import type {
    MessageFns,
    TerminalServerFrame as TerminalServerMessage,
} from '../web-src/proto/terminal.js';
import { startPhi, type PhiServer } from './_server.js';

// Real embedded Electron runtime against the RAM window: the production
// web bundle is vendored into desktop/electron, the body page is the
// app:// surface, and the pane is a real PTY behind the v3 replay server.
// This spec belongs to the desktop config only (a display is required).

const ServerCodec: MessageFns<TerminalServerMessage> =
    TerminalServerFrame as unknown as MessageFns<TerminalServerMessage>;

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, 'fixtures', 'mobile-settings-app');

function electronBinary(): string {
    const pkgRoot = join(here, '..', 'desktop', 'electron');
    const pathTxt = join(pkgRoot, 'node_modules', 'electron', 'path.txt');
    if (!existsSync(pathTxt)) throw new Error('electron path.txt missing');
    const rel = readFileSync(pathTxt, 'utf8').trim();
    const full = join(pkgRoot, 'node_modules', 'electron', 'dist', rel);
    if (!existsSync(full)) throw new Error(`electron binary missing: ${full}`);
    return full;
}

// A shell pane that emits more than the configured window, seeded before
// the embedded app loads so the retained floor is already nonzero.
function seedShellPane(dir: string) {
    const state = join(dir, 'home', '.phi');
    const workspace = join(dir, 'workspace');
    mkdirSync(join(state, 'backends'), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const command = join(dir, 'fixture-shell');
    writeFileSync(command, '#!/bin/sh\nexec bash --noprofile --norc -i\n', {
        mode: 0o755,
    });
    writeFileSync(
        join(state, 'backends', 'bash.json'),
        JSON.stringify({ id: 'bash', command }),
    );
    writeFileSync(
        join(state, 'tabs.json'),
        JSON.stringify([
            {
                id: 't1',
                coder: 'bash',
                session_id: '',
                cwd: realpathSync(workspace),
                workspace: realpathSync(workspace),
                title: 'RAM pane',
            },
        ]),
    );
}

// Track the real xterm instance behind the pane, so assertions read the
// painted buffer instead of the canvas or a screenshot.
const tracker = () => {
    const w = window as unknown as {
        __ramTracked: unknown[];
        __ramPending: number;
    };
    w.__ramTracked = [];
    w.__ramPending = 0;
    let Base: any;
    Object.defineProperty(window, 'Terminal', {
        configurable: true,
        get: () => Base,
        set: (Original: any) => {
            Base = class extends Original {
                constructor(options: unknown) {
                    super(options);
                    w.__ramTracked.push(this);
                }
                write(data: unknown, cb?: () => void) {
                    w.__ramPending++;
                    super.write(data, () => {
                        w.__ramPending--;
                        cb?.();
                    });
                }
            };
        },
    });
};

const screenText = (page: Page) =>
    page.evaluate(() => {
        const w = window as unknown as {
            __ramTracked?: Array<{
                element?: { closest(s: string): { id: string } | null };
                buffer: {
                    active: {
                        length: number;
                        getLine(i: number): {
                            translateToString(t: boolean): string;
                        };
                    };
                };
            }>;
        };
        const term = w.__ramTracked?.find(
            (t) => t.element?.closest('.term-container')?.id === 'term-t1',
        );
        if (!term) return '';
        const lines: string[] = [];
        for (let i = 0; i < term.buffer.active.length; i++)
            lines.push(term.buffer.active.getLine(i).translateToString(true));
        return lines.join('\n');
    });

async function bodyPage(
    application: Awaited<ReturnType<typeof _electron.launch>>,
): Promise<Page> {
    const context = application.context();
    await expect
        .poll(
            () =>
                context
                    .pages()
                    .some((page) => page.url().startsWith('phi-app://app/')),
            { timeout: 60_000, intervals: [100, 250, 500, 1_000] },
        )
        .toBe(true);
    const page = context
        .pages()
        .find((p) => p.url().startsWith('phi-app://app/'));
    if (!page) throw new Error('embedded Phi body page did not appear');
    await expect(page.locator('#app')).toBeVisible({ timeout: 30_000 });
    return page;
}

test('embedded Electron keeps the retained tail and one echo', async () => {
    test.setTimeout(240_000);
    const fixtureDir = mkdtempSync(join(tmpdir(), 'phi-ram-electron-'));
    let phi: PhiServer | null = null;
    let application: Awaited<ReturnType<typeof _electron.launch>> | null = null;
    try {
        phi = await startPhi({
            config: { replay_buffer_bytes: 4096 },
            setup: (dir) => seedShellPane(dir),
        });
        application = await _electron.launch({
            executablePath: electronBinary(),
            args: [appDir],
            timeout: 60_000,
            env: {
                PATH: process.env.PATH || '',
                HOME: join(fixtureDir, 'home'),
                USERPROFILE: join(fixtureDir, 'home'),
                APPDATA: join(fixtureDir, 'home'),
                TMPDIR: join(fixtureDir, 'temp'),
                TMP: join(fixtureDir, 'temp'),
                TEMP: join(fixtureDir, 'temp'),
                PHI_MS_FIXTURE_DIR: fixtureDir,
                PHI_MS_A_URL: phi.url,
                PHI_MS_B_URL: phi.url,
                PHI_DESKTOP_LOW_MEMORY: '1',
                ELECTRON_DISABLE_SANDBOX: '1',
            } as Record<string, string>,
        });
        await expect
            .poll(
                () =>
                    application!.evaluate(() => {
                        const g = globalThis as unknown as {
                            __phiMsReady?: boolean;
                            __phiMsStartError?: string;
                        };
                        if (g.__phiMsStartError)
                            throw new Error(g.__phiMsStartError);
                        return g.__phiMsReady === true;
                    }),
                { timeout: 60_000 },
            )
            .toBe(true);
        await application.context().addInitScript(tracker);
        // Host startup does not select a backend. Activate it before
        // looking for its embedded body view, as the existing spec does.
        await application.evaluate((_electron, url) => {
            const g = globalThis as unknown as {
                __phiMsHost: { activateServerUrl(url: string): void };
            };
            g.__phiMsHost.activateServerUrl(url);
        }, phi.url);
        const body = await bodyPage(application);
        const problems: string[] = [];
        body.on('pageerror', (error) => problems.push(String(error)));
        body.on('console', (message) => {
            if (message.type() !== 'error') return;
            const text = message.text();
            if (text.includes('Failed to load resource')) return;
            problems.push(text.slice(0, 300));
        });

        const attach: { current: Record<string, unknown> | null } = {
            current: null,
        };
        body.on('websocket', (socket) => {
            if (!socket.url().includes('/ws/pane/t1?')) return;
            socket.on('framereceived', ({ payload }) => {
                if (!Buffer.isBuffer(payload)) return;
                const frame = ServerCodec.decode(new Uint8Array(payload));
                if (frame.payload?.$case === 'attach')
                    attach.current = frame.payload.value as unknown as Record<
                        string,
                        unknown
                    >;
            });
        });

        // Resize the native window, not CDP's device metrics: overriding
        // DPR on a Retina host scales the WebGL terminal incorrectly.
        await application.evaluate(({ BrowserWindow }) => {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) throw new Error('owned Electron window is missing');
            win.setContentSize(1440, 900);
        });
        await body.reload();
        const screen = body.locator('#term-t1 .xterm-screen');
        await expect(screen).toBeVisible({ timeout: 60_000 });
        await screen.click();

        // About 5 KB of output against a 4 KiB window: the head is evicted,
        // so only the retained tail can be repainted.
        await body.keyboard.type(
            'yes "electron padding padding" | head -500; echo "TAIL-MARKER-$(printf ZZZ)"',
        );
        await body.keyboard.press('Enter');
        await expect
            .poll(() => screenText(body), { timeout: 120_000 })
            .toContain('TAIL-MARKER-ZZZ');

        // The retained floor really moved: a read below it is refused with
        // the certified window instead of serving evicted bytes.
        await expect
            .poll(() => attach.current, { timeout: 30_000 })
            .not.toBeNull();
        const epoch = Number(attach.current?.epoch);
        const replay = await fetch(
            `${phi.url}/api/terminals/t1/replay?epoch=${epoch}&from=0&through=latest`,
        );
        expect(replay.status).toBe(409);
        const window = JSON.parse(
            replay.headers.get('x-phi-replay-window') ?? '{}',
        ) as { oldest?: number; head?: number };
        expect(window.oldest ?? 0).toBeGreaterThan(0);
        expect(window.head ?? 0).toBeGreaterThan(window.oldest ?? 0);

        await body
            .getByRole('button', { name: 'Reload current terminal' })
            .click();
        await expect
            .poll(() => screenText(body), { timeout: 60_000 })
            .toContain('TAIL-MARKER-ZZZ');
        expect(
            (await screenText(body)).split('TAIL-MARKER-ZZZ').length - 1,
        ).toBe(1);

        await screen.click();
        await body.keyboard.type('echo "ELECTRON-INPUT-$(printf OK)"');
        await body.keyboard.press('Enter');
        await expect
            .poll(() => screenText(body), { timeout: 60_000 })
            .toContain('ELECTRON-INPUT-OK');

        expect(
            (await screenText(body)).split('ELECTRON-INPUT-OK').length - 1,
        ).toBe(1);
        await body.screenshot({
            path: join('test-results', 'desktop', 'terminal-ram-electron.png'),
        });
        expect(problems).toEqual([]);
    } finally {
        if (application) await application.close().catch(() => {});
        if (phi) await phi.stop();
        rmSync(fixtureDir, { recursive: true, force: true });
    }
});
