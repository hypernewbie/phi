import { expect, test } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

const HASH = '1234567890abcdef1234567890abcdef12345678';
const RAW_DIFF = `diff --git a/commit.txt b/commit.txt
index 4458ac6..98043d1 100644
--- a/commit.txt
+++ b/commit.txt
@@ -1 +1 @@
-old content
+requested commit content
`;
let phi: PhiServer;

test.beforeAll(async () => {
    phi = await startPhi();
});
test.afterAll(async () => {
    await phi.stop();
});

test('a show-commit card selects an older hash and opens that hash in the pretty viewer', async ({
    page,
}) => {
    await page.setViewportSize({ width: 1400, height: 850 });
    await page.route('**/api/proxy?*', (route) =>
        route.fulfill({
            json: [
                {
                    key: 'show:commit',
                    value: {
                        title: 'Review this commit',
                        diff: { commit: HASH },
                        auto_open: true,
                    },
                    updated_at: new Date().toISOString(),
                },
            ],
        }),
    );
    await page.route('**/api/git/commits?*', (route) =>
        route.fulfill({
            json: [{ hash: 'abcdef0', subject: 'Unrelated recent commit' }],
        }),
    );
    const requested: string[] = [];
    await page.route('**/api/git/raw-diff?*', (route) => {
        const commit =
            new URL(route.request().url()).searchParams.get('commit') || '';
        requested.push(commit);
        return route.fulfill({ contentType: 'text/plain', body: RAW_DIFF });
    });
    await page.goto(phi.url);
    await page.locator('#diff-term-container .xterm').first().waitFor();
    if (
        await page
            .locator('#diff-panel')
            .evaluate((el) => el.classList.contains('hidden'))
    ) {
        await page.locator('#header-diff-toggle-btn').click();
    }
    await page.locator('.diff-tab-btn[data-tab="sync"]').click();
    const card = page.locator('.sync-card', { hasText: 'Review this commit' });
    await expect(card.locator('.sync-diff-btn')).toHaveText(
        `Show Diff ${HASH.slice(0, 12)}`,
    );
    await expect(page.locator('#diff-modal')).toBeHidden();
    expect(requested).not.toContain(HASH);

    await card.locator('.sync-diff-btn').click();
    await expect(page.locator('.diff-tab-btn[data-tab="diff"]')).toHaveClass(
        /active/,
    );
    await expect(page.locator('#diff-commit-select')).toHaveValue(HASH);
    await expect.poll(() => requested.includes(HASH)).toBe(true);
    await expect(page.locator('#diff-modal')).toBeHidden();

    // A recent-list refresh must retain the requested old/full hash.
    const reloaded = page.waitForResponse('**/api/git/commits?*');
    await page.locator('#refresh-diff-btn').click();
    await reloaded;
    await expect(page.locator('#diff-commit-select')).toHaveValue(HASH);
    await page.locator('.diff-tab-btn[data-tab="sync"]').click();
    await card.locator('.sync-pretty-diff-btn').click();
    await expect(page.locator('#diff-modal')).toBeVisible();
    await expect(
        page.locator('#diff-modal .d2h-code-line-ctn', {
            hasText: 'requested commit content',
        }),
    ).toBeVisible();
    await expect(page.locator('#diff-commit-select')).toHaveValue(HASH);
    expect(requested.every((commit) => commit === HASH)).toBe(true);
});
