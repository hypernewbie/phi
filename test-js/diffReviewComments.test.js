// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness, stubWebSocket } from './_dom.js';

// Tests for the diff-review commenting feature in web-src/diff.ts. The
// feature lets reviewers attach inline notes to specific diff lines,
// then compile those notes into a prompt-engineered Markdown summary
// that lands in the active terminal's input bar.
//
// Most tests load DiffController.prototype methods directly and mount
// only the DOM they touch (matching the pattern in diffCopyHandlers /
// diffNotGitRepo). For pure-logic helpers (key derivation, prompt
// formatting, ordering) we just instantiate them with stub `this`.
// Methods that call each other (e.g. applyReviewToTerminalPrompt ->
// _buildPromptEngineeredReview) use makeCtx so the prototype chain
// resolves both.

setupDomHarness();

beforeEach(() => {
    stubWebSocket();
});

async function loadDiffControllerProto() {
    const mod = await import('../web/diff.js');
    return mod.DiffController.prototype;
}

// makeCtx returns a `this`-shaped object that inherits every prototype
// method from DiffController so chained method calls (e.g.
// applyReviewToTerminalPrompt -> _buildPromptEngineeredReview) resolve
// without each test having to wire up the full dependency graph.
function makeCtx(Proto, overrides = {}) {
    return Object.assign(Object.create(Proto), overrides);
}

function makeRow({
    side = 'unified',
    file = 'auth.ts',
    oldLine = '10',
    newLine = '10',
    kind = 'cntx',
    code = '  return 1;',
} = {}) {
    // Build a single diff2html-shaped <tr> with optional .line-num1/2.
    const tr = document.createElement('tr');
    const ln = document.createElement('td');
    if (side === 'unified') {
        ln.className = `d2h-code-linenumber d2h-${kind}`;
        const a = document.createElement('div');
        a.className = 'line-num1';
        a.textContent = oldLine || '';
        const b = document.createElement('div');
        b.className = 'line-num2';
        b.textContent = newLine || '';
        ln.append(a, b);
    } else {
        ln.className = `d2h-code-side-linenumber d2h-${kind}`;
        ln.textContent = oldLine || newLine || '';
    }
    const cell = document.createElement('td');
    cell.className = `d2h-${kind}`;
    const codeEl = document.createElement('div');
    codeEl.className =
        side === 'unified' ? 'd2h-code-line' : 'd2h-code-side-line';
    const prefix = document.createElement('span');
    prefix.className = 'd2h-code-line-prefix';
    prefix.textContent = kind === 'ins' ? '+' : kind === 'del' ? '-' : ' ';
    const ctn = document.createElement('span');
    ctn.className = 'd2h-code-line-ctn';
    ctn.textContent = code;
    codeEl.append(prefix, ctn);
    cell.appendChild(codeEl);
    tr.append(ln, cell);
    // Wrap in a file container + tbody so _rowFilePath and the
    // querySelectorAll('.d2h-diff-tbody tr') selector both resolve
    // from the same DOM subtree.
    const wrapper = document.createElement('div');
    wrapper.className = 'd2h-file-wrapper';
    const header = document.createElement('div');
    header.className = 'd2h-file-header';
    const name = document.createElement('span');
    name.className = 'd2h-file-name';
    name.textContent = file;
    header.appendChild(name);
    const tbody = document.createElement('tbody');
    tbody.className = 'd2h-diff-tbody';
    tbody.appendChild(tr);
    wrapper.append(header, tbody);
    return { tr, wrapper, tbody };
}

function mountModalBody(content) {
    document.body.innerHTML = `
        <div id="diff-modal" class="md-modal-overlay">
            <div class="md-modal-content">
                <div id="diff-modal-body" class="md-modal-body diff-modal-body"></div>
            </div>
        </div>
    `;
    const modalBody = document.getElementById('diff-modal-body');
    if (content) {
        // Use appendChild rather than innerHTML so the structure stays
        // intact: a <tbody> without a parent <table> would be dropped
        // by the HTML parser, breaking selector-based queries.
        modalBody.appendChild(content);
    }
    return {
        modal: document.getElementById('diff-modal'),
        modalContent: document.querySelector('.md-modal-content'),
        modalBody,
    };
}

