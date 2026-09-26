// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness, stubWebSocket } from './_dom.js';
import {
    DiffController,
    nodeStream,
    mergeStreams,
    escapeDiffHtml,
    DIFF_EXT_TO_HLJS,
} from '../web/diff.js';

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
        <div id="diff-action-bar"></div>
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

function buildAppStub() {
    return {
        showToast: vi.fn(),
        tabManager: {
            getActiveTab: vi.fn(() => ({ cwd: '/home/user/project' })),
            copyTextRobustly: vi.fn(),
        },
        sessionsManager: {
            activeCWD: '/home/user/project',
            loadConfig: vi.fn().mockResolvedValue(undefined),
        },
    };
}

describe('Diff syntax highlighting DOM stream helpers', () => {
    it('escapes HTML special characters correctly', () => {
        expect(escapeDiffHtml('foo & bar < baz > qux')).toBe(
            'foo &amp; bar &lt; baz &gt; qux',
        );
    });

    it('nodeStream computes accurate character offsets for nested tags', () => {
        const div = document.createElement('div');
        div.innerHTML = 'hello <ins>world</ins>!';
        const stream = nodeStream(div);
        expect(stream).toHaveLength(2); // start and stop for <ins>
        expect(stream[0]).toMatchObject({ event: 'start', offset: 6 });
        expect(stream[1]).toMatchObject({ event: 'stop', offset: 11 });
    });

    it('mergeStreams merges word-diff tags with syntax highlight spans', () => {
        // Line with word diff: function foo(<ins>bar</ins>) {
        const line = document.createElement('span');
        line.innerHTML = 'function foo(<ins>bar</ins>) {';
        const origStream = nodeStream(line);

        // Simulated hljs highlight: <span class="hljs-keyword">function</span> <span class="hljs-title">foo</span>(<span class="hljs-params">bar</span>) {
        const hlNode = document.createElement('div');
        hlNode.innerHTML =
            '<span class="hljs-keyword">function</span> <span class="hljs-title">foo</span>(<span class="hljs-params">bar</span>) {';
        const hlStream = nodeStream(hlNode);

        const merged = mergeStreams(
            origStream,
            hlStream,
            'function foo(bar) {',
        );
        expect(merged).toContain('<span class="hljs-keyword">function</span>');
        expect(merged).toContain('<span class="hljs-title">foo</span>');
        expect(merged).toContain(
            '<ins><span class="hljs-params">bar</span></ins>',
        );
    });

    it('maps standard programming file extensions to highlight.js language names', () => {
        expect(DIFF_EXT_TO_HLJS.ts).toBe('typescript');
        expect(DIFF_EXT_TO_HLJS.js).toBe('javascript');
        expect(DIFF_EXT_TO_HLJS.go).toBe('go');
        expect(DIFF_EXT_TO_HLJS.py).toBe('python');
        expect(DIFF_EXT_TO_HLJS.rs).toBe('rust');
        expect(DIFF_EXT_TO_HLJS.css).toBe('css');
    });
});

