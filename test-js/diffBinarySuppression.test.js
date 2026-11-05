// @vitest-environment jsdom
/**
 * DiffController — binary diff suppression.
 *
 * A binary blob has no line structure to render, so binary file sections are
 * dropped from the patch before diff2html sees it. We assert:
 *   - diff2html receives text without the binary section
 *   - text files around the binary keep their section, byte for byte
 *   - one muted note names the skipped files
 *   - a diff made only of binary changes reports the count instead of
 *     rendering an empty panel
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness, stubWebSocket } from './_dom.js';
import { DiffController } from '../web/diff.js';

setupDomHarness();

beforeEach(() => {
    stubWebSocket();
});

function bootstrapDiffDom() {
    document.body.innerHTML = `
        <div id="diff-panel"></div>
        <button id="header-diff-toggle-btn"></button>
        <button id="close-diff-btn"></button>
        <button id="refresh-diff-btn"></button>
        <button id="copy-diff-btn"></button>
        <div id="diff-term-container"></div>
        <select id="diff-commit-select"></select>
        <div id="diff-action-bar">
            <a id="diff-vscode-local-btn" class="ft-vscode-btn ft-vscode-btn-compact hidden" href="#"></a>
            <a id="diff-vscode-remote-btn" class="ft-vscode-btn ft-vscode-btn-compact hidden" href="#"></a>
        </div>
        <button id="rich-diff-btn"></button>
        <div id="diff-modal" class="hidden">
            <button id="diff-layout-toggle-btn">Side-by-Side</button>
            <button id="diff-context-toggle-btn">More context</button>
            <button id="diff-syntax-toggle-btn">Syntax On</button>
            <button id="diff-modal-close"></button>
            <div id="diff-modal-body"></div>
        </div>
    `;
}

function buildAppStub({
    cwd = '/home/user/project',
    hostname = 'jupiter',
} = {}) {
    return {
        showToast: vi.fn(),
        tabManager: {
            getActiveTab: vi.fn(() => ({ cwd })),
            copyTextRobustly: vi.fn(),
        },
        sessionsManager: {
            activeCWD: cwd,
            loadConfig: vi.fn().mockResolvedValue(undefined),
        },
        hostname,
    };
}

/** Diff2Html stub that renders one `.d2h-file-wrapper` per `diff --git`
 *  section in the text it actually receives, so tests can prove which
 *  sections reached the renderer. */
function installDiff2HtmlSpy() {
    const html = vi.fn((text) => {
        const headers = text
            .split('\n')
            .filter((line) => line.startsWith('diff --git '));
        return `<div class="d2h-wrapper">${headers
            .map(
                (header) => `
                <div class="d2h-file-wrapper">
                    <div class="d2h-file-header">
                        <span class="d2h-file-name">${header.split(' b/').pop()}</span>
                    </div>
                </div>`,
            )
            .join('')}</div>`;
    });
    const parse = vi.fn((text) =>
        text
            .split('\n')
            .filter((line) => line.startsWith('diff --git '))
            .map((header) => ({ newName: header.split(' b/').pop() })),
    );
    window.Diff2Html = { parse, html, sanitize: vi.fn((s) => s) };
    window.DOMPurify = window.DOMPurify || { sanitize: vi.fn((s) => s) };
    return { parse, html };
}

function buildController() {
    const diffCtrl = new DiffController(
        buildAppStub({ cwd: '/home/alex/phi', hostname: 'jupiter' }),
    );
    diffCtrl.activeDiffRoot = '/home/alex/phi';
    diffCtrl.activeDiffHostname = 'jupiter';
    return diffCtrl;
}

const TEXT_SECTION = `diff --git a/src/main.go b/src/main.go
index 1111111..2222222 100644
--- a/src/main.go
+++ b/src/main.go
@@ -1 +1 @@
-old
+new`;

const BINARY_SECTION = `diff --git a/logo.png b/logo.png
new file mode 100644
Binary files /dev/null and b/logo.png differ`;

describe('DiffController — binary sections are not rendered', () => {
    beforeEach(() => {
        bootstrapDiffDom();
    });

    it('drops the binary section and renders the text section', () => {
        const { html, parse } = installDiff2HtmlSpy();
        const diffCtrl = buildController();
        diffCtrl.renderRichDiff(`${BINARY_SECTION}\n${TEXT_SECTION}\n`);

        const renderedText = html.mock.calls[0][0];
        expect(renderedText).not.toContain('logo.png');
        expect(renderedText).not.toContain('Binary files');
        expect(renderedText).toContain(
            'diff --git a/src/main.go b/src/main.go',
        );
        expect(renderedText).toContain('+new');
        expect(parse.mock.calls[0][0]).toBe(renderedText);

        const wrappers =
            diffCtrl.diffModalBody.querySelectorAll('.d2h-file-wrapper');
        expect(wrappers.length).toBe(1);
    });

    it('names skipped binaries in one muted note', () => {
        installDiff2HtmlSpy();
        const diffCtrl = buildController();
        diffCtrl.renderRichDiff(`${BINARY_SECTION}\n${TEXT_SECTION}\n`);

        const note = diffCtrl.diffModalBody.querySelector('.git-binary-note');
        expect(note).not.toBeNull();
        expect(note.textContent).toBe('Skipped 1 binary file: logo.png');
    });

    it('caps the note at five names', () => {
        installDiff2HtmlSpy();
        const diffCtrl = buildController();
        const binaries = Array.from(
            { length: 7 },
            (_, i) => `diff --git a/img${i}.png b/img${i}.png
Binary files /dev/null and b/img${i}.png differ`,
        ).join('\n');
        diffCtrl.renderRichDiff(`${binaries}\n${TEXT_SECTION}\n`);

        const note = diffCtrl.diffModalBody.querySelector('.git-binary-note');
        expect(note.textContent).toBe(
            'Skipped 7 binary files: img0.png, img1.png, img2.png, img3.png, img4.png, +2 more',
        );
    });

    it('reports a binary-only diff instead of rendering an empty panel', () => {
        const { html } = installDiff2HtmlSpy();
        const diffCtrl = buildController();
        diffCtrl.renderRichDiff(`${BINARY_SECTION}\n`);

        expect(html).not.toHaveBeenCalled();
        const text = diffCtrl.diffModalBody.textContent;
        expect(text).toContain('Only binary changes (1)');
        expect(text).not.toContain('Binary files');
    });
});