// ─── Pure helpers ───────────────────────────────────────────────────

describe('DiffController._reviewKey', () => {
    it('produces unique keys for inserts vs deletes on the same line', async () => {
        const Proto = await loadDiffControllerProto();
        const info = (over) => ({
            filePath: 'foo.ts',
            oldLineNumber: null,
            newLineNumber: 13,
            lineType: 'insert',
            ...over,
        });
        const insKey = Proto._reviewKey.call(
            makeCtx(Proto),
            info({ newLineNumber: 13 }),
        );
        const delKey = Proto._reviewKey.call(
            {},
            info({
                newLineNumber: null,
                oldLineNumber: 13,
                lineType: 'delete',
            }),
        );
        const ctxKey = Proto._reviewKey.call(
            {},
            info({
                oldLineNumber: 13,
                newLineNumber: 13,
                lineType: 'context',
            }),
        );
        expect(insKey).not.toBe(delKey);
        expect(insKey).toBe('foo.ts::13');
        expect(delKey).toBe('foo.ts:13:');
        expect(ctxKey).toBe('foo.ts:13:13');
    });

    it('disambiguates side-by-side panes (old-only vs new-only)', async () => {
        const Proto = await loadDiffControllerProto();
        const oldSide = Proto._reviewKey.call(
            {},
            {
                filePath: 'foo.ts',
                oldLineNumber: 10,
                newLineNumber: null,
                lineType: 'delete',
            },
        );
        const newSide = Proto._reviewKey.call(
            {},
            {
                filePath: 'foo.ts',
                oldLineNumber: null,
                newLineNumber: 10,
                lineType: 'insert',
            },
        );
        expect(oldSide).not.toBe(newSide);
        expect(oldSide).toBe('foo.ts:10:');
        expect(newSide).toBe('foo.ts::10');
    });
});

describe('DiffController._rowLineNumbers / _rowLineType', () => {
    it('reads both old and new line numbers in unified view', async () => {
        const Proto = await loadDiffControllerProto();
        const { tr } = makeRow({ oldLine: '7', newLine: '8' });
        const out = Proto._rowLineNumbers.call(makeCtx(Proto), tr);
        expect(out).toEqual({ oldLineNumber: 7, newLineNumber: 8 });
        expect(Proto._rowLineType.call(makeCtx(Proto), tr)).toBe('context');
    });

    it('returns the single side number when one is empty', async () => {
        const Proto = await loadDiffControllerProto();
        const ins = makeRow({ oldLine: '', newLine: '42', kind: 'ins' });
        const out = Proto._rowLineNumbers.call(makeCtx(Proto), ins.tr);
        expect(out).toEqual({ oldLineNumber: null, newLineNumber: 42 });
        expect(Proto._rowLineType.call(makeCtx(Proto), ins.tr)).toBe('insert');
    });

    it('detects delete rows', async () => {
        const Proto = await loadDiffControllerProto();
        const del = makeRow({ oldLine: '13', newLine: '', kind: 'del' });
        expect(Proto._rowLineType.call(makeCtx(Proto), del.tr)).toBe('delete');
    });
});

describe('DiffController._extractLineInfo', () => {
    it('returns null for hunk-header rows (d2h-info)', async () => {
        const Proto = await loadDiffControllerProto();
        const tr = document.createElement('tr');
        const ln = document.createElement('td');
        ln.className = 'd2h-code-linenumber d2h-info';
        const cell = document.createElement('td');
        cell.className = 'd2h-info';
        tr.append(ln, cell);
        expect(Proto._extractLineInfo.call(makeCtx(Proto), tr)).toBeNull();
    });

    it('returns null for empty-placeholder rows (no line numbers)', async () => {
        const Proto = await loadDiffControllerProto();
        const tr = document.createElement('tr');
        const ln = document.createElement('td');
        ln.className = 'd2h-code-side-linenumber d2h-emptyplaceholder';
        const cell = document.createElement('td');
        cell.className = 'd2h-emptyplaceholder';
        tr.append(ln, cell);
        expect(Proto._extractLineInfo.call(makeCtx(Proto), tr)).toBeNull();
    });

    it('returns the full info tuple for a real code row', async () => {
        const Proto = await loadDiffControllerProto();
        const { tr, wrapper } = makeRow({
            file: 'auth.ts',
            oldLine: '12',
            newLine: '12',
            kind: 'cntx',
        });
        document.body.appendChild(wrapper);
        const info = Proto._extractLineInfo.call(makeCtx(Proto), tr);
        expect(info).toEqual({
            filePath: 'auth.ts',
            oldLineNumber: 12,
            newLineNumber: 12,
            lineType: 'context',
        });
    });
});

