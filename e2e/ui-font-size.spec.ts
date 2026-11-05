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
 * publishes the appearance scale, not to this file.
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

/** The computed font size of the first match, in CSS pixels. */
async function fontSize(page: Page, selector: string): Promise<number> {
    const locator = page.locator(selector).first();
    await expect(locator).toBeVisible();
    return locator.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
}

/** The published appearance scale and the cached appearance, for diagnostics. */
async function appearanceState(page: Page): Promise<{
    scale: string;
    cached: string;
}> {
    return page.evaluate((key) => {
        const scale = getComputedStyle(document.documentElement)
            .getPropertyValue('--ui-scale')
            .trim();
        return { scale, cached: localStorage.getItem(key) || '' };
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

    const { scale, cached } = await appearanceState(page);
    const terminal = await fontSize(page, '.xterm');
    const tabTitle = await fontSize(page, '.tab-title');
    const newSession = await fontSize(page, '#new-session-btn');

    // The scale the appearance code publishes must track the configured
    // size. A scale below 1 shrinks the whole interface without the
    // config ever changing, which is how this stayed invisible.
    expect(
        scale,
        `the published UI scale must follow ui_font_size=${UI_FONT_SIZE}; ` +
            `cached appearance=${cached}`,
    ).toBe('1');

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
            `at ${UI_FONT_SIZE}px; scale=${scale} cached=${cached}`,
    ).toBe(UI_FONT_SIZE);
    expect(
        newSession,
        `ui_font_size=${UI_FONT_SIZE} must render the interface button at ` +
            `${UI_FONT_SIZE}px; scale=${scale} cached=${cached}`,
    ).toBe(UI_FONT_SIZE);
});

test('the interface is never rendered smaller than the terminal', async ({
    page,
}) => {
    await page.goto(phi.url);
    await page.locator('.tab-title').first().waitFor({ state: 'visible' });

    const { scale, cached } = await appearanceState(page);
    const terminal = await fontSize(page, '.xterm');
    const tabTitle = await fontSize(page, '.tab-title');

    // Same configured size on both sides, so the interface must not read
    // smaller than the terminal. This is the "terminal is larger than UI
    // by a LOT" half of the report.
    expect(
        tabTitle,
        `the interface text must not render smaller than the terminal ` +
            `(${tabTitle}px vs ${terminal}px); scale=${scale} cached=${cached}`,
    ).toBeGreaterThanOrEqual(terminal);
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

    const { scale, cached } = await appearanceState(page);
    const terminal = await fontSize(page, '.xterm');
    const tabTitle = await fontSize(page, '.tab-title');

    expect(
        scale,
        `a stale browser cache must not publish a UI scale below 1; ` +
            `cached=${cached}`,
    ).toBe('1');
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
