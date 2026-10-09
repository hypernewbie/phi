import { expect, test } from '@playwright/test';
import {
    mkdtempSync,
    rmSync,
    writeFileSync,
    readFileSync,
    existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startPhi, type PhiServer } from './_server.js';

test.skip(
    process.platform === 'win32',
    'POSIX fake CLI; Go tests cover Windows argv wrapping',
);
let fixture: string;
let mini: PhiServer;
let legacy: PhiServer;

test.beforeAll(async () => {
    fixture = mkdtempSync(join(tmpdir(), 'phi-opencode-cli-'));
    for (const generation of [1, 2]) {
        writeFileSync(
            join(fixture, `opencode-v${generation}`),
            `#!/bin/sh
case "$1" in
  --version) printf '${generation}.0.21\\n'; exit 0 ;;
  debug) printf '%s\\n' "$HOME/.local/share/opencode/opencode.db"; exit 0 ;;
esac
printf '%s\\n' "$*" > "$HOME/launch-args.txt"
if [ '${generation}' = '1' ] || [ "$1" != 'mini' ]; then printf '\\033[?1049h'; fi
i=0
while [ "$i" -lt 400 ]; do printf 'history row %s\\r\\n' "$i"; i=$((i+1)); done
printf 'ready\\r\\n'
sleep 120
`,
            { mode: 0o755 },
        );
    }
    const config = {
        opencode_command: join(fixture, 'opencode-v2'),
        opencode_legacy_command: join(fixture, 'opencode-v1'),
    };
    mini = await startPhi({ config });
    legacy = await startPhi({ config: { ...config, opencode_legacy: true } });
});

test.afterAll(async () => {
    await mini?.stop();
    await legacy?.stop();
    if (fixture) rmSync(fixture, { recursive: true, force: true });
});

