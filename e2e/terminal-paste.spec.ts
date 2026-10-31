import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';
import { isCancelledWorktreeRead } from './_session-requests.js';

// Terminal paste: byte fidelity, local recovery on disconnect, and no
// silent retransmission. One pane carries cumulative byte expectations
// across the flows so every span is accounted for exactly once.
//
// Limit: paste is dispatched as a browser DOM event with stubbed
// clipboard data. That tests routing through the real terminal DOM and
// common writer, not native shortcut dispatch. Native Command+V proof
// lives in the M1/M3 research evidence, not here.
//
// Expected bytes below are hand-written literals, never computed with
// the xterm encoder under test. xterm paste semantics (verified against
// the installed @xterm/xterm Clipboard.ts): CRLF and lone LF become CR,
// lone CR passes through, and bracketed mode wraps the span in
// ESC[200~...ESC[201~ after replacing ESC with visible U+241B.
const fixture = `#!/usr/bin/env python3
import os, select, tty
CAPTURE = '__CAPTURE__'
CTL = '__CTL__'
tty.setraw(0)
cap = open(CAPTURE, 'ab', buffering=0)
def out(data):
    while data:
        data = data[os.write(1, data):]
total = 0
out(b'\\x1b[?2004h')
out(b'PASTE RECORDER READY\\r\\n')
while True:
    r, _, _ = select.select([0], [], [], 0.1)
    if r:
        chunk = os.read(0, 65536)
        if not chunk:
            break
        cap.write(chunk)
        total += len(chunk)
        out(b'ACK %d\\r\\n' % total)
    try:
        with open(CTL, 'rb') as f:
            cmd = f.read().strip()
    except FileNotFoundError:
        cmd = b''
    if cmd:
        os.unlink(CTL)
        if cmd == b'on':
            out(b'\\x1b[?2004h')
            out(b'BRACKET ON\\r\\n')
        elif cmd == b'off':
            out(b'\\x1b[?2004l')
            out(b'BRACKET OFF\\r\\n')
`;

let phi: PhiServer;
let pane = '';
let capturePath = '';
let ctlPath = '';

