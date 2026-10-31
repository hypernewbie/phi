import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    expect,
    test,
    type BrowserContext,
    type Locator,
    type Page,
} from '@playwright/test';
import { configToToml, startPhi } from './_server.js';

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const timestamp = '2026-10-03T00:00:00.000Z';
const rowCount = 220;

function writePiSession(home: string, cwd: string, sessionId: string) {
    const encoded = realpathSync(cwd)
        .replaceAll('\\', '/')
        .replace(/^\/+|\/+$/g, '')
        .replace(/:/g, '-')
        .replace(/\//g, '-');
    const directory = join(home, '.pi', 'agent', 'sessions', `--${encoded}--`);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${sessionId}.jsonl`);
    const entries: Record<string, unknown>[] = [
        { type: 'session', version: 3, id: sessionId, timestamp, cwd },
        { type: 'session_info', name: `Search ${sessionId}` },
    ];
    for (let index = 0; index < rowCount; index++) {
        const marker =
            index === 7
                ? `${sessionId.toUpperCase()}-NEEDLE-007`
                : `${sessionId.toUpperCase()}-ROW-${String(index).padStart(3, '0')}`;
        entries.push({
            type: 'message',
            id: `${sessionId}-message-${index}`,
            parentId: index ? `${sessionId}-message-${index - 1}` : null,
            timestamp,
            message: {
                role: 'user',
                content: `${marker} deterministic transcript row ${index}`,
                timestamp: Date.parse(timestamp) + index,
            },
        });
    }
    writeFileSync(
        path,
        entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    );
    return path;
}

function monitorPage(page: Page, baseUrl: string) {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    let offlinePhase = false;
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const url = new URL(message.location().url || baseUrl);
        // The isolated home has no update checker or OpenCode installation.
        // Keep these two unrelated startup errors explicit; fail on all others.
        if (
            (url.pathname === '/api/update/status' &&
                message.text().includes('503')) ||
            (url.pathname === '/api/sessions' &&
                url.searchParams.get('coder') === 'opencode' &&
                message.text().includes('500'))
        )
            return;
        // Offline search can overlap this unrelated local background poll.
        if (
            offlinePhase &&
            url.pathname === '/api/system/cpu' &&
            message.text() ===
                'Failed to load resource: net::ERR_INTERNET_DISCONNECTED'
        )
            return;
        consoleErrors.push(message.text());
    });
    page.on('requestfailed', (request) => {
        if (request.resourceType() === 'websocket') return;
        const url = new URL(request.url());
        const error = request.failure()?.errorText ?? 'failed';
        // A newer worktree refresh may cancel this unrelated background GET.
        if (
            request.method() === 'GET' &&
            url.pathname === '/api/git/worktrees' &&
            error === 'net::ERR_ABORTED'
        )
            return;
        if (
            offlinePhase &&
            url.pathname === '/api/system/cpu' &&
            error === 'net::ERR_INTERNET_DISCONNECTED'
        )
            return;
        failedRequests.push(`${request.method()} ${request.url()}: ${error}`);
    });
    return {
        pageErrors,
        consoleErrors,
        failedRequests,
        setOfflinePhase(offline: boolean) {
            offlinePhase = offline;
        },
    };
}

async function openPiSession(
    page: Page,
    sessionId: string,
    path: string,
    touch = false,
) {
    if (touch) {
        await page.locator('#mobile-sidebar-toggle').tap();
        await expect(page.locator('#sidebar-panel')).toHaveClass(/drawer-open/);
        await page.locator('#drawer-open-sessions').tap();
        await page.locator('#coder-selector .coder-tab[data-coder="pi"]').tap();
    } else {
        await page
            .locator('#coder-selector .coder-tab[data-coder="pi"]')
            .click();
    }
    const row = page.locator(`.session-item[data-session-id="${sessionId}"]`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.hover();
    await row.locator('.review-btn').click();
    const paneId = `pi-rpc:session:${encodeURIComponent(path)}`;
    const tab = page.locator(`.tab[data-pane-id="${paneId}"]`);
    if (!touch) {
        await expect(tab).toBeVisible({ timeout: 30_000 });
        await tab.click();
    }
    const transcript = page.locator('.review-chat-wrapper').last();
    await expect(
        page.locator('.review-header-bar .review-header-coder').last(),
    ).toHaveText('Ready', { timeout: 30_000 });
    await expect
        .poll(async () => transcript.locator('[data-pi-message-index]').count())
        .toBeGreaterThan(0);
    await expect(transcript).toContainText(
        `${sessionId.toUpperCase()}-ROW-219`,
        { timeout: 30_000 },
    );
    return { paneId, tab, transcript };
}

async function searchOffline(
    page: Page,
    transcript: Locator,
    sessionId: string,
    query: string,
    setOfflinePhase: (offline: boolean) => void,
) {
    const target = `${sessionId.toUpperCase()}-NEEDLE-007`;
    await expect(transcript.locator('[data-pi-message-index="7"]')).toHaveCount(
        0,
    );
    setOfflinePhase(true);
    await page.context().setOffline(true);
    await page.locator('#input-textarea').press('Control+f');
    const bar = page.locator('.find-bar').last();
    await expect(bar).toBeVisible();
    await expect(bar.locator('.find-source-label')).toHaveText(
        'Pi RPC transcript',
    );
    const input = bar.locator('.find-input');
    await input.fill(query);
    await expect(bar.locator('.find-status')).toContainText(
        '1 matches in Pi RPC transcript',
        { timeout: 15_000 },
    );
    await input.press('Enter');
    await expect(bar.locator('.find-preview')).toBeVisible();
    await expect(bar.locator('.find-preview')).toContainText(target);
    await expect(
        transcript.locator('[data-pi-message-index="7"]'),
    ).toContainText(target);
    expect(
        await transcript.locator('[data-pi-message-index]').count(),
    ).toBeLessThanOrEqual(100);
    return bar;
}

test('Pi RPC active-session search reveals local transcript rows while offline on desktop and touch', async ({
    browser,
    page,
}) => {
    test.setTimeout(240_000);
    page.setDefaultTimeout(30_000);
    const sessionPaths = new Map<string, string>();
    const phi = await startPhi({
        config: { pi_bridge_no_inject: true, auto_reconnect: 'off' },
        env: { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
        setup(dir) {
            const home = join(dir, 'home');
            const cwd = realpathSync(dir);
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
            mkdirSync(join(home, '.phi'), { recursive: true });
            writeFileSync(
                join(home, '.phi', 'config.toml'),
                configToToml({ workspaces: [cwd], active_cwd: cwd }),
            );
            const binary = join(process.cwd(), 'node_modules', '.bin', 'pi');
            const bin = join(dir, 'bin');
            mkdirSync(bin, { recursive: true });
            writeFileSync(
                join(bin, 'pi'),
                `#!/bin/sh\nexec ${shellQuote(binary)} --offline --no-extensions --no-skills --no-prompt-templates --no-context-files --no-approve --model anthropic/claude-sonnet-4-5 "$@"\n`,
                { mode: 0o755 },
            );
            sessionPaths.set(
                'desktop-search-session',
                writePiSession(home, cwd, 'desktop-search-session'),
            );
            sessionPaths.set(
                'mobile-search-session',
                writePiSession(home, cwd, 'mobile-search-session'),
            );
        },
    });

    let mobileContext: BrowserContext | undefined;
    try {
        phi.verify();
        await page.setViewportSize({ width: 1440, height: 900 });
        const desktopMonitor = monitorPage(page, phi.url);
        await page.goto(phi.url);
        const desktop = await openPiSession(
            page,
            'desktop-search-session',
            sessionPaths.get('desktop-search-session')!,
        );
        const desktopBar = await searchOffline(
            page,
            desktop.transcript,
            'desktop-search-session',
            'desktop-search-session-needle-007',
            desktopMonitor.setOfflinePhase,
        );
        await expect(page.locator('.find-bar')).toHaveCount(1);
        expect(
            await page.evaluate(
                () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
        ).toBe(true);
        await desktopBar.locator('.find-close').click();
        await expect(page.locator('#input-textarea')).toBeFocused();
        await page.context().setOffline(false);
        desktopMonitor.setOfflinePhase(false);

        mobileContext = await browser.newContext({
            viewport: { width: 390, height: 844 },
            deviceScaleFactor: 2,
            isMobile: true,
            hasTouch: true,
            colorScheme: 'dark',
        });
        const mobilePage = await mobileContext.newPage();
        mobilePage.setDefaultTimeout(30_000);
        const mobileMonitor = monitorPage(mobilePage, phi.url);
        await mobilePage.goto(phi.url);
        const mobile = await openPiSession(
            mobilePage,
            'mobile-search-session',
            sessionPaths.get('mobile-search-session')!,
            true,
        );
        const mobileTarget = 'MOBILE-SEARCH-SESSION-NEEDLE-007';
        await expect(
            mobile.transcript.locator('[data-pi-message-index="7"]'),
        ).toHaveCount(0);
        mobileMonitor.setOfflinePhase(true);
        await mobileContext.setOffline(true);
        await mobilePage.locator('#input-textarea').tap();
        await mobilePage.keyboard.press('Control+f');
        const mobileBar = mobilePage.locator('.find-bar').last();
        await expect(mobileBar).toBeVisible();
        const mobileInput = mobileBar.locator('.find-input');
        await mobileInput.tap();
        await mobilePage.keyboard.type('mobile-search-session-needle-007');
        await expect(mobileBar.locator('.find-status')).toContainText(
            '1 matches in Pi RPC transcript',
            { timeout: 15_000 },
        );
        await mobileBar.locator('.find-next').tap();
        await expect(mobileBar.locator('.find-preview')).toBeVisible();
        await expect(mobileBar.locator('.find-preview')).toContainText(
            mobileTarget,
        );
        await expect(
            mobile.transcript.locator('[data-pi-message-index="7"]'),
        ).toContainText(mobileTarget);
        const bounds = await mobileBar.boundingBox();
        if (!bounds) throw new Error('mobile Pi search bar has no layout box');
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
        expect(
            await mobileInput.evaluate((element) =>
                Number.parseFloat(getComputedStyle(element).fontSize),
            ),
        ).toBeGreaterThanOrEqual(16);
        expect(
            await mobilePage.evaluate(
                () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
        ).toBe(true);
        await mobileBar.locator('.find-close').tap();
        await expect(mobileBar).toHaveCount(0);

        expect(mobileMonitor.pageErrors).toEqual([]);
        expect(desktopMonitor.pageErrors).toEqual([]);
        expect(desktopMonitor.consoleErrors).toEqual([]);
        expect(mobileMonitor.consoleErrors).toEqual([]);
        expect(desktopMonitor.failedRequests).toEqual([]);
        expect(mobileMonitor.failedRequests).toEqual([]);
    } finally {
        await mobileContext?.close();
        await phi.stop();
    }
});