describe('DiffController._rowCodeSnippet', () => {
    it('collects surrounding +/-/ space-prefixed lines', async () => {
        const Proto = await loadDiffControllerProto();
        // Build a small hunk: ctx, ctx, ctx, ins, ctx, ctx, ctx
        const tbody = document.createElement('tbody');
        tbody.className = 'd2h-diff-tbody';
        const rows = [];
        for (let i = 0; i < 7; i++) {
            const { tr } = makeRow({
                oldLine: `${i}`,
                newLine: `${i}`,
                kind: i === 3 ? 'ins' : 'cntx',
                code: `  line ${i};`,
            });
            tbody.appendChild(tr);
            rows.push(tr);
        }
        document.body.appendChild(tbody);
        const target = rows[3];
        const snippet = Proto._rowCodeSnippet.call(makeCtx(Proto), target, 2);
        const lines = snippet.split('\n');
        // diff2html's .d2h-code-line-prefix span already carries
        // '+' / '-' / ' ' for the line marker; we read textContent
        // verbatim so the snippet includes the prefix and any
        // leading whitespace inside the code span.
        expect(lines).toEqual([
            '   line 1;',
            '   line 2;',
            '+  line 3;',
            '   line 4;',
            '   line 5;',
        ]);
    });
});

// ─── Prompt builder ────────────────────────────────────────────────

describe('DiffController._buildPromptEngineeredReview', () => {
    async function makeController({
        commit = 'fa4f33a',
        head = 'fa4f33a',
        branch = 'main',
    } = {}) {
        const Proto = await loadDiffControllerProto();
        const cwd = '/code/phi';
        return makeCtx(Proto, {
            reviewComments: new Map(),
            activeGitHead: head,
            activeGitBranch: branch,
            commitSelect: { value: commit },
            sessionsManager: { activeCWD: cwd },
            app: { sessionsManager: { activeCWD: cwd } },
        });
    }

    it('formats a single comment with full snippet + directives', async () => {
        const Proto = await loadDiffControllerProto();
        const c = await makeController();
        c.reviewComments.set('auth.ts:12:12', {
            id: 'c1',
            filePath: 'auth.ts',
            oldLineNumber: 12,
            newLineNumber: 12,
            lineType: 'context',
            codeSnippet: '- const a = 1;\n+ const a = 2;',
            commentText: 'Rename `a` to `count` for clarity.',
            createdAt: 100,
        });
        const md = Proto._buildPromptEngineeredReview.call(c);
        expect(md).toContain(
            'Please address the following code review feedback',
        );
        expect(md).toContain('on git revision `fa4f33a`');
        expect(md).toContain('in workspace `phi`');
        expect(md).toContain('### Code Review Feedback (1 item)');
        expect(md).toContain('#### 1. `auth.ts:12`');
        // Snippet wrapped as code block with `>` prefix per line.
        expect(md).toContain('> ```ts');
        expect(md).toContain('> - const a = 1;');
        expect(md).toContain('> + const a = 2;');
        expect(md).toContain('**Requested Change:**');
        expect(md).toContain('Rename `a` to `count` for clarity.');
        // Directives.
        expect(md).toContain('### Instructions for Assistant:');
        expect(md).toContain('1. Locate the exact code locations');
        expect(md).toContain('3. Verify your changes');
    });

    it('uses HEAD short hash for unstaged / staged', async () => {
        const Proto = await loadDiffControllerProto();
        const c = await makeController({ commit: 'unstaged', head: 'abc1234' });
        c.reviewComments.set('foo.ts::1', {
            id: 'c1',
            filePath: 'foo.ts',
            oldLineNumber: null,
            newLineNumber: 1,
            lineType: 'insert',
            codeSnippet: '+ new line',
            commentText: 'fix typo',
            createdAt: 1,
        });
        const md = Proto._buildPromptEngineeredReview.call(c);
        expect(md).toContain(
            'unstaged working tree changes relative to HEAD `abc1234`',
        );
    });

    it('uses the commit hash verbatim for a specific commit', async () => {
        const Proto = await loadDiffControllerProto();
        const c = await makeController({ commit: 'deadbee' });
        const md = Proto._buildPromptEngineeredReview.call(c);
        expect(md).toContain('on git revision `deadbee`');
    });

    it('pluralises "items" when there is more than one comment', async () => {
        const Proto = await loadDiffControllerProto();
        const c = await makeController();
        c.reviewComments.set('a.ts::1', {
            id: 'a',
            filePath: 'a.ts',
            oldLineNumber: null,
            newLineNumber: 1,
            lineType: 'insert',
            codeSnippet: '+ x',
            commentText: 'one',
            createdAt: 1,
        });
        c.reviewComments.set('b.ts::2', {
            id: 'b',
            filePath: 'b.ts',
            oldLineNumber: null,
            newLineNumber: 2,
            lineType: 'insert',
            codeSnippet: '+ y',
            commentText: 'two',
            createdAt: 2,
        });
        const md = Proto._buildPromptEngineeredReview.call(c);
        expect(md).toContain('### Code Review Feedback (2 items)');
    });
});

