import { expect, test, type Page } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

const RAW_DIFF = [
    'diff --git a/sample.ts b/sample.ts',
    'index 1111111..2222222 100644',
    '--- a/sample.ts',
    '+++ b/sample.ts',
    '@@ -1,3 +1,3 @@',
    ' function example() {',
    '-\treturn 1; \t',
    '+\treturn 2; \t',
    ' }',
    '',
].join('\n');

let phi: PhiServer;

test.beforeAll(async () => {
    phi = await startPhi();
});

test.afterAll(async () => {
    await phi.stop();
});

async function openDiff(page: Page, lineEnding: string) {
    await page.setViewportSize({ width: 1400, height: 850 });
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
                writeText: async (text: string) => {
                    (
                        window as unknown as { copiedReview: string }
                    ).copiedReview = text;
                },
            },
        });
    });
    await page.route('**/api/git/raw-diff?*', (route) =>
        route.fulfill({
            contentType: 'text/plain',
            body:
                lineEnding === 'CRLF'
                    ? RAW_DIFF.replaceAll('\n', '\r\n')
                    : RAW_DIFF,
        }),
    );
    await page.goto(phi.url);
    await page
        .locator('#diff-term-container .xterm')
        .first()
        .waitFor({ state: 'attached' });
    if (
        await page
            .locator('#diff-panel')
            .evaluate((el) => el.classList.contains('hidden'))
    ) {
        await page.locator('#header-diff-toggle-btn').click();
    }
    await page.locator('.diff-tab-btn[data-tab="diff"]').click();
    await page.locator('#rich-diff-btn').click();
    return page.locator('#diff-modal');
}

for (const lineEnding of ['LF', 'CRLF']) {
    for (const layout of ['unified', 'side-by-side']) {
        for (const highlighted of [false, true]) {
            test(`${layout} ${lineEnding}, syntax ${highlighted ? 'on' : 'off'}: Copy and Apply preserve source whitespace`, async ({
                page,
            }, testInfo) => {
                const modal = await openDiff(page, lineEnding);
                if (layout === 'side-by-side')
                    await modal.locator('#diff-layout-toggle-btn').click();
                if (highlighted)
                    await modal.locator('#diff-syntax-toggle-btn').click();
                const row = modal
                    .locator('.d2h-diff-tbody tr:has(td.d2h-ins)')
                    .filter({ hasText: 'return 2;' })
                    .first();
                await expect(row).toBeVisible();
                if (highlighted)
                    await expect(row.locator('.d2h-code-line-ctn')).toHaveClass(
                        /hljs/,
                    );
                await row.hover();
                await row.locator('.diff-add-comment-btn').click();
                const comment =
                    'Why is this value different?\n\n    Keep my comment indentation.';
                await modal.locator('.diff-comment-textarea').fill(comment);
                await modal.locator('.diff-comment-save-btn').click();
                await expect(
                    modal.locator('.diff-review-count-badge'),
                ).toHaveText('1');
                const drafts = await page.evaluate(
                    () =>
                        Object.keys(localStorage)
                            .filter((key) =>
                                key.startsWith('phi_diff_review_draft'),
                            )
                            .flatMap((key) =>
                                JSON.parse(localStorage.getItem(key) || '[]'),
                            ) as Array<{
                            codeSnippet: string;
                            commentText: string;
                        }>,
                );
                await modal.locator('#diff-review-copy-btn').click();
                const copied = await page.evaluate(
                    () =>
                        (window as unknown as { copiedReview: string })
                            .copiedReview,
                );
                await modal.locator('#diff-review-apply-btn').click();
                const staged = await page
                    .locator('#input-textarea')
                    .inputValue();
                await testInfo.attach('review-prompt.json', {
                    body: JSON.stringify(
                        {
                            layout,
                            lineEnding,
                            highlighted,
                            drafts,
                            copied,
                            staged,
                        },
                        null,
                        2,
                    ),
                    contentType: 'application/json',
                });
                const expectedLines =
                    layout === 'unified'
                        ? [
                              ' function example() {',
                              '-\treturn 1; \t',
                              '+\treturn 2; \t',
                              ' }',
                          ]
                        : [' function example() {', '+\treturn 2; \t', ' }'];
                expect(drafts[0].codeSnippet).toBe(expectedLines.join('\n'));
                expect(copied).toBe(staged);
                expect(staged).toContain(comment);
                expect(staged).toContain(
                    `> \`\`\`ts\n${expectedLines.map((line) => `> ${line}`).join('\n')}\n> \`\`\``,
                );
                expect(staged).not.toContain('\r');
                expect(staged).not.toContain('\u00a0');
            });
        }
    }
}

test('an existing broken draft is cleaned on Copy, edit, and Apply without changing its saved context', async ({
    page,
}) => {
    await page.addInitScript(() => {
        // The constructor reads the blank-CWD fallback before workspace
        // startup. Seed that scope to isolate legacy text migration.
        localStorage.setItem(
            'phi_diff_review_draft_',
            JSON.stringify([
                {
                    id: 'legacy',
                    filePath: 'sample.ts',
                    oldLineNumber: null,
                    newLineNumber: 2,
                    lineType: 'insert',
                    createdAt: 1,
                    // Deliberately different from today's diff: migration must
                    // preserve the saved context, not invent newer source code.
                    codeSnippet:
                        '\n            \u00a0\n            original context\n\n            +\n                original source',
                    commentText: 'Keep this old review',
                },
            ]),
        );
    });
    const modal = await openDiff(page, 'LF');
    await expect(modal.locator('.diff-comment-card-body')).toHaveText(
        'Keep this old review',
    );
    await modal.locator('#diff-review-copy-btn').click();
    const copied = await page.evaluate(
        () => (window as unknown as { copiedReview: string }).copiedReview,
    );
    const snippet =
        '> ```ts\n>  original context\n> +    original source\n> ```';
    expect(copied).toContain(snippet);
    expect(copied).not.toContain('return 2;');
    await modal.locator('.diff-comment-card-btn', { hasText: 'Edit' }).click();
    await modal
        .locator('.diff-comment-textarea')
        .fill('Keep this old review, edited');
    await modal.locator('.diff-comment-save-btn').click();
    const storedSnippet = await page.evaluate(
        () =>
            Object.keys(localStorage)
                .filter((key) => key.startsWith('phi_diff_review_draft'))
                .flatMap((key) => JSON.parse(localStorage.getItem(key) || '[]'))
                .find(
                    (draft) =>
                        draft.commentText === 'Keep this old review, edited',
                )?.codeSnippet,
    );
    expect(storedSnippet).toBe(' original context\n+    original source');
    await modal.locator('#diff-review-apply-btn').click();
    const staged = await page.locator('#input-textarea').inputValue();
    expect(staged).toContain(snippet);
    expect(staged).toContain('Keep this old review, edited');
});
