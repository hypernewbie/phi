// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { MarkdownManager } from '../web/markdown.js';

// "Insert @path" context-menu action (research/2026-08-01-1228-right-click-file-insert-at-mention.md).
// Covers: coder-aware formatting via ATTACHMENT_SYNTAX, the unchanged
// Ctrl/Cmd+click raw-path path, cursor/padding splice semantics, and that
// the context menu surfaces the new action as the first button.

setupDomHarness();

// Minimum-DOM stub for MarkdownManager construction — the ids its
// constructor/_setupEventListeners dereference directly (subset of the
// list in managerSurfaceSmoke.test.js, markdown-only). 'input-textarea' is
// deliberately NOT in this list: makeMm() creates a REAL <textarea> for it
// before calling this, so _insertRelativePath's own
// document.getElementById('input-textarea') finds a real element with a
// working .value/.selectionStart, not a placeholder <div>.
function stubDom() {
    const ids = [
        'markdown-file-list',
        'md-modal',
        'md-modal-title',
        'md-modal-body',
        'md-modal-close',
        'md-modal-copy-btn',
    ];
    for (const id of ids) {
        if (!document.getElementById(id)) {
            const el = document.createElement('div');
            el.id = id;
            document.body.appendChild(el);
        }
    }
}

function makeMm(coder = 'claude') {
    const textarea = document.createElement('textarea');
    textarea.id = 'input-textarea';
    document.body.appendChild(textarea);

    stubDom();

    const app = {
        showToast: vi.fn(),
        markdownDirs: [],
        sessionsManager: { activeCWD: '/ws' },
        tabManager: {
            getActiveTab: () => ({ coder }),
            adjustInputHeight: vi.fn(),
        },
    };
    const mm = new MarkdownManager(app);
    return { mm, textarea };
}

describe('_insertRelativePath mention formatting', () => {
    it('mention insert formats @path for the claude coder', () => {
        const { mm, textarea } = makeMm('claude');
        mm._insertRelativePath(
            { path: '/ws/docs/notes.md' },
            { mention: true },
        );
        expect(textarea.value).toBe('@docs/notes.md');
        expect(textarea.selectionStart).toBe(textarea.value.length);
    });

    it('mention insert falls back to the raw path for the bash coder', () => {
        const { mm, textarea } = makeMm('bash');
        mm._insertRelativePath(
            { path: '/ws/docs/notes.md' },
            { mention: true },
        );
        expect(textarea.value).toBe('docs/notes.md');
    });

    it('mention insert falls back to the raw path for the pseudo-coder review', () => {
        const { mm, textarea } = makeMm('review');
        mm._insertRelativePath(
            { path: '/ws/docs/notes.md' },
            { mention: true },
        );
        expect(textarea.value).toBe('docs/notes.md');
    });

    it('no opts inserts the raw relative path (Ctrl/Cmd+click behavior, unchanged)', () => {
        const { mm, textarea } = makeMm('claude');
        mm._insertRelativePath({ path: '/ws/docs/notes.md' });
        expect(textarea.value).toBe('docs/notes.md');
    });

    it('pads with a single leading space when inserting after existing text', () => {
        const { mm, textarea } = makeMm('claude');
        textarea.value = 'fix';
        textarea.setSelectionRange(3, 3);
        mm._insertRelativePath(
            { path: '/ws/docs/notes.md' },
            { mention: true },
        );
        expect(textarea.value).toBe('fix @docs/notes.md');
    });
});

describe('_showContextMenu single Copy action', () => {
    it('shows only "Copy to clipboard" and not Insert @path', () => {
        const { mm } = makeMm('claude');
        const anchor = document.createElement('button');
        document.body.appendChild(anchor);

        mm._showContextMenu(
            { path: '/ws/docs/notes.md', name: 'notes.md', dir: '.' },
            anchor,
        );

        const buttons = mm.contextMenuEl.querySelectorAll('.md-context-action');
        expect(buttons.length).toBe(1);
        const first = buttons[0];
        expect(first.classList.contains('copy')).toBe(true);
        expect(first.querySelector('.md-context-label').textContent).toBe(
            'Copy to clipboard',
        );
    });
});
