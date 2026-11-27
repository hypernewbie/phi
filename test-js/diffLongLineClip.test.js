// @vitest-environment jsdom
/**
 * DiffController — hunk content lines past the clip bound.
 *
 * A generated file can put its whole content on one line (a minified
 * search index is ~800k chars). Every compositor tile that touches such
 * a text run costs ~200 ms to raster, and a full-window modal has nothing
 * else to show, so the main thread blocks on the commit: the enlarged
 * pretty diff freezes. We assert:
 *   - only hunk content lines are shortened: a leading marker names the
 *     full length, then the first N content chars follow
 *   - file headers, hunk headers and short lines pass through untouched
 *   - the input itself is returned when nothing needs clipping
 *   - diff2html receives the shortened patch from renderRichDiff
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness, stubWebSocket } from './_dom.js';
import {
    DIFF_LINE_CLIP_CHARS,
    DiffController,
    clipDiffLines,
} from '../web/diff.js';

setupDomHarness();

beforeEach(() => {
    stubWebSocket();
});

const PATCH = `diff --git a/docs/search/search_index.json b/docs/search/search_index.json
index 1111111..2222222 100644
--- a/docs/search/search_index.json
+++ b/docs/search/search_index.json
@@ -1 +1 @@
-{"docs":[{"id":"one"}]}
+{"docs":[{"id":"two"}]}
diff --git a/src/main.cpp b/src/main.cpp
index 3333333..4444444 100644
--- a/src/main.cpp
+++ b/src/main.cpp
@@ -1 +1 @@
-int seed() { return 1; }
+int seed() { return 2; }`;

const n = (value) => value.toLocaleString();

describe('clipDiffLines', () => {
    it('returns the input itself when every line is within the bound', () => {
        expect(clipDiffLines(PATCH, 40)).toBe(PATCH);
        expect(clipDiffLines('', 40)).toBe('');
    });

    it('shortens only hunk content lines, marker first, then N chars', () => {
        const long = 'x'.repeat(50);
        const patch = PATCH.replace(
            '-{"docs":[{"id":"one"}]}',
            `-${long}`,
        ).replace('+{"docs":[{"id":"two"}]}', `+${long}`);
        const lines = clipDiffLines(patch, 40).split('\n');
        expect(lines[5]).toBe(
            `-…[${n(50)}-char line, first ${n(40)} shown] ${'x'.repeat(40)}`,
        );
        expect(lines[6]).toBe(
            `+…[${n(50)}-char line, first ${n(40)} shown] ${'x'.repeat(40)}`,
        );
        // Everything else is byte for byte the input.
        const kept = lines.filter((_, i) => i !== 5 && i !== 6);
        expect(kept.join('\n')).toBe(
            patch
                .split('\n')
                .filter((_, i) => i !== 5 && i !== 6)
                .join('\n'),
        );
    });

    it('leaves file headers alone, however long, and resets per file', () => {
        const path = 'a/'.padEnd(60, 'p');
        const patch = `diff --git ${path} ${path}\n--- ${path}\n+++ ${path}\n@@ -1 +1 @@\n-${'y'.repeat(60)}\ndiff --git a/next b/next\n--- ${'y'.repeat(60)}\n+++ b/next\n@@ -1 +1 @@\n context\n+${'z'.repeat(60)}`;
        const lines = clipDiffLines(patch, 40).split('\n');
        expect(lines[1]).toBe(`--- ${path}`);
        expect(lines[2]).toBe(`+++ ${path}`);
        expect(lines[4]).toBe(
            `-…[${n(60)}-char line, first ${n(40)} shown] ${'y'.repeat(40)}`,
        );
        // After the next file header the hunk has not started yet: a
        // long `---` line there is still a header, not content.
        expect(lines[6]).toBe(`--- ${'y'.repeat(60)}`);
        expect(lines[9]).toBe(' context');
        expect(lines[10]).toBe(
            `+…[${n(60)}-char line, first ${n(40)} shown] ${'z'.repeat(40)}`,
        );
    });

    it('drops the CR of a shortened CRLF line', () => {
        const patch = `@@ -1 +1 @@\r\n-${'c'.repeat(60)}\r\n+short\r\n`;
        const lines = clipDiffLines(patch, 40).split('\n');
        expect(lines[1]).toBe(
            `-…[${n(60)}-char line, first ${n(40)} shown] ${'c'.repeat(40)}`,
        );
        expect(lines[2]).toBe('+short\r');
    });

    it('clips a line exactly one char over the bound', () => {
        const patch = `@@ -1 +1 @@\n ${'k'.repeat(41)}\n ${'k'.repeat(40)}`;
        const lines = clipDiffLines(patch, 40).split('\n');
        expect(lines[1]).toBe(
            ` …[${n(41)}-char line, first ${n(40)} shown] ${'k'.repeat(40)}`,
        );
        expect(lines[2]).toBe(` ${'k'.repeat(40)}`);
    });

    it('ships a bound far above any reviewed line', () => {
        expect(DIFF_LINE_CLIP_CHARS).toBeGreaterThanOrEqual(2000);
        expect(DIFF_LINE_CLIP_CHARS).toBeLessThanOrEqual(10000);
    });
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

describe('DiffController — long lines are clipped before diff2html', () => {
    beforeEach(() => {
        bootstrapDiffDom();
    });

    it('hands diff2html the shortened patch', () => {
        const html = vi.fn(() => '<div class="d2h-wrapper"></div>');
        const parse = vi.fn(() => []);
        window.Diff2Html = { html, parse, sanitize: vi.fn((s) => s) };
        window.DOMPurify = window.DOMPurify || { sanitize: vi.fn((s) => s) };
        const app = {
            showToast: vi.fn(),
            tabManager: {
                getActiveTab: vi.fn(() => ({ cwd: '/p' })),
                copyTextRobustly: vi.fn(),
            },
            sessionsManager: {
                activeCWD: '/p',
                loadConfig: vi.fn().mockResolvedValue(undefined),
            },
            hostname: 'jupiter',
        };
        const diffCtrl = new DiffController(app);
        diffCtrl.activeDiffRoot = '/p';
        diffCtrl.activeDiffHostname = 'jupiter';

        const long = 'x'.repeat(900_000);
        const patch = `diff --git a/index.json b/index.json\nindex 1111111..2222222 100644\n--- a/index.json\n+++ b/index.json\n@@ -1 +1 @@\n-${long}\n+${'y'.repeat(900_000)}\n`;
        diffCtrl.renderRichDiff(patch);

        const rendered = html.mock.calls[0][0];
        expect(
            rendered.startsWith('diff --git a/index.json b/index.json\n'),
        ).toBe(true);
        expect(rendered).toContain(
            `-…[${n(900_000)}-char line, first ${n(DIFF_LINE_CLIP_CHARS)} shown] ${'x'.repeat(DIFF_LINE_CLIP_CHARS)}`,
        );
        expect(rendered).toContain(
            `+…[${n(900_000)}-char line, first ${n(DIFF_LINE_CLIP_CHARS)} shown] ${'y'.repeat(DIFF_LINE_CLIP_CHARS)}`,
        );
        expect(rendered.length).toBeLessThan(10_000);
    });
});
