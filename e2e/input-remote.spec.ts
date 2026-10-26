import { expect, test } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

// Remote keyboard (web/input.html): type on one device, bytes land in a
// live pane's PTY stdin. Proves the phone-to-session path end to end:
// input.html POST -> pane stdin -> shell echo -> vanilla WS read-back.

let phi: PhiServer;

test.beforeAll(async () => {
    phi = await startPhi();
});

test.afterAll(async () => {
    await phi.stop();
});

async function spawnShell(): Promise<string> {
    // bash on unix, pwsh on Windows; skip if neither exists.
    for (const coder of process.platform === 'win32'
        ? ['pwsh', 'bash']
        : ['bash']) {
        const res = await fetch(`${phi.url}/api/terminals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ coder }),
        });
        if (res.ok) {
            const body = (await res.json()) as { pane_id: string };
            return body.pane_id;
        }
    }
    test.skip(true, 'no shell coder available');
    throw new Error('unreachable');
}

test('input.html sends keystrokes into a live pane', async ({ page }) => {
    const paneId = await spawnShell();
    // >16 runes: crosses the bracketed-paste wrap threshold, so the
    // round-trip also proves the wrapped payload is fine for shells.
    const marker = `kb-e2e-${Date.now()}`;

    await page.goto(`${phi.url}/input.html`);
    const picker = page.locator('#kb-pane');
    await expect
        .poll(
            async () =>
                picker.evaluate(
                    (el: HTMLSelectElement, id: string) =>
                        [...el.options].some((o) => o.value === id),
                    paneId,
                ),
            { timeout: 15_000 },
        )
        .toBe(true);
    await picker.selectOption(paneId);

    // Read-back tap: a vanilla WS attach streaming the pane's output. The
    // endpoint admits only the terminal subprotocol, and frames are decoded
    // with the generated browser codec rather than scanned as raw bytes.
    await page.evaluate(
        async ([url, id]) => {
            const w = window as unknown as {
                __kbOut: string;
                __kbAttached: boolean;
            };
            w.__kbOut = '';
            w.__kbAttached = false;
            type ServerFrame = {
                payload?:
                    | { $case: 'output'; value: { data: Uint8Array } }
                    | { $case: string; value: unknown };
            };
            type OutputPayload = {
                $case: 'output';
                value: { data: Uint8Array };
            };
            type Codec = {
                TerminalServerFrame: {
                    decode: (bytes: Uint8Array) => ServerFrame;
                };
            };
            const codecPath = '/proto/terminal.js';
            const codec = (await import(codecPath)) as Codec;
            const ws = new WebSocket(
                `${url.replace(/^http/, 'ws')}/ws/pane/${id}`,
                'phi.terminal.protobuf.v1',
            );
            ws.binaryType = 'arraybuffer';
            const decoder = new TextDecoder();
            ws.onmessage = (e) => {
                const frame = codec.TerminalServerFrame.decode(
                    new Uint8Array(e.data as ArrayBuffer),
                );
                const payload = frame.payload;
                if (!payload) return;
                // The server registers this client before it enqueues the
                // attach frame, so seeing it means live output will arrive.
                if (payload.$case === 'attach') {
                    w.__kbAttached = true;
                    return;
                }
                if (payload.$case !== 'output') return;
                w.__kbOut += decoder.decode(
                    (payload as OutputPayload).value.data,
                );
            };
        },
        [phi.url, paneId],
    );
    await expect
        .poll(
            async () =>
                page.evaluate(
                    () =>
                        (window as unknown as { __kbAttached: boolean })
                            .__kbAttached,
                ),
            { timeout: 15_000 },
        )
        .toBe(true);

    await page.locator('#kb-text').fill(marker);
    await page.locator('#kb-send').click();

    // Shell echoes the line back through the pane.
    await expect
        .poll(
            async () =>
                page.evaluate(
                    (want: string) =>
                        (
                            window as unknown as { __kbOut: string }
                        ).__kbOut.includes(want),
                    marker,
                ),
            { timeout: 30_000 },
        )
        .toBe(true);
    // Sent means cleared, ready for the next line.
    await expect(page.locator('#kb-text')).toHaveValue('');
});
