import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startPhi } from './_server.js';

// Workspace manager: one dialog for registered projects plus live root
// folders. Cover real persistence, offline recovery, and lost acknowledgements.

const STATUS = '#ws-manager-status';

async function openManager(page: Page): Promise<void> {
    await page.click('#remove-workspace-btn');
    await expect(page.locator('#ws-manager-modal')).toBeVisible();
}

function rootSection(page: Page) {
    return page.locator('#ws-manager-roots .ws-manager-section').first();
}

function projectRow(page: Page, name: string) {
    return page
        .locator('#ws-manager-projects .ws-manager-row')
        .filter({ hasText: name });
}

function restRow(page: Page, name: string) {
    return rootSection(page)
        .locator('.ws-manager-row')
        .filter({ hasText: name });
}

test('adds and removes projects through a live root folder', async ({
    page,
}) => {
    const server = await startPhi({
        setup: (dir) => {
            for (const name of ['alpha', 'beta', 'gamma']) {
                mkdirSync(join(dir, 'code', name), { recursive: true });
            }
        },
    });
    try {
        const rootPath = join(server.dir, 'code');
        await page.goto(server.url);
        await openManager(page);

        await page.fill('#ws-manager-root-input', rootPath);
        await page.click('#ws-manager-root-add');

        await expect(rootSection(page)).toContainText('Rest of code');
        await expect(rootSection(page).locator('.ws-manager-row')).toHaveCount(
            3,
        );
        // The root itself is never a project.
        await expect(projectRow(page, rootPath)).toHaveCount(0);

        await restRow(page, 'alpha').locator('input').check();
        await restRow(page, 'beta').locator('input').check();
        await rootSection(page).locator('.ws-manager-add-btn').click();

        await expect(projectRow(page, 'alpha')).toHaveCount(1);
        await expect(projectRow(page, 'beta')).toHaveCount(1);
        await expect(rootSection(page).locator('.ws-manager-row')).toHaveCount(
            1,
        );
        await expect(
            page.locator('#workspace-select option', { hasText: 'alpha' }),
        ).toHaveCount(1);

        await projectRow(page, 'alpha').locator('input').check();
        await page.click('#ws-manager-remove');

        await expect(projectRow(page, 'alpha')).toHaveCount(0);
        await expect(restRow(page, 'alpha')).toHaveCount(1);

        // The server kept the same list; a reload shows the same two sections.
        await page.reload();
        await openManager(page);
        await expect(projectRow(page, 'beta')).toHaveCount(1);
        await expect(restRow(page, 'alpha')).toHaveCount(1);
        await expect(restRow(page, 'gamma')).toHaveCount(1);
    } finally {
        await server.stop();
    }
});

test('flushes a change queued in an earlier session when the app loads online', async ({
    page,
}) => {
    const server = await startPhi({
        setup: (dir) => {
            mkdirSync(join(dir, 'code', 'alpha'), { recursive: true });
        },
    });
    try {
        const rootPath = join(server.dir, 'code');
        // A write that never left the browser in a previous session (the tab
        // was closed while offline). Nothing else retries it: the `online`
        // event already happened before this page existed.
        await page.addInitScript((path: string) => {
            localStorage.setItem(
                'phi_workspace_manager_outbox',
                JSON.stringify({
                    kind: 'add',
                    paths: [path],
                    state: 'unsent',
                }),
            );
        }, `${rootPath}/alpha`);

        const writes: string[] = [];
        page.on('request', (request) => {
            if (
                request.method() !== 'GET' &&
                request.url().includes('/api/config/workspace')
            ) {
                writes.push(request.url());
            }
        });

        await page.goto(server.url);
        await openManager(page);

        await expect.poll(() => writes.length, { timeout: 10_000 }).toBe(1);
        await expect(projectRow(page, 'alpha')).toHaveCount(1);
        await expect
            .poll(() =>
                page.evaluate(() =>
                    localStorage.getItem('phi_workspace_manager_outbox'),
                ),
            )
            .toBeNull();
    } finally {
        await server.stop();
    }
});

