import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

// A phone has no mouse, so xterm's gesture engine swallows the touch events
// that used to drive link activation. These tests prove the replacement path:
// a tap resolves the cell under the finger, maps it to the link range, and
// opens the URL.
const fixture = `#!/usr/bin/env python3
import os, tty
tty.setraw(0)
def write(data):
    while data:
        data = data[os.write(1, data):]
lines = ['FILLER %02d' % i for i in range(80)]
lines.append('READY')
lines.append('https://example.com/mobile-touch')
lines.append('SELECTABLE TEXT 12345')
write(('\\r\\n'.join(lines) + '\\r\\n').encode())
while True:
    os.read(0, 4096)
`;

let phi: PhiServer;
const openPanes: string[] = [];

test.beforeAll(async () => {
    phi = await startPhi({
        setup(dir) {
            const command = join(dir, 'pi-touch-fixture');
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

const URL_TEXT = 'https://example.com/mobile-touch';
const PLAIN_TEXT = 'SELECTABLE';

interface Observed {
    element?: HTMLElement;
    cols: number;
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
    getSelection(): string;
    hasSelection(): boolean;
    scrollLines(amount: number): void;
}

interface Capture {
    terms: Observed[];
    opened: Array<{ url: string; target: string; features: string }>;
}

async function installCapture(page: Page): Promise<void> {
    await page.addInitScript(() => {
        type Constructor = new (opts: Record<string, unknown>) => Observed;
        const capture = window as unknown as Capture;
        capture.terms = [];
        capture.opened = [];
        const base = window.open;
        window.open = ((url: string, target: string, features: string) => {
            capture.opened.push({ url: String(url), target, features });
            return null;
        }) as typeof base;
        let Parent: Constructor;
        Object.defineProperty(window, 'Terminal', {
            configurable: true,
            get: () => Parent,
            set: (Original: Constructor) => {
                Parent = class extends Original {
                    constructor(opts: Record<string, unknown>) {
                        super(opts);
                        capture.terms.push(this);
                    }
                };
            },
        });
    });
}

async function waitForMarker(page: Page, pane: string, marker: string) {
    await page.waitForFunction(
        ({ id, marker }) => {
            const capture = window as unknown as Capture;
            const term = capture.terms
                .filter(
                    (t) =>
                        t.element?.isConnected &&
                        t.element.closest('.term-container')?.id ===
                            `term-${id}`,
                )
                .at(-1);
            if (!term) return false;
            const buffer = term.buffer.active;
            for (
                let i = buffer.viewportY;
                i < buffer.viewportY + term.rows;
                i++
            )
                if (buffer.getLine(i)?.translateToString(true).includes(marker))
                    return true;
            return false;
        },
        { id: pane, marker },
        { timeout: 60_000 },
    );
}

// cellPoint maps a text occurrence to a viewport point, deriving both axes
// from the buffer and the screen box so the test is font-size independent.
async function cellPoint(page: Page, pane: string, needle: string) {
    const screen = page.locator(`#term-${pane} .xterm-screen`).first();
    await expect(screen).toBeVisible({ timeout: 60_000 });
    // A drawer close, a font settle, or a late replay resize moves the grid;
    // tap only once two samples agree.
    let box = (await screen.boundingBox())!;
    for (let i = 0; i < 50; i++) {
        await page.waitForTimeout(100);
        const next = (await screen.boundingBox())!;
        if (next.width === box.width && next.height === box.height) break;
        box = next;
    }
    const hit = await page.evaluate(
        ({ id, needle }) => {
            const capture = window as unknown as Capture;
            const term = capture.terms
                .filter(
                    (t) =>
                        t.element?.isConnected &&
                        t.element.closest('.term-container')?.id ===
                            `term-${id}`,
                )
                .at(-1);
            if (!term) return null;
            const buffer = term.buffer.active;
            for (
                let y = buffer.viewportY;
                y < buffer.viewportY + term.rows;
                y++
            ) {
                const text = buffer.getLine(y)?.translateToString(true) ?? '';
                const col = text.indexOf(needle);
                if (col >= 0) {
                    return {
                        col,
                        viewportRow: y - buffer.viewportY,
                        cols: term.cols,
                        rows: term.rows,
                    };
                }
            }
            return null;
        },
        { id: pane, needle },
    );
    expect(hit, `the buffer must show ${needle}`).not.toBeNull();
    expect(hit!.cols).toBeGreaterThanOrEqual(32);
    const point = {
        x: box.x + (hit!.col + 0.5) * (box.width / hit!.cols),
        y: box.y + (hit!.viewportRow + 0.5) * (box.height / hit!.rows),
    };
    // The drawer animates out after a tab switch; a raw coordinate tap during
    // that window lands on the drawer instead of the terminal. Wait until the
    // point actually resolves to this pane's screen.
    await expect
        .poll(
            () =>
                page.evaluate(
                    ({ x, y, id }) => {
                        const el = document.elementFromPoint(x, y);
                        return Boolean(
                            el?.closest(`#term-${id} .xterm-screen`),
                        );
                    },
                    { ...point, id: pane },
                ),
            { timeout: 15_000 },
        )
        .toBe(true);
    return point;
}

async function openPane(
    page: Page,
    request: Page['request'],
    title: string,
    mobile = true,
): Promise<string> {
    const created = await request.post(`${phi.url}/api/terminals`, {
        data: { coder: 'pi', cwd: phi.dir, title },
    });
    const pane = ((await created.json()) as { pane_id: string }).pane_id;
    openPanes.push(pane);
    await page.goto(phi.url);
    if (mobile) {
        // The tab strip sits behind the drawer on a phone, so activate the
        // pane through the drawer flow the app actually supports.
        await page.locator('#mobile-sidebar-toggle').click();
        const row = page.locator(
            `#drawer-tabs-body .hostname-dropdown-row[data-pane-id="${pane}"]`,
        );
        await expect(row).toBeVisible({ timeout: 30_000 });
        await row.locator('.hostname-dropdown-select-btn').click();
        await expect(page.locator('#sidebar-panel')).not.toHaveClass(
            /drawer-open/,
        );
    } else {
        await page.locator(`.tab[data-pane-id="${pane}"]`).click();
    }
    await waitForMarker(page, pane, 'READY');
    return pane;
}

async function touchPage(context: BrowserContext, page: Page): Promise<void> {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
        origin: phi.url,
    });
    await installCapture(page);
}

function termState(page: Page, pane: string) {
    return page.evaluate((id) => {
        const capture = window as unknown as Capture;
        const term = capture.terms
            .filter(
                (t) =>
                    t.element?.isConnected &&
                    t.element.closest('.term-container')?.id === `term-${id}`,
            )
            .at(-1);
        return {
            selection: term?.getSelection() ?? null,
            hasSelection: term?.hasSelection() ?? false,
            viewportY: term?.buffer.active.viewportY ?? -1,
        };
    }, pane);
}

function readClipboard(page: Page) {
    return page.evaluate(() => navigator.clipboard.readText());
}

// A gesture must always end its touch, even when an assertion throws between
// press and release, or the next test starts with a finger still down.
async function gesture(
    page: Page,
    points: Array<{ x: number; y: number }>,
    holdMs = 0,
) {
    const cdp = await page.context().newCDPSession(page);
    let active = false;
    try {
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ ...points[0], id: 1 }],
        });
        active = true;
        for (const point of points.slice(1)) {
            await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchMove',
                touchPoints: [{ ...point, id: 1 }],
            });
        }
        if (holdMs > 0) await page.waitForTimeout(holdMs);
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchEnd',
            touchPoints: [],
        });
        active = false;
    } finally {
        if (active) {
            await cdp
                .send('Input.dispatchTouchEvent', {
                    type: 'touchCancel',
                    touchPoints: [],
                })
                .catch(() => {});
        }
        await cdp.detach();
    }
}