describe('DiffController._sortedReviewComments', () => {
    it('orders by file path then line number', async () => {
        const Proto = await loadDiffControllerProto();
        const c = makeCtx(Proto, { reviewComments: new Map() });
        const mk = (over) => ({
            id: 'x',
            filePath: 'x.ts',
            oldLineNumber: null,
            newLineNumber: 1,
            lineType: 'insert',
            codeSnippet: '',
            commentText: 't',
            createdAt: 0,
            ...over,
        });
        c.reviewComments.set(
            'b.ts::5',
            mk({ filePath: 'b.ts', newLineNumber: 5, createdAt: 10 }),
        );
        c.reviewComments.set(
            'a.ts::1',
            mk({ filePath: 'a.ts', newLineNumber: 1, createdAt: 5 }),
        );
        c.reviewComments.set(
            'a.ts::20',
            mk({ filePath: 'a.ts', newLineNumber: 20, createdAt: 1 }),
        );
        const sorted = Proto._sortedReviewComments.call(c);
        expect(sorted.map((s) => `${s.filePath}:${s.newLineNumber}`)).toEqual([
            'a.ts:1',
            'a.ts:20',
            'b.ts:5',
        ]);
    });
});

// ─── DOM integration ───────────────────────────────────────────────

describe('DiffController._attachDiffReviewListeners', () => {
    it('adds a + button to every commentable row, never twice', async () => {
        const Proto = await loadDiffControllerProto();
        const { tr, wrapper } = makeRow();
        const { modalBody } = mountModalBody(wrapper);
        const ctx = makeCtx(Proto, { diffModalBody: modalBody });
        Proto._attachDiffReviewListeners.call(ctx);
        Proto._attachDiffReviewListeners.call(ctx); // idempotent
        const btns = modalBody.querySelectorAll('.diff-add-comment-btn');
        expect(btns.length).toBe(1);
        expect(btns[0].textContent).toBe('+');
        expect(btns[0].title).toBe('Add review comment');
        expect(tr.dataset.reviewWired).toBe('1');
    });

    it('skips hunk-header rows (d2h-info)', async () => {
        const Proto = await loadDiffControllerProto();
        // Build a wrapper containing an info-only row.
        const wrapper = document.createElement('div');
        wrapper.className = 'd2h-file-wrapper';
        const head = document.createElement('div');
        head.className = 'd2h-file-header';
        const name = document.createElement('span');
        name.className = 'd2h-file-name';
        name.textContent = 'foo.ts';
        head.appendChild(name);
        const tbody = document.createElement('tbody');
        tbody.className = 'd2h-diff-tbody';
        const tr = document.createElement('tr');
        const ln = document.createElement('td');
        ln.className = 'd2h-code-linenumber d2h-info';
        const cell = document.createElement('td');
        cell.className = 'd2h-info';
        tr.append(ln, cell);
        tbody.appendChild(tr);
        wrapper.append(head, tbody);
        const { modalBody } = mountModalBody(wrapper);
        const ctx = makeCtx(Proto, { diffModalBody: modalBody });
        Proto._attachDiffReviewListeners.call(ctx);
        expect(modalBody.querySelectorAll('.diff-add-comment-btn').length).toBe(
            0,
        );
    });

    it('opens an editor row when the + button is clicked', async () => {
        const Proto = await loadDiffControllerProto();
        const { tr, wrapper } = makeRow({
            file: 'foo.ts',
            oldLine: '5',
            newLine: '5',
        });
        const { modalBody } = mountModalBody(wrapper);
        const ctx = makeCtx(Proto, { diffModalBody: modalBody });
        Proto._attachDiffReviewListeners.call(ctx);
        tr.querySelector('.diff-add-comment-btn').click();
        const editor = modalBody.querySelector('.diff-comment-editor-row');
        expect(editor).toBeTruthy();
        const badge = editor.querySelector('.diff-comment-target-badge');
        expect(badge.textContent).toBe('foo.ts:5');
        const textarea = editor.querySelector('textarea');
        expect(textarea.placeholder).toMatch(/Explain/);
    });
});

