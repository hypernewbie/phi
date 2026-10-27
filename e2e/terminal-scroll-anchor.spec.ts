import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

// One wheel notch must keep the reader on the line they saw, even when a burst
// of output lands right after the gesture. The fixture blocks on stdin after
// filling the scrollback, so the notch always happens before the late burst —
// the write backlog that used to clamp the viewport to the oldest row
// (viewportY = 0) is deterministic instead of a race.
const fixture = `#!/usr/bin/env python3
import os, tty, time
tty.setraw(0)
def write(data):
    while data:
        data = data[os.write(1, data):]
def burst(start, count):
    buf = bytearray()
    for i in range(start, start + count):
        buf += ('WHEEL %06d %s\\r\\n' % (i, 'X' * 40)).encode()
        if len(buf) >= 1 << 16:
            write(bytes(buf))
            buf = bytearray()
    if buf:
        write(bytes(buf))
burst(0, 11000)
write(b'ANCHOR READY\\r\\n')
# The test wheels inside this window, so the late burst always lands while the
# reader is scrolled up.
# Wait for the test's trigger file (written only after the wheel has landed and
# the anchor is asserted), so a slow attach cannot consume the window.
trigger = '__TRIGGER__'
for _ in range(600):
    if os.path.exists(trigger):
        break
    time.sleep(0.1)
try:
    size = int(open('__BURST__').read().strip())
except Exception:
    size = 6000
burst(11000, size)
write(b'ANCHOR LATE DONE\\r\\n')
while True:
    os.read(0, 4096)
`;

let phi: PhiServer;
// Panes are closed per test: each scenario needs the pane active and recently
// activated, and leftover panes make the second activation replay its state
// checkpoint mid-gesture.
const openPanes: string[] = [];