describe('DiffController syntax highlighting & context buttons', () => {
    beforeEach(() => {
        bootstrapDiffDom();
        if (typeof window !== 'undefined') {
            window.hljs = {
                highlight: vi.fn((text, opts) => ({
                    value: `<span class="hljs-keyword">${text}</span>`,
                    language: opts.language,
                })),
                getLanguage: vi.fn((lang) =>
                    lang !== 'unsupported' ? {} : undefined,
                ),
            };
            window.Diff2Html = {
                html: vi.fn(
                    () => `
                    <div class="d2h-wrapper">
                        <div class="d2h-file-wrapper" data-lang="js">
                            <div class="d2h-file-header">
                                <span class="d2h-file-name">app.js</span>
                            </div>
                            <div class="d2h-code-line">
                                <span class="d2h-code-line-ctn">const x = 1;</span>
                            </div>
                        </div>
                    </div>
                `,
                ),
            };
        }
    });

    it('initializes context button with "More context" and toggles to "Less context"', async () => {
        const app = buildAppStub();
        const diffCtrl = new DiffController(app);
        diffCtrl.loadRichDiff = vi.fn().mockResolvedValue(undefined);

        const contextBtn = document.getElementById('diff-context-toggle-btn');
        expect(contextBtn?.textContent).toBe('More context');

        await diffCtrl.toggleRichDiffContext();
        expect(diffCtrl.currentContextLines).toBe(30);
        expect(contextBtn?.textContent).toBe('Less context');

        await diffCtrl.toggleRichDiffContext();
        expect(diffCtrl.currentContextLines).toBe(3);
        expect(contextBtn?.textContent).toBe('More context');
    });

    it('initializes syntax button with "Syntax On", toggles to "Syntax Off" with active class', () => {
        const app = buildAppStub();
        const diffCtrl = new DiffController(app);
        const syntaxBtn = document.getElementById('diff-syntax-toggle-btn');

        expect(diffCtrl.syntaxHighlightEnabled).toBe(false);
        expect(syntaxBtn?.textContent).toBe('Syntax On');
        expect(syntaxBtn?.classList.contains('active')).toBe(false);

        diffCtrl.toggleRichDiffSyntax();
        expect(diffCtrl.syntaxHighlightEnabled).toBe(true);
        expect(syntaxBtn?.textContent).toBe('Syntax Off');
        expect(syntaxBtn?.classList.contains('active')).toBe(true);
        expect(localStorage.getItem('phi_diff_syntax_highlight')).toBe('true');

        diffCtrl.toggleRichDiffSyntax();
        expect(diffCtrl.syntaxHighlightEnabled).toBe(false);
        expect(syntaxBtn?.textContent).toBe('Syntax On');
        expect(syntaxBtn?.classList.contains('active')).toBe(false);
        expect(localStorage.getItem('phi_diff_syntax_highlight')).toBe('false');
    });

    it('applies syntax highlighting to rendered diff elements when enabled', () => {
        const app = buildAppStub();
        const diffCtrl = new DiffController(app);
        diffCtrl.syntaxHighlightEnabled = true;

        diffCtrl.renderRichDiff('diff --git a/app.js b/app.js\n...');

        const lineCtn =
            diffCtrl.diffModalBody?.querySelector('.d2h-code-line-ctn');
        expect(lineCtn?.classList.contains('hljs')).toBe(true);
        expect(lineCtn?.innerHTML).toContain('hljs-keyword');
        expect(window.hljs.highlight).toHaveBeenCalled();
    });

    it('skips syntax highlighting and alerts toast if diff exceeds 10,000 lines', () => {
        const app = buildAppStub();
        const diffCtrl = new DiffController(app);
        diffCtrl.syntaxHighlightEnabled = true;

        // Build a mock DOM with >10,000 code lines
        const linesHtml = Array.from(
            { length: 10001 },
            (_, i) =>
                `<div class="d2h-code-line"><span class="d2h-code-line-ctn">line ${i}</span></div>`,
        ).join('');
        window.Diff2Html.html = vi.fn(
            () => `
            <div class="d2h-wrapper">
                <div class="d2h-file-wrapper" data-lang="js">
                    <span class="d2h-file-name">huge.js</span>
                    ${linesHtml}
                </div>
            </div>
        `,
        );

        diffCtrl.renderRichDiff('diff --git a/huge.js b/huge.js\n...');

        expect(diffCtrl.syntaxHighlightEnabled).toBe(false);
        expect(app.showToast).toHaveBeenCalledWith(
            expect.stringContaining('max 10,000 for syntax highlighting'),
            { type: 'info' },
        );
        const syntaxBtn = document.getElementById('diff-syntax-toggle-btn');
        expect(syntaxBtn?.textContent).toBe('Syntax On');
    });

    it('skips lockfiles like pnpm-lock.yaml and go.sum', () => {
        const app = buildAppStub();
        const diffCtrl = new DiffController(app);
        diffCtrl.syntaxHighlightEnabled = true;

        window.Diff2Html.html = vi.fn(
            () => `
            <div class="d2h-wrapper">
                <div class="d2h-file-wrapper" data-lang="yaml">
                    <span class="d2h-file-name">pnpm-lock.yaml</span>
                    <div class="d2h-code-line"><span class="d2h-code-line-ctn">lockfileVersion: 5.4</span></div>
                </div>
            </div>
        `,
        );

        diffCtrl.renderRichDiff(
            'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml\n...',
        );

        const lineCtn =
            diffCtrl.diffModalBody?.querySelector('.d2h-code-line-ctn');
        expect(lineCtn?.classList.contains('hljs')).toBe(false);
    });

    it('preserves exact text content, spacing, and indentation between syntax on and off', () => {
        const app = buildAppStub();
        const diffCtrl = new DiffController(app);

        const sampleCode =
            '    const greeting = "hello world"; // 4 leading spaces';
        window.Diff2Html.html = vi.fn(
            () => `
            <div class="d2h-wrapper">
                <div class="d2h-file-wrapper" data-lang="js">
                    <span class="d2h-file-name">indent.js</span>
                    <div class="d2h-code-line"><span class="d2h-code-line-ctn">${sampleCode}</span></div>
                </div>
            </div>
        `,
        );

        // 1. Render with syntax OFF
        diffCtrl.syntaxHighlightEnabled = false;
        diffCtrl.renderRichDiff('diff ...');
        const offEl =
            diffCtrl.diffModalBody?.querySelector('.d2h-code-line-ctn');
        const textOff = offEl?.textContent;
        expect(textOff).toBe(sampleCode);

        // 2. Render with syntax ON
        diffCtrl.syntaxHighlightEnabled = true;
        diffCtrl.renderRichDiff('diff ...');
        const onEl =
            diffCtrl.diffModalBody?.querySelector('.d2h-code-line-ctn');
        const textOn = onEl?.textContent;

        // Character-for-character, whitespace-for-whitespace identical
        expect(textOn).toBe(textOff);
        expect(textOn?.startsWith('    ')).toBe(true);
        expect(onEl?.classList.contains('hljs')).toBe(true);
    });
});
