import { mkdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    expect,
    test,
    type Page,
    type Route,
    type WebSocketRoute,
} from '@playwright/test';
import { TerminalServerFrame } from '../web/proto/terminal.js';
import type {
    MessageFns,
    TerminalServerFrame as TerminalServerMessage,
} from '../web-src/proto/terminal.js';
import { startPhi, type PhiServer } from './_server.js';

// Real-server gate for the markdown panel's name/modified sort. The first
// milestone must see a real filesystem write, a real watcher notification on
// the selected pane socket, a subsequent listing GET, and the rendered
// reorder without a page reload.

const ServerCodec: MessageFns<TerminalServerMessage> =
    TerminalServerFrame as unknown as MessageFns<TerminalServerMessage>;

let phi: PhiServer;

test.beforeEach(async () => {
    phi = await startPhi({
        config: {
            markdown_dirs: ['./first', './second'],
            auto_reconnect: 'visible',
        },
        setup(dir) {
            const first = join(dir, 'first');
            const second = join(dir, 'second');
            mkdirSync(first, { recursive: true });
            mkdirSync(second, { recursive: true });
            const early = new Date('2024-01-01T00:00:00Z');
            const late = new Date('2024-02-01T00:00:00Z');
            writeFileSync(join(first, 'alpha.md'), '# alpha\n');
            writeFileSync(join(first, 'bravo.md'), '# bravo\n');
            writeFileSync(join(second, 'charlie.md'), '# charlie\n');
            writeFileSync(join(second, 'delta.md'), '# delta\n');
            utimesSync(join(first, 'alpha.md'), early, early);
            utimesSync(join(first, 'bravo.md'), late, late);
            utimesSync(join(second, 'charlie.md'), early, early);
            utimesSync(join(second, 'delta.md'), late, late);
            for (const worktree of ['wt-a', 'wt-b']) {
                for (const sub of ['first', 'second']) {
                    const subdir = join(dir, worktree, sub);
                    mkdirSync(subdir, { recursive: true });
                    const name = `${worktree}-${sub}.md`;
                    writeFileSync(join(subdir, name), `# ${name}\n`);
                    utimesSync(join(subdir, name), early, early);
                }
            }
        },
    });
});

test.afterEach(async () => {
    await phi.stop();
});

interface GroupView {
    label: string;
    names: string[];
}

async function readGroups(page: Page): Promise<GroupView[]> {
    return page
        .locator('#markdown-file-list .md-file-group')
        .evaluateAll((groups) =>
            groups.map((group) => ({
                label:
                    group.querySelector('.md-dir-label > span')?.textContent ??
                    '',
                names: Array.from(
                    group.querySelectorAll('.md-file-name'),
                    (name) => name.textContent ?? '',
                ),
            })),
        );
}

function listingResponse(page: Page, cwd: string) {
    return page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
            url.pathname === '/api/markdown/files' &&
            url.searchParams.get('cwd') === cwd
        );
    });
}

function sameDir(a: string, b: string): boolean {
    try {
        return realpathSync(a) === realpathSync(b);
    } catch {
        return a === b;
    }
}

async function openMarkdownPanel(page: Page) {
    const panel = page.locator('#diff-panel');
    const closed = await panel.evaluate((element) =>
        element.classList.contains('hidden'),
    );
    if (closed) await page.locator('#header-diff-toggle-btn').click();
    await page.locator('.diff-tab-btn[data-tab="markdown"]').click();
}

async function selectPane(page: Page, paneId: string) {
    await page.locator(`.tab[data-pane-id="${paneId}"]`).click();
    await page
        .locator(`#term-${paneId} .xterm`)
        .waitFor({ state: 'attached', timeout: 30_000 });
}

function fileRow(page: Page, name: string) {
    return page.locator('#markdown-file-list .md-file-row', {
        has: page.locator('.md-file-name', { hasText: name }),
    });
}

async function waitForSortMenu(page: Page) {
    await page.locator('.md-sort-menu').waitFor({ state: 'visible' });
    await expect
        .poll(
            () =>
                page
                    .locator('.md-sort-menu')
                    .evaluate((element) => getComputedStyle(element).opacity),
            { timeout: 5_000 },
        )
        .toBe('1');
}

