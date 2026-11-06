import { expect, test, type Page } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

// The DOM and WebGL renderers must propose the same cell grid. Otherwise
// disposing and re-creating the GL addon on every tab switch resizes the PTY
// even though the panel never changed size.
let phi: PhiServer;

test.beforeAll(async () => {
    phi = await startPhi();
});

test.afterAll(async () => {
    await phi.stop();
});

type TrackedTerminal = {
    cols: number;
    rows: number;
    element?: HTMLElement;
    _phiWebgl?: unknown;
    resize(cols: number, rows: number): void;
};

type TrackedWindow = Window & {
    trackedTerms: TrackedTerminal[];
    trackedResizes: number;
};

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

async function installTracker(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const w = window as unknown as TrackedWindow;
        w.trackedTerms = [];
        w.trackedResizes = 0;
        let Base: unknown;
        Object.defineProperty(window, 'Terminal', {
            configurable: true,
            get: () => Base,
            set: (Original: new (options: unknown) => object) => {
                Base = class extends Original {
                    constructor(options: unknown) {
                        super(options);
                        const term = this as unknown as TrackedTerminal;
                        w.trackedTerms.push(term);
                        const resize = term.resize.bind(term);
                        term.resize = (cols, rows) => {
                            w.trackedResizes++;
                            resize(cols, rows);
                        };
                    }
                };
            },
        });
    });
}

const grid = (page: Page, pane: string) =>
    page.evaluate((id) => {
        const w = window as unknown as TrackedWindow;
        const term = w.trackedTerms.find(
            (candidate) =>
                candidate.element?.closest('.term-container')?.id ===
                `term-${id}`,
        );
        return term ? `${term.cols}x${term.rows}` : '';
    }, pane);

// Reads the GL canvas in the same task that reveals the pane. The reveal task
// is the only moment that proves the first painted frame is the GL frame: a
// later read cannot tell it apart from a frame rendered after the DOM rows were
// already shown.
const switchAndCountPaintedPixels = (page: Page, from: string, to: string) =>
    page.evaluate(
        ({ fromPane, toPane }) => {
            const w = window as unknown as TrackedWindow;
            const termFor = (id: string) =>
                w.trackedTerms.find(
                    (candidate) =>
                        candidate.element?.closest('.term-container')?.id ===
                        `term-${id}`,
                );
            const painted = (id: string) => {
                const addon = termFor(id)?._phiWebgl as
                    | { _renderer?: { _gl?: WebGL2RenderingContext } }
                    | null
                    | undefined;
                const gl = addon?._renderer?._gl;
                if (!gl) return -1;
                const { width, height } = gl.canvas;
                const pixels = new Uint8Array(width * height * 4);
                gl.readPixels(
                    0,
                    0,
                    width,
                    height,
                    gl.RGBA,
                    gl.UNSIGNED_BYTE,
                    pixels,
                );
                let count = 0;
                for (let i = 0; i < pixels.length; i += 4) {
                    if (
                        pixels[i] |
                        pixels[i + 1] |
                        pixels[i + 2] |
                        pixels[i + 3]
                    )
                        count++;
                }
                return count;
            };
            const fromTab = document.querySelector(
                `.tab[data-pane-id="${fromPane}"]`,
            );
            const toTab = document.querySelector(
                `.tab[data-pane-id="${toPane}"]`,
            );
            if (!fromTab || !toTab) return { missing: true };
            (fromTab as HTMLElement).click();
            (toTab as HTMLElement).click();
            return {
                missing: false,
                incomingPixels: painted(toPane),
                incomingHasContext: Boolean(termFor(toPane)?._phiWebgl),
                outgoingHasContext: Boolean(termFor(fromPane)?._phiWebgl),
                visible: !document.hidden,
            };
        },
        { fromPane: from, toPane: to },
    );