describe('DiffController — _splitDiffChunks', () => {
    beforeEach(() => {
        bootstrapDiffDom();
    });

    it('round-trips the patch text exactly', () => {
        const diffCtrl = buildController();
        const raw = `${BINARY_SECTION}\n${TEXT_SECTION}\n`;
        const rebuilt = diffCtrl
            ._splitDiffChunks(raw)
            .map((chunk) => chunk.text)
            .join('\n');
        expect(rebuilt).toBe(raw);
    });

    it('flags binary markers and keeps the destination name', () => {
        const diffCtrl = buildController();
        const chunks = diffCtrl._splitDiffChunks(
            `${BINARY_SECTION}\n${TEXT_SECTION}\n`,
        );
        expect(chunks.map((c) => [c.name, c.isBinary])).toEqual([
            ['logo.png', true],
            ['src/main.go', false],
        ]);
    });

    it('treats GIT binary patch sections as binary', () => {
        const diffCtrl = buildController();
        const chunks = diffCtrl._splitDiffChunks(
            'diff --git a/a.bin b/a.bin\nGIT binary patch\nliteral 4\n',
        );
        expect(chunks[0].isBinary).toBe(true);
    });

    it('starts a new section at a quoted path header', () => {
        // Git quotes paths that need it. A quoted header that did not
        // split would merge the file into the previous section — and a
        // binary neighbour would swallow this file's diff.
        const diffCtrl = buildController();
        const quoted = `diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"
--- "a/caf\\303\\251.txt"
+++ "b/caf\\303\\251.txt"
@@ -1 +1 @@
-old
+new`;
        const chunks = diffCtrl._splitDiffChunks(
            `${BINARY_SECTION}\n${quoted}\n`,
        );
        expect(chunks.map((c) => [c.name, c.isBinary])).toEqual([
            ['logo.png', true],
            ['caf\\303\\251.txt', false],
        ]);
    });

    it('keeps a quoted-path text file when a binary file precedes it', () => {
        installDiff2HtmlSpy();
        const diffCtrl = buildController();
        const quoted = `diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"
--- "a/caf\\303\\251.txt"
+++ "b/caf\\303\\251.txt"
@@ -1 +1 @@
-old
+new`;
        diffCtrl.renderRichDiff(`${BINARY_SECTION}\n${quoted}\n`);

        const rendered = window.Diff2Html.html.mock.calls[0][0];
        expect(rendered).toContain('caf');
        expect(rendered).toContain('+new');
        expect(rendered).not.toContain('logo.png');
    });

    it('drops a section whose bytes leaked in without a binary marker', () => {
        // A cache written before the server marked binaries, or an older
        // server, delivers raw bytes as added lines. A NUL byte cannot
        // appear in a text patch, so its presence is proof the section
        // has no line structure.
        const diffCtrl = buildController();
        const leaked = `diff --git a/logo.png b/logo.png
new file mode 100644
--- /dev/null
+++ b/logo.png
@@ -0,0 +1,2 @@
+\u0000\u0089PNG
+IHDR`;
        const chunks = diffCtrl._splitDiffChunks(
            `${leaked}\n${TEXT_SECTION}\n`,
        );
        expect(chunks.map((c) => [c.name, c.isBinary])).toEqual([
            ['logo.png', true],
            ['src/main.go', false],
        ]);
    });

    it('renders the leaked section as skipped, not as bytes', () => {
        installDiff2HtmlSpy();
        const diffCtrl = buildController();
        const leaked = `diff --git a/logo.png b/logo.png
new file mode 100644
--- /dev/null
+++ b/logo.png
@@ -0,0 +1,1 @@
+\u0000\u0089PNG`;
        diffCtrl.renderRichDiff(`${leaked}\n${TEXT_SECTION}\n`);

        const body = diffCtrl.diffModalBody;
        expect(body.textContent).not.toContain('PNG');
        expect(body.textContent).not.toContain('\u0000');
        const note = body.querySelector('.git-binary-note');
        expect(note.textContent).toBe('Skipped 1 binary file: logo.png');
        expect(body.querySelectorAll('.d2h-file-wrapper').length).toBe(1);
    });
});