test.beforeEach(async () => {
    phi = await startPhi({
        setup(dir) {
            capturePath = join(dir, 'paste-capture.bin');
            ctlPath = join(dir, 'bracket.ctl');
            const command = join(dir, 'paste-recorder');
            writeFileSync(
                command,
                fixture
                    .replace('__CAPTURE__', capturePath)
                    .replace('__CTL__', ctlPath),
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
    phi.verify();
    const created = await fetch(`${phi.url}/api/terminals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coder: 'pi', cwd: phi.dir, title: 'Paste' }),
    });
    expect(created.ok).toBe(true);
    pane = ((await created.json()) as { pane_id: string }).pane_id;
});

test.afterEach(async () => {
    await phi?.stop();
});

interface ObservedTerm {
    element?: HTMLElement;
    rows: number;
    buffer: {
        active: {
            length: number;
            getLine(
                i: number,
            ): { translateToString(trim?: boolean): string } | undefined;
        };
    };
}

async function observeTerminals(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const capture = window as unknown as { pasteTerms: ObservedTerm[] };
        capture.pasteTerms = [];
        let base: new (opts: Record<string, unknown>) => ObservedTerm;
        Object.defineProperty(window, 'Terminal', {
            configurable: true,
            get: () => base,
            set: (
                Original: new (opts: Record<string, unknown>) => ObservedTerm,
            ) => {
                base = class extends Original {
                    constructor(opts: Record<string, unknown>) {
                        super(opts);
                        capture.pasteTerms.push(this);
                    }
                };
            },
        });
    });
}

async function termText(page: Page, id: string): Promise<string> {
    return page.evaluate((paneId: string) => {
        const terms = (window as unknown as { pasteTerms?: ObservedTerm[] })
            .pasteTerms;
        const term = terms
            ?.filter(
                (t) =>
                    t.element?.closest('.term-container')?.id ===
                    `term-${paneId}`,
            )
            .at(-1);
        if (!term) return '';
        const lines: string[] = [];
        for (let i = 0; i < term.buffer.active.length; i++)
            lines.push(
                term.buffer.active.getLine(i)?.translateToString(true) ?? '',
            );
        return lines.join('\n');
    }, id);
}

async function waitForScreen(
    page: Page,
    id: string,
    needle: string,
    timeout = 30_000,
): Promise<void> {
    await expect.poll(() => termText(page, id), { timeout }).toContain(needle);
}

function captureBytes(): Buffer {
    return readFileSync(capturePath);
}

// Dispatches a paste event against the real helper textarea with stubbed
// clipboard data. Returns whether a handler consumed the event.
async function terminalPaste(
    page: Page,
    id: string,
    text: string,
): Promise<boolean> {
    return page.evaluate(
        ({ paneId, value }: { paneId: string; value: string }) => {
            const helper = document.querySelector(
                `#term-${paneId} .xterm-helper-textarea`,
            ) as HTMLElement | null;
            if (!helper) return false;
            helper.focus();
            const stub = {
                types: ['text/plain'],
                getData: (type: string) => (type === 'text/plain' ? value : ''),
            };
            const event = new Event('paste', {
                bubbles: true,
                cancelable: true,
            });
            Object.defineProperty(event, 'clipboardData', { value: stub });
            helper.dispatchEvent(event);
            return event.defaultPrevented;
        },
        { paneId: id, value: text },
    );
}

for (const touch of [false, true]) {
    test.describe(touch ? 'mobile touch' : 'desktop', () => {
        test.use({
            viewport: touch
                ? { width: 390, height: 844 }
                : { width: 1440, height: 900 },
            isMobile: touch,
            hasTouch: touch,
        });
        test('terminal paste: bytes, recovery, and no-retry', async ({
            page,
            request,
        }) => {
            phi.verify();
            await observeTerminals(page);
            const errors: string[] = [];
            page.on('pageerror', (error) => errors.push(error.message));
            page.on('console', (message) => {
                if (message.type() !== 'error') return;
                const url = new URL(message.location().url || phi.url);
                if (
                    url.pathname === '/api/update/status' &&
                    message.text().includes('503')
                )
                    return;
                if (
                    url.pathname === '/api/sessions' &&
                    url.searchParams.get('coder') === 'opencode' &&
                    message.text().includes('500')
                ) {
                    return;
                }
                errors.push(`${message.text()} (${url.pathname})`);
            });
            const failedRequests: string[] = [];
            page.on('requestfailed', (req) => {
                if (isCancelledWorktreeRead(req, phi.url)) return;
                if (
                    /^\/api\/terminals\/[^/]+\/pin$/.test(
                        new URL(req.url()).pathname,
                    ) &&
                    req.failure()?.errorText === 'net::ERR_ABORTED'
                )
                    return;
                failedRequests.push(req.url());
            });

            let link: { close: () => void } | undefined;
            let blockReconnect = false;
            await page.routeWebSocket(`**/ws/pane/${pane}?*`, (socket) => {
                if (blockReconnect) {
                    socket.close();
                    return;
                }
                link = socket;
                socket.connectToServer();
            });

            await page.goto(`${phi.url}/?pane=${pane}`);
            await expect(
                page.locator(`.tab[data-pane-id="${pane}"]`),
            ).toHaveClass(/active/);
            const term = page.locator(`#term-${pane} .xterm`);
            await expect(term).toBeVisible({ timeout: 60_000 });
            await waitForScreen(page, pane, 'PASTE RECORDER READY');
            // Pi tabs stage input by default: the toggle must start inactive.
            const toggle = page.locator('#direct-mode-toggle');
            await expect(toggle).not.toHaveClass(/active/);
            const area = page.locator('#input-textarea');
            const restriction = page.locator('#input-restriction');
            const tab = page.locator(`.tab[data-pane-id="${pane}"]`);
            await term.click();

            // Flow 1: byte fidelity with bracketed mode on, staged then direct.
            await area.fill('SEED_DRAFT');
            let consumed = await terminalPaste(page, pane, 'A\tBé\r\nC\x1bD');
            expect(consumed).toBe(true);
            // Hand-written: ESC[200~ A TAB B U+00E9 CR C U+241B D ESC[201~.
            const spanA = Buffer.from([
                0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e, 0x41, 0x09, 0x42, 0xc3,
                0xa9, 0x0d, 0x43, 0xe2, 0x90, 0x9b, 0x44, 0x1b, 0x5b, 0x32,
                0x30, 0x31, 0x7e,
            ]);
            await waitForScreen(page, pane, `ACK ${spanA.length}`);
            expect(captureBytes().subarray(0, spanA.length).equals(spanA)).toBe(
                true,
            );
            await expect(area).toHaveValue('SEED_DRAFT');

            await toggle.click();
            await expect(toggle).toHaveClass(/active/);
            consumed = await terminalPaste(page, pane, 'DIR1');
            expect(consumed).toBe(true);
            const spanB = Buffer.from([
                0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e, 0x44, 0x49, 0x52, 0x31,
                0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e,
            ]);
            const totalB = spanA.length + spanB.length;
            await waitForScreen(page, pane, `ACK ${totalB}`);
            expect(
                captureBytes().subarray(spanA.length, totalB).equals(spanB),
            ).toBe(true);
            await expect(area).toHaveValue('SEED_DRAFT');
            await toggle.click();
            await expect(toggle).not.toHaveClass(/active/);

            // Lone CR passes through unwrapped-newline conversion; still bracketed.
            consumed = await terminalPaste(page, pane, 'R1\rR2');
            expect(consumed).toBe(true);
            const spanD = Buffer.from([
                0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e, 0x52, 0x31, 0x0d, 0x52,
                0x32, 0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e,
            ]);
            const totalD = totalB + spanD.length;
            await waitForScreen(page, pane, `ACK ${totalD}`);
            expect(captureBytes().subarray(totalB, totalD).equals(spanD)).toBe(
                true,
            );
            await expect(area).toHaveValue('SEED_DRAFT');

            // Bracketed mode off: LF becomes CR with no wrappers.
            writeFileSync(ctlPath, 'off');
            await waitForScreen(page, pane, 'BRACKET OFF');
            consumed = await terminalPaste(page, pane, 'OFF1\nL2');
            expect(consumed).toBe(true);
            const spanC = Buffer.from([
                0x4f, 0x46, 0x46, 0x31, 0x0d, 0x4c, 0x32,
            ]);
            const totalC = totalD + spanC.length;
            await waitForScreen(page, pane, `ACK ${totalC}`);
            expect(captureBytes().subarray(totalD, totalC).equals(spanC)).toBe(
                true,
            );
            await expect(area).toHaveValue('SEED_DRAFT');
            expect(captureBytes().length).toBe(totalC);

            // Flow 2: sever the socket, hold HTTP behind a gate, and require
            // local recovery without any network round trip.
            await area.fill('SEED_BEFORE_DOWN');
            blockReconnect = true;
            link?.close();
            await expect(tab).toHaveClass(/dead/, { timeout: 30_000 });
            let releaseRefresh!: () => void;
            const refreshGate = new Promise<void>((resolve) => {
                releaseRefresh = resolve;
            });
            const held: string[] = [];
            await page.route('**/api/**', async (route) => {
                held.push(route.request().url());
                await refreshGate;
                await route.continue();
            });
            // Wake the existing background refresh listeners and prove a real HTTP
            // request is pending before checking local paste recovery.
            await page.evaluate(() => {
                document.dispatchEvent(new Event('visibilitychange'));
                window.dispatchEvent(new Event('focus'));
            });
            await expect.poll(() => held.length).toBeGreaterThan(0);
            consumed = await terminalPaste(page, pane, 'REFUSED_SPAN');
            expect(consumed).toBe(true);
            await expect(area).toHaveValue('SEED_BEFORE_DOWNREFUSED_SPAN', {
                timeout: 10_000,
            });
            await expect(restriction).toContainText(
                'Paste saved locally, not sent.',
            );
            expect(captureBytes().length).toBe(totalC);
            releaseRefresh();
            await page.unrouteAll({ behavior: 'wait' });

            // Flow 3: reconnect, reload, and require the held text plus warning.
            // The fixture must see zero paste bytes until an explicit Send.
            blockReconnect = false;
            await page.locator(`#term-${pane} .reconnect-btn`).click();
            await expect(tab).not.toHaveClass(/dead/, { timeout: 60_000 });
            await page.reload();
            await expect(page.locator(`#term-${pane} .xterm`)).toBeVisible({
                timeout: 60_000,
            });
            await expect(area).toHaveValue('SEED_BEFORE_DOWNREFUSED_SPAN', {
                timeout: 30_000,
            });
            await expect(restriction).toContainText(
                'Paste saved locally, not sent.',
            );
            expect(captureBytes().length).toBe(totalC);
            await page.locator('#send-input-btn').click();
            // Explicit Send wraps the 27-char payload and appends one Enter.
            const sentPayload = Buffer.concat([
                Buffer.from([0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e]),
                Buffer.from('SEED_BEFORE_DOWNREFUSED_SPAN', 'utf8'),
                Buffer.from([0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e, 0x0d]),
            ]);
            const totalSent = totalC + sentPayload.length;
            await waitForScreen(page, pane, `ACK ${totalSent}`);
            expect(
                captureBytes().subarray(totalC, totalSent).equals(sentPayload),
            ).toBe(true);

            // Flow 5: an accepted paste is never retransmitted after a fresh
            // attach, and a known-refused paste stays absent. A typed barrier
            // marker bounds the observation window instead of a sleep.
            writeFileSync(ctlPath, 'on');
            await waitForScreen(page, pane, 'BRACKET ON');
            await page.locator(`#term-${pane} .xterm`).click();
            consumed = await terminalPaste(page, pane, 'ONCE_SPAN');
            expect(consumed).toBe(true);
            const spanOnce = Buffer.concat([
                Buffer.from([0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e]),
                Buffer.from('ONCE_SPAN', 'utf8'),
                Buffer.from([0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e]),
            ]);
            const totalOnce = totalSent + spanOnce.length;
            await waitForScreen(page, pane, `ACK ${totalOnce}`);
            blockReconnect = true;
            link?.close();
            await expect(tab).toHaveClass(/dead/, { timeout: 30_000 });
            consumed = await terminalPaste(page, pane, 'ABSENT_SPAN');
            expect(consumed).toBe(true);
            await expect(area).toHaveValue('ABSENT_SPAN', { timeout: 10_000 });
            expect(captureBytes().length).toBe(totalOnce);
            blockReconnect = false;
            await page.locator(`#term-${pane} .reconnect-btn`).click();
            await expect(tab).not.toHaveClass(/dead/, { timeout: 60_000 });
            await toggle.click();
            await expect(toggle).toHaveClass(/active/);
            await page.locator(`#term-${pane} .xterm`).click();
            await page.keyboard.type('BARRIER5');
            await page.keyboard.press('Enter');
            const barrier = Buffer.from('BARRIER5\r', 'utf8');
            const totalFinal = totalOnce + barrier.length;
            await waitForScreen(page, pane, `ACK ${totalFinal}`);
            const finalBytes = captureBytes();
            expect(finalBytes.length).toBe(totalFinal);
            expect(
                finalBytes.subarray(totalSent, totalOnce).equals(spanOnce),
            ).toBe(true);
            expect(
                finalBytes.subarray(totalOnce, totalFinal).equals(barrier),
            ).toBe(true);
            const occurrences =
                finalBytes.toString('utf8').split('ONCE_SPAN').length - 1;
            expect(occurrences).toBe(1);
            expect(finalBytes.toString('utf8')).not.toContain('ABSENT_SPAN');

            const overflow = await page.evaluate(
                () =>
                    document.documentElement.scrollWidth -
                    document.documentElement.clientWidth,
            );
            expect(overflow).toBeLessThanOrEqual(1);
            await request
                .delete(`${phi.url}/api/terminals/${pane}`)
                .catch(() => {});
            expect(errors, errors.join('\n')).toEqual([]);
            expect(failedRequests, failedRequests.join('\n')).toEqual([]);
        });
    });
}
