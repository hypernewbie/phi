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