test('live sort MVP: watcher write reorders the selected pane list', async ({
    page,
}, testInfo) => {
    test.setTimeout(120_000);
    const fixtureCwd = realpathSync(phi.dir);
    const spawned = await page.request.post(`${phi.url}/api/terminals`, {
        data: {
            coder: 'bash',
            cwd: fixtureCwd,
            title: 'Markdown sort',
        },
    });
    expect(spawned.ok()).toBe(true);
    const paneId = ((await spawned.json()) as { pane_id: string }).pane_id;

    const notifications: Array<{ dir: string; at: number }> = [];
    const listings: Array<{ cwd: string; at: number }> = [];
    page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname !== '/api/markdown/files') return;
        listings.push({
            cwd: url.searchParams.get('cwd') ?? '',
            at: Date.now(),
        });
    });

    await page.routeWebSocket(`**/ws/pane/${paneId}?*`, (socket) => {
        const backend = socket.connectToServer();
        socket.onMessage((message) => backend.send(message));
        backend.onMessage((message) => {
            if (Buffer.isBuffer(message)) {
                try {
                    const frame = ServerCodec.decode(new Uint8Array(message));
                    const payload = frame.payload;
                    if (
                        payload?.$case === 'notification' &&
                        payload.value.kind?.$case === 'markdownChanged'
                    ) {
                        notifications.push({
                            dir: payload.value.kind.value.dir ?? '',
                            at: Date.now(),
                        });
                    }
                } catch {
                    // Never let evidence decoding interfere with the real
                    // pane stream this test forwards.
                }
            }
            socket.send(message);
        });
    });

    await page.setViewportSize({ width: 1400, height: 850 });
    await page.goto(phi.url);
    await page.locator(`.tab[data-pane-id="${paneId}"]`).click();
    await page
        .locator(`#term-${paneId} .xterm`)
        .waitFor({ state: 'attached', timeout: 30_000 });

    const initial = listingResponse(page, fixtureCwd);
    await openMarkdownPanel(page);
    const initialReply = await initial;
    expect(initialReply.ok()).toBe(true);
    await expect
        .poll(async () => readGroups(page), { timeout: 20_000 })
        .toEqual([
            { label: './first', names: ['alpha.md', 'bravo.md'] },
            { label: './second', names: ['charlie.md', 'delta.md'] },
        ]);

    await page.locator('.md-sort-btn').click();
    const modified = page.locator('.md-sort-option[data-sort="modified"]');
    await expect(modified).toHaveAttribute('aria-checked', 'false');
    await modified.click();
    await expect(page.locator('.md-sort-btn')).toHaveAttribute(
        'aria-expanded',
        'false',
    );
    await expect
        .poll(async () => readGroups(page), { timeout: 20_000 })
        .toEqual([
            { label: './first', names: ['bravo.md', 'alpha.md'] },
            { label: './second', names: ['delta.md', 'charlie.md'] },
        ]);
    expect(await page.evaluate(() => localStorage.getItem('phi-md-sort'))).toBe(
        'modified',
    );

    const changedPath = join(fixtureCwd, 'first', 'alpha.md');
    const writeAt = Date.now();
    writeFileSync(changedPath, '# alpha changed by the live sort gate\n');
    const firstDir = join(fixtureCwd, 'first');

    await expect
        .poll(() => notifications.some((entry) => entry.dir === firstDir), {
            timeout: 20_000,
        })
        .toBe(true);
    const notification = notifications.find((entry) => entry.dir === firstDir)!;
    expect(notification.at).toBeGreaterThanOrEqual(writeAt);

    await expect
        .poll(
            () =>
                listings.some(
                    (entry) =>
                        entry.cwd === fixtureCwd && entry.at >= notification.at,
                ),
            { timeout: 20_000 },
        )
        .toBe(true);
    const listingAt = listings.find(
        (entry) => entry.cwd === fixtureCwd && entry.at >= notification.at,
    )!;
    expect(listingAt.at).toBeGreaterThanOrEqual(notification.at);

    await expect
        .poll(async () => readGroups(page), { timeout: 20_000 })
        .toEqual([
            { label: './first', names: ['alpha.md', 'bravo.md'] },
            { label: './second', names: ['delta.md', 'charlie.md'] },
        ]);
    expect(await page.locator('#markdown-file-list').textContent()).not.toMatch(
        /\d{4}-\d{2}-\d{2}/,
    );

    await page.screenshot({
        path: testInfo.outputPath('md-sort-live-desktop.png'),
        fullPage: true,
    });

    await page.reload();
    await page.locator(`.tab[data-pane-id="${paneId}"]`).click();
    await page
        .locator(`#term-${paneId} .xterm`)
        .waitFor({ state: 'attached', timeout: 30_000 });
    await openMarkdownPanel(page);
    await expect
        .poll(async () => readGroups(page), { timeout: 20_000 })
        .toEqual([
            { label: './first', names: ['alpha.md', 'bravo.md'] },
            { label: './second', names: ['delta.md', 'charlie.md'] },
        ]);
    await page.locator('.md-sort-btn').click();
    await expect(
        page.locator('.md-sort-option[data-sort="modified"]'),
    ).toHaveAttribute('aria-checked', 'true');

    await page.setViewportSize({ width: 420, height: 850 });
    await page.screenshot({
        path: testInfo.outputPath('md-sort-live-mobile.png'),
        fullPage: true,
    });
    console.log(`phi identity: ${JSON.stringify(phi.identity)}`);
});

