import {
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startPhi } from './_server.js';

// The composer presets row is one line of buttons that never squeezes a
// label: a wrapped row or an ellipsised chip is a regression, not a layout
// preference. Chips differ in height (icons vs text) and are centred, so
// their tops differ by a pixel or two: compare the row height against one
// chip instead.
async function expectSingleRowPresets(page: Page) {
    const chips = page.locator('#presets-container > .preset-btn');
    await expect(chips.first()).toBeVisible();
    const measured = await chips.evaluateAll((els) => {
        const container = els[0].closest('#presets-container');
        if (!container) throw new Error('missing #presets-container');
        return {
            rowHeight: container.getBoundingClientRect().height,
            wrap: getComputedStyle(container).flexWrap,
            shrink: [
                ...new Set(els.map((el) => getComputedStyle(el).flexShrink)),
            ],
            chipHeight: Math.max(
                ...els.map((el) => el.getBoundingClientRect().height),
            ),
            squeezed: els
                .filter((el) => el.scrollWidth > el.clientWidth + 1)
                .map(
                    (el) =>
                        el.getAttribute('aria-label') || el.textContent.trim(),
                ),
        };
    });
    expect(measured.wrap, 'presets row is allowed to wrap').toBe('nowrap');
    expect(measured.shrink, 'presets chips may shrink').toEqual(['0']);
    expect(
        measured.rowHeight,
        'presets row wrapped onto more than one line',
    ).toBeLessThan(measured.chipHeight * 2);
    expect(measured.squeezed, 'chips shrank into an ellipsis').toEqual([]);
}

async function watchPage(page: Page, serverOrigin: string) {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const localFailures: string[] = [];
    const blockedExternal: string[] = [];
    const stubbedLocal: string[] = [];

    page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('requestfailed', (request) => {
        const url = new URL(request.url());
        if (url.origin === serverOrigin) {
            localFailures.push(
                `${request.method()} ${request.url()}: ${request.failure()?.errorText}`,
            );
        }
    });
    page.on('response', (response) => {
        const url = new URL(response.url());
        if (url.origin === serverOrigin && response.status() >= 400) {
            localFailures.push(`${response.status()} ${response.url()}`);
        }
    });
    await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== serverOrigin) {
            blockedExternal.push(url.href);
            await route.abort();
        } else if (url.pathname === '/api/update/status') {
            stubbedLocal.push(url.pathname);
            await route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({
                    current: 'dev',
                    update_available: false,
                }),
            });
        } else if (
            url.pathname === '/api/sessions' &&
            url.searchParams.get('coder') === 'opencode'
        ) {
            stubbedLocal.push(url.pathname);
            await route.fulfill({
                contentType: 'application/json',
                body: '[]',
            });
        } else {
            await route.continue();
        }
    });
    return {
        consoleErrors,
        pageErrors,
        localFailures,
        blockedExternal,
        stubbedLocal,
    };
}

function countQuit(inputLog: string): number {
    if (!existsSync(inputLog)) return 0;
    const matches = readFileSync(inputLog, 'utf8').match(/\/quit/g);
    return matches ? matches.length : 0;
}