describe('DiffController._saveComment / _renderCommentDisplayRow', () => {
    function mountWithRow() {
        const { tr, wrapper } = makeRow({
            file: 'foo.ts',
            oldLine: '7',
            newLine: '8',
        });
        const els = mountModalBody(wrapper);
        return { ...els, tr };
    }

    it('inserts a display row + adds d2h-has-comment to the target row', async () => {
        const Proto = await loadDiffControllerProto();
        const ctx = mountWithRow();
        // Find the cloned tr inside the modal body — mountModalBody
        // clones via outerHTML, so the original `tr` ref is detached.
        const modalTr = ctx.modalBody.querySelector('tr');
        const controller = makeCtx(Proto, {
            diffModalBody: ctx.modalBody,
            reviewComments: new Map(),
            app: { showToast: vi.fn() },
        });
        const info = {
            filePath: 'foo.ts',
            oldLineNumber: 7,
            newLineNumber: 8,
            lineType: 'context',
        };
        Proto._saveComment.call(
            controller,
            info,
            '- const a = 1;\n+ const a = 2;',
            'rename a to count',
        );
        expect(modalTr.classList.contains('d2h-has-comment')).toBe(true);
        const displayRow = ctx.modalBody.querySelector(
            '.diff-comment-display-row',
        );
        expect(displayRow).toBeTruthy();
        expect(displayRow.nextElementSibling).toBeNull();
        const card = displayRow.querySelector('.diff-comment-card');
        expect(card.textContent).toContain('rename a to count');
        expect(card.textContent).toContain('foo.ts:8');
        expect(controller.reviewComments.size).toBe(1);
    });

    it('replaces existing display rows on edit (no stacking)', async () => {
        const Proto = await loadDiffControllerProto();
        const ctx = mountWithRow();
        const controller = makeCtx(Proto, {
            diffModalBody: ctx.modalBody,
            reviewComments: new Map(),
            app: { showToast: vi.fn() },
        });
        const info = {
            filePath: 'foo.ts',
            oldLineNumber: 7,
            newLineNumber: 8,
            lineType: 'context',
        };
        Proto._saveComment.call(controller, info, 'snippet', 'first');
        const first = controller.reviewComments.values().next().value;
        Proto._saveComment.call(controller, info, 'snippet', 'second', first);
        const displays = ctx.modalBody.querySelectorAll(
            '.diff-comment-display-row',
        );
        expect(displays.length).toBe(1);
        expect(displays[0].textContent).toContain('second');
        expect(controller.reviewComments.size).toBe(1);
    });
});

