import { expect, test, type Page } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

// Redraws are the series a performance regression shows up in, so every one
// — resize, panel change, tab reveal, explicit refresh — lands on a single
// DevTools custom track. console.timeStamp leaves no User Timing entry, so
// recording is unbounded: there is no buffer to clear and no threshold that
// would hide the cheap members of the series.
let phi: PhiServer;

test.beforeAll(async () => {
    phi = await startPhi();
});

test.afterAll(async () => {
    await phi.stop();
});

type RedrawEntry = {
    label: string;
    start: number;
    end: number;
    track: string;
    group: string;
    data: { ms: number; cols: number; rows: number };
};

type TracedWindow = Window & { phiRedrawEntries: RedrawEntry[] };

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

// The trace is written by console.timeStamp, so the page can record what the
// performance panel would receive without DevTools attached.
async function installTraceSpy(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const w = window as unknown as TracedWindow;
        w.phiRedrawEntries = [];
        // Forward to the real API so the trace still receives the entry;
        // the DOM typing only knows the single-label form.
        const passThrough = console.timeStamp?.bind(console) as
            | ((...args: unknown[]) => void)
            | undefined;
        console.timeStamp = (...args: unknown[]) => {
            const [label, start, end, track, group, , data] = args as [
                string,
                number,
                number,
                string,
                string,
                string,
                { ms: number; cols: number; rows: number },
            ];
            w.phiRedrawEntries.push({ label, start, end, track, group, data });
            passThrough?.(...args);
        };
    });
}

const entries = (page: Page) =>
    page.evaluate(() => (window as unknown as TracedWindow).phiRedrawEntries);

test('every redraw lands on the trace track, fast ones included', async ({
    page,
}) => {
    test.setTimeout(120_000);
    const a = await spawnShell();
    const b = await spawnShell();
    await installTraceSpy(page);
    await page.goto(phi.url);

    const tabA = page.locator(`.tab[data-pane-id="${a}"]`);
    const tabB = page.locator(`.tab[data-pane-id="${b}"]`);
    const screenA = page.locator(`#term-${a} .xterm-screen`);
    const screenB = page.locator(`#term-${b} .xterm-screen`);
    await expect(screenA).toBeAttached({ timeout: 30_000 });
    await expect(screenB).toBeAttached({ timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    await tabA.click();
    await expect(screenA).toBeVisible();
    await page.waitForTimeout(500);

    // A tab reveal redraws the incoming pane at its panel geometry.
    await tabB.click();
    await expect(screenB).toBeVisible();
    await page.waitForTimeout(800);
    expect((await entries(page)).map((entry) => entry.label)).toContain(
        'tab-switch',
    );

    // A window resize reaches the trace through the panel observer, which is
    // what requests the refit; any pending span also absorbs the settle path.
    const beforeResize = (await entries(page)).length;
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.waitForTimeout(800);
    expect((await entries(page)).length).toBeGreaterThan(beforeResize);

    const recorded = await entries(page);
    for (const entry of recorded) {
        expect(entry.track).toBe('redraw');
        expect(entry.group).toBe('phi');
        expect(entry.end).toBeGreaterThanOrEqual(entry.start);
        expect(entry.data.ms).toBeGreaterThanOrEqual(0);
        expect(entry.data.cols).toBeGreaterThan(0);
        expect(entry.data.rows).toBeGreaterThan(0);
    }
    // Every span closes on a painted frame, so none may sit at the drop cap.
    expect(recorded.every((entry) => entry.data.ms < 3000)).toBe(true);
});
