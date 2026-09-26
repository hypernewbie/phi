import { expect, test } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

const RAW_DIFF = `diff --git a/sample.txt b/sample.txt
index 4458ac6..98043d1 100644
--- a/sample.txt
+++ b/sample.txt
@@ -100,4 +100,5 @@
 context one
-old content
+new content
+extra content
 context two
 context three
`;

let phi: PhiServer;

test.beforeAll(async () => {
    phi = await startPhi();
});

test.afterAll(async () => {
    await phi.stop();
});

test('hovering unified old/new lines does not move diff rows; comments and modal sizing work', async ({
    page,
}) => {
    await page.setViewportSize({ width: 1400, height: 850 });
    await page.route('**/api/git/raw-diff?*', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'text/plain',
            body: RAW_DIFF,
        }),
    );
    await page.goto(phi.url);
    await page.locator('#diff-term-container .xterm').first().waitFor();
    const panelHidden = await page
        .locator('#diff-panel')
        .evaluate((el) => el.classList.contains('hidden'));
    if (panelHidden) await page.locator('#header-diff-toggle-btn').click();
    await page.locator('.diff-tab-btn[data-tab="diff"]').click();
    await expect(page.locator('#rich-diff-btn')).toBeVisible();
    await page.locator('#rich-diff-btn').click();

    const modal = page.locator('#diff-modal');
    const content = modal.locator('.md-modal-content');
    const row = modal
        .locator('.d2h-diff-tbody tr:has(.d2h-code-linenumber.d2h-cntx)')
        .first();
    const nextRow = row.locator('xpath=following-sibling::tr[1]');
    await expect(row.locator('.line-num1')).toHaveText('100');
    await expect(row.locator('.line-num2')).toHaveText('100');
    const measure = () =>
        row.evaluate((el) => {
            const following = el.nextElementSibling!;
            const number = el.querySelector('.d2h-code-linenumber')!;
            return {
                rowHeight: el.getBoundingClientRect().height,
                followingTop: following.getBoundingClientRect().top,
                numberHeight: number.getBoundingClientRect().height,
            };
        });
    const before = await measure();
    await row.hover();
    await expect(row.locator('.diff-add-comment-btn')).toBeVisible();
    expect(await measure()).toEqual(before);
    await nextRow.hover();
    expect(await measure()).toEqual(before);
    await row.hover();
    await row.locator('.diff-add-comment-btn').click({ timeout: 5_000 });
    await expect(modal.locator('.diff-comment-editor-row')).toBeVisible();
    await modal.locator('.diff-comment-textarea').fill('Review this line');
    await modal.locator('.diff-comment-save-btn').click();
    await expect(modal.locator('.diff-comment-card-body')).toHaveText(
        'Review this line',
    );

    const size = modal.locator('#diff-modal-size-btn');
    expect((await size.textContent())?.trim()).toBe('');
    expect(await size.evaluate((el) => el.nextElementSibling?.id)).toBe(
        'diff-modal-close',
    );
    await expect(size.locator('svg:visible')).toHaveCount(1);
    const original = await content.boundingBox();
    await size.click();
    await expect(size).toHaveAttribute('aria-pressed', 'true');
    await expect(size).toHaveAttribute(
        'aria-label',
        'Restore diff viewer size',
    );
    await expect(content).toHaveClass(/diff-modal-maximized/);
    await expect(size.locator('svg:visible')).toHaveCount(1);
    const expanded = await content.boundingBox();
    expect(expanded!.width).toBeGreaterThan(original!.width + 20);
    expect(expanded!.width).toBeLessThan(1400);
    expect(expanded!.height).toBeGreaterThan(original!.height);
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    await size.click();
    await expect(size).toHaveAttribute('aria-pressed', 'false');
    await expect(size).toHaveAttribute('aria-label', 'Maximize diff viewer');
    await expect(content).not.toHaveClass(/diff-modal-maximized/);
    expect((await content.boundingBox())!.width).toBe(original!.width);
    await expect(modal.locator('.diff-comment-card-body')).toHaveText(
        'Review this line',
    );

    await modal.locator('#diff-layout-toggle-btn').click();
    await expect(
        modal.locator('.diff-comment-card-body', {
            hasText: 'Review this line',
        }),
    ).toHaveCount(1);
    const added = modal
        .locator(
            '.d2h-file-side-diff .d2h-diff-tbody tr:has(.d2h-code-side-linenumber.d2h-ins)',
        )
        .first();
    const sideBefore = await added.evaluate((el) => ({
        height: el.getBoundingClientRect().height,
        followingTop: el.nextElementSibling!.getBoundingClientRect().top,
    }));
    await added.hover();
    expect(
        await added.evaluate((el) => ({
            height: el.getBoundingClientRect().height,
            followingTop: el.nextElementSibling!.getBoundingClientRect().top,
        })),
    ).toEqual(sideBefore);
    await added.locator('.diff-add-comment-btn').click({ timeout: 5_000 });
    await modal.locator('.diff-comment-textarea').fill('Side note');
    await modal.locator('.diff-comment-save-btn').click();
    await expect(
        modal.locator('.diff-comment-card-body', { hasText: 'Side note' }),
    ).toHaveCount(1);
    await expect(
        modal
            .locator('.d2h-file-side-diff')
            .first()
            .locator('tr:has(.d2h-code-side-linenumber.d2h-del)')
            .first(),
    ).not.toHaveClass(/d2h-has-comment/);

    // Context after an extra insertion has different old/new numbers.
    // Click the OLD pane, then verify the note has one owner and survives
    // switching back to unified view with the correct new-line badge.
    const panes = modal.locator('.d2h-file-side-diff');
    const oldContext = panes
        .first()
        .locator(
            'tr:has(.d2h-code-side-linenumber.d2h-cntx:not(.d2h-emptyplaceholder))',
        )
        .nth(1);
    const newContext = panes
        .nth(1)
        .locator(
            'tr:has(.d2h-code-side-linenumber.d2h-cntx:not(.d2h-emptyplaceholder))',
        )
        .nth(1);
    await expect(oldContext.locator('.d2h-code-side-linenumber')).toContainText(
        '102',
    );
    await expect(newContext.locator('.d2h-code-side-linenumber')).toContainText(
        '103',
    );
    await oldContext.hover();
    await oldContext.locator('.diff-add-comment-btn').click({ timeout: 5_000 });
    await modal.locator('.diff-comment-textarea').fill('Offset note');
    await modal.locator('.diff-comment-save-btn').click();
    await expect(
        panes
            .first()
            .locator('.diff-comment-card-body', { hasText: 'Offset note' }),
    ).toHaveCount(1);
    await expect(
        panes
            .nth(1)
            .locator('.diff-comment-card-body', { hasText: 'Offset note' }),
    ).toHaveCount(0);
    await expect(modal.locator('.diff-review-count-badge')).toHaveText('3');
    await modal.locator('#diff-layout-toggle-btn').click();
    await expect(
        modal.locator('.diff-comment-card-body', { hasText: 'Offset note' }),
    ).toHaveCount(1);
    await expect(
        modal
            .locator('.diff-comment-card', { hasText: 'Offset note' })
            .locator('.diff-comment-target-badge'),
    ).toHaveText('sample.txt:103');
});

test('modal size toggle remains an in-page dialog on a narrow viewport', async ({
    page,
}) => {
    await page.setViewportSize({ width: 420, height: 800 });
    await page.route('**/api/git/raw-diff?*', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'text/plain',
            body: RAW_DIFF,
        }),
    );
    await page.goto(phi.url);
    await page.locator('#diff-term-container .xterm').first().waitFor();
    const panel = page.locator('#diff-panel');
    if (!(await panel.evaluate((el) => el.classList.contains('mobile-open')))) {
        await page.locator('#header-diff-toggle-btn').click();
    }
    await page
        .locator('.diff-tab-btn[data-tab="diff"]')
        .click({ timeout: 5_000 });
    await page.locator('#rich-diff-btn').click();
    const modal = page.locator('#diff-modal');
    const content = modal.locator('.md-modal-content');
    const size = modal.locator('#diff-modal-size-btn');
    await expect(size).toBeVisible();
    await size.click();
    const box = (await content.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(10);
    expect(box.x + box.width).toBeLessThanOrEqual(410);
    expect(box.height).toBeLessThan(800);
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    await size.click();
    await expect(content).not.toHaveClass(/diff-modal-maximized/);
});