describe('DiffController._deleteComment', () => {
    it('removes the comment, drops the display row, clears the highlight', async () => {
        const Proto = await loadDiffControllerProto();
        const { wrapper } = makeRow({
            file: 'foo.ts',
            oldLine: '7',
            newLine: '8',
        });
        const { modalBody } = mountModalBody(wrapper);
        const modalTr = modalBody.querySelector('tr');
        const controller = makeCtx(Proto, {
            diffModalBody: modalBody,
            reviewComments: new Map(),
            app: { showToast: vi.fn() },
        });
        const info = {
            filePath: 'foo.ts',
            oldLineNumber: 7,
            newLineNumber: 8,
            lineType: 'context',
        };
        Proto._saveComment.call(controller, info, 'snip', 't');
        const id = controller.reviewComments.values().next().value.id;
        expect(modalTr.classList.contains('d2h-has-comment')).toBe(true);
        Proto._deleteComment.call(controller, id);
        expect(controller.reviewComments.size).toBe(0);
        expect(modalTr.classList.contains('d2h-has-comment')).toBe(false);
        expect(modalBody.querySelector('.diff-comment-display-row')).toBeNull();
    });
});

describe('DiffController._ensureReviewActionBar', () => {
    it('builds the floating bar inside .md-modal-content exactly once', async () => {
        const Proto = await loadDiffControllerProto();
        const { modalContent } = mountModalBody('');
        const ctx = makeCtx(Proto, {
            diffModal: document.getElementById('diff-modal'),
            reviewActionBar: null,
        });
        Proto._ensureReviewActionBar.call(ctx);
        Proto._ensureReviewActionBar.call(ctx);
        const bars = modalContent.querySelectorAll('#diff-review-action-bar');
        expect(bars.length).toBe(1);
        expect(modalContent.style.position).toBe('relative');
        expect(bars[0].classList.contains('hidden')).toBe(true);
        // Wires Clear / Copy Prompt / Apply to Prompt buttons.
        const ids = [
            'diff-review-clear-btn',
            'diff-review-copy-btn',
            'diff-review-apply-btn',
        ];
        ids.forEach((id) => {
            expect(bars[0].querySelector(`#${id}`)).toBeTruthy();
        });
    });
});

describe('DiffController._updateReviewActionBar', () => {
    it('updates the count badge and toggles hidden', async () => {
        const Proto = await loadDiffControllerProto();
        const { modalContent } = mountModalBody('');
        const bar = document.createElement('div');
        bar.id = 'diff-review-action-bar';
        bar.className = 'diff-review-action-bar hidden';
        const badge = document.createElement('span');
        badge.className = 'diff-review-count-badge';
        badge.textContent = '0';
        bar.appendChild(badge);
        modalContent.appendChild(bar);
        const ctx = makeCtx(Proto, {
            reviewActionBar: bar,
            reviewComments: new Map([
                ['a', {}],
                ['b', {}],
            ]),
        });
        Proto._updateReviewActionBar.call(ctx);
        expect(badge.textContent).toBe('2');
        expect(bar.classList.contains('hidden')).toBe(false);
        ctx.reviewComments.clear();
        Proto._updateReviewActionBar.call(ctx);
        expect(badge.textContent).toBe('0');
        expect(bar.classList.contains('hidden')).toBe(true);
    });
});

