// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { html, parse } from 'diff2html';
import createDOMPurify from 'dompurify';
import { setupDomHarness, stubWebSocket } from './_dom.js';
import { DIFF_LINE_CLIP_CHARS, DiffController } from '../web/diff.js';

setupDomHarness();

let ctrl;
let copy;

beforeEach(() => {
    stubWebSocket();
    vi.stubGlobal('innerWidth', 1600);
    vi.stubGlobal('Diff2Html', { html, parse });
    vi.stubGlobal('DOMPurify', createDOMPurify(window));
    document.body.innerHTML = `
        <div id="diff-panel"></div>
        <button id="header-diff-toggle-btn"></button>
        <button id="close-diff-btn"></button>
        <button id="refresh-diff-btn"></button>
        <div id="diff-modal"><div id="diff-modal-body"></div></div>
    `;
    copy = vi.fn();
    ctrl = new DiffController({
        showToast: vi.fn(),
        tabManager: { copyTextRobustly: copy },
        sessionsManager: { activeCWD: '/project' },
    });
    ctrl.activeDiffRoot = '/project';
});

function patch(oldLine, newLine) {
    return `diff --git a/data.json b/data.json
--- a/data.json
+++ b/data.json
@@ -10,3 +40,3 @@ function heading
 before
-${oldLine}
+${newLine}
 after
`;
}

function codeLines(selector = '.d2h-code-line-ctn') {
    return [...ctrl.diffModalBody.querySelectorAll(selector)];
}

function preview(length, prefix) {
    return `…[${length.toLocaleString()}-char line, first ${prefix.length.toLocaleString()} shown] ${prefix}`;
}

describe('long-line previews with the real diff2html renderer', () => {
    it.each(['line-by-line', 'side-by-side'])(
        'bounds text without running the word highlighter on previews (%s)',
        (layout) => {
            ctrl.currentLayout = layout;
            const n = DIFF_LINE_CLIP_CHARS;
            const oldLine = 'foo '.repeat(n * 4);
            const newLine = 'bar '.repeat(n * 4);
            ctrl.renderRichDiff(patch(oldLine, newLine));

            const [oldCode] = codeLines('.d2h-del .d2h-code-line-ctn');
            const [newCode] = codeLines('.d2h-ins .d2h-code-line-ctn');
            expect(oldCode.textContent).toBe(
                preview(oldLine.length, oldLine.slice(0, n)),
            );
            expect(newCode.textContent).toBe(
                preview(newLine.length, newLine.slice(0, n)),
            );
            expect(oldCode.querySelector('del')).toBeNull();
            expect(newCode.querySelector('ins')).toBeNull();
            expect(ctrl._extractLineInfo(oldCode.closest('tr'))).toEqual({
                filePath: 'data.json',
                oldLineNumber: 11,
                newLineNumber: null,
                lineType: 'delete',
            });
            expect(ctrl._extractLineInfo(newCode.closest('tr'))).toEqual({
                filePath: 'data.json',
                oldLineNumber: null,
                newLineNumber: 41,
                lineType: 'insert',
            });
        },
    );

    it('keeps ordinary code, word highlights, and hunk headings', () => {
        ctrl.renderRichDiff(patch('const count = 1;', 'const count = 2;'));

        expect(codeLines().map((line) => line.textContent)).toEqual([
            'before',
            'const count = 1;',
            'const count = 2;',
            'after',
        ]);
        expect(codeLines('.d2h-code-line-ctn del')[0].textContent).toBe('1');
        expect(codeLines('.d2h-code-line-ctn ins')[0].textContent).toBe('2');
        expect(ctrl.diffModalBody.textContent).toContain('function heading');
        expect(
            ctrl.diffModalBody.querySelector('.git-diff-preview-note'),
        ).toBeNull();
    });

    it('preserves combined-diff markers, hunk line numbers, and file boundaries', () => {
        const long = 'a'.repeat(DIFF_LINE_CLIP_CHARS + 1);
        const merge = `diff --cc merge.txt
index 1111111,2222222..3333333
--- a/merge.txt
+++ b/merge.txt
@@@ -8,3 -8,3 +17,3 @@@
  before
- ${long}
 -other parent
++${long}
  after
diff --cc other.txt
index 1111111,2222222..3333333
--- a/other.txt
+++ b/other.txt
@@@ -4 -4 +4 @@@
- retired
 -obsolete
++ready
`;
        ctrl.renderRichDiff(merge);

        expect(
            codeLines('.d2h-file-header .d2h-file-name').map(
                (el) => el.textContent,
            ),
        ).toEqual(['merge.txt', 'other.txt']);
        const firstFile = ctrl.diffModalBody.querySelector('.d2h-file-wrapper');
        const firstFileRows = [
            ...firstFile.querySelectorAll('.d2h-code-line-ctn'),
        ];
        const expectedTypes = parse(
            merge.split('diff --cc other.txt')[0],
        )[0].blocks[0].lines.map((line) => [
            line.type,
            line.oldNumber ?? null,
            line.newNumber ?? null,
        ]);
        expect(
            firstFileRows.map((line) => {
                const info = ctrl._extractLineInfo(line.closest('tr'));
                return [info.lineType, info.oldLineNumber, info.newLineNumber];
            }),
        ).toEqual(expectedTypes);
        const clipped = preview(
            long.length,
            long.slice(0, DIFF_LINE_CLIP_CHARS),
        );
        expect(firstFileRows.map((line) => line.textContent)).toEqual([
            'before',
            clipped,
            'other parent',
            clipped,
            'after',
        ]);
    });

    it('does not split an emoji at the boundary and copies the original patch', () => {
        const prefix = 'x'.repeat(DIFF_LINE_CLIP_CHARS - 1);
        const long = `${prefix}🙂 end of line`;
        const exact = 'q'.repeat(DIFF_LINE_CLIP_CHARS);
        const raw = patch(exact, long).replaceAll('\n', '\r\n');
        ctrl.renderRichDiff(raw);

        expect(codeLines('.d2h-del .d2h-code-line-ctn')[0].textContent).toBe(
            exact,
        );
        expect(codeLines('.d2h-ins .d2h-code-line-ctn')[0].textContent).toBe(
            preview(long.length, prefix),
        );
        const button = ctrl.diffModalBody.querySelector(
            '.git-diff-preview-note button',
        );
        expect(button.textContent).toBe('Copy full patch');
        button.click();
        expect(copy).toHaveBeenCalledExactlyOnceWith(raw);

        ctrl.renderRichDiff(patch('one', 'two'));
        expect(
            ctrl.diffModalBody.querySelector('.git-diff-preview-note'),
        ).toBeNull();
    });
});