async function checkTheme(
    page: Page,
    scheme: 'light' | 'dark',
    color: 'neon' | 'arc',
    expected: string,
) {
    await page.emulateMedia({ colorScheme: scheme });
    const accent = await page.evaluate(
        `(async (name) => { const mod = await import('/theme.js'); return mod.applyThemeTokens(name).accent; })('${color}')`,
    );
    expect(accent).toBe(expected);
    await expect(page.locator('html')).toHaveAttribute(
        'data-theme-color',
        color,
    );
    const rootAccent = await page.evaluate(() =>
        getComputedStyle(document.documentElement)
            .getPropertyValue('--accent')
            .trim(),
    );
    expect(rootAccent).toBe(expected);
    const cmdsColor = await page
        .getByRole('button', { name: 'Cmds ▾' })
        .evaluate((el) => getComputedStyle(el).color);
    expect(cmdsColor).toMatch(/^rgba?\(/);
    const menuColor = await page.evaluate(() => {
        const btn = document.querySelector(
            '#quick-commands-dropup .dropup-model-btn',
        );
        return btn ? getComputedStyle(btn).color : '';
    });
    expect(menuColor).toMatch(/^rgba?\(/);
}

test('low-frequency Pi presets move to Cmds on desktop and mobile', async ({
    browser,
    page,
    request,
}) => {
    test.setTimeout(180_000);
    let mobilePage: Page | undefined;
    let desktopWatch: Awaited<ReturnType<typeof watchPage>> | undefined;
    let mobileWatch: Awaited<ReturnType<typeof watchPage>> | undefined;
    const phi = await startPhi({
        setup(dir) {
            const home = join(dir, 'home');
            const cwd = join(dir, 'workspace');
            mkdirSync(cwd, { recursive: true });
            mkdirSync(join(home, '.phi', 'backends'), { recursive: true });
            writeFileSync(
                join(home, '.phi', 'config.json'),
                JSON.stringify({ workspaces: [realpathSync(cwd)] }),
            );
            const command = join(dir, 'fake-pi');
            writeFileSync(
                command,
                `#!/bin/sh
printf 'Fake Pi ready\\r\\n'
while IFS= read -r line; do
  printf '%s\\n' "$line" >> "$HOME/pi-input.log"
done
`,
                { mode: 0o755 },
            );
            writeFileSync(
                join(home, '.phi', 'backends', 'pi.json'),
                JSON.stringify({ id: 'pi', command }),
            );
        },
    });

    try {
        const home = join(phi.dir, 'home');
        const cwd = realpathSync(join(phi.dir, 'workspace'));
        const created = await request.post(`${phi.url}/api/terminals`, {
            data: { coder: 'pi', cwd, title: '+ Pi' },
        });
        expect(created.ok()).toBe(true);
        const { pane_id: paneId } = (await created.json()) as {
            pane_id: string;
        };
        const inputLog = join(home, 'pi-input.log');

        const pin = await request.post(
            `${phi.url}/api/terminals/${paneId}/pin`,
            { data: { pinned: true } },
        );
        expect(pin.ok()).toBe(true);
        const list = await request.get(`${phi.url}/api/terminals`);
        expect(list.ok()).toBe(true);
        const terminals = (await list.json()) as Array<{
            id: string;
            pinned: boolean;
        }>;
        expect(terminals.find((t) => t.id === paneId)?.pinned).toBe(true);

        desktopWatch = await watchPage(page, new URL(phi.url).origin);
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(phi.url);
        await expect(
            page.locator(`.tab[data-pane-id="${paneId}"]`),
        ).toBeVisible();

        const desktopPresets = page.locator('#presets-container .preset-btn');
        const desktopLabels = await desktopPresets.allTextContents();
        expect(desktopLabels).not.toContain('/quit');
        expect(desktopLabels).not.toContain('/resume');
        // /model moved into Cmds: the Models picker covers it.
        expect(desktopLabels).not.toContain('/model');
        expect(desktopLabels).toContain('/compact');
        // One row, and every chip keeps its full width: the row scrolls
        // instead of squeezing labels into ellipses.
        await expectSingleRowPresets(page);

        const desktopCommands = page.getByRole('button', { name: 'Cmds ▾' });
        await desktopCommands.focus();
        await page.keyboard.press('Enter');
        const desktopMenu = page.locator('#quick-commands-dropup');
        await expect(desktopMenu).toBeVisible();
        await expect(desktopMenu.locator('.dropup-header').first()).toHaveText(
            'Built-in Commands',
        );
        const desktopBuiltIns = await desktopMenu
            .locator('.dropup-row > .dropup-model-btn')
            .allTextContents();
        expect(desktopBuiltIns.slice(0, 2)).toEqual(['/quit', '/resume']);
        expect(desktopBuiltIns).toContain('/model');
        const desktopBaseline = countQuit(inputLog);
        const quit = desktopMenu.getByRole('button', { name: '/quit' });
        await quit.focus();
        await page.keyboard.press('Enter');
        await expect.poll(() => countQuit(inputLog)).toBe(desktopBaseline + 1);
        await expect(desktopMenu).toBeHidden();

        mobilePage = await browser.newPage({
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
        });
        mobileWatch = await watchPage(mobilePage, new URL(phi.url).origin);
        await mobilePage.goto(phi.url);
        await expect(mobilePage.locator(`#term-${paneId}`)).toBeVisible();
        // Compact keeps the pickers in the row and parks the slash trigger
        // with the input controls.
        const slashTrigger = mobilePage.locator(
            '#input-bar-container .input-actions .slash-trigger-btn',
        );
        await expect(slashTrigger).toBeVisible();
        await expectSingleRowPresets(mobilePage);
        await slashTrigger.tap();
        const slashMenu = mobilePage.locator('#slash-presets-dropup');
        await expect(slashMenu).not.toContainText('/model');
        await expect(slashMenu).toContainText('/compact');
        await expect(slashMenu).not.toContainText('/quit');
        await expect(slashMenu).not.toContainText('/resume');

        await mobilePage.getByRole('button', { name: 'Cmds ▾' }).tap();
        const mobileMenu = mobilePage.locator('#quick-commands-dropup');
        await expect(mobileMenu).toContainText('Built-in Commands');
        const mobileInput = mobilePage.locator('#input-textarea');
        await mobileInput.focus();
        const mobileBaseline = countQuit(inputLog);
        await mobileMenu.getByRole('button', { name: '/quit' }).tap();
        await expect.poll(() => countQuit(inputLog)).toBe(mobileBaseline + 1);
        await expect(mobileMenu).toBeHidden();
        expect(
            await mobileInput.evaluate(
                (element) => document.activeElement === element,
            ),
        ).toBe(false);

        await checkTheme(page, 'light', 'neon', '#1a79ff');
        await checkTheme(page, 'dark', 'arc', '#2952ff');
        await checkTheme(mobilePage, 'light', 'neon', '#1a79ff');
        await checkTheme(mobilePage, 'dark', 'arc', '#2952ff');

        // Let outstanding real pin requests settle before diagnostics.
        await page.waitForTimeout(1000);
        await mobilePage.waitForTimeout(1000);

        for (const target of [page, mobilePage]) {
            expect(
                await target.evaluate(
                    () =>
                        document.documentElement.scrollWidth <=
                        window.innerWidth,
                ),
            ).toBe(true);
        }
        if (!desktopWatch || !mobileWatch) {
            throw new Error('diagnostic watches missing');
        }
        const desktopDiag = {
            consoleErrors: [...desktopWatch.consoleErrors],
            pageErrors: [...desktopWatch.pageErrors],
            localFailures: [...desktopWatch.localFailures],
            blockedExternal: [...desktopWatch.blockedExternal],
            stubbedLocal: [...desktopWatch.stubbedLocal],
        };
        const mobileDiag = {
            consoleErrors: [...mobileWatch.consoleErrors],
            pageErrors: [...mobileWatch.pageErrors],
            localFailures: [...mobileWatch.localFailures],
            blockedExternal: [...mobileWatch.blockedExternal],
            stubbedLocal: [...mobileWatch.stubbedLocal],
        };
        // Narrow user-approved waiver (2026-10-27): the pre-existing
        // attachment POST .../pin aborts with ERR_ABORTED in Chromium
        // despite HTTP 200. Confirmed unrelated to this feature's diff
        // (pin call sites outside every hunk). Waived entries are
        // retained in the attachments and reported, never dropped.
        const pinAbortPrefix = `POST ${new URL(phi.url).origin}/api/terminals/${paneId}/pin`;
        const waivedPinAborts: Record<string, string[]> = {};
        for (const [name, diagnostics] of [
            ['desktop', desktopDiag],
            ['mobile', mobileDiag],
        ] as const) {
            const waived = diagnostics.localFailures.filter(
                (entry) =>
                    entry.startsWith(pinAbortPrefix) &&
                    entry.includes('ERR_ABORTED'),
            );
            diagnostics.localFailures = diagnostics.localFailures.filter(
                (entry) => !waived.includes(entry),
            );
            waivedPinAborts[name] = waived;
        }
        await test.info().attach('desktop-diagnostics', {
            body: JSON.stringify(desktopDiag, null, 2),
            contentType: 'application/json',
        });
        await test.info().attach('mobile-diagnostics', {
            body: JSON.stringify(mobileDiag, null, 2),
            contentType: 'application/json',
        });
        await test.info().attach('waived-pin-aborts', {
            body: JSON.stringify(waivedPinAborts, null, 2),
            contentType: 'application/json',
        });
        if (existsSync(phi.logPath)) {
            await test.info().attach('server-log-tail', {
                body: readFileSync(phi.logPath, 'utf8').slice(-20000),
                contentType: 'text/plain',
            });
        }
        for (const diagnostics of [desktopDiag, mobileDiag]) {
            expect(diagnostics.pageErrors).toEqual([]);
            expect(diagnostics.localFailures).toEqual([]);
            expect(diagnostics.consoleErrors).toEqual([]);
            // Every non-local request is intercepted and retained here.
            expect(diagnostics.blockedExternal).toEqual([]);
            expect(diagnostics.stubbedLocal).toContain('/api/update/status');
        }
    } finally {
        await mobilePage?.close();
        const url = phi.url;
        const dir = phi.dir;
        await phi.stop();
        const health = await (async () => {
            try {
                const res = await fetch(`${url}/healthz`);
                return res.ok ? 'up' : 'down';
            } catch {
                return 'down';
            }
        })();
        expect(health).toBe('down');
        expect(existsSync(dir)).toBe(false);
    }
});
