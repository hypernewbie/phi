import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
    hasSelection(): boolean;
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

function paneTerm(page: Page, pane: string) {
    return page.evaluate((id) => {
        const capture = window as unknown as Capture;
        return Boolean(
            capture.terms
                .filter(
                    (t) =>
                        t.element?.isConnected &&
                        t.element.closest('.term-container')?.id ===
                            `term-${id}`,
                )
                .at(-1),
        );
    }, pane);
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
): Promise<string> {
    const created = await request.post(`${phi.url}/api/terminals`, {
        data: { coder: 'pi', cwd: phi.dir, title },
    });
    const pane = ((await created.json()) as { pane_id: string }).pane_id;
    openPanes.push(pane);
    await page.goto(phi.url);
    // The tab strip sits behind the drawer on a phone, so activate the pane
    // through the drawer flow the app actually supports.
    await page.locator('#mobile-sidebar-toggle').click();
    const row = page.locator(
        `#drawer-tabs-body .hostname-dropdown-row[data-pane-id="${pane}"]`,
    );
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.locator('.hostname-dropdown-select-btn').click();
    await expect(page.locator('#sidebar-panel')).not.toHaveClass(/drawer-open/);
    await waitForMarker(page, pane, 'READY');
    return pane;
}

async function touchPage(context: BrowserContext, page: Page): Promise<void> {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
        origin: phi.url,
    });
    await installCapture(page);
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
