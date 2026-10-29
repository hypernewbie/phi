import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import {
    TerminalClientFrame,
    TerminalServerFrame,
} from '../web/proto/terminal.js';
import type {
    MessageFns,
    TerminalClientFrame as TerminalClientMessage,
    TerminalServerFrame as TerminalServerMessage,
} from '../web-src/proto/terminal.js';
import { startPhi, type PhiServer } from './_server.js';

// The served bundle carries no types; bind its runtime codecs to the
// generated declarations so spec-side decoding is fully checked.
const ServerCodec: MessageFns<TerminalServerMessage> =
    TerminalServerFrame as unknown as MessageFns<TerminalServerMessage>;
const ClientCodec: MessageFns<TerminalClientMessage> =
    TerminalClientFrame as unknown as MessageFns<TerminalClientMessage>;

// M1 terminal gate: the smallest real pane flows over generated protobuf,
// in Chromium and through the actual phic console plus the relay. Both
// cases must run and pass; a skip is not a pass.

const execFileAsync = promisify(execFile);

let phi: PhiServer;

test.beforeAll(async () => {
    phi = await startPhi();
});

test.afterAll(async () => {
    await phi.stop();
});

interface CapturedTerm {
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

async function termText(page: Page, paneId: string): Promise<string> {
    return page.evaluate((id: string) => {
        const terms = (window as unknown as { wsTerms?: CapturedTerm[] })
            .wsTerms;
        const term = terms?.find(
            (t) => t.element?.closest('.term-container')?.id === `term-${id}`,
        );
        if (!term) return '';
        const lines: string[] = [];
        for (let i = 0; i < term.buffer.active.length; i++)
            lines.push(
                term.buffer.active.getLine(i)?.translateToString(true) ?? '',
            );
        return lines.join('\n');
    }, paneId);
}

test('terminal pane flows over protobuf in Chromium', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const url = new URL(msg.location().url || phi.url);
        // The isolated home has no OpenCode database or update checker.
        // These unrelated optional services already fail without this
        // flow (same filter as terminal-history-floor.spec.ts).
        if (url.pathname === '/api/update/status' && msg.text().includes('503'))
            return;
        if (
            url.pathname === '/api/sessions' &&
            url.searchParams.get('coder') === 'opencode' &&
            msg.text().includes('500')
        )
            return;
        consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('requestfailed', (req) => {
        // Pin synchronization can finish with an empty 200 response that
        // Chromium reports as aborted. It does not carry terminal data
        // (same filter as terminal-history-floor.spec.ts).
        if (
            /^\/api\/terminals\/[^/]+\/pin$/.test(
                new URL(req.url()).pathname,
            ) &&
            req.failure()?.errorText === 'net::ERR_ABORTED'
        )
            return;
        failedRequests.push(req.url());
    });

    // A second pane for the admission probe, away from the routed UI pane.
    const probeSpawn = await fetch(`${phi.url}/api/terminals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coder: 'bash' }),
    });
    expect(probeSpawn.ok).toBe(true);
    const probePane = (await probeSpawn.json()) as { pane_id: string };

    await page.addInitScript(() => {
        const capture = window as unknown as {
            wsTerms: CapturedTerm[];
        };
        capture.wsTerms = [];
        let ctor: new (opts: Record<string, unknown>) => CapturedTerm;
        Object.defineProperty(window, 'Terminal', {
            configurable: true,
            get: () => ctor,
            set: (
                base: new (opts: Record<string, unknown>) => CapturedTerm,
            ) => {
                ctor = class extends base {
                    constructor(opts: Record<string, unknown>) {
                        super(opts);
                        capture.wsTerms.push(this);
                    }
                };
            },
        });
    });

    // Binary capture with passthrough in both directions. Installed
    // before navigation like the other pane specs. The UI restores the
    // API-created probe pane as a tab at load, so this page opens a
    // socket for it too; capture only other panes so per-pane output
    // sequences stay ordered. Probe traffic still forwards untouched.
    const serverFrames: Buffer[] = [];
    const clientFrames: Buffer[] = [];
    await page.routeWebSocket('**/ws/pane/**', (socket) => {
        const capture = !socket.url().includes(probePane.pane_id);
        const backend = socket.connectToServer();
        socket.onMessage((message) => {
            if (capture && Buffer.isBuffer(message)) clientFrames.push(message);
            backend.send(message);
        });
        backend.onMessage((message) => {
            if (capture && Buffer.isBuffer(message)) serverFrames.push(message);
            socket.send(message);
        });
    });

    await page.goto(phi.url);
    await page
        .locator('#diff-term-container .xterm')
        .first()
        .waitFor({ state: 'attached' });

    // Admission runs on a second page carrying the phi origin; from
    // about:blank the browser sends Origin: null and the server's
    // same-origin check rejects even the token dial (403). A separate
    // unrouted page keeps the probe sockets out of the main capture.
    // Admission: the token is selected, a tokenless dial is rejected.
    const probePage = await page.context().newPage();
    await probePage.goto(phi.url);
    const admission = await probePage.evaluate(
        async ({ base, id }: { base: string; id: string }) => {
            const wsUrl = `${base.replace(/^http/, 'ws')}/ws/pane/${id}?state=ansi-v1`;
            const open = (protocols?: string): Promise<string> =>
                new Promise((resolve) => {
                    const ws = new WebSocket(wsUrl, protocols);
                    ws.onopen = () => {
                        const negotiated = ws.protocol;
                        ws.close();
                        resolve(`open:${negotiated}`);
                    };
                    ws.onerror = () => resolve('rejected');
                });
            return {
                token: await open('phi.terminal.protobuf.v1'),
                bare: await open(),
            };
        },
        { base: phi.url, id: probePane.pane_id },
    );
    await probePage.close();
    expect(admission.token).toBe('open:phi.terminal.protobuf.v1');
    expect(admission.bare).toBe('rejected');
    consoleErrors.length = 0;
    pageErrors.length = 0;
    failedRequests.length = 0;

    const created = page.waitForResponse(
        (r) =>
            r.url().endsWith('/api/terminals') &&
            r.request().method() === 'POST',
    );
    await page.locator('#coder-selector .coder-tab[data-coder="bash"]').click();
    const reply = await created;
    expect(reply.ok()).toBe(true);
    const pane = (await reply.json()) as { pane_id: string };
    await expect(
        page.locator(`.tab[data-pane-id="${pane.pane_id}"]`),
    ).toBeVisible();
    const term = page.locator(`#term-${pane.pane_id} .xterm`);
    await expect(term).toBeVisible();
    await term.click();

    await page.keyboard.type('echo BROWSER-MARKER-1', { delay: 5 });
    await page.keyboard.press('Enter');
    await expect
        .poll(() => termText(page, pane.pane_id), { timeout: 20_000 })
        .toContain('BROWSER-MARKER-1');

    const dimPair = (text: string): string | null => {
        const matches = [...text.matchAll(/(\d+)\s+(\d+)/g)];
        return matches.length ? matches[0][0] : null;
    };
    await page.keyboard.type('stty size', { delay: 5 });
    await page.keyboard.press('Enter');
    let initial = '';
    await expect
        .poll(
            async () => {
                const found = dimPair(await termText(page, pane.pane_id));
                if (found) initial = found;
                return found;
            },
            { timeout: 20_000 },
        )
        .not.toBeNull();
    const [initialRows, initialCols] = initial.split(/\s+/).map(Number);
    const resizeStart = clientFrames.length;
    await page.setViewportSize({ width: 800, height: 500 });
    // The viewport changes before the debounced resize reaches the socket.
    await expect
        .poll(
            () =>
                clientFrames.slice(resizeStart).some((raw) => {
                    const payload = ClientCodec.decode(
                        new Uint8Array(raw),
                    ).payload;
                    return (
                        payload?.$case === 'resize' &&
                        (payload.value.rows !== initialRows ||
                            payload.value.cols !== initialCols)
                    );
                }),
            { timeout: 20_000 },
        )
        .toBe(true);
    await page.keyboard.type('stty size', { delay: 5 });
    await page.keyboard.press('Enter');
    await expect
        .poll(
            async () => {
                const pairs = [
                    ...new Set(
                        [
                            ...(await termText(page, pane.pane_id)).matchAll(
                                /(\d+)\s+(\d+)/g,
                            ),
                        ].map((m) => m[0]),
                    ),
                ].filter((pair) => pair !== initial);
                return pairs.length ? pairs[0] : null;
            },
            { timeout: 20_000 },
        )
        .not.toBeNull();

    // Every captured server frame decodes with the pane codec. The first
    // is the attach head; output starts run in order behind it.
    expect(serverFrames.length).toBeGreaterThan(0);
    const variants: string[] = [];
    const starts: number[] = [];
    let first = true;
    for (const raw of serverFrames) {
        const frame = ServerCodec.decode(new Uint8Array(raw));
        const payload = frame.payload;
        expect(payload).toBeDefined();
        if (!payload) throw new Error('empty server frame');
        variants.push(payload.$case);
        if (first) {
            expect(payload.$case).toBe('attach');
            if (payload.$case === 'attach') {
                const { oldest, head } = payload.value;
                expect(oldest).toBeDefined();
                expect(head).toBeDefined();
                expect((oldest as bigint) <= (head as bigint)).toBe(true);
            }
            first = false;
        }
        if (payload.$case === 'output')
            starts.push(Number(payload.value.start));
    }
    expect(variants).toContain('output');
    for (let i = 1; i < starts.length; i++)
        expect(starts[i] >= starts[i - 1]).toBe(true);
    console.log(`pane ${pane.pane_id}: server variants=${variants.join(',')}`);
    console.log(`pane ${pane.pane_id}: output starts=${starts.join(',')}`);

    // The app sends generated input and resize frames too.
    const clientCases = new Set(
        clientFrames.map(
            (raw) => ClientCodec.decode(new Uint8Array(raw)).payload?.$case,
        ),
    );
    expect(clientCases.has('input')).toBe(true);
    expect(clientCases.has('resize')).toBe(true);

    // Reload reconnects: the marker survives and new input still lands.
    await page.reload();
    await page
        .locator(`#term-${pane.pane_id} .xterm`)
        .waitFor({ state: 'visible', timeout: 30_000 });
    await expect
        .poll(() => termText(page, pane.pane_id), { timeout: 30_000 })
        .toContain('BROWSER-MARKER-1');
    await page.locator(`#term-${pane.pane_id} .xterm`).click();
    await page.keyboard.type('echo BROWSER-MARKER-2', { delay: 5 });
    await page.keyboard.press('Enter');
    await expect
        .poll(() => termText(page, pane.pane_id), { timeout: 20_000 })
        .toContain('BROWSER-MARKER-2');

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
});

test('terminal pane flows through the real phic console and relay', async () => {
    const dir = join(phi.dir, 'accept-native');
    mkdirSync(dir, { recursive: true });
    let stdout: string;
    try {
        ({ stdout } = await execFileAsync(
            'go',
            [
                'test',
                '-count=1',
                '-timeout',
                '120s',
                '-v',
                '-run',
                '^TestWebSocketProtobufLiveAcceptance$',
                './internal/phic',
            ],
            {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    PHI_WS_ACCEPTANCE_URL: phi.url,
                    PHI_WS_ACCEPTANCE_DIR: dir,
                } as NodeJS.ProcessEnv,
                timeout: 115_000,
                maxBuffer: 10 * 1024 * 1024,
            },
        ));
    } catch (err) {
        const out = err as {
            stdout?: string;
            stderr?: string;
            message?: string;
        };
        throw new Error(
            `live acceptance failed: ${out.message}\n--- stdout ---\n${out.stdout ?? ''}\n--- stderr ---\n${out.stderr ?? ''}`,
        );
    }
    expect(stdout).toMatch(/--- PASS: TestWebSocketProtobufLiveAcceptance/);
    expect(stdout).not.toContain('SKIP');
});