test.beforeAll(async () => {
    phi = await startPhi({
        setup(dir) {
            const command = join(dir, 'pi-wheel-fixture');
            // The PTY does not start in this directory, so bake absolute paths in.
            writeFileSync(
                command,
                fixture
                    .replace('__TRIGGER__', join(dir, 'late-burst.trigger'))
                    .replace('__BURST__', join(dir, 'late-burst.txt')),
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
});
test.afterEach(async ({ request }) => {
    for (const pane of openPanes.splice(0)) {
        await request
            .delete(`${phi.url}/api/terminals/${pane}`)
            .catch(() => {});
    }
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
            baseY: number;
            getLine(
                i: number,
            ): { translateToString(trim?: boolean): string } | undefined;
        };
    };
}

async function observeTerminals(page: Page): Promise<void> {
    await page.addInitScript(() => {
        type Constructor = new (opts: Record<string, unknown>) => Observed;
        const capture = window as unknown as { anchorTerms: Observed[] };
        capture.anchorTerms = [];
        let base: Constructor;
        Object.defineProperty(window, 'Terminal', {
            configurable: true,
            get: () => base,
            set: (Original: Constructor) => {
                base = class extends Original {
                    constructor(opts: Record<string, unknown>) {
                        super(opts);
                        capture.anchorTerms.push(this);
                    }
                };
            },
        });
    });
}

function topLine(page: Page, pane: string) {
    return page.evaluate((id) => {
        const term = (
            window as unknown as { anchorTerms: Observed[] }
        ).anchorTerms
            .filter(
                (t) =>
                    t.element?.closest('.term-container')?.id === `term-${id}`,
            )
            .at(-1);
        if (!term) return null;
        const buffer = term.buffer.active;
        for (let i = buffer.viewportY; i < buffer.viewportY + term.rows; i++) {
            const text = buffer.getLine(i)?.translateToString(true) ?? '';
            const match = /WHEEL (\d{6})/.exec(text);
            if (match) {
                return {
                    line: Number(match[1]),
                    viewportY: buffer.viewportY,
                    baseY: buffer.baseY,
                };
            }
        }
        return { line: null, viewportY: buffer.viewportY, baseY: buffer.baseY };
    }, pane);
}

// Two contexts in one pane: desktop (1280x800) drives the full gesture ->
// anchor -> burst -> preserved-row path; the mobile viewport (390x844) then
// re-checks the same wiring under a reflow and the narrow layout. Touch input
// is not emulated here: the anchor is driven by the buffer scroll, which wheel
// and touch share.
//
// Scope: this proves the browser wiring (wheel -> onScroll -> anchor ->
// restore). The eviction fallback (reading row leaves the buffer -> live output
// + notice) is covered deterministically in test-js/scrollAnchor.property.test.js.
test('one wheel notch keeps the reading row when a burst follows', async ({
    page,
    request,
}) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await observeTerminals(page);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const url = new URL(message.location().url || phi.url);
        // The isolated home has no OpenCode database or update checker;
        // these optional services already fail without this flow.
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

    writeFileSync(join(phi.dir, 'late-burst.txt'), '6000');
    const created = await request.post(`${phi.url}/api/terminals`, {
        data: { coder: 'pi', cwd: phi.dir, title: 'Anchor' },
    });
    const pane = ((await created.json()) as { pane_id: string }).pane_id;
    openPanes.push(pane);
    await page.goto(`${phi.url}/?pane=${pane}`);
    // Panes accumulate across tests on one server; make sure this pane is
    // the active tab before driving its screen.
    await page.locator(`.tab[data-pane-id="${pane}"]`).click();
    // The fixture only releases its second burst after this marker paints.
    await page.waitForFunction(
        (id) =>
            (window as unknown as { anchorTerms: Observed[] }).anchorTerms.some(
                (t) => {
                    if (
                        t.element?.closest('.term-container')?.id !==
                        `term-${id}`
                    )
                        return false;
                    const buffer = t.buffer.active;
                    for (
                        let i = buffer.baseY;
                        i < Math.min(buffer.baseY + t.rows, buffer.baseY + 40);
                        i++
                    ) {
                        const text =
                            buffer.getLine(i)?.translateToString(true) ?? '';
                        if (text.includes('ANCHOR READY')) return true;
                    }
                    return false;
                },
            ),
        pane,
        { timeout: 180_000 },
    );

    // Activation replays a state checkpoint, which briefly resets the
    // buffer; wait for the retained scrollback to be back before acting.
    await page.waitForFunction(
        (id) =>
            (window as unknown as { anchorTerms: Observed[] }).anchorTerms
                .filter(
                    (t) =>
                        t.element?.closest('.term-container')?.id ===
                        `term-${id}`,
                )
                .some((t) => t.buffer.active.baseY >= 10000),
        pane,
        { timeout: 120_000 },
    );
    await page.waitForTimeout(200);
    const before = await topLine(page, pane);
    expect(before?.line).not.toBeNull();
    const screen = page.locator(`#term-${pane} .xterm-screen`).first();
    await expect(screen).toBeVisible({ timeout: 60_000 });
    const box = (await screen.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(150);
    // The gesture must reach the pane itself and register a reading anchor;
    // without this the assertions below could pass for the wrong reason.
    const anchored = await page.evaluate(
        ({ id, x, y }) => {
            const target = document
                .elementFromPoint(x, y)
                ?.closest('.term-container');
            const term = (
                window as unknown as { anchorTerms: Observed[] }
            ).anchorTerms
                .filter(
                    (t) =>
                        t.element?.closest('.term-container')?.id ===
                        `term-${id}`,
                )
                .at(-1) as unknown as
                | {
                      _phiReaderAnchor?: { marker: { line: number } };
                      buffer: { active: { viewportY: number } };
                  }
                | undefined;
            return {
                container: target?.id ?? null,
                anchorLine: term?._phiReaderAnchor?.marker?.line ?? null,
                viewportY: term?.buffer.active.viewportY ?? null,
            };
        },
        { id: pane, x: box.x + box.width / 2, y: box.y + box.height / 2 },
    );
    expect(
        anchored,
        `wheel must land on the pane and anchor it: ${JSON.stringify(anchored)}`,
    ).toEqual({
        container: `term-${pane}`,
        anchorLine: anchored.viewportY, // post-notch row, not the row the wheel left
        viewportY: anchored.viewportY,
    });

    // The notch must actually move the view upward; its landed row is the
    // content the anchor has to hold.
    const postNotch = await topLine(page, pane);
    expect(postNotch!.line!).toBeLessThan(before!.line!);

    // Release the late burst only now: the anchor is captured and asserted.
    writeFileSync(join(phi.dir, 'late-burst.trigger'), 'go');

    await page.waitForFunction(
        (id) =>
            (window as unknown as { anchorTerms: Observed[] }).anchorTerms.some(
                (t) => {
                    if (
                        t.element?.closest('.term-container')?.id !==
                        `term-${id}`
                    )
                        return false;
                    const buffer = t.buffer.active;
                    for (let i = 0; i < buffer.baseY + t.rows; i++) {
                        const text =
                            buffer.getLine(i)?.translateToString(true) ?? '';
                        if (text.includes('ANCHOR LATE DONE')) return true;
                    }
                    return false;
                },
            ),
        pane,
        { timeout: 60_000 },
    );
    await page.waitForTimeout(500);
    const after = await topLine(page, pane);

    // The reader's row is still inside the buffer: it must not move, and the
    // viewport must not clamp to the oldest retained row (viewportY = 0).
    // Two lines of slack for partial-line accounting; the defect this guards
    // against displaced the row by a full screen (~9-11 rows).
    expect(after!.viewportY).toBeGreaterThan(0);
    expect(
        Math.abs((after!.line ?? 0) - (postNotch!.line ?? 0)),
    ).toBeLessThanOrEqual(2);

    const overflow = await page.evaluate(
        () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    // Mobile viewport: the reflow can move the viewport without a buffer
    // scroll, so the narrow pass takes its own notch and asserts it landed.
    // The equality below is the proof: a wheel that never reached the pane
    // would leave the stale anchor and the current row apart.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(600); // fit after the viewport change
    // The diff drawer is open over the pane at this width (unrelated to this
    // flow and pre-existing); close it so the wheel reaches the terminal.
    await page.evaluate(() =>
        document.getElementById('diff-panel')?.classList.remove('mobile-open'),
    );
    await page.waitForTimeout(200);
    const mobileScreen = page.locator(`#term-${pane} .xterm-screen`).first();
    await mobileScreen.hover(); // scrolls the pane into view first
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(150);
    const mobileAnchored = await page.evaluate(
        ({ id }) => {
            const term = (
                window as unknown as { anchorTerms: Observed[] }
            ).anchorTerms
                .filter(
                    (t) =>
                        t.element?.closest('.term-container')?.id ===
                        `term-${id}`,
                )
                .at(-1) as unknown as
                | {
                      _phiReaderAnchor?: { marker: { line: number } };
                      buffer: { active: { viewportY: number; baseY: number } };
                  }
                | undefined;
            return {
                anchorLine: term?._phiReaderAnchor?.marker?.line ?? null,
                viewportY: term?.buffer.active.viewportY ?? null,
                baseY: term?.buffer.active.baseY ?? null,
            };
        },
        { id: pane },
    );
    expect(mobileAnchored.baseY!).toBeGreaterThan(0);
    expect(mobileAnchored.anchorLine).toBe(mobileAnchored.viewportY);
    expect(
        await page.evaluate(
            () =>
                document.documentElement.scrollWidth -
                document.documentElement.clientWidth,
        ),
    ).toBeLessThanOrEqual(1);
    expect(errors, errors.join('\n')).toEqual([]);
});
