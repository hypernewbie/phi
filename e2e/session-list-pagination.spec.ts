import {
    mkdirSync,
    readFileSync,
    realpathSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
    expect,
    test,
    type APIRequestContext,
    type Page,
} from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

// The sidebar must scan and render sessions in pages: the server reads titles
// only for the requested window, and the arrows move between pages. The
// per-page title-read count is observable because extractPiSessionTitle logs
// one warning per file whose body contains an undecodable record.
const SESSION_COUNT = 23;
const WARNING_MARKER = 'Pi title extraction warning in';

function piProjectDirectory(home: string, cwd: string): string {
    const normalized = realpathSync(cwd).replaceAll('\\', '/');
    const encoded = normalized
        .replace(/^\/+|\/+$/g, '')
        .replace(/:/g, '-')
        .replace(/\//g, '-');
    return join(home, '.pi', 'agent', 'sessions', `--${encoded}--`);
}

function writeSessions(home: string, cwd: string): void {
    const directory = piProjectDirectory(home, cwd);
    mkdirSync(directory, { recursive: true });
    const base = Date.UTC(2026, 9, 1, 12, 0, 0);
    for (let i = 0; i < SESSION_COUNT; i++) {
        const id = `page-${String(i).padStart(2, '0')}`;
        // Valid header (the only part validation reads), an undecodable
        // record that makes the title reader log once, then the real title.
        const body = [
            JSON.stringify({ type: 'session', version: 3, id, cwd }),
            'not-json',
            JSON.stringify({
                type: 'session_info',
                name: `Page session ${String(i).padStart(2, '0')}`,
            }),
        ].join('\n');
        const name = `f-${String(SESSION_COUNT - 1 - i).padStart(2, '0')}.jsonl`;
        const path = join(directory, name);
        writeFileSync(path, `${body}\n`);
        const mtime = new Date(base - i * 60_000);
        utimesSync(path, mtime, mtime);
    }
}

function warningCount(logPath: string): number {
    const log = readFileSync(logPath, 'utf8');
    return log.split(WARNING_MARKER).length - 1;
}

function sessionRequestOffset(request: { url(): string }): number | null {
    const url = new URL(request.url());
    if (url.pathname !== '/api/sessions') return null;
    if (url.searchParams.get('coder') !== 'pi') return null;
    return Number(url.searchParams.get('offset'));
}

async function startFixture(
    pageSize?: number,
): Promise<{ phi: PhiServer; cwd: string }> {
    let fixtureCwd = '';
    const phi = await startPhi({
        setup(dir) {
            fixtureCwd = realpathSync(dir);
            const home = join(dir, 'home');
            mkdirSync(join(home, '.phi'), { recursive: true });
            writeFileSync(
                join(home, '.phi', 'config.json'),
                JSON.stringify({
                    workspaces: [fixtureCwd],
                    active_cwd: fixtureCwd,
                    ...(pageSize === undefined
                        ? {}
                        : { session_list_page_size: pageSize }),
                }),
            );
            const agent = join(home, '.pi', 'agent');
            mkdirSync(agent, { recursive: true });
            writeFileSync(
                join(agent, 'settings.json'),
                JSON.stringify({
                    defaultProjectTrust: 'never',
                    quietStartup: true,
                    enableInstallTelemetry: false,
                    cacheWarming: 'off',
                }),
            );
            writeSessions(home, fixtureCwd);
        },
    });
    return { phi, cwd: fixtureCwd };
}

// Runtime guard: the 23 fixture sessions produce 23 title-read warnings when
// the unpaginated endpoint parses everything, which is the baseline for the
// per-page deltas.
async function establishBaseline(
    request: APIRequestContext,
    page: Page,
    phi: PhiServer,
    cwd: string,
    expectedSize: number,
): Promise<{ baseline: number; requestOffsets: number[] }> {
    const configResponse = await request.get(`${phi.url}/api/config`);
    expect(configResponse.status()).toBe(200);
    const config = (await configResponse.json()) as {
        session_list_page_size?: number;
    };
    expect(config.session_list_page_size).toBe(expectedSize);

    const encoded = encodeURIComponent(cwd);
    const all = await request.get(
        `${phi.url}/api/sessions?coder=pi&cwd=${encoded}`,
    );
    expect(all.status()).toBe(200);
    expect(await all.json()).toHaveLength(SESSION_COUNT);

    await expect
        .poll(() => warningCount(phi.logPath))
        .toBeGreaterThanOrEqual(SESSION_COUNT);
    const baseline = warningCount(phi.logPath);

    const requestOffsets: number[] = [];
    page.on('request', (req) => {
        const offset = sessionRequestOffset(req);
        if (offset !== null) requestOffsets.push(offset);
    });
    return { baseline, requestOffsets };
}

async function assertPagedSidebar(
    page: Page,
    phi: PhiServer,
    cwd: string,
    size: number,
    baseline: number,
    requestOffsets: number[],
    keyboard = false,
): Promise<void> {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(phi.url);
    await page.locator('#coder-selector .coder-tab[data-coder="pi"]').click();

    const section = page.locator(
        `.worktree-section[data-worktree-path="${cwd}"]`,
    );
    await expect(section).toBeVisible({ timeout: 30_000 });
    const rows = section.locator('.session-item');
    const prev = section.locator('.session-page[data-page="-1"]');
    const next = section.locator('.session-page[data-page="1"]');
    const label = section.locator('.session-page-label');

    const firstPage = Math.min(size, SESSION_COUNT);
    await expect(rows).toHaveCount(firstPage, { timeout: 30_000 });
    await expect(label).toHaveText('Page 1');
    await expect(prev).toBeDisabled();
    await expect(next).toBeEnabled();
    await expect
        .poll(() => warningCount(phi.logPath))
        .toBe(baseline + firstPage);
    await expect(rows.first()).toContainText('Page session 00');
    expect(requestOffsets).toContain(0);

    let pageNo = 1;
    let offset = 0;
    while (offset + size < SESSION_COUNT) {
        if (keyboard && pageNo === 1) {
            await next.focus();
            await page.keyboard.press('Enter');
        } else {
            await next.click();
        }
        pageNo += 1;
        offset += size;
        await expect(label).toHaveText(`Page ${pageNo}`, { timeout: 30_000 });
        await expect(rows).toHaveCount(Math.min(size, SESSION_COUNT - offset));
        await expect(prev).toBeEnabled();
        await expect
            .poll(() => warningCount(phi.logPath))
            .toBe(baseline + Math.min(SESSION_COUNT, offset + size));
        await expect(rows.first()).toContainText(
            `Page session ${String(offset).padStart(2, '0')}`,
        );
        expect(requestOffsets).toContain(offset);
        if (keyboard && pageNo === 2) {
            await expect(next).toBeFocused();
        }
    }

    await expect(next).toBeDisabled();
    await expect
        .poll(() => warningCount(phi.logPath))
        .toBe(baseline + SESSION_COUNT);

    // Stepping back paints the cached page first, then revalidates it while
    // keeping the rows on screen; page 1 refreshes too.
    let expectedWarnings = baseline + SESSION_COUNT;
    while (pageNo > 1) {
        await prev.click();
        pageNo -= 1;
        offset -= size;
        await expect(label).toHaveText(`Page ${pageNo}`, { timeout: 30_000 });
        expectedWarnings += Math.min(size, SESSION_COUNT - offset);
        await expect
            .poll(() => warningCount(phi.logPath))
            .toBe(expectedWarnings);
        // The revalidated response replaced the cached paint with the same
        // page; the rows must still be the ones for this offset.
        await expect(rows).toHaveCount(Math.min(size, SESSION_COUNT - offset));
        await expect(rows.first()).toContainText(
            `Page session ${String(offset).padStart(2, '0')}`,
        );
        expect(requestOffsets).toContain(offset);
    }
    await expect(label).toHaveText('Page 1');
    await expect(rows).toHaveCount(firstPage);
    await expect(rows.first()).toContainText('Page session 00');
    expect(pageErrors).toEqual([]);
}

test('sidebar pages Pi sessions 10 at a time and bounds title reads', async ({
    page,
    request,
}) => {
    test.setTimeout(240_000);
    const { phi, cwd } = await startFixture();
    try {
        const { baseline, requestOffsets } = await establishBaseline(
            request,
            page,
            phi,
            cwd,
            10,
        );
        await assertPagedSidebar(
            page,
            phi,
            cwd,
            10,
            baseline,
            requestOffsets,
            true,
        );
    } finally {
        await phi.stop();
    }
});

test('sidebar honours a configured page size of 7', async ({
    page,
    request,
}) => {
    test.setTimeout(240_000);
    const { phi, cwd } = await startFixture(7);
    try {
        const { baseline, requestOffsets } = await establishBaseline(
            request,
            page,
            phi,
            cwd,
            7,
        );
        await assertPagedSidebar(page, phi, cwd, 7, baseline, requestOffsets);
    } finally {
        await phi.stop();
    }
});

test.describe('mobile', () => {
    test.use({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
    });

    test('sidebar pages by tap without horizontal overflow', async ({
        page,
        request,
    }) => {
        test.setTimeout(240_000);
        const { phi, cwd } = await startFixture();
        try {
            const { baseline, requestOffsets } = await establishBaseline(
                request,
                page,
                phi,
                cwd,
                10,
            );
            const pageErrors: string[] = [];
            page.on('pageerror', (error) => pageErrors.push(error.message));

            await page.goto(phi.url);
            const sidebarToggle = page.locator('#mobile-sidebar-toggle');
            if (await sidebarToggle.isVisible()) {
                await sidebarToggle.tap();
            }
            await page
                .locator('#coder-selector .coder-tab[data-coder="pi"]')
                .tap();

            const section = page.locator(
                `.worktree-section[data-worktree-path="${cwd}"]`,
            );
            await expect(section).toBeVisible({ timeout: 30_000 });
            const rows = section.locator('.session-item');
            await expect(rows).toHaveCount(10, { timeout: 30_000 });

            const next = section.locator('.session-page[data-page="1"]');
            await next.tap();
            await expect(section.locator('.session-page-label')).toHaveText(
                'Page 2',
                { timeout: 30_000 },
            );
            await expect(rows).toHaveCount(10, { timeout: 30_000 });
            await expect(rows.first()).toContainText('Page session 10');
            await expect
                .poll(() => warningCount(phi.logPath))
                .toBe(baseline + 20);
            expect(requestOffsets).toContain(10);

            const overflow = await page.evaluate(() => ({
                inner: window.innerWidth,
                scroll: document.documentElement.scrollWidth,
            }));
            expect(overflow.scroll).toBeLessThanOrEqual(overflow.inner);
            expect(pageErrors).toEqual([]);
        } finally {
            await phi.stop();
        }
    });
});