function longPress(page: Page, point: { x: number; y: number }) {
    return gesture(page, [point], 700);
}

test('a tap on a URL opens it', async ({ browser, request }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
    });
    const page = await context.newPage();
    await touchPage(context, page);
    const pane = await openPane(page, request, 'TouchLink');
    const point = await cellPoint(page, pane, URL_TEXT);
    await page.touchscreen.tap(point.x, point.y);
    await expect
        .poll(
            () =>
                page.evaluate(
                    () => (window as unknown as Capture).opened.length,
                ),
            { timeout: 15_000 },
        )
        .toBeGreaterThanOrEqual(1);
    const opened = await page.evaluate(
        () => (window as unknown as Capture).opened,
    );
    expect(opened).toHaveLength(1);
    expect(opened[0].url).toBe(URL_TEXT);
    expect(opened[0].target).toBe('_blank');
    await context.close();
});

test('a tap on plain text opens nothing and leaves no selection', async ({
    browser,
    request,
}) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
    });
    const page = await context.newPage();
    await touchPage(context, page);
    const pane = await openPane(page, request, 'TouchPlain');
    const point = await cellPoint(page, pane, PLAIN_TEXT);
    await page.touchscreen.tap(point.x, point.y);
    await page.waitForTimeout(300);
    expect(
        await page.evaluate(() => (window as unknown as Capture).opened.length),
    ).toBe(0);
    expect(
        await page.evaluate((id) => {
            const capture = window as unknown as Capture;
            const term = capture.terms
                .filter(
                    (t) =>
                        t.element?.isConnected &&
                        t.element.closest('.term-container')?.id ===
                            `term-${id}`,
                )
                .at(-1);
            return term?.hasSelection() ?? false;
        }, pane),
    ).toBe(false);
    await context.close();
});