describe('DiffController.applyReviewToTerminalPrompt', () => {
    it('stages markdown into #input-textarea, focuses, clears comments, closes modal', async () => {
        const Proto = await loadDiffControllerProto();
        const { modal } = mountModalBody('');
        document.body.insertAdjacentHTML(
            'beforeend',
            '<textarea id="input-textarea"></textarea>',
        );
        const inputTextArea = document.getElementById('input-textarea');
        const ctx = makeCtx(Proto, {
            diffModal: modal,
            diffModalBody: document.getElementById('diff-modal-body'),
            reviewComments: new Map([
                [
                    'foo.ts:7:8',
                    {
                        id: 'a',
                        filePath: 'foo.ts',
                        oldLineNumber: 7,
                        newLineNumber: 8,
                        lineType: 'context',
                        codeSnippet: '+ new line',
                        commentText: 'rename a',
                        createdAt: 1,
                    },
                ],
            ]),
            activeGitHead: 'deadbee',
            activeGitBranch: 'main',
            commitSelect: { value: 'deadbee' },
            sessionsManager: { activeCWD: '/code/phi' },
            app: {
                tabManager: {
                    inputTextArea,
                    adjustInputHeight: vi.fn(),
                    getActiveTab: () => ({ directMode: false }),
                },
                showToast: vi.fn(),
            },
            closeRichDiffModal: vi.fn(() => {
                modal.classList.add('hidden');
            }),
        });
        Proto.applyReviewToTerminalPrompt.call(ctx);
        expect(inputTextArea.value).toContain(
            'Please address the following code review feedback',
        );
        expect(inputTextArea.value).toContain('on git revision `deadbee`');
        expect(inputTextArea.value).toContain('rename a');
        expect(inputTextArea.style.height).not.toBe('');
        expect(ctx.reviewComments.size).toBe(0);
        expect(modal.classList.contains('hidden')).toBe(true);
        expect(ctx.app.showToast).toHaveBeenCalledWith(
            expect.stringContaining('Review staged into terminal prompt'),
            expect.objectContaining({ type: 'success' }),
        );
    });

    it('flips direct mode off so the user actually sees the prompt bar', async () => {
        const Proto = await loadDiffControllerProto();
        const { modal } = mountModalBody('');
        document.body.insertAdjacentHTML(
            'beforeend',
            '<textarea id="input-textarea"></textarea>',
        );
        const inputTextArea = document.getElementById('input-textarea');
        const toggleDirectMode = vi.fn();
        const ctx = makeCtx(Proto, {
            diffModal: modal,
            diffModalBody: document.getElementById('diff-modal-body'),
            reviewComments: new Map([
                [
                    'a.ts::1',
                    {
                        id: 'x',
                        filePath: 'a.ts',
                        oldLineNumber: null,
                        newLineNumber: 1,
                        lineType: 'insert',
                        codeSnippet: '+ x',
                        commentText: 't',
                        createdAt: 1,
                    },
                ],
            ]),
            activeGitHead: 'abc',
            commitSelect: { value: 'abc' },
            sessionsManager: { activeCWD: '/code/phi' },
            app: {
                tabManager: {
                    inputTextArea,
                    adjustInputHeight: vi.fn(),
                    getActiveTab: () => ({ directMode: true }),
                    toggleDirectMode,
                },
                showToast: vi.fn(),
            },
            closeRichDiffModal: vi.fn(),
        });
        Proto.applyReviewToTerminalPrompt.call(ctx);
        expect(toggleDirectMode).toHaveBeenCalled();
    });

    it('preserves existing prompt text and appends the review below it', async () => {
        const Proto = await loadDiffControllerProto();
        const { modal } = mountModalBody('');
        document.body.insertAdjacentHTML(
            'beforeend',
            '<textarea id="input-textarea">first draft</textarea>',
        );
        const inputTextArea = document.getElementById('input-textarea');
        const ctx = makeCtx(Proto, {
            diffModal: modal,
            diffModalBody: document.getElementById('diff-modal-body'),
            reviewComments: new Map([
                [
                    'a.ts::1',
                    {
                        id: 'x',
                        filePath: 'a.ts',
                        oldLineNumber: null,
                        newLineNumber: 1,
                        lineType: 'insert',
                        codeSnippet: '+ x',
                        commentText: 't',
                        createdAt: 1,
                    },
                ],
            ]),
            activeGitHead: 'abc',
            commitSelect: { value: 'abc' },
            sessionsManager: { activeCWD: '/code/phi' },
            app: {
                tabManager: {
                    inputTextArea,
                    adjustInputHeight: vi.fn(),
                    getActiveTab: () => ({ directMode: false }),
                },
                showToast: vi.fn(),
            },
            closeRichDiffModal: vi.fn(),
        });
        Proto.applyReviewToTerminalPrompt.call(ctx);
        expect(inputTextArea.value.startsWith('first draft\n\n')).toBe(true);
        expect(inputTextArea.value).toContain('### Code Review Feedback');
    });
});

// ─── Persistence ───────────────────────────────────────────────────

