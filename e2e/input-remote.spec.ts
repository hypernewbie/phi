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

    // Read-back tap: a vanilla WS attach streaming the pane's output.
    // Framing-agnostic — the marker is scanned out of the raw bytes.
    await page.evaluate(
        ([url, id]) => {
            const w = window as unknown as { __kbOut: string };
            w.__kbOut = '';
            const ws = new WebSocket(
                `${url.replace(/^http/, 'ws')}/ws/pane/${id}`,
            );
            ws.binaryType = 'arraybuffer';
            ws.onmessage = (e) => {
                w.__kbOut += String.fromCharCode(...new Uint8Array(e.data));
            };
        },
        [phi.url, paneId],
    );

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