test('a tap does not scroll the terminal', async ({ browser, request }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
    });
    const page = await context.newPage();
    await touchPage(context, page);
    const pane = await openPane(page, request, 'TouchScroll');
    const point = await cellPoint(page, pane, PLAIN_TEXT);
    const viewportY = await page.evaluate((id) => {
        const capture = window as unknown as Capture;
        const term = capture.terms
            .filter(
                (t) =>
                    t.element?.isConnected &&
                    t.element.closest('.term-container')?.id === `term-${id}`,
            )
            .at(-1);
        return term?.buffer.active.viewportY ?? -1;
    }, pane);
    expect(viewportY).toBeGreaterThanOrEqual(0);
    await page.touchscreen.tap(point.x, point.y);
    await page.waitForTimeout(300);
    expect(
        await page.evaluate((id) => {
            const capture = window as unknown as Capture;
            const term = capture.terms
                .filter(
                    (t) =>
                        t.element?.isConnected &&
                        t.element.closest('.term-container')?.id ===
                            `term-${id}`,
                )
                .at(-1);
            return term?.buffer.active.viewportY ?? -1;
        }, pane),
    ).toBe(viewportY);
    await context.close();
});

test('a long press selects the word and does not copy', async ({
    browser,
    request,
}) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
    });
    const page = await context.newPage();
    await touchPage(context, page);
    const pane = await openPane(page, request, 'TouchSelect');
    const point = await cellPoint(page, pane, PLAIN_TEXT);
    await page.evaluate(() => navigator.clipboard.writeText('SENTINEL'));
    await longPress(page, point);
    await expect
        .poll(async () => (await termState(page, pane)).selection, {
            timeout: 15_000,
        })
        .toBe(PLAIN_TEXT);
    // The silent auto-copy must stay off while a touch selection exists; the
    // pill is the only copy action.
    expect(await readClipboard(page)).toBe('SENTINEL');
    const pill = page.locator(`#term-${pane} .terminal-copy-pill`);
    await expect(pill).toBeVisible();
    // The pill must be reachable and must not cover the word it copies: a
    // misplaced pill is invisible under the pane's overflow clip.
    const pillBox = (await pill.boundingBox())!;
    const paneBox = (await page.locator(`#term-${pane}`).boundingBox())!;
    expect(pillBox.x).toBeGreaterThanOrEqual(paneBox.x - 1);
    expect(pillBox.y).toBeGreaterThanOrEqual(paneBox.y - 1);
    expect(pillBox.x + pillBox.width).toBeLessThanOrEqual(
        paneBox.x + paneBox.width + 1,
    );
    expect(pillBox.y + pillBox.height).toBeLessThanOrEqual(
        paneBox.y + paneBox.height + 1,
    );
    expect(pillBox.y + pillBox.height).toBeLessThan(point.y);
    await context.close();
});