describe('DiffController review draft persistence', () => {
    it('round-trips comments through localStorage keyed by CWD', async () => {
        const Proto = await loadDiffControllerProto();
        const c1 = makeCtx(Proto, {
            reviewComments: new Map([
                [
                    'a.ts::1',
                    {
                        id: 'a',
                        filePath: 'a.ts',
                        oldLineNumber: null,
                        newLineNumber: 1,
                        lineType: 'insert',
                        codeSnippet: '+ x',
                        commentText: 'rename',
                        createdAt: 100,
                    },
                ],
            ]),
            reviewStorageKey: 'phi_diff_review_draft',
            sessionsManager: { activeCWD: '/code/phi' },
        });
        Proto._saveReviewDraft.call(c1);
        // Simulate a fresh session by mounting a new controller-like this.
        const c2 = makeCtx(Proto, {
            reviewComments: new Map(),
            reviewStorageKey: 'phi_diff_review_draft',
            sessionsManager: { activeCWD: '/code/phi' },
        });
        Proto._loadReviewDraft.call(c2);
        expect(c2.reviewComments.size).toBe(1);
        const loaded = c2.reviewComments.values().next().value;
        expect(loaded.filePath).toBe('a.ts');
        expect(loaded.commentText).toBe('rename');
    });

    it('keys drafts by CWD so per-worktree notes do not bleed', async () => {
        const Proto = await loadDiffControllerProto();
        const writer = makeCtx(Proto, {
            reviewComments: new Map([
                [
                    'a.ts::1',
                    {
                        id: 'a',
                        filePath: 'a.ts',
                        oldLineNumber: null,
                        newLineNumber: 1,
                        lineType: 'insert',
                        codeSnippet: '+ x',
                        commentText: 'A',
                        createdAt: 1,
                    },
                ],
            ]),
            reviewStorageKey: 'phi_diff_review_draft',
            sessionsManager: { activeCWD: '/work/A' },
        });
        Proto._saveReviewDraft.call(writer);
        // Different CWD: same writer, different workspace — should not
        // see A's notes.
        const reader = makeCtx(Proto, {
            reviewComments: new Map(),
            reviewStorageKey: 'phi_diff_review_draft',
            sessionsManager: { activeCWD: '/work/B' },
        });
        Proto._loadReviewDraft.call(reader);
        expect(reader.reviewComments.size).toBe(0);
        // Now switch back to A's CWD and confirm round-trip.
        const sameReader = makeCtx(Proto, {
            reviewComments: new Map(),
            reviewStorageKey: 'phi_diff_review_draft',
            sessionsManager: { activeCWD: '/work/A' },
        });
        Proto._loadReviewDraft.call(sameReader);
        expect(sameReader.reviewComments.size).toBe(1);
    });

    it('drops corrupted localStorage entries without throwing', async () => {
        const Proto = await loadDiffControllerProto();
        localStorage.setItem('phi_diff_review_draft_/code/phi', '{not json');
        const reader = makeCtx(Proto, {
            reviewComments: new Map(),
            reviewStorageKey: 'phi_diff_review_draft',
            sessionsManager: { activeCWD: '/code/phi' },
        });
        expect(() => Proto._loadReviewDraft.call(reader)).not.toThrow();
        expect(reader.reviewComments.size).toBe(0);
    });

    it('removes the localStorage entry when comments are cleared', async () => {
        const Proto = await loadDiffControllerProto();
        const c = makeCtx(Proto, {
            reviewComments: new Map([
                [
                    'a.ts::1',
                    {
                        id: 'a',
                        filePath: 'a.ts',
                        oldLineNumber: null,
                        newLineNumber: 1,
                        lineType: 'insert',
                        codeSnippet: '+ x',
                        commentText: 'x',
                        createdAt: 1,
                    },
                ],
            ]),
            reviewStorageKey: 'phi_diff_review_draft',
            sessionsManager: { activeCWD: '/code/phi' },
            diffModalBody: null,
            _updateReviewActionBar: vi.fn(),
        });
        Proto._saveReviewDraft.call(c);
        expect(
            localStorage.getItem('phi_diff_review_draft_/code/phi'),
        ).toBeTruthy();
        c.reviewComments.clear();
        Proto._saveReviewDraft.call(c);
        expect(
            localStorage.getItem('phi_diff_review_draft_/code/phi'),
        ).toBeNull();
    });
});
