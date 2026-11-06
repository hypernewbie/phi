/**
 * NEVER BREAK THIS AGAIN.
 *
 * The UI font size stopped being a size and became a decoration. The
 * report that started this spec was blunt: "in config it is still
 * default 14,14 but this is NOT fucking 14 on ui size, terminal size is
 * larger than UI by a LOT".
 *
 * What the report means, measured:
 *
 *   - The terminal font size setting IS absolute. `terminal_font_size =
 *     14` renders 14px text in the terminal, exactly as asked.
 *   - The UI font size setting is NOT absolute. `ui_font_size = 14`
 *     renders 10-13px text across the interface: the authored pixel
 *     sizes win and the setting only multiplies them. So the number in
 *     the config is a lie: it says 14 and the interface shows 13 (and
 *     10-12 for secondary text).
 *   - The consequence is the visible one: the terminal sits at the
 *     configured size while the interface sits below it, so the terminal
 *     reads as "normal" and the whole interface reads as "tiny".
 *
 * Two ways this regressed into a state where nobody noticed:
 *
 *   1. The interface text is smaller than the configured size, and
 *      smaller than the terminal, while the config still reads 14,14.
 *   2. A stale browser-side appearance cache (`phi_appearance` in an
 *      ordinary tab, `phi:desktop-appearance:v1:<owner>` in an embedded
 *      desktop view) silently overrides the server config forever.
 *      A cache written before the terminal font size existed carries only
 *      `ui_font_size`, so the interface shrinks to the stale value while
 *      the terminal keeps the server's 14px. That is precisely the
 *      reported symptom: tiny interface text, normal terminal, and a
 *      config file that still says 14,14.
 *
 * The invariant this spec pins, and the reason it must never be
 * relaxed:
 *
 *   The configured UI font size IS the size of the interface's primary
 *   text, and the interface is never rendered smaller than the terminal
 *   when both are configured to the same value. A stale browser cache
 *   may not render the interface below the server's configured size.
 *
 * Both halves of the invariant fail today. That is deliberate: this spec
 * is the reproduction, not the fix. The fix belongs to the code that
 * publishes the root font size, not to this file.
 */
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

// The configured sizes under test. Both fields must be present in the
// server config: the comparison between the interface and the terminal
// is only meaningful when both are asked for the same size.
const UI_FONT_SIZE = 14;
const TERMINAL_FONT_SIZE = 14;

// The interface's primary text is authored as 1rem over a 13px anchor, so
// the root font size is the setting itself. Asserting the root pins the
// mechanism; asserting rendered px below pins the result.

// The browser-side cache key for an ordinary (non-embedded) tab. The
// embedded desktop view uses `phi:desktop-appearance:v1:<owner>`; the
// plain key is what a browser tab, and any page the user opened before
// the desktop existed, still carries.
const LEGACY_APPEARANCE_KEY = 'phi_appearance';

let phi: PhiServer;

/**
 * Seeds a shell backend and one restored tab, so the page has both
 * interface text (the tab title, the sidebar button) and a real
 * terminal with a measurable font size.
 */