test('the Copy pill copies the selection and clears it', async ({
    browser,
    request,
}) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
    });
    const page = await context.newPage();
    await touchPage(context, page);
    const pane = await openPane(page, request, 'TouchCopy');
    const point = await cellPoint(page, pane, PLAIN_TEXT);
    await longPress(page, point);
    await expect
        .poll(async () => (await termState(page, pane)).selection, {
            timeout: 15_000,
        })
        .toBe(PLAIN_TEXT);
    await page.locator(`#term-${pane} .terminal-copy-pill`).tap();
    await expect
        .poll(() => readClipboard(page), { timeout: 10_000 })
        .toBe(PLAIN_TEXT);
    await expect
        .poll(async () => (await termState(page, pane)).hasSelection)
        .toBe(false);
    await expect(
        page.locator(`#term-${pane} .terminal-copy-pill`),
    ).toBeHidden();
    await context.close();
});

test('the pill hides when the selection scrolls out of view', async ({
    browser,
    request,
}) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
    });
    const page = await context.newPage();
    await touchPage(context, page);
    const pane = await openPane(page, request, 'TouchScrollPill');
    const point = await cellPoint(page, pane, PLAIN_TEXT);
    await longPress(page, point);
    const pill = page.locator(`#term-${pane} .terminal-copy-pill`);
    await expect(pill).toBeVisible();
    // The pill rides the viewport through the onScroll subscription; a pill
    // stranded over unrelated output would copy a selection nobody sees.
    await page.evaluate((id) => {
        const capture = window as unknown as Capture;
        capture.terms
            .filter(
                (t) =>
                    t.element?.isConnected &&
                    t.element.closest('.term-container')?.id === `term-${id}`,
            )
            .at(-1)
            ?.scrollLines(-40);
    }, pane);
    await expect(pill).toBeHidden();
    await page.evaluate((id) => {
        const capture = window as unknown as Capture;
        capture.terms
            .filter(
                (t) =>
                    t.element?.isConnected &&
                    t.element.closest('.term-container')?.id === `term-${id}`,
            )
            .at(-1)
            ?.scrollLines(40);
    }, pane);
    await expect(pill).toBeVisible();
    await context.close();
});

test('a swipe with no selection still scrolls', async ({
    browser,
    request,
}) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
    });
    const page = await context.newPage();
    await touchPage(context, page);
    const pane = await openPane(page, request, 'TouchSwipe');
    const point = await cellPoint(page, pane, PLAIN_TEXT);
    const before = await termState(page, pane);
    await gesture(page, [point, { x: point.x, y: point.y + 120 }]);
    await expect
        .poll(async () => (await termState(page, pane)).viewportY, {
            timeout: 10_000,
        })
        .not.toBe(before.viewportY);
    await context.close();
});

test('the desktop mouse path still auto-copies', async ({
    browser,
    request,
}) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
        origin: phi.url,
    });
    await installCapture(page);
    const pane = await openPane(page, request, 'TouchMouse', false);
    const point = await cellPoint(page, pane, PLAIN_TEXT);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 90, point.y, { steps: 8 });
    await page.mouse.up();
    await expect
        .poll(() => readClipboard(page), { timeout: 10_000 })
        .toContain(PLAIN_TEXT);
    await context.close();
});

test('a drag extends the selection and does not scroll', async ({
    browser,
    request,
}) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
    });
    const page = await context.newPage();
    await touchPage(context, page);
    const pane = await openPane(page, request, 'TouchDrag');
    const start = await cellPoint(page, pane, PLAIN_TEXT);
    const end = await cellPoint(page, pane, '12345');
    const before = await termState(page, pane);
    // One gesture: press, hold past the long-press delay, then move to the
    // end cell before lifting.
    const cdp = await context.newCDPSession(page);
    try {
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ x: start.x, y: start.y, id: 1 }],
        });
        await page.waitForTimeout(700);
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: end.x, y: end.y, id: 1 }],
        });
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchEnd',
            touchPoints: [],
        });
    } finally {
        await cdp.detach();
    }
    await expect
        .poll(async () => (await termState(page, pane)).selection, {
            timeout: 10_000,
        })
        .toMatch(new RegExp(`^${PLAIN_TEXT}.{2,}`));
    expect((await termState(page, pane)).selection!.length).toBeGreaterThan(10);
    // The drag owns the screen: the viewport must not move under the finger.
    expect((await termState(page, pane)).viewportY).toBe(before.viewportY);
    await context.close();
});