test('live attention: one changed row, dot, failed preview, and acknowledgment', async ({
    page,
}, testInfo) => {
    test.setTimeout(120_000);
    const fixtureCwd = realpathSync(phi.dir);
    const spawned = await page.request.post(`${phi.url}/api/terminals`, {
        data: {
            coder: 'bash',
            cwd: fixtureCwd,
            title: 'Markdown attention',
        },
    });
    expect(spawned.ok()).toBe(true);
    const paneId = ((await spawned.json()) as { pane_id: string }).pane_id;

    let listingCount = 0;
    page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/markdown/files') {
            listingCount++;
        }
    });

    await page.setViewportSize({ width: 1400, height: 850 });
    await page.goto(phi.url);
    await selectPane(page, paneId);
    await openMarkdownPanel(page);
    await expect(fileRow(page, 'bravo.md')).toBeVisible({ timeout: 20_000 });

    writeFileSync(
        join(fixtureCwd, 'first', 'bravo.md'),
        '# bravo changed by the attention gate\n',
    );
    const bravo = fileRow(page, 'bravo.md');
    await expect(bravo).toHaveClass(/has-attention/, { timeout: 20_000 });
    await expect(fileRow(page, 'alpha.md')).not.toHaveClass(/has-attention/);
    expect(await bravo.locator('.md-file-attention-dot').count()).toBe(1);
    expect(await bravo.locator('.md-file-icon-doc').count()).toBe(0);
    expect(
        await bravo.locator('.md-file-item').getAttribute('aria-label'),
    ).toBe('bravo.md (changed)');

    await page.screenshot({
        path: testInfo.outputPath('md-sort-attention-desktop.png'),
        fullPage: true,
    });

    const listingBeforePreview = listingCount;
    await bravo.locator('.md-file-item').click();
    await expect(page.locator('#md-modal-body')).toContainText(
        'bravo changed by the attention gate',
    );
    await expect(fileRow(page, 'bravo.md')).not.toHaveClass(/has-attention/);
    expect(
        await fileRow(page, 'bravo.md').locator('.md-file-icon-doc').count(),
    ).toBe(1);
    expect(listingCount).toBe(listingBeforePreview);
    await page.locator('#md-modal-close').click();

    writeFileSync(
        join(fixtureCwd, 'second', 'charlie.md'),
        '# charlie changed by the attention gate\n',
    );
    const charlie = fileRow(page, 'charlie.md');
    await expect(charlie).toHaveClass(/has-attention/, { timeout: 20_000 });

    let failedPreview = false;
    const failRoute = async (route: Route) => {
        if (!failedPreview) {
            failedPreview = true;
            await route.fulfill({
                status: 500,
                contentType: 'text/plain',
                body: 'preview failed by the attention gate',
            });
            return;
        }
        await route.continue();
    };
    await page.route('**/api/markdown/file?*', failRoute);
    await charlie.locator('.md-file-item').click();
    await expect(page.locator('#md-modal-body')).toContainText(
        'preview failed by the attention gate',
    );
    await expect(fileRow(page, 'charlie.md')).toHaveClass(/has-attention/);
    await page.unroute('**/api/markdown/file?*', failRoute);
    await page.locator('#md-modal-close').click();

    await fileRow(page, 'charlie.md').locator('.md-file-item').click();
    await expect(page.locator('#md-modal-body')).toContainText(
        'charlie changed by the attention gate',
    );
    await expect(fileRow(page, 'charlie.md')).not.toHaveClass(/has-attention/);
    await page.locator('#md-modal-close').click();

    writeFileSync(
        join(fixtureCwd, 'second', 'delta.md'),
        '# delta changed by the attention gate\n',
    );
    await expect(fileRow(page, 'delta.md')).toHaveClass(/has-attention/, {
        timeout: 20_000,
    });
    await page.setViewportSize({ width: 420, height: 850 });
    await page.screenshot({
        path: testInfo.outputPath('md-sort-attention-mobile.png'),
        fullPage: true,
    });
});