test('warm tab switches do not resize either terminal', async ({ page }) => {
    test.setTimeout(120_000);
    const a = await spawnShell();
    const b = await spawnShell();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const url = message.location().url;
        // Isolated servers have no update checker or OpenCode installation;
        // those background probes are unrelated to terminal switching.
        if (
            url.includes('/api/update/status') ||
            url.includes('/api/sessions?coder=opencode')
        )
            return;
        errors.push(`${message.text()} (${url || 'inline'})`);
    });
    await installTracker(page);
    await page.goto(phi.url);

    const tabA = page.locator(`.tab[data-pane-id="${a}"]`);
    const tabB = page.locator(`.tab[data-pane-id="${b}"]`);
    const screenA = page.locator(`#term-${a} .xterm-screen`);
    const screenB = page.locator(`#term-${b} .xterm-screen`);
    await expect(screenA).toBeAttached({ timeout: 30_000 });
    await expect(screenB).toBeAttached({ timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);

    // Fit each pane once before measuring. A pane's first activation still
    // replaces its spawn grid with the actual panel grid.
    for (const [tab, screen] of [
        [tabA, screenA],
        [tabB, screenB],
        [tabA, screenA],
    ] as const) {
        await tab.click();
        await expect(screen).toBeVisible();
    }
    await expect
        .poll(() =>
            page.evaluate(() =>
                (window as unknown as TrackedWindow).trackedTerms.some((term) =>
                    Boolean(term._phiWebgl),
                ),
            ),
        )
        .toBe(true);
    await page.waitForTimeout(1000);

    const beforeA = await grid(page, a);
    const beforeB = await grid(page, b);
    const resizesBefore = await page.evaluate(
        () => (window as unknown as TrackedWindow).trackedResizes,
    );
    for (let i = 0; i < 4; i++) {
        await tabB.click();
        await expect(screenB).toBeVisible();
        await tabA.click();
        await expect(screenA).toBeVisible();
    }
    await page.waitForTimeout(500);

    expect(await grid(page, a)).toBe(beforeA);
    expect(await grid(page, b)).toBe(beforeB);
    expect(
        (await page.evaluate(
            () => (window as unknown as TrackedWindow).trackedResizes,
        )) - resizesBefore,
    ).toBe(0);
    expect(errors).toEqual([]);
});

// A revealed tab is paused until xterm's IntersectionObserver resumes it in a
// later task. The addon's own refresh is deferred to an animation frame, so
// without a synchronous paint the first composited frame of the switch is the
// stale DOM renderer output. Widgets that count frames here read the GL canvas
// inside the reveal task, where a deferred paint is still blank.
test('a warm tab switch paints the GL canvas in the reveal task', async ({
    page,
}) => {
    test.setTimeout(120_000);
    const a = await spawnShell();
    const b = await spawnShell();
    const skippedPaints: string[] = [];
    page.on('console', (message) => {
        if (message.text().includes('sync GL paint skipped'))
            skippedPaints.push(message.text());
    });
    await installTracker(page);
    await page.goto(phi.url);

    const tabA = page.locator(`.tab[data-pane-id="${a}"]`);
    const tabB = page.locator(`.tab[data-pane-id="${b}"]`);
    await expect(page.locator(`#term-${a} .xterm-screen`)).toBeAttached({
        timeout: 30_000,
    });
    await expect(page.locator(`#term-${b} .xterm-screen`)).toBeAttached({
        timeout: 30_000,
    });
    await page.evaluate(() => document.fonts.ready);

    // Warm both panes: a pane's first activation still replaces its spawn grid
    // and attaches its first context.
    await tabA.click();
    await expect(page.locator(`#term-${a} .xterm-screen`)).toBeVisible();
    await tabB.click();
    await expect(page.locator(`#term-${b} .xterm-screen`)).toBeVisible();
    await tabA.click();
    await expect(page.locator(`#term-${a} .xterm-screen`)).toBeVisible();
    await page.waitForTimeout(500);

    const result = await switchAndCountPaintedPixels(page, a, b);
    if (result.missing) test.skip(true, 'tabs were not rendered');
    if (result.incomingPixels === -1)
        test.skip(true, 'no WebGL context in this browser');
    if (!result.visible)
        test.skip(true, 'page is not visible; sync paint is skipped by design');

    expect(result.incomingPixels).toBeGreaterThan(0);
    expect(result.incomingHasContext).toBe(true);
    // One live GL context: the outgoing pane hands rendering back to the DOM.
    expect(result.outgoingHasContext).toBe(false);
    expect(skippedPaints).toEqual([]);
});