test('never resends an accepted write after its reply is lost and the page reloads', async ({
    page,
    context,
}) => {
    const server = await startPhi({
        setup: (dir) => {
            mkdirSync(join(dir, 'code', 'alpha'), { recursive: true });
        },
    });
    try {
        const root = join(server.dir, 'code');
        await page.request.post(`${server.url}/api/config/workspace-roots`, {
            data: { path: root },
        });
        await page.goto(server.url);
        await openManager(page);
        await expect(restRow(page, 'alpha')).toHaveCount(1);

        let writes = 0;
        await page.route('**/api/config/workspaces', async (route) => {
            writes++;
            const response = await route.fetch();
            expect(response.ok()).toBe(true); // the real server saved the change
            await context.setOffline(true);
            await route.abort('connectionclosed'); // only its acknowledgement is lost
        });
        await restRow(page, 'alpha').locator('input').check();
        await rootSection(page).locator('.ws-manager-add-btn').click();
        await expect(page.locator(STATUS)).toContainText('not confirmed');
        await expect(projectRow(page, 'alpha')).toHaveCount(1);
        await expect
            .poll(() =>
                page.evaluate(
                    () =>
                        JSON.parse(
                            localStorage.getItem(
                                'phi_workspace_manager_outbox',
                            ) || '{}',
                        ).state,
                ),
            )
            .toBe('unconfirmed');

        await context.setOffline(false);
        await page.reload();
        await openManager(page);
        // The first fresh read confirms the write by itself: no resend, and no
        // manual Check status step for a reply that was only lost.
        await expect(page.locator(STATUS)).toContainText('Saved.');
        await expect(
            page.getByRole('button', { name: 'Check status' }),
        ).toHaveCount(0);
        await expect(projectRow(page, 'alpha')).toHaveCount(1);
        expect(writes).toBe(1);
        const config = await (
            await page.request.get(`${server.url}/api/config`)
        ).json();
        expect(
            config.workspaces.filter(
                (path: string) => path === join(root, 'alpha'),
            ),
        ).toHaveLength(1);
    } finally {
        await context.setOffline(false);
        await server.stop();
    }
});

test('keeps an offline change locally and sends it once on reconnect', async ({
    page,
    context,
}) => {
    const server = await startPhi({
        setup: (dir) => {
            mkdirSync(join(dir, 'code', 'alpha'), { recursive: true });
        },
    });
    try {
        const rootPath = join(server.dir, 'code');
        const writes: string[] = [];
        page.on('request', (request) => {
            if (
                request.method() !== 'GET' &&
                request.url().includes('/api/config/workspace')
            ) {
                writes.push(request.url());
            }
        });

        await page.goto(server.url);
        await openManager(page);

        await page.fill('#ws-manager-root-input', rootPath);
        await page.click('#ws-manager-root-add');
        await expect(restRow(page, 'alpha')).toHaveCount(1);
        writes.length = 0;

        await context.setOffline(true);
        await restRow(page, 'alpha').locator('input').check();
        await rootSection(page).locator('.ws-manager-add-btn').click();

        await expect(page.locator(STATUS)).toContainText(
            'Saved in this browser',
        );
        // Visible locally, but nothing left the browser yet.
        await expect(projectRow(page, 'alpha')).toHaveCount(1);
        expect(writes).toHaveLength(0);

        await context.setOffline(false);
        await expect.poll(() => writes.length, { timeout: 10_000 }).toBe(1);
        await expect(page.locator(STATUS)).not.toContainText(
            'Saved in this browser',
        );

        await page.reload();
        await openManager(page);
        await expect(projectRow(page, 'alpha')).toHaveCount(1);
        await expect(rootSection(page)).toContainText(
            'Every project in this folder is already added.',
        );
    } finally {
        await server.stop();
    }
});