function seedShellPane(dir: string): void {
    const workspace = join(dir, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const state = join(dir, 'home', '.phi');
    const backends = join(state, 'backends');
    mkdirSync(backends, { recursive: true });
    const command = join(dir, 'fixture-bash');
    writeFileSync(
        command,
        '#!/bin/sh\nprintf "fixture ready\\r\\n"\nexec cat\n',
        {
            mode: 0o755,
        },
    );
    writeFileSync(
        join(backends, 'bash.json'),
        JSON.stringify({ id: 'bash', command }),
    );
    writeFileSync(
        join(state, 'tabs.json'),
        JSON.stringify([
            {
                id: 't1',
                coder: 'bash',
                session_id: '',
                cwd: realpathSync(workspace),
                workspace: realpathSync(workspace),
                title: 'Font probe',
            },
        ]),
    );
}

/** The settled computed font size of the first match, in CSS pixels. */
async function fontSize(page: Page, selector: string): Promise<number> {
    const locator = page.locator(selector).first();
    await expect(locator).toBeVisible();
    // A published root font size changes the computed size of every authored
    // rule, and `.btn` transitions `all`, so its font size animates for
    // 200ms after the root lands. Measure the settled value, not a frame of
    // it.
    const read = () =>
        locator.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    let settled = await read();
    for (let attempt = 0; attempt < 20; attempt++) {
        await page.waitForTimeout(50);
        const current = await read();
        if (current === settled) return settled;
        settled = current;
    }
    return settled;
}

/** The published root font size and the cached appearance, for diagnostics. */
async function appearanceState(page: Page): Promise<{
    root: string;
    cached: string;
}> {
    return page.evaluate((key) => {
        const root = getComputedStyle(document.documentElement).fontSize;
        return { root, cached: localStorage.getItem(key) || '' };
    }, LEGACY_APPEARANCE_KEY);
}

test.beforeAll(async () => {
    phi = await startPhi({
        config: {
            ui_font_size: UI_FONT_SIZE,
            terminal_font_size: TERMINAL_FONT_SIZE,
        },
        setup: seedShellPane,
    });
});

test.afterAll(async () => {
    await phi.stop();
});

test('the configured UI font size is the size of the interface text', async ({
    page,
}) => {
    await page.goto(phi.url);
    await page.locator('.tab-title').first().waitFor({ state: 'visible' });

    const { root, cached } = await appearanceState(page);
    const terminal = await fontSize(page, '.xterm');
    const tabTitle = await fontSize(page, '.tab-title');
    const newSession = await fontSize(page, '#new-session-btn');

    // The interface's rem text reads its size from the root font size, so
    // the root must BE the configured size. A smaller root shrinks the whole
    // interface without the config ever changing, which is how this stayed
    // invisible.
    expect(
        Number.parseFloat(root),
        `the root font size must follow ui_font_size=${UI_FONT_SIZE}; ` +
            `cached appearance=${cached}`,
    ).toBe(UI_FONT_SIZE);

    // The terminal honours its configured size exactly.
    expect(
        terminal,
        `terminal_font_size=${TERMINAL_FONT_SIZE} must render exactly ` +
            `${TERMINAL_FONT_SIZE}px`,
    ).toBe(TERMINAL_FONT_SIZE);

    // The interface must honour its configured size exactly too. Today
    // the authored pixel sizes win (13px) and the configured number is
    // only a multiplier, so the interface renders below the setting.
    expect(
        tabTitle,
        `ui_font_size=${UI_FONT_SIZE} must render the interface tab title ` +
            `at ${UI_FONT_SIZE}px; root=${root} cached=${cached}`,
    ).toBe(UI_FONT_SIZE);
    expect(
        newSession,
        `ui_font_size=${UI_FONT_SIZE} must render the interface button at ` +
            `${UI_FONT_SIZE}px; root=${root} cached=${cached}`,
    ).toBe(UI_FONT_SIZE);
});

test('the interface is never rendered smaller than the terminal', async ({
    page,
}) => {
    await page.goto(phi.url);
    await page.locator('.tab-title').first().waitFor({ state: 'visible' });

    const { root, cached } = await appearanceState(page);
    const terminal = await fontSize(page, '.xterm');
    const tabTitle = await fontSize(page, '.tab-title');

    // Same configured size on both sides, so the interface must not read
    // smaller than the terminal. This is the "terminal is larger than UI
    // by a LOT" half of the report.
    expect(
        tabTitle,
        `the interface text must not render smaller than the terminal ` +
            `(${tabTitle}px vs ${terminal}px); root=${root} cached=${cached}`,
    ).toBeGreaterThanOrEqual(terminal);
});

test('the interface text fits its containers at the largest UI size', async ({
    page,
}) => {
    // A failed save must not undo the local preview or pollute the shared
    // server's settings for other tests.
    await page.route('**/api/config/appearance', (route) =>
        route.fulfill({ status: 503, body: 'Unavailable' }),
    );
    await page.goto(phi.url);
    await page.locator('.tab-title').first().waitFor({ state: 'visible' });
    await page.locator('#header-config-pill .pill-label').click();
    const input = page.locator('#settings-ui-font-size');
    await expect(input).toBeVisible();
    await Promise.all([
        page.waitForResponse(
            (response) =>
                response.url().endsWith('/api/config/appearance') &&
                response.status() === 503,
        ),
        input.fill('24'),
    ]);
    await expect
        .poll(() =>
            page.evaluate(
                () => getComputedStyle(document.documentElement).fontSize,
            ),
        )
        .toBe('24px');
    await page.locator('.settings-overlay .modal-close-btn').click();
    await expect(page.locator('.settings-overlay')).toHaveCount(0);
    await expect.poll(() => fontSize(page, '.tab-title')).toBe(24);

    // The containers that hold scaled text must grow with it: a fixed
    // header crops the brand and the action buttons, a fixed tab bar crops
    // the tab titles.
    const fit = await page.evaluate(() => {
        const box = (selector: string) => {
            const el = document.querySelector(selector);
            if (!el) throw new Error(`missing ${selector}`);
            return el.getBoundingClientRect();
        };
        const header = box('.app-header');
        const brand = box('.brand');
        const actions = box('.header-actions');
        const bar = box('.terminal-tabs-bar');
        const tab = box('.tab');
        const select = document.querySelector('#workspace-select');
        if (!(select instanceof HTMLSelectElement))
            throw new Error('missing workspace select');
        const style = getComputedStyle(select);
        const measure = document.createElement('span');
        measure.style.cssText =
            'position:fixed;visibility:hidden;white-space:pre';
        measure.style.font = style.font;
        measure.style.letterSpacing = style.letterSpacing;
        measure.textContent = select.selectedOptions[0].text;
        document.body.appendChild(measure);
        const textWidth = measure.getBoundingClientRect().width;
        measure.remove();
        const fits = (parent: DOMRect, child: DOMRect) =>
            child.top >= parent.top - 1 && child.bottom <= parent.bottom + 1;
        return {
            headerFitsBrand: fits(header, brand),
            headerFitsActions: fits(header, actions),
            barFitsTab: fits(bar, tab),
            workspaceFitsLabel:
                select.clientWidth -
                    parseFloat(style.paddingLeft) -
                    parseFloat(style.paddingRight) >=
                textWidth,
            geometry: {
                header: `${header.top}-${header.bottom}`,
                brand: `${brand.top}-${brand.bottom}`,
                actions: `${actions.top}-${actions.bottom}`,
                bar: `${bar.top}-${bar.bottom}`,
                tab: `${tab.top}-${tab.bottom}`,
            },
        };
    });
    expect(
        fit,
        `the interface must not crop its own text at 24px: ${JSON.stringify(fit)}`,
    ).toMatchObject({
        headerFitsBrand: true,
        headerFitsActions: true,
        barFitsTab: true,
        workspaceFitsLabel: true,
    });

    // All diff tabs must remain reachable without displacing panel actions.
    const lastDiffTab = page.locator('.diff-tab-btn').last();
    await lastDiffTab.focus();
    expect(
        await lastDiffTab.evaluate((el) => {
            const strip = el.closest('.diff-tabs');
            const header = el.closest('.diff-header');
            if (!strip || !header) throw new Error('missing diff tab strip');
            const tab = el.getBoundingClientRect();
            const bounds = strip.getBoundingClientRect();
            return (
                tab.left >= bounds.left - 1 &&
                tab.right <= bounds.right + 1 &&
                header.scrollWidth <= header.clientWidth + 1
            );
        }),
    ).toBe(true);

    // Compact layout does not imply the mobile appearance profile.
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
        await page.locator('.app-header').evaluate((el) => {
            const header = el.getBoundingClientRect();
            const brand = el.querySelector('.brand')?.getBoundingClientRect();
            return (
                !!brand &&
                brand.top >= header.top - 1 &&
                brand.bottom <= header.bottom + 1
            );
        }),
    ).toBe(true);
});