test('directory baselines and unread preference', async ({
    page,
}, testInfo) => {
    test.setTimeout(150_000);
    const fixtureCwd = realpathSync(phi.dir);
    const addedDir = join(fixtureCwd, 'added');
    const firstDir = join(fixtureCwd, 'first');
    mkdirSync(addedDir, { recursive: true });
    const early = new Date('2024-01-01T00:00:00Z');
    const late = new Date('2024-02-01T00:00:00Z');
    writeFileSync(join(addedDir, 'added-a.md'), '# added a\n');
    writeFileSync(join(addedDir, 'added-b.md'), '# added b\n');
    utimesSync(join(addedDir, 'added-a.md'), early, early);
    utimesSync(join(addedDir, 'added-b.md'), late, late);

    const spawned = await page.request.post(`${phi.url}/api/terminals`, {
        data: {
            coder: 'bash',
            cwd: fixtureCwd,
            title: 'Markdown baselines',
        },
    });
    expect(spawned.ok()).toBe(true);
    const paneId = ((await spawned.json()) as { pane_id: string }).pane_id;

    const notifications: Array<{ dir: string; at: number }> = [];
    const listings: Array<{ cwd: string; at: number }> = [];
    page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname !== '/api/markdown/files') return;
        listings.push({
            cwd: url.searchParams.get('cwd') ?? '',
            at: Date.now(),
        });
    });
    await page.routeWebSocket(`**/ws/pane/${paneId}?*`, (socket) => {
        const backend = socket.connectToServer();
        socket.onMessage((message) => backend.send(message));
        backend.onMessage((message) => {
            if (Buffer.isBuffer(message)) {
                try {
                    const frame = ServerCodec.decode(new Uint8Array(message));
                    const payload = frame.payload;
                    if (
                        payload?.$case === 'notification' &&
                        payload.value.kind?.$case === 'markdownChanged'
                    ) {
                        notifications.push({
                            dir: payload.value.kind.value.dir ?? '',
                            at: Date.now(),
                        });
                    }
                } catch {
                    // Evidence decoding never changes the pane stream.
                }
            }
            socket.send(message);
        });
    });

    await page.setViewportSize({ width: 1400, height: 850 });
    await page.goto(phi.url);
    await selectPane(page, paneId);
    await openMarkdownPanel(page);
    await expect(fileRow(page, 'bravo.md')).toBeVisible({ timeout: 20_000 });

    await page.locator('.md-sort-btn').click();
    const highlight = page.locator('.md-sort-highlight-option');
    await expect(highlight).toHaveAttribute('aria-checked', 'true');
    await page.locator('.md-sort-option[data-sort="modified"]').click();

    const nameOrder = [
        { label: './first', names: ['alpha.md', 'bravo.md'] },
        { label: './second', names: ['charlie.md', 'delta.md'] },
    ];
    const modifiedBaseline = [
        { label: './first', names: ['bravo.md', 'alpha.md'] },
        { label: './second', names: ['delta.md', 'charlie.md'] },
    ];
    const withAdded = (groups: GroupView[]) => [
        ...groups,
        { label: './added', names: ['added-b.md', 'added-a.md'] },
    ];
    await expect
        .poll(async () => readGroups(page), { timeout: 20_000 })
        .toEqual(modifiedBaseline);

    const addedListing = listingResponse(page, fixtureCwd);
    await page.locator('.md-manage-btn', { hasText: '+ Add Dir' }).click();
    await expect(page.locator('.config-editor-overlay')).toBeVisible();
    await page.locator('#config-editor-dir').fill('./added');
    await page.locator('.config-editor-footer .btn-accent').click();
    await addedListing;
    await expect
        .poll(async () => readGroups(page), { timeout: 20_000 })
        .toEqual(withAdded(modifiedBaseline));
    await expect(
        page.locator('#markdown-file-list .md-file-row.has-attention'),
    ).toHaveCount(0);
    expect(
        await fileRow(page, 'added-a.md').locator('.md-file-icon-doc').count(),
    ).toBe(1);

    const writeAt = Date.now();
    writeFileSync(join(firstDir, 'bravo.md'), '# bravo baseline gate\n');
    utimesSync(
        join(firstDir, 'bravo.md'),
        new Date('2024-05-01T00:00:00Z'),
        new Date('2024-05-01T00:00:00Z'),
    );
    writeFileSync(join(firstDir, 'alpha.md'), '# alpha baseline gate\n');
    utimesSync(
        join(firstDir, 'alpha.md'),
        new Date('2024-06-01T00:00:00Z'),
        new Date('2024-06-01T00:00:00Z'),
    );

    await expect
        .poll(
            () =>
                notifications.some(
                    (entry) =>
                        entry.at >= writeAt && sameDir(entry.dir, firstDir),
                ),
            { timeout: 20_000 },
        )
        .toBe(true);
    const notification = notifications.find(
        (entry) => entry.at >= writeAt && sameDir(entry.dir, firstDir),
    )!;
    await expect
        .poll(
            () =>
                listings.some(
                    (entry) =>
                        entry.at >= notification.at &&
                        sameDir(entry.cwd, fixtureCwd),
                ),
            { timeout: 20_000 },
        )
        .toBe(true);

    const unreadGroups = [
        { label: './first', names: ['alpha.md', 'bravo.md'] },
        ...withAdded(modifiedBaseline).slice(1),
    ];
    await expect(fileRow(page, 'alpha.md')).toHaveClass(/has-attention/, {
        timeout: 20_000,
    });
    await expect(fileRow(page, 'bravo.md')).toHaveClass(/has-attention/);
    await expect
        .poll(async () => readGroups(page), { timeout: 20_000 })
        .toEqual(unreadGroups);

    // Two configured spellings resolve to the same filesystem paths. Adding
    // or removing the alias must not acknowledge an already unread file.
    const alias = './first/.';
    const aliasListing = listingResponse(page, fixtureCwd);
    await page.locator('.md-manage-btn', { hasText: '+ Add Dir' }).click();
    await page.locator('#config-editor-dir').fill(alias);
    await page.locator('.config-editor-footer .btn-accent').click();
    const aliasFiles = (await (await aliasListing).json()) as Array<{
        path: string;
        name: string;
        dir: string;
    }>;
    const sharedAlpha = aliasFiles.filter((entry) => entry.name === 'alpha.md');
    expect(sharedAlpha.map((entry) => entry.dir)).toEqual(['./first', alias]);
    expect(new Set(sharedAlpha.map((entry) => entry.path)).size).toBe(1);
    await expect
        .poll(() => readGroups(page), { timeout: 20_000 })
        .toEqual([
            ...unreadGroups,
            { label: alias, names: ['alpha.md', 'bravo.md'] },
        ]);
    await expect(
        page.locator('#markdown-file-list .md-file-row.has-attention'),
    ).toHaveCount(4);

    const removedAliasListing = listingResponse(page, fixtureCwd);
    page.once('dialog', (dialog) => void dialog.accept());
    await page
        .locator('.md-file-group')
        .filter({
            has: page.locator('.md-dir-label > span', { hasText: alias }),
        })
        .locator('.md-dir-del-btn')
        .click();
    await removedAliasListing;
    await expect
        .poll(() => readGroups(page), { timeout: 20_000 })
        .toEqual(unreadGroups);
    await expect(
        page.locator('#markdown-file-list .md-file-row.has-attention'),
    ).toHaveCount(2);

    const listingBeforePreview = listings.length;
    await fileRow(page, 'alpha.md').locator('.md-file-item').click();
    await expect(page.locator('#md-modal-body')).toContainText(
        'alpha baseline gate',
    );
    await expect(fileRow(page, 'alpha.md')).not.toHaveClass(/has-attention/);
    await expect(fileRow(page, 'bravo.md')).toHaveClass(/has-attention/);
    const readGroupsView = [
        { label: './first', names: ['bravo.md', 'alpha.md'] },
        ...withAdded(modifiedBaseline).slice(1),
    ];
    await expect
        .poll(async () => readGroups(page), { timeout: 20_000 })
        .toEqual(readGroupsView);
    expect(listings.length).toBe(listingBeforePreview);
    await page.locator('#md-modal-close').click();

    await page.locator('.md-sort-btn').click();
    await page.locator('.md-sort-option[data-sort="name"]').click();
    const nameWithAdded = [
        ...nameOrder,
        { label: './added', names: ['added-a.md', 'added-b.md'] },
    ];
    await expect
        .poll(async () => readGroups(page), { timeout: 20_000 })
        .toEqual(nameWithAdded);
    await expect(fileRow(page, 'bravo.md')).toHaveClass(/has-attention/);

    await page.locator('.md-sort-btn').click();
    await page.locator('.md-sort-option[data-sort="modified"]').click();
    await expect
        .poll(async () => readGroups(page), { timeout: 20_000 })
        .toEqual(readGroupsView);

    await page.locator('.md-sort-btn').click();
    await expect(highlight).toHaveAttribute('aria-checked', 'true');
    await page.locator('.md-sort-highlight-option').click();
    await expect(
        page.locator('#markdown-file-list .md-file-row.has-attention'),
    ).toHaveCount(0);
    await expect(
        page.locator('#markdown-file-list .md-file-attention-dot'),
    ).toHaveCount(0);
    const plainModified = [
        { label: './first', names: ['alpha.md', 'bravo.md'] },
        ...withAdded(modifiedBaseline).slice(1),
    ];
    await expect
        .poll(async () => readGroups(page), { timeout: 20_000 })
        .toEqual(plainModified);
    expect(
        await page.evaluate(() =>
            localStorage.getItem('phi-md-highlight-unread'),
        ),
    ).toBe('false');

    await page.locator('.md-sort-btn').click();
    await expect(highlight).toHaveAttribute('aria-checked', 'false');
    await page.locator('.md-sort-highlight-option').click();
    await expect(fileRow(page, 'bravo.md')).toHaveClass(/has-attention/);
    await expect
        .poll(async () => readGroups(page), { timeout: 20_000 })
        .toEqual(readGroupsView);

    await page.locator('.md-sort-btn').click();
    await expect(highlight).toHaveAttribute('aria-checked', 'true');
    await page.screenshot({
        path: testInfo.outputPath('md-sort-revision5-checked-menu.png'),
        fullPage: true,
    });
    await page.locator('.md-sort-highlight-option').click();

    await page.reload();
    await selectPane(page, paneId);
    await openMarkdownPanel(page);
    await expect(fileRow(page, 'alpha.md')).toBeVisible({ timeout: 20_000 });
    await expect
        .poll(async () => readGroups(page), { timeout: 20_000 })
        .toEqual(plainModified);
    await expect(
        page.locator('#markdown-file-list .md-file-row.has-attention'),
    ).toHaveCount(0);

    await page.locator('.md-sort-btn').click();
    await expect(highlight).toHaveAttribute('aria-checked', 'false');
    await expect(
        page.locator('.md-sort-option[data-sort="modified"]'),
    ).toHaveAttribute('aria-checked', 'true');
    await page.setViewportSize({ width: 420, height: 850 });
    await waitForSortMenu(page);
    await page.screenshot({
        path: testInfo.outputPath('md-sort-revision5-unchecked-mobile.png'),
        fullPage: true,
    });
});

