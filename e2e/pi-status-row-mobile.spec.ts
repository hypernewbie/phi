import { expect, test, type Page } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

// The Pi status row is one non-wrapping flex line whose own
// `overflow: hidden` used to amputate the right end on phones: the model
// segment was pinned at `flex-shrink: 0`, so at 390px the bar held 568px
// of content and the model was cut mid-name. These checks pin the
// contract: the row wraps on compact viewports and no segment may ever
// spill past the bar.
let phi: PhiServer;
test.beforeAll(async () => {
    phi = await startPhi();
});
test.afterAll(async () => phi.stop());

const bar = (model: string, { tokens = true } = {}) => `
<div class="terminal-content" style="height:100dvh">
  <div id="bar" class="pi-rpc-status-bar">
    <div class="pi-rpc-status-cwd" id="cwd">~/code/phi &bull; session title</div>
    <div class="pi-rpc-status-main">
      ${tokens ? '<span class="pi-rpc-status-tokens" id="tokens">&uarr;123K &darr;45K R892K $1.23</span>' : ''}
      <span class="pi-rpc-context-meter pi-rpc-status-meter" id="meter"
            role="progressbar" aria-valuemin="0" aria-valuemax="100"
            aria-valuenow="35">
        <span class="pi-rpc-context-meter-fill pi-rpc-context-meter-fill--low"
              style="width:35%"></span>
        <span class="pi-rpc-context-meter-text">70K/200K</span>
      </span>
      <span class="pi-rpc-status-model" id="model" title="${model}">${model}</span>
    </div>
  </div>
  <div class="terminals-wrapper"></div>
</div>`;

// Real stylesheet, synthetic markup: the same reason the picker spec
// builds a fixture instead of driving a live Pi session.
const fixture = `<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/style.css">
${bar('deepseek/deepseek-v4.1-flash \u2022 high')}`;

interface Metrics {
    root: number;
    barWidth: number;
    barScrollWidth: number;
    barHeight: number;
    rows: number;
    segments: Array<{
        id: string;
        width: number;
        right: number;
        overflow: number;
    }>;
    barRight: number;
}

async function measure(page: Page, rootFont: number): Promise<Metrics> {
    return page.evaluate((rootPx) => {
        document.documentElement.style.fontSize = `${rootPx}px`;
        const el = (id: string) => document.getElementById(id) as HTMLElement;
        const bar = el('bar');
        const barRect = bar.getBoundingClientRect();
        const ids = ['cwd', 'tokens', 'meter', 'model'].filter((id) =>
            document.getElementById(id),
        );
        return {
            root: Number.parseFloat(
                getComputedStyle(document.documentElement).fontSize,
            ),
            barWidth: bar.clientWidth,
            barScrollWidth: bar.scrollWidth,
            barHeight: barRect.height,
            barRight: barRect.right,
            rows: (() => {
                const tops = ids
                    .map((id) => el(id).getBoundingClientRect().top)
                    .sort((a, b) => a - b);
                // A wrapped line puts all of its segments within a few px of
                // each other; baseline-aligned spans of different heights
                // differ by a couple of px, so merge on an 8px band.
                const bands: number[] = [];
                for (const top of tops) {
                    if (
                        bands.length === 0 ||
                        top - bands[bands.length - 1] > 8
                    ) {
                        bands.push(top);
                    }
                }
                return bands.length;
            })(),
            segments: ids.map((id) => {
                const segment = el(id);
                const rect = segment.getBoundingClientRect();
                return {
                    id,
                    width: rect.width,
                    right: rect.right,
                    overflow: segment.scrollWidth - segment.clientWidth,
                };
            }),
        };
    }, rootFont);
}

async function open(page: Page, html: string = fixture): Promise<void> {
    await page.route('**/status-row-fixture', (route) =>
        route.fulfill({ contentType: 'text/html', body: html }),
    );
    await page.goto(`${phi.url}/status-row-fixture`);
    await expect(page.locator('#bar')).toBeVisible();
}

test.describe('compact viewports', () => {
    test.use({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
    });

    test('the row wraps and never clips its tail', async ({ page }) => {
        await open(page);
        const m = await measure(page, 14);

        // The old failure: 532px of content inside a 390px bar with
        // `overflow: hidden`, so everything past the model's start was lost.
        expect(m.barScrollWidth).toBeLessThanOrEqual(m.barWidth + 1);
        expect(m.rows).toBeGreaterThan(1);
        for (const segment of m.segments) {
            expect(segment.right).toBeLessThanOrEqual(m.barRight + 0.5);
            // Segments shrink to an ellipsis instead of being amputated.
            if (segment.overflow > 1) {
                expect(
                    await page.evaluate(
                        (id) =>
                            getComputedStyle(document.getElementById(id)!)
                                .textOverflow,
                        segment.id,
                    ),
                ).toBe('ellipsis');
            }
        }
        // At the default mobile size the model keeps its whole name.
        const model = m.segments.find((s) => s.id === 'model')!;
        expect(model.overflow).toBeLessThanOrEqual(1);
    });

    test('a 320px phone still contains every segment', async ({ page }) => {
        await page.setViewportSize({ width: 320, height: 568 });
        await open(page);
        for (const rootFont of [14, 17]) {
            const m = await measure(page, rootFont);
            expect(m.barScrollWidth).toBeLessThanOrEqual(m.barWidth + 1);
            for (const segment of m.segments) {
                expect(segment.right).toBeLessThanOrEqual(m.barRight + 0.5);
            }
        }
    });

    test('an over-long model id truncates with an ellipsis, not a cut', async ({
        page,
    }) => {
        const long = `router/${'x'.repeat(80)}`;
        await open(
            page,
            `<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/style.css">
${bar(long)}`,
        );
        const m = await measure(page, 17);
        expect(m.barScrollWidth).toBeLessThanOrEqual(m.barWidth + 1);
        const model = m.segments.find((s) => s.id === 'model')!;
        expect(model.right).toBeLessThanOrEqual(m.barRight + 0.5);
        expect(model.overflow).toBeGreaterThan(1);
    });
});

test('desktop keeps one line and the whole row', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    const m = await measure(page, 14);
    expect(m.barScrollWidth).toBeLessThanOrEqual(m.barWidth + 1);
    expect(m.rows).toBe(1);
    const model = m.segments.find((s) => s.id === 'model')!;
    expect(model.overflow).toBeLessThanOrEqual(1);
});

test('a bridge-shaped row (no token counts) stays inside one line on desktop', async ({
    page,
}) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(
        page,
        `<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/style.css">
${bar('deepseek/deepseek-v4.1-flash', { tokens: false })}`,
    );
    const m = await measure(page, 14);
    expect(m.barScrollWidth).toBeLessThanOrEqual(m.barWidth + 1);
    expect(m.segments.map((s) => s.id)).toEqual(['cwd', 'meter', 'model']);
    expect(
        m.segments.find((s) => s.id === 'model')!.overflow,
    ).toBeLessThanOrEqual(1);
});