test('a stale browser appearance cache cannot shrink the interface below the configured size', async ({
    page,
}) => {
    // A cache left behind by an older build: it carries the UI size only,
    // because the terminal font size did not exist yet. It must not
    // shrink the interface below the server's configured size while the
    // terminal keeps the configured 14px.
    await page.addInitScript(
        ([key, size]) => {
            window.localStorage.setItem(
                key,
                JSON.stringify({ ui_font_size: size, ui_font_family: '' }),
            );
        },
        [LEGACY_APPEARANCE_KEY, 10] as const,
    );
    await page.goto(phi.url);
    await page.locator('.tab-title').first().waitFor({ state: 'visible' });

    const { root, cached } = await appearanceState(page);
    const terminal = await fontSize(page, '.xterm');
    const tabTitle = await fontSize(page, '.tab-title');

    expect(
        Number.parseFloat(root),
        `a stale browser cache must not shrink the root font size below the ` +
            `configured ${UI_FONT_SIZE}px; cached=${cached}`,
    ).toBe(UI_FONT_SIZE);
    expect(
        tabTitle,
        `a stale browser cache must not render the interface below the ` +
            `configured ${UI_FONT_SIZE}px (rendered ${tabTitle}px); ` +
            `cached=${cached}`,
    ).toBe(UI_FONT_SIZE);
    expect(
        terminal,
        `the terminal must stay at the configured ${TERMINAL_FONT_SIZE}px ` +
            `even when a stale cache is present`,
    ).toBe(TERMINAL_FONT_SIZE);
});