for (const mode of ['tui', 'mini', 'legacy']) {
    test(`configured ${mode}: launch, restore metadata, and wheel routing agree`, async ({
        page,
        request,
    }) => {
        const phi = mode === 'legacy' ? legacy : mini;
        const response = await request.post(`${phi.url}/api/terminals`, {
            data: {
                coder: 'opencode',
                cwd: phi.dir,
                title: 'OpenCode test',
                ...(mode === 'mini' ? { opencode_mini: true } : {}),
            },
        });
        expect(response.ok()).toBe(true);
        const pane = await response.json();
        expect(pane.opencode_mode).toBe(mode);
        const metadata = await (
            await request.get(`${phi.url}/api/coders`)
        ).json();
        expect(metadata.opencode.opencode_mode).toBe(
            mode === 'legacy' ? 'legacy' : 'tui',
        );
        const running = await (
            await request.get(`${phi.url}/api/terminals`)
        ).json();
        expect(
            running.find((p: { id: string }) => p.id === pane.pane_id)
                .opencode_mode,
        ).toBe(mode);
        const argFile = join(phi.dir, 'home', 'launch-args.txt');
        await expect
            .poll(() =>
                existsSync(argFile) ? readFileSync(argFile, 'utf8') : null,
            )
            .toBe(
                mode === 'legacy'
                    ? '\n'
                    : `${mode === 'mini' ? 'mini ' : ''}--session ${pane.session_id}\n`,
            );
        await page.addInitScript(() => {
            type BufferView = {
                type: string;
                baseY: number;
                viewportY: number;
            };
            type ObservedTerminal = {
                element?: HTMLElement;
                buffer: { active: BufferView };
            };
            type TerminalClass = new (
                options: Record<string, unknown>,
            ) => ObservedTerminal;
            const capture = window as unknown as {
                opencodeTestTerms: ObservedTerminal[];
            };
            capture.opencodeTestTerms = [];
            let terminalClass: TerminalClass;
            // Observe real xterm instances, without replacing parsing or
            // scrolling. Current xterm virtualizes its DOM scroll height.
            Object.defineProperty(window, 'Terminal', {
                configurable: true,
                get: () => terminalClass,
                set: (base: TerminalClass) => {
                    terminalClass = class extends base {
                        constructor(options: Record<string, unknown>) {
                            super(options);
                            capture.opencodeTestTerms.push(this);
                        }
                    };
                },
            });
        });
        const inputs: string[] = [];
        await page.routeWebSocket('**/ws/pane/**', (socket) => {
            const backend = socket.connectToServer();
            socket.onMessage((message) => {
                if (Buffer.isBuffer(message) && message[0] === 0x01)
                    inputs.push(message.subarray(1).toString('utf8'));
                backend.send(message);
            });
        });
        await page.goto(phi.url);
        const terminal = page.locator(`#term-${pane.pane_id}`);
        const viewport = terminal.locator('.xterm-viewport');
        await page.locator(`.tab[data-pane-id="${pane.pane_id}"]`).click();
        await expect(viewport).toBeVisible();
        const buffer = () =>
            page.evaluate((paneId) => {
                const capture = window as unknown as {
                    opencodeTestTerms: Array<{
                        element?: HTMLElement;
                        buffer: {
                            active: {
                                type: string;
                                baseY: number;
                                viewportY: number;
                            };
                        };
                    }>;
                };
                const term = capture.opencodeTestTerms.find(
                    (term) =>
                        term.element?.closest('.term-container')?.id ===
                        `term-${paneId}`,
                );
                if (!term) throw new Error('pane xterm not opened');
                const { type, baseY, viewportY } = term.buffer.active;
                return { type, baseY, viewportY };
            }, pane.pane_id);
        await expect
            .poll(async () => (await buffer()).type)
            .toBe(mode === 'mini' ? 'normal' : 'alternate');
        // Drive the real capture listener deterministically. For Mini,
        // xterm owns scrolling; older pages require the manual history button.
        // Legacy TUIs route wheel-up as navigation keys instead.
        const prevented = await terminal.evaluate((el) => {
            const event = new WheelEvent('wheel', {
                deltaY: -120,
                bubbles: true,
                cancelable: true,
            });
            el.dispatchEvent(event);
            return event.defaultPrevented;
        });
        if (mode === 'mini') {
            await terminal.locator('.load-history-btn').click();
            await expect
                .poll(async () => (await buffer()).baseY)
                .toBeGreaterThan(100);
            expect(prevented).toBe(false);
            expect(inputs.join('')).not.toContain('\x1b\x19');
            expect(inputs.join('')).not.toContain('\x1b\x05');
            await expect(terminal.locator('.tab-loader')).toBeHidden();
            await terminal.locator('.xterm-screen').hover();
            const before = (await buffer()).viewportY;
            // The explicit button click opened the older page at its top.
            // A real wheel-down now scrolls within that book.
            await page.mouse.wheel(0, 240);
            await expect
                .poll(async () => (await buffer()).viewportY)
                .toBeGreaterThan(before);
        } else {
            expect(prevented).toBe(true);
            await expect.poll(() => inputs.join('')).toContain('\x1b\x19');
        }
    });
}

test('right-click Open Mini opts in once, then normal launch remains full TUI', async ({
    page,
}) => {
    await page.goto(mini.url);
    const button = page.locator('#new-session-btn');
    await expect(button).toBeVisible();
    await page
        .locator('#coder-selector .coder-tab[data-coder="opencode"]')
        .click();
    await button.click({ button: 'right' });
    const item = page.locator('.session-ctx-item', { hasText: 'Open Mini' });
    await expect(item).toBeVisible();
    const miniResponse = page.waitForResponse(
        (r) =>
            r.url().endsWith('/api/terminals') &&
            r.request().method() === 'POST',
    );
    await item.click();
    const opened = await miniResponse;
    expect(opened.ok()).toBe(true);
    expect(opened.request().postDataJSON().opencode_mini).toBe(true);
    expect((await opened.json()).opencode_mode).toBe('mini');
    const normalResponse = page.waitForResponse(
        (r) =>
            r.url().endsWith('/api/terminals') &&
            r.request().method() === 'POST',
    );
    await button.click();
    const normal = await normalResponse;
    expect(normal.request().postDataJSON().opencode_mini).toBeUndefined();
    expect((await normal.json()).opencode_mode).toBe('tui');
});
