import { expect, test, type Page } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

// M1 vertical slice: RAM-only retained window + one repaint per reconnect.
// A shell emits more than the configured window, the view is reloaded, and
// the retained tail must render exactly once with the viewport still pinned
// to the bottom. A second reload must not append a second copy: repeating a
// repaint of the same window is what scrolled the screen continuously.

let phi: PhiServer;

// A fresh server per test: a shared one would restore the previous test's
// pane into the next test's tab list, and the mobile layout would attach it.
test.beforeEach(async () => {
    phi = await startPhi({ config: { replay_buffer_bytes: 65536 } });
});

test.afterEach(async () => {
    await phi.stop();
});

async function spawnShell(): Promise<string> {
    for (const coder of process.platform === 'win32'
        ? ['pwsh', 'bash']
        : ['bash']) {
        const res = await fetch(`${phi.url}/api/terminals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ coder, cols: 100, rows: 30 }),
        });
        if (res.ok) return ((await res.json()) as { pane_id: string }).pane_id;
    }
    test.skip(true, 'no shell coder available');
    throw new Error('unreachable');
}

type Tracked = {
    replayTerms: Array<{
        buffer: {
            active: { length: number; baseY: number; viewportY: number };
        };
        element?: { closest: (s: string) => { id: string } | null };
        getLine?: unknown;
    }>;
    replayPending: number;
};

async function installTermTracker(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const w = window as unknown as Tracked & Record<string, unknown>;
        w.replayTerms = [];
        w.replayPending = 0;
        let Base: unknown;
        Object.defineProperty(window, 'Terminal', {
            configurable: true,
            get: () => Base,
            set: (Original: new (o: unknown) => object) => {
                Base = class extends Original {
                    constructor(options: unknown) {
                        super(options);
                        w.replayTerms.push(this as never);
                    }
                };
            },
        });
    });
}

const paneBody = (page: Page, pane: string) =>
    page.evaluate((id) => {
        const w = window as unknown as Tracked;
        const term = w.replayTerms.find(
            (t) => t.element?.closest('.term-container')?.id === `term-${id}`,
        );
        if (!term || w.replayPending !== 0) return '';
        const buf = term.buffer.active as unknown as {
            length: number;
            getLine?: (i: number) => { translateToString(t: boolean): string };
        };
        const lines: string[] = [];
        for (let i = 0; i < buf.length; i++)
            lines.push(buf.getLine?.(i)?.translateToString(true) ?? '');
        return lines.join('\n');
    }, pane);

const countIn = (text: string, needle: string) => text.split(needle).length - 1;

const atBottom = (page: Page, pane: string) =>
    page.evaluate((id) => {
        const w = window as unknown as Tracked;
        const term = w.replayTerms.find(
            (t) => t.element?.closest('.term-container')?.id === `term-${id}`,
        );
        const buf = term?.buffer.active;
        if (!buf) return false;
        return buf.baseY - buf.viewportY <= 1;
    }, pane);

test('retained window repaints once and keeps input live', async ({ page }) => {
    test.setTimeout(180_000);
    const pane = await spawnShell();
    await page.setViewportSize({ width: 1440, height: 900 });
    await installTermTracker(page);
    await page.goto(phi.url);

    const screen = page.locator(`#term-${pane} .xterm-screen`);
    await expect(screen).toBeVisible({ timeout: 30_000 });
    await screen.click();

    // 4000 lines is roughly 200 KB: four times the 64 KiB window, so the
    // head marker is evicted and only the tail can be repainted.
    await page.keyboard.type(
        'echo HDR-MARKER-AAA; for i in $(seq 1 4000); do ' +
            'echo "line $i padding padding padding padding padding"; ' +
            'done; echo "TAIL-MARKER-$(printf ZZZ)"',
    );
    await page.keyboard.press('Enter');
    await expect
        .poll(() => paneBody(page, pane), { timeout: 120_000 })
        .toContain('TAIL-MARKER-ZZZ');

    const reload = page.getByRole('button', {
        name: 'Reload current terminal',
    });
    await reload.click();
    await expect
        .poll(() => paneBody(page, pane), { timeout: 60_000 })
        .toContain('TAIL-MARKER-ZZZ');
    expect(await atBottom(page, pane)).toBe(true);
    // The client keeps its own history; the server window bounds the replay.
    // The tail must appear exactly once, not once per repaint.
    // The marker exists only in output: the echoed command is assembled by
    // the shell, so a second occurrence means the window was appended twice.
    const afterFirst = await paneBody(page, pane);
    expect(countIn(afterFirst, 'TAIL-MARKER-ZZZ')).toBe(1);

    // A second reload must not repaint the same window twice.
    await reload.click();
    await expect
        .poll(() => paneBody(page, pane), { timeout: 60_000 })
        .toContain('TAIL-MARKER-ZZZ');
    await page.waitForTimeout(1500);
    const afterSecond = await paneBody(page, pane);
    expect(countIn(afterSecond, 'TAIL-MARKER-ZZZ')).toBe(1);
    expect(afterSecond.length).toBeLessThanOrEqual(afterFirst.length + 64);
    expect(await atBottom(page, pane)).toBe(true);

    // Input still reaches the same child after the redraws.
    await screen.click();
    await page.keyboard.type('echo INPUT-OK-MARK');
    await page.keyboard.press('Enter');
    await expect
        .poll(() => paneBody(page, pane), { timeout: 30_000 })
        .toContain('INPUT-OK-MARK');
});

test.describe('mobile', () => {
    test.use({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
    });

    test('retained window renders on a touch layout without overflow', async ({
        page,
    }) => {
        test.setTimeout(180_000);
        await spawnShell();
        const logs: string[] = [];
        page.on('console', (m) => {
            if (m.type() === 'error') logs.push(m.text().slice(0, 200));
        });
        page.on('pageerror', (e) => logs.push(`pageerror ${String(e)}`));
        page.on('websocket', (s) => logs.push(`ws ${s.url().slice(0, 120)}`));
        await installTermTracker(page);
        await page.goto(phi.url);

        // A touch layout mounts the pane after the session list settles and
        // may attach it under the workspace's own pane id, so read the id
        // from the mounted terminal instead of assuming the spawn id.
        const screen = page.locator('.term-container .xterm-screen').first();
        try {
            await expect(screen).toBeVisible({ timeout: 60_000 });
        } catch (e) {
            console.log('MOBILE_LOGS', JSON.stringify(logs.slice(-12)));
            throw e;
        }
        const pane = await page.evaluate(
            () =>
                [...document.querySelectorAll('.term-container')]
                    .find((c) => c.querySelector('.xterm-screen'))
                    ?.id.replace(/^term-/, '') ?? '',
        );
        expect(pane).not.toBe('');
        // Touch layouts keep the xterm helper textarea off-screen and cover
        // the screen with the mobile chrome, so focus the input directly.
        await page.locator('.xterm-helper-textarea').first().focus();

        // A narrow pane mangles long typed lines, so the burst is one short
        // command: about 60 KB, close to the configured window.
        await page.keyboard.type(
            'yes "mline padding padding" | head -3000; ' +
                'echo "TAIL-MARKER-$(printf ZZZ)"',
        );
        await page.keyboard.press('Enter');
        await expect
            .poll(() => paneBody(page, pane), { timeout: 120_000 })
            .toContain('TAIL-MARKER-ZZZ');

        const reload = page.getByRole('button', {
            name: 'Reload current terminal',
        });
        await reload.click();
        await expect
            .poll(() => paneBody(page, pane), { timeout: 60_000 })
            .toContain('TAIL-MARKER-ZZZ');
        const body = await paneBody(page, pane);
        expect(countIn(body, 'TAIL-MARKER-ZZZ')).toBe(1);
        expect(await atBottom(page, pane)).toBe(true);

        // The touch layout must not grow a horizontal scrollbar.
        const overflow = await page.evaluate(
            () =>
                document.documentElement.scrollWidth -
                document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(1);
    });
});