test('pane reconnect catches up a missed markdown change', async ({ page }) => {
    test.setTimeout(150_000);
    const fixtureCwd = realpathSync(phi.dir);

    const spawned = await page.request.post(`${phi.url}/api/terminals`, {
        data: {
            coder: 'bash',
            cwd: fixtureCwd,
            title: 'Markdown recovery',
        },
    });
    expect(spawned.ok()).toBe(true);
    const paneId = ((await spawned.json()) as { pane_id: string }).pane_id;

    const notifications: Array<{ dir: string; at: number }> = [];
    const listings: Array<{ cwd: string; at: number }> = [];
    page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname !== '/api/markdown/files') return;
        listings.push({
            cwd: url.searchParams.get('cwd') ?? '',
            at: Date.now(),
        });
    });

    let phase: 'live' | 'blocked' = 'live';
    let liveConnections = 0;
    let blockedRedials = 0;
    let stopForwarding: (() => void) | undefined;
    let firstRoute: WebSocketRoute | undefined;
    let firstBackend: WebSocketRoute | undefined;
    const liveRoutes: WebSocketRoute[] = [];
    const liveBackends: WebSocketRoute[] = [];
    try {
        await page.routeWebSocket(`**/ws/pane/${paneId}?*`, async (socket) => {
            if (phase === 'blocked') {
                blockedRedials++;
                await socket.close({
                    code: 1000,
                    reason: 'blocked by recovery gate',
                });
                return;
            }
            liveConnections++;
            const backend = socket.connectToServer();
            liveRoutes.push(socket);
            liveBackends.push(backend);
            let closed = false;
            if (!firstRoute) {
                firstRoute = socket;
                firstBackend = backend;
                stopForwarding = () => {
                    closed = true;
                };
            }
            socket.onMessage((message) => {
                if (!closed) backend.send(message);
            });
            socket.onClose(() => {
                // Retain the server-side proxy so the watcher event can
                // be observed while the page is disconnected.
                closed = true;
            });
            backend.onMessage((message) => {
                if (Buffer.isBuffer(message)) {
                    try {
                        const frame = ServerCodec.decode(
                            new Uint8Array(message),
                        );
                        const payload = frame.payload;
                        if (
                            payload?.$case === 'notification' &&
                            payload.value.kind?.$case === 'markdownChanged'
                        ) {
                            notifications.push({
                                dir: payload.value.kind.value.dir ?? '',
                                at: Date.now(),
                            });
                        }
                    } catch {
                        // Evidence decoding never changes the pane stream.
                    }
                }
                if (!closed) socket.send(message);
            });
        });

        await page.setViewportSize({ width: 1400, height: 850 });
        await page.goto(phi.url);
        await selectPane(page, paneId);
        await openMarkdownPanel(page);
        await expect(fileRow(page, 'delta.md')).toBeVisible({
            timeout: 20_000,
        });
        await page.locator('.md-sort-btn').click();
        await page.locator('.md-sort-option[data-sort="modified"]').click();
        const baseline = [
            { label: './first', names: ['bravo.md', 'alpha.md'] },
            { label: './second', names: ['delta.md', 'charlie.md'] },
        ];
        await expect
            .poll(async () => readGroups(page), { timeout: 20_000 })
            .toEqual(baseline);

        expect(liveConnections).toBe(1);
        phase = 'blocked';
        if (!firstRoute) throw new Error('pane socket was not routed');
        const listingsBeforeBlock = listings.length;
        stopForwarding?.();
        await firstRoute.close({
            code: 1001,
            reason: 'recovery gate outage',
        });
        await expect(page.locator('.reconnect-overlay')).toBeVisible({
            timeout: 20_000,
        });

        const notificationCountBefore = notifications.length;
        writeFileSync(
            join(fixtureCwd, 'second', 'charlie.md'),
            '# charlie caught up after reconnect\n',
        );
        const charlieDir = join(fixtureCwd, 'second');
        await expect
            .poll(
                () =>
                    notifications
                        .slice(notificationCountBefore)
                        .some((entry) => sameDir(entry.dir, charlieDir)),
                { timeout: 30_000 },
            )
            .toBe(true);

        // A blocked redial after the real notification gives pending
        // debounced refreshes time to run, without an arbitrary sleep.
        const redialsAfterWrite = blockedRedials;
        await expect
            .poll(() => blockedRedials, { timeout: 30_000 })
            .toBeGreaterThan(redialsAfterWrite);
        expect(
            listings
                .slice(listingsBeforeBlock)
                .filter((entry) => sameDir(entry.cwd, fixtureCwd)),
        ).toEqual([]);
        await expect
            .poll(async () => readGroups(page), { timeout: 20_000 })
            .toEqual(baseline);

        phase = 'live';
        const listingsBeforeRestore = listings.length;
        if (firstBackend) {
            await firstBackend.close({
                code: 1001,
                reason: 'recovery gate restore',
            });
        }
        await expect
            .poll(() => liveConnections, { timeout: 30_000 })
            .toBeGreaterThan(1);
        await expect
            .poll(
                () =>
                    listings
                        .slice(listingsBeforeRestore)
                        .some((entry) => sameDir(entry.cwd, fixtureCwd)),
                { timeout: 30_000 },
            )
            .toBe(true);
        await expect
            .poll(async () => readGroups(page), { timeout: 30_000 })
            .toEqual([
                { label: './first', names: ['bravo.md', 'alpha.md'] },
                { label: './second', names: ['charlie.md', 'delta.md'] },
            ]);
        await expect(fileRow(page, 'charlie.md')).toHaveClass(/has-attention/, {
            timeout: 20_000,
        });
    } finally {
        for (const backend of liveBackends) {
            try {
                await backend.close({
                    code: 1000,
                    reason: 'recovery gate cleanup',
                });
            } catch {}
        }
        for (const route of liveRoutes) {
            try {
                await route.close({
                    code: 1000,
                    reason: 'recovery gate cleanup',
                });
            } catch {}
        }
    }
});

