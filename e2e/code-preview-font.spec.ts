import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startPhi, type PhiServer } from './_server.js';

const source =
    '#include <iostream>\n\nint main() {\n\tconst char* text = "<tag>& literal text";  \n\t// ' +
    'long source line '.repeat(20) +
    '\n\tstd::cout << text;\n\treturn 0;\n}\n';
let phi: PhiServer;

test.beforeAll(async () => {
    phi = await startPhi();
    writeFileSync(join(phi.dir, 'preview.cpp'), source);
});
test.afterAll(async () => {
    await phi.stop();
});

for (const [width, highlight] of [
    [1400, true],
    [420, true],
    [1400, false],
] as const) {
    test(`C++ preview uses readable monospace text (${width}px, highlight ${highlight})`, async ({
        page,
    }) => {
        await page.setViewportSize({ width, height: 850 });
        await page.goto(phi.url);
        await page
            .locator('#diff-term-container .xterm')
            .first()
            .waitFor({ state: 'attached' });
        if (!highlight)
            await page.evaluate(() => {
                (window as unknown as { hljs?: unknown }).hljs = undefined;
            });
        const panel = page.locator('#diff-panel');
        const closed = await panel.evaluate(
            (el, mobile) =>
                mobile
                    ? !el.classList.contains('mobile-open')
                    : el.classList.contains('hidden'),
            width < 768,
        );
        if (closed) await page.locator('#header-diff-toggle-btn').click();
        await page.locator('.diff-tab-btn[data-tab="files"]').click();
        await page
            .locator('#file-tree-list .md-file-row', { hasText: 'preview.cpp' })
            .locator('.md-file-item')
            .click();
        const code = page.locator('#md-modal-body pre > code.language-cpp');
        await expect(code).toBeVisible();
        expect(await code.textContent()).toBe(source);
        const typography = await code.evaluate((el) => {
            const style = getComputedStyle(el);
            return {
                size: parseFloat(style.fontSize),
                family: style.fontFamily,
                lineHeight: parseFloat(style.lineHeight),
            };
        });
        expect(typography.size).toBe(14);
        expect(typography.family).toContain('JetBrains Mono');
        expect(typography.lineHeight).toBeCloseTo(22.4, 1);
        if (highlight)
            await expect(code.locator('.hljs-keyword').first()).toBeVisible();
        else await expect(code.locator('span')).toHaveCount(0);
        // Source text stays literal, including tabs/trailing spaces and HTML-like strings.
        await expect(code.locator('tag')).toHaveCount(0);
        await page.locator('#md-modal-size-btn').click();
        expect(await code.evaluate((el) => getComputedStyle(el).fontSize)).toBe(
            '14px',
        );
        expect(await code.textContent()).toBe(source);
        await page.locator('#md-modal-close').click();
        await expect(page.locator('#md-modal')).toBeHidden();
    });
}
