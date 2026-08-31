// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { MarkdownManager } from '../web/markdown.js';

// "Open in new window" context-menu action: window.open with popup-blocked
// detection (plan/2026-08-01-183549-markdown-popout-and-sanitization.md §3.4).

setupDomHarness();

// Minimum-DOM stub for MarkdownManager construction — the ids its
// constructor/_setupEventListeners dereference directly (same list as
// mdInsertMention.test.js).
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

function makeMm() {
    stubDom();
    const app = {
        showToast: vi.fn(),
        markdownDirs: [],
        sessionsManager: { activeCWD: '/ws' },
        tabManager: {
            getActiveTab: () => ({ coder: 'claude' }),
            adjustInputHeight: vi.fn(),
        },
    };
    const mm = new MarkdownManager(app);
    return { mm, app };
}

describe('_openInNewWindow', () => {
    it('opens md.html with encoded path+cwd and severs the opener reference', () => {
        const { mm, app } = makeMm();
        const fakeWin = { opener: {} };
        const openSpy = vi.fn(() => fakeWin);
        vi.stubGlobal('open', openSpy);

        mm._openInNewWindow({ path: '/ws/docs/notes.md', name: 'notes.md' });

        expect(openSpy).toHaveBeenCalledTimes(1);
        const [url, target, features] = openSpy.mock.calls[0];
        expect(url).toContain(
            `md.html?path=${encodeURIComponent('/ws/docs/notes.md')}&cwd=${encodeURIComponent('/ws')}`,
        );
        expect(target).toBe('_blank');
        expect(features).toBe('width=860,height=1000');
        expect(fakeWin.opener).toBe(null);
        expect(app.showToast).not.toHaveBeenCalled();
    });

    it('shows a toast when the popup is blocked (window.open returns null)', () => {
        const { mm, app } = makeMm();
        vi.stubGlobal(
            'open',
            vi.fn(() => null),
        );

        mm._openInNewWindow({ path: '/ws/docs/notes.md', name: 'notes.md' });

        expect(app.showToast).toHaveBeenCalledTimes(1);
        expect(app.showToast.mock.calls[0][0]).toContain('Popup blocked');
        expect(app.showToast.mock.calls[0][1]).toEqual({ type: 'error' });
    });
});

describe('_showContextMenu single Copy action', () => {
    it('shows only Copy to clipboard (no Open in new window)', () => {
        const { mm } = makeMm();
        const anchor = document.createElement('button');
        document.body.appendChild(anchor);

        mm._showContextMenu(
            { path: '/ws/docs/notes.md', name: 'notes.md', dir: '.' },
            anchor,
        );

        const buttons = mm.contextMenuEl.querySelectorAll('.md-context-action');
        expect(buttons.length).toBe(1);
        expect(buttons[0].classList.contains('copy')).toBe(true);
        expect(buttons[0].querySelector('.md-context-label').textContent).toBe(
            'Copy to clipboard',
        );
    });
});