test('visual acceptance: desktop, mobile, and appearance extremes', async ({
    page,
}, testInfo) => {
    test.setTimeout(150_000);
    const fixtureCwd = realpathSync(phi.dir);
    const longName =
        'a-very-long-markdown-filename-that-needs-truncation-on-mobile.md';
    const spawned = await page.request.post(`${phi.url}/api/terminals`, {
        data: {
            coder: 'bash',
            cwd: fixtureCwd,
            title: 'Markdown appearance',
        },
    });
    expect(spawned.ok()).toBe(true);
    const paneId = ((await spawned.json()) as { pane_id: string }).pane_id;

    await page.setViewportSize({ width: 1400, height: 850 });
    await page.goto(phi.url);
    await selectPane(page, paneId);
    await openMarkdownPanel(page);
    await expect(fileRow(page, 'bravo.md')).toBeVisible({ timeout: 20_000 });
    await page.locator('.md-sort-btn').click();
    await page.locator('.md-sort-option[data-sort="modified"]').click();
    await expect(
        page.locator('.md-sort-option[data-sort="modified"]'),
    ).toHaveAttribute('aria-checked', 'true');

    writeFileSync(join(fixtureCwd, 'first', longName), '# long name\n');
    await expect(fileRow(page, longName)).toHaveClass(/has-attention/, {
        timeout: 20_000,
    });

    await fileRow(page, longName).hover();
    await page.locator('.md-sort-btn').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.screenshot({
        path: testInfo.outputPath(
            'md-sort-1400-normal-purple-attention-hover-focus.png',
        ),
        fullPage: true,
    });

    await page.locator('.md-sort-btn').click();
    await waitForSortMenu(page);
    await expect(
        page.locator('.md-sort-option[data-sort="modified"]'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.md-sort-highlight-option')).toHaveAttribute(
        'aria-checked',
        'true',
    );
    await page.screenshot({
        path: testInfo.outputPath('md-sort-1400-normal-purple-menu.png'),
        fullPage: true,
    });

    await page.setViewportSize({ width: 420, height: 850 });
    await waitForSortMenu(page);
    // setViewportSize can resolve before the browser dispatches resize.
    await expect
        .poll(async () => {
            const box = await page.locator('.md-sort-menu').boundingBox();
            return box ? box.x + box.width : Number.POSITIVE_INFINITY;
        })
        .toBeLessThanOrEqual(421);
    await expect(
        page.locator('.md-sort-option[data-sort="modified"]'),
    ).toBeFocused();
    const touchBox = await page.locator('.md-sort-btn').boundingBox();
    expect(touchBox).not.toBeNull();
    expect(touchBox!.width).toBeGreaterThanOrEqual(40);
    expect(touchBox!.height).toBeGreaterThanOrEqual(40);
    const mobileMenu = await page.locator('.md-sort-menu').boundingBox();
    expect(mobileMenu).not.toBeNull();
    expect(mobileMenu!.x).toBeGreaterThanOrEqual(0);
    expect(mobileMenu!.y).toBeGreaterThanOrEqual(0);
    expect(mobileMenu!.x + mobileMenu!.width).toBeLessThanOrEqual(421);
    expect(mobileMenu!.y + mobileMenu!.height).toBeLessThanOrEqual(851);
    const mobileHighlight = await page
        .locator('.md-sort-highlight-option')
        .boundingBox();
    expect(mobileHighlight).not.toBeNull();
    expect(mobileHighlight!.x).toBeGreaterThanOrEqual(0);
    expect(mobileHighlight!.x + mobileHighlight!.width).toBeLessThanOrEqual(
        421,
    );
    await expect(
        page.locator('.md-sort-highlight-option .md-context-label'),
    ).toHaveText('Highlight unread docs');
    expect(
        await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
    ).toBe(true);
    await page.screenshot({
        path: testInfo.outputPath(
            'md-sort-420-normal-purple-menu-longname.png',
        ),
        fullPage: true,
    });
    await page.locator('.md-sort-btn').click();

    await page.setViewportSize({ width: 1400, height: 850 });
    await page.locator('#header-config-pill .pill-label').click();
    await expect(page.locator('.settings-overlay')).toBeVisible();
    await page.locator('#settings-ui-font-size').fill('24');
    await page.locator('.settings-swatch[data-color="white"]').click();
    await page.locator('.settings-overlay .modal-close-btn').click();
    await expect
        .poll(
            () =>
                page.evaluate(
                    () => getComputedStyle(document.documentElement).fontSize,
                ),
            { timeout: 10_000 },
        )
        .toBe('24px');

    await page.locator('.md-sort-btn').click();
    await waitForSortMenu(page);
    const whiteMenu = await page.locator('.md-sort-menu').boundingBox();
    expect(whiteMenu).not.toBeNull();
    expect(whiteMenu!.x).toBeGreaterThanOrEqual(0);
    expect(whiteMenu!.y).toBeGreaterThanOrEqual(0);
    expect(whiteMenu!.x + whiteMenu!.width).toBeLessThanOrEqual(1401);
    expect(whiteMenu!.y + whiteMenu!.height).toBeLessThanOrEqual(851);
    await expect(
        page.locator('.md-sort-option[data-sort="modified"]'),
    ).toBeVisible();
    await expect(page.locator('.md-sort-highlight-option')).toBeVisible();
    await page.screenshot({
        path: testInfo.outputPath('md-sort-1400-24px-white-menu.png'),
        fullPage: true,
    });

    await page.locator('#header-config-pill .pill-label').click();
    await expect(page.locator('.settings-overlay')).toBeVisible();
    await page.locator('.settings-swatch[data-color="green"]').click();
    await page.locator('.settings-overlay .modal-close-btn').click();
    await page.setViewportSize({ width: 420, height: 850 });
    await page.locator('.md-sort-btn').click();
    await waitForSortMenu(page);
    const greenMenu = await page.locator('.md-sort-menu').boundingBox();
    expect(greenMenu).not.toBeNull();
    expect(greenMenu!.x).toBeGreaterThanOrEqual(0);
    expect(greenMenu!.y).toBeGreaterThanOrEqual(0);
    expect(greenMenu!.x + greenMenu!.width).toBeLessThanOrEqual(421);
    expect(greenMenu!.y + greenMenu!.height).toBeLessThanOrEqual(851);
    expect(
        await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
    ).toBe(true);
    const menuItemBoxes = await page
        .locator('.md-sort-option, .md-sort-highlight-option')
        .evaluateAll((options) =>
            options.map((option) => {
                const rect = option.getBoundingClientRect();
                return { left: rect.left, right: rect.right };
            }),
        );
    expect(menuItemBoxes).toHaveLength(3);
    for (const box of menuItemBoxes) {
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(420);
    }
    await page.screenshot({
        path: testInfo.outputPath('md-sort-420-24px-green-menu.png'),
        fullPage: true,
    });
});

test('live refresh preserves the focused action and list scroll after a reorder', async ({
    page,
}, testInfo) => {
    test.setTimeout(120_000);
    const fixtureCwd = realpathSync(phi.dir);
    const early = new Date('2024-01-01T00:00:00Z');
    for (let i = 0; i < 35; i++) {
        const path = join(
            fixtureCwd,
            'first',
            `many-${String(i).padStart(2, '0')}.md`,
        );
        writeFileSync(path, '# scroll fixture\n');
        utimesSync(path, early, early);
    }
    const spawned = await page.request.post(`${phi.url}/api/terminals`, {
        data: { coder: 'bash', cwd: fixtureCwd, title: 'Markdown focus' },
    });
    expect(spawned.ok()).toBe(true);
    const paneId = ((await spawned.json()) as { pane_id: string }).pane_id;
    await page.setViewportSize({ width: 1400, height: 850 });
    await page.goto(phi.url);
    await selectPane(page, paneId);
    await openMarkdownPanel(page);
    await expect(fileRow(page, 'many-34.md')).toBeAttached({ timeout: 20_000 });
    await page.locator('.md-sort-btn').click();
    await page.locator('.md-sort-option[data-sort="modified"]').click();

    // A menu cannot remain detached when its toolbar scrolls out of view.
    await page.locator('.md-sort-btn').click();
    await waitForSortMenu(page);
    const list = page.locator('#markdown-file-list');
    await list.evaluate((element) => {
        element.scrollTop = 300;
    });
    await expect(page.locator('.md-sort-menu')).toBeHidden();
    expect(
        await list.evaluate((element) => element.scrollTop),
    ).toBeGreaterThanOrEqual(300);

    const target = fileRow(page, 'many-24.md');
    await target.locator('.md-file-action-btn').focus();
    await expect(target.locator('.md-file-action-btn')).toBeFocused();
    const beforeScroll = await list.evaluate((element) => element.scrollTop);
    expect(beforeScroll).toBeGreaterThan(0);
    writeFileSync(
        join(fixtureCwd, 'first', 'many-24.md'),
        '# moved to the top\n',
    );
    await expect(target).toHaveClass(/has-attention/, { timeout: 20_000 });
    await expect(
        page.locator('#markdown-file-list .md-file-name').first(),
    ).toHaveText('many-24.md');
    await expect(target.locator('.md-file-action-btn')).toBeFocused();
    expect(await list.evaluate((element) => element.scrollTop)).toBe(
        beforeScroll,
    );
    await page.screenshot({
        path: testInfo.outputPath('md-sort-retained-scroll-focus.png'),
        fullPage: true,
    });
});

test('hidden cwd round-trip resets attention without a background listing', async ({
    page,
}) => {
    test.setTimeout(120_000);
    const fixtureCwd = realpathSync(phi.dir);
    const cwdA = join(fixtureCwd, 'wt-a');
    const cwdB = join(fixtureCwd, 'wt-b');
    const paneA = await page.request.post(`${phi.url}/api/terminals`, {
        data: { coder: 'bash', cwd: cwdA, title: 'Markdown A' },
    });
    const paneB = await page.request.post(`${phi.url}/api/terminals`, {
        data: { coder: 'bash', cwd: cwdB, title: 'Markdown B' },
    });
    expect(paneA.ok()).toBe(true);
    expect(paneB.ok()).toBe(true);
    const paneAId = ((await paneA.json()) as { pane_id: string }).pane_id;
    const paneBId = ((await paneB.json()) as { pane_id: string }).pane_id;

    const listings: Array<{ cwd: string; at: number }> = [];
    page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname !== '/api/markdown/files') return;
        listings.push({
            cwd: url.searchParams.get('cwd') ?? '',
            at: Date.now(),
        });
    });

    await page.setViewportSize({ width: 1400, height: 850 });
    await page.goto(phi.url);
    await selectPane(page, paneAId);
    await openMarkdownPanel(page);
    await expect(fileRow(page, 'wt-a-first.md')).toBeVisible({
        timeout: 20_000,
    });
    expect(await fileRow(page, 'wt-b-first.md').count()).toBe(0);

    writeFileSync(join(cwdA, 'first', 'wt-a-first.md'), '# wt-a changed\n');
    await expect(fileRow(page, 'wt-a-first.md')).toHaveClass(/has-attention/, {
        timeout: 20_000,
    });

    await page.locator('#close-diff-btn').click();
    await expect(page.locator('#diff-panel')).toHaveClass(/hidden/);
    const hiddenSince = Date.now();

    await selectPane(page, paneBId);
    await selectPane(page, paneAId);
    await expect(page.locator(`.tab[data-pane-id="${paneAId}"]`)).toHaveClass(
        /active/,
    );
    const reopenedAt = Date.now();
    expect(
        listings.filter(
            (entry) => entry.at >= hiddenSince && entry.at < reopenedAt,
        ),
    ).toEqual([]);

    const resumed = listingResponse(page, cwdA);
    await openMarkdownPanel(page);
    await resumed;
    await expect(fileRow(page, 'wt-a-first.md')).toBeVisible({
        timeout: 20_000,
    });
    await expect(fileRow(page, 'wt-a-first.md')).not.toHaveClass(
        /has-attention/,
    );
    expect(await fileRow(page, 'wt-b-first.md').count()).toBe(0);
});