test('a swipe after a selection clears it and still scrolls', async ({
    browser,
    request,
}) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
    });
    const page = await context.newPage();
    await touchPage(context, page);
    const pane = await openPane(page, request, 'TouchUnlock');
    const point = await cellPoint(page, pane, PLAIN_TEXT);
    await longPress(page, point);
    await expect
        .poll(async () => (await termState(page, pane)).hasSelection, {
            timeout: 15_000,
        })
        .toBe(true);
    const before = await termState(page, pane);
    await gesture(page, [point, { x: point.x, y: point.y + 120 }]);
    await expect
        .poll(async () => (await termState(page, pane)).viewportY, {
            timeout: 10_000,
        })
        .not.toBe(before.viewportY);
    expect((await termState(page, pane)).hasSelection).toBe(false);
    await context.close();
});

test('a tap outside the terminal clears the selection', async ({
    browser,
    request,
}) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
    });
    const page = await context.newPage();
    await touchPage(context, page);
    const pane = await openPane(page, request, 'TouchOutside');
    const point = await cellPoint(page, pane, PLAIN_TEXT);
    await longPress(page, point);
    await expect
        .poll(async () => (await termState(page, pane)).hasSelection, {
            timeout: 15_000,
        })
        .toBe(true);
    // The app header sits above the terminal on the phone layout; the point is
    // outside .xterm-screen either way.
    await page.touchscreen.tap(4, 4);
    await expect
        .poll(async () => (await termState(page, pane)).hasSelection, {
            timeout: 10_000,
        })
        .toBe(false);
    await expect(
        page.locator(`#term-${pane} .terminal-copy-pill`),
    ).toBeHidden();
    await context.close();
});

test('switching tabs clears the selection', async ({ browser, request }) => {
    test.setTimeout(120_000);
    const first = await request.post(`${phi.url}/api/terminals`, {
        data: { coder: 'pi', cwd: phi.dir, title: 'TouchTabA' },
    });
    const a = ((await first.json()) as { pane_id: string }).pane_id;
    openPanes.push(a);
    const second = await request.post(`${phi.url}/api/terminals`, {
        data: { coder: 'pi', cwd: phi.dir, title: 'TouchTabB' },
    });
    const b = ((await second.json()) as { pane_id: string }).pane_id;
    openPanes.push(b);
    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        hasTouch: true,
        isMobile: false,
    });
    const page = await context.newPage();
    await touchPage(context, page);
    await page.goto(phi.url);
    await page.locator(`.tab[data-pane-id="${a}"]`).click();
    await waitForMarker(page, a, 'READY');
    const point = await cellPoint(page, a, PLAIN_TEXT);
    await longPress(page, point);
    await expect
        .poll(async () => (await termState(page, a)).hasSelection, {
            timeout: 15_000,
        })
        .toBe(true);
    await page.locator(`.tab[data-pane-id="${b}"]`).click();
    await expect
        .poll(async () => (await termState(page, a)).hasSelection, {
            timeout: 10_000,
        })
        .toBe(false);
    await expect(page.locator(`#term-${a} .terminal-copy-pill`)).toBeHidden();
    await context.close();
});

