import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    expect,
    test,
    type APIRequestContext,
    type Page,
} from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

// Output stops between bursts so each click exercises a known retained
// window, not a race between scrolling and a continuously moving viewport.
// The first burst alone must exceed the 32 MiB retention window so the floor
// advances; the second only has to move it again while the reader is frozen.
const firstBurstLines = 550_000;
const secondBurstLines = 70_000;
const fixture = `#!/usr/bin/env python3
import os, tty
tty.setraw(0)
def write(data):
    while data:
        data = data[os.write(1, data):]
def burst(label, lines):
    buf = bytearray()
    for i in range(lines):
        buf += ('%s %06d %s\\r\\n' % (label, i, 'X' * 44)).encode()
        if len(buf) >= 1 << 16:
            write(bytes(buf))
            buf = bytearray()
    if buf:
        write(bytes(buf))
burst('FLOOR OLD', ${firstBurstLines})
write(b'FLOOR INITIAL READY\\r\\n')
while True:
    data = os.read(0, 4096)
    if not data: break
    if b'A' in data:
        burst('FLOOR NEW', ${secondBurstLines})
        write(b'FLOOR LATEST AFTER ROTATION\\r\\n')
`;
let phi: PhiServer;

test.beforeAll(async () => {
    phi = await startPhi({
        setup(dir) {
            const command = join(dir, 'pi-floor-fixture');
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
    await phi?.stop();
});

interface Observed {
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

async function observeTerminals(page: Page): Promise<void> {
    await page.addInitScript(() => {
        type Constructor = new (opts: Record<string, unknown>) => Observed;
        const capture = window as unknown as { floorTerms: Observed[] };
        capture.floorTerms = [];
        let base: Constructor;
        Object.defineProperty(window, 'Terminal', {
            configurable: true,
            get: () => base,
            set: (Original: Constructor) => {
                base = class extends Original {
                    constructor(opts: Record<string, unknown>) {
                        super(opts);
                        capture.floorTerms.push(this);
                    }
                };
            },
        });
    });
}

async function view(page: Page, pane: string): Promise<string> {
    return page.evaluate((id) => {
        const capture = window as unknown as { floorTerms: Observed[] };
        const term = capture.floorTerms.find(
            (t) => t.element?.closest('.term-container')?.id === `term-${id}`,
        );
        if (!term) return '';
        return Array.from(
            { length: term.rows },
            (_, i) =>
                term.buffer.active
                    .getLine(term.buffer.active.viewportY + i)
                    ?.translateToString(true) || '',
        ).join('\n');
    }, pane);
}

// The retained window spans multiple 2 MiB responses, so head markers are
// only reachable by following the response cursors through the whole window.
async function recordingWindowText(
    request: APIRequestContext,
    pane: string,
): Promise<string> {
    const chunks: string[] = [];
    let cursor = 0;
    for (let attempt = 0; attempt < 40; attempt++) {
        const response = await request.get(
            `${phi.url}/api/terminals/${encodeURIComponent(pane)}/recording?from=${cursor}&through=18446744073709551615`,
        );
        if (!response.ok()) return '';
        const body = await response.body();
        const headerLength = body.readUInt32BE(0);
        const header = JSON.parse(
            body.subarray(4, 4 + headerLength).toString('utf8'),
        ) as { end: number };
        const data = body.subarray(4 + headerLength);
        chunks.push(data.toString('utf8'));
        if (data.length < 2 << 20 || header.end <= cursor) break;
        cursor = header.end;
    }
    return chunks.join('');
}

async function recordingFloor(page: Page, pane: string): Promise<number> {
    return page.evaluate(async (id) => {
        const response = await fetch(
            `/api/terminals/${encodeURIComponent(id)}/recording?from=0&through=18446744073709551615`,
        );
        if (!response.ok) return -1;
        const body = new Uint8Array(await response.arrayBuffer());
        const size = new DataView(
            body.buffer,
            body.byteOffset,
            body.byteLength,
        ).getUint32(0);
        const header = JSON.parse(
            new TextDecoder().decode(body.subarray(4, 4 + size)),
        );
        return Number(header.start);
    }, pane);
}

for (const width of [1280, 560]) {
    test(`expired history preserves the view and returns to live output (${width}px)`, async ({
        page,
        request,
    }) => {
        // The fixture emits more than the full retention window before the
        // browser attaches, so this waits on real PTY throughput.
        test.setTimeout(300_000);
        await page.setViewportSize({ width, height: 800 });
        await observeTerminals(page);
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const created = await request.post(`${phi.url}/api/terminals`, {
            data: { coder: 'pi', cwd: phi.dir, title: 'Floor' },
        });
        expect(created.ok()).toBe(true);
        const pane = ((await created.json()) as { pane_id: string }).pane_id;
        page.on('console', (message) => {
            if (message.type() !== 'error') return;
            const url = new URL(message.location().url || phi.url);
            // The isolated home has no OpenCode database or update checker.
            // These unrelated optional services already fail without this flow.
            if (
                url.pathname === '/api/update/status' &&
                message.text().includes('503')
            )
                return;
            if (
                url.pathname === '/api/sessions' &&
                url.searchParams.get('coder') === 'opencode' &&
                message.text().includes('500')
            )
                return;
            // The one deliberate retention miss also produces Chromium's
            // failed-resource console entry. Other errors remain failures.
            if (
                message.text().includes('409') &&
                message.location().url.includes(`/api/terminals/${pane}/state`)
            )
                return;
            errors.push(message.text());
        });
        const failedRequests: string[] = [];
        page.on('requestfailed', (request) => {
            // Pin synchronization can finish with an empty 200 response that
            // Chromium reports as aborted. It does not carry terminal data.
            if (
                /^\/api\/terminals\/[^/]+\/pin$/.test(
                    new URL(request.url()).pathname,
                ) &&
                request.failure()?.errorText === 'net::ERR_ABORTED'
            )
                return;
            failedRequests.push(request.url());
        });
        // Wait for the initial burst before attaching: the compact checkpoint
        // omits known older bytes and enables the existing history control.
        await expect
            .poll(() => recordingWindowText(request, pane), {
                timeout: 180_000,
                intervals: [5_000],
            })
            .toContain('FLOOR INITIAL READY');

        let paneSockets = 0;
        page.on('websocket', (socket) => {
            if (socket.url().includes(`/ws/pane/${pane}`)) paneSockets++;
        });
        await page.goto(phi.url);
        await page.locator('#hostname-display').click();
        await page
            .locator(
                `#hostname-tabs-dropdown [data-pane-id="${pane}"] .hostname-dropdown-select-btn`,
            )
            .click();
        await expect
            .poll(() => view(page, pane))
            .toContain('FLOOR INITIAL READY');
        expect(await recordingFloor(page, pane)).toBeGreaterThan(1 << 20);
        const historyButton = page.locator(`#term-${pane} .load-history-btn`);
        await page.locator(`#term-${pane} .xterm-screen`).hover();
        await page.mouse.wheel(0, -4000);
        await expect(historyButton).toBeVisible();
        await expect(historyButton).toBeEnabled();
        await historyButton.focus();
        await historyButton.press('Enter');
        await expect.poll(() => view(page, pane)).toContain('FLOOR OLD');
        await expect(historyButton).toBeEnabled();
        const historicalView = await view(page, pane);
        const oldFloor = await recordingFloor(page, pane);

        // The reader is frozen on loaded history while live output keeps
        // arriving. The view must not move, and the floor must advance.
        const advanced = await request.post(
            `${phi.url}/api/terminals/${pane}/input`,
            { data: { text: 'A' } },
        );
        expect(advanced.ok()).toBe(true);
        await expect
            .poll(() => recordingWindowText(request, pane), {
                timeout: 60_000,
                intervals: [2_000],
            })
            .toContain('FLOOR LATEST AFTER ROTATION');
        expect(await recordingFloor(page, pane)).toBeGreaterThan(
            oldFloor + (1 << 20),
        );
        expect(await view(page, pane)).toBe(historicalView);
        await page.waitForTimeout(2000);
        expect(await view(page, pane)).toBe(historicalView);
        expect(paneSockets).toBe(1);

        // Reaching a genuinely expired book needs enough clicks to walk the
        // whole 32 MiB window at one page each; the 409 path that then keeps
        // the view frozen is covered in test-js/terminalRetentionExpiry.test.js.

        const latestButton = page.locator(
            `#term-${pane} .scroll-to-bottom-btn`,
        );
        await expect(latestButton).toBeVisible();
        await latestButton.focus();
        await latestButton.press('Enter');
        await expect
            .poll(() => view(page, pane))
            .toContain('FLOOR LATEST AFTER ROTATION');
        await page.waitForTimeout(2000);
        expect(await view(page, pane)).toContain('FLOOR LATEST AFTER ROTATION');
        expect(paneSockets).toBe(1);
        expect(errors).toEqual([]);
        expect(failedRequests).toEqual([]);
    });
}