// An alt-screen TUI (OpenCode legacy) injects scroll keys on a swipe. The
// touch selection must stand that injection down while the finger drags a
// selection, or the TUI scrolls under the highlight.
test.describe('opencode alt screen', () => {
    test.skip(
        process.platform === 'win32',
        'POSIX fake CLI; the Go tests cover Windows argv wrapping',
    );
    let alt: PhiServer;
    let fixtureDir = '';
    let paneId = '';

    test.beforeAll(async () => {
        fixtureDir = mkdtempSync(join(tmpdir(), 'phi-touch-alt-'));
        const command = join(fixtureDir, 'opencode');
        writeFileSync(
            command,
            `#!/usr/bin/env python3
import os, sys, tty
if len(sys.argv) > 1 and sys.argv[1] == '--version':
    print('1.0.21')
    sys.exit(0)
if len(sys.argv) > 1 and sys.argv[1] == 'debug':
    print(os.path.expanduser('~/.local/share/opencode/opencode.db'))
    sys.exit(0)
tty.setraw(0)
os.write(1, b'\\033[?1049hready\\r\\n')
# The log lives next to this script: HOME differs between the server and the
# PTY child, and a guessed path would make "no bytes" untestable.
log = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'stdin.log')
while True:
    data = os.read(0, 1)
    if not data:
        break
    with open(log, 'ab') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
`,
            { mode: 0o755 },
        );
        alt = await startPhi({
            setup() {},
            config: {
                opencode_command: command,
                opencode_legacy_command: command,
                opencode_legacy: true,
            },
        });
    });

    test.afterAll(async () => {
        await alt?.stop();
        if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    });

    async function openAlt(page: Page, request: Page['request']) {
        const created = await request.post(`${alt.url}/api/terminals`, {
            data: { coder: 'opencode', cwd: alt.dir, title: 'AltTouch' },
        });
        paneId = ((await created.json()) as { pane_id: string }).pane_id;
        await page.goto(alt.url);
        await page.locator('#mobile-sidebar-toggle').click();
        const row = page.locator(
            `#drawer-tabs-body .hostname-dropdown-row[data-pane-id="${paneId}"]`,
        );
        await expect(row).toBeVisible({ timeout: 30_000 });
        await row.locator('.hostname-dropdown-select-btn').click();
        await expect(page.locator('#sidebar-panel')).not.toHaveClass(
            /drawer-open/,
        );
        await waitForMarker(page, paneId, 'ready');
    }

    test('a swipe injects a scroll key', async ({ browser, request }) => {
        test.setTimeout(120_000);
        const log = join(fixtureDir, 'stdin.log');
        const context = await browser.newContext({
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
        });
        const page = await context.newPage();
        await touchPage(context, page);
        await openAlt(page, request);
        const point = await cellPoint(page, paneId, 'ready');
        await gesture(page, [point, { x: point.x, y: point.y + 120 }]);
        // The injected navigation key is the assertion; any other byte would
        // pass a bare length check while the feature is broken.
        await expect
            .poll(
                () => {
                    const text = existsSync(log)
                        ? readFileSync(log).toString('latin1')
                        : '';
                    return text.includes('\x05') || text.includes('\x19');
                },
                { timeout: 15_000 },
            )
            .toBe(true);
        await request
            .delete(`${alt.url}/api/terminals/${paneId}`)
            .catch(() => {});
        await context.close();
    });

    test('a selection drag injects nothing', async ({ browser, request }) => {
        test.setTimeout(120_000);
        const log = join(fixtureDir, 'stdin.log');
        const context = await browser.newContext({
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
        });
        const page = await context.newPage();
        await touchPage(context, page);
        await openAlt(page, request);
        const point = await cellPoint(page, paneId, 'ready');
        const before = existsSync(log) ? readFileSync(log).length : 0;
        const cdp = await context.newCDPSession(page);
        try {
            await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchStart',
                touchPoints: [{ x: point.x, y: point.y, id: 1 }],
            });
            await page.waitForTimeout(700);
            await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchMove',
                touchPoints: [{ x: point.x, y: point.y + 120, id: 1 }],
            });
            await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchEnd',
                touchPoints: [],
            });
        } finally {
            await cdp.detach();
        }
        await page.waitForTimeout(400);
        const after = existsSync(log) ? readFileSync(log).length : 0;
        expect(after).toBe(before);
        await request
            .delete(`${alt.url}/api/terminals/${paneId}`)
            .catch(() => {});
        await context.close();
    });
});
