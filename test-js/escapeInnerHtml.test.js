// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness, mockFetch, stubWebSocket } from './_dom.js';
import { MarkdownManager } from '../web/markdown.js';
import { SessionsManager } from '../web/sessions.js';
import { SyncManager } from '../web/sync.js';

// Regression coverage for the nine innerHTML-injection sites fixed by
// wrapping untrusted strings in escapeHtml (plan: escape-innerhtml). Each
// test drives the REAL production method with an HTML-metacharacter
// payload and asserts both halves of "this is just text now":
//   1. no live element was created from the payload
//      (container.querySelector('img') is null)
//   2. the payload survives as literal text (container.textContent
//      contains it verbatim)
//
// Self-verification: every test below was confirmed to go red by
// temporarily spying on the `escapeHtml` export of web/util.js with an
// identity mockImplementation (Vite's SSR transform makes each call site a
// live property read on the module's exports object, so the spy reaches
// every caller regardless of how it imported the name). The spy was removed
// again before this file was finalized — it is not part of the committed
// suite.

setupDomHarness();

const PAYLOAD = '<img src=x onerror=alert(1)>';

// Full MarkdownManager construction. The five ids below are exactly what
// the constructor dereferences directly (mirrors mdChangedRefresh.test.js);
// every other DOM lookup in the class is null-guarded.
function makeMm({ activeCWD = '/w', markdownDirs = ['.'] } = {}) {
    document.body.innerHTML = `
        <div id="markdown-file-list"></div>
        <div id="md-modal" class="hidden"></div>
        <div id="md-modal-title"></div>
        <div id="md-modal-body"></div>
        <button id="md-modal-close"></button>
    `;
    const app = {
        showToast: vi.fn(),
        markdownDirs,
        sessionsManager: { activeCWD },
    };
    return new MarkdownManager(app);
}

// Bare MarkdownManager for the modal-only methods (openHelpModal,
// openChangelogModal) — mirrors changelogPopup.test.js's makeManager():
// skip the constructor entirely and hand-wire only the fields those two
// methods touch.
function makeBareMm() {
    const m = Object.create(MarkdownManager.prototype);
    m.app = { showToast: vi.fn() };
    m.modalTitle = document.createElement('span');
    m.modalBody = document.createElement('div');
    m.modalClose = document.createElement('button');
    m.modalCopyBtn = document.createElement('button');
    m.modal = document.createElement('div');
    m.modal.classList.add('hidden');
    m.currentRawContent = '';
    return m;
}

describe('MarkdownManager._renderFileList — file name (markdown.ts:247)', () => {
    it('a malicious filename from the server scan renders as literal text, not markup', async () => {
        const mm = makeMm();
        mockFetch(() => [{ path: '/w/evil.md', name: PAYLOAD, dir: '.' }]);
        await mm.refreshFiles({ force: true });
        const nameEl = mm.fileListEl.querySelector('.md-file-name');
        expect(mm.fileListEl.querySelector('img')).toBeNull();
        expect(nameEl.textContent).toBe(PAYLOAD);
    });
});

describe('MarkdownManager.refreshFiles — fetch-error path (markdown.ts:151)', () => {
    it('a fetch-error message containing HTML renders as literal text, not markup', async () => {
        const mm = makeMm();
        mockFetch(() => ({ ok: false, status: 500, text: PAYLOAD }));
        await mm.refreshFiles({ force: true }); // silent:false (default) -> writes the error div
        expect(mm.fileListEl.querySelector('img')).toBeNull();
        expect(mm.fileListEl.textContent).toContain(PAYLOAD);
    });
});

describe('MarkdownManager.openFile — fetch-error path (markdown.ts:355)', () => {
    it('a fetch-error message containing HTML renders as literal text, not markup', async () => {
        const mm = makeMm();
        mockFetch(() => ({ ok: false, status: 500, text: PAYLOAD }));
        await mm.openFile({ name: 'x.md', path: '/w/x.md' });
        expect(mm.modalBody.querySelector('img')).toBeNull();
        expect(mm.modalBody.textContent).toContain(PAYLOAD);
    });
});

describe('MarkdownManager.openHelpModal — fetch-error path (markdown.ts:~419)', () => {
    it('the raw help.md response body renders as literal text, not markup', async () => {
        const m = makeBareMm();
        // On a non-ok response the thrown message IS `await res.text()` —
        // i.e. the raw HTTP response body, verbatim server content.
        mockFetch(() => ({ ok: false, status: 500, text: PAYLOAD }));
        await m.openHelpModal();
        expect(m.modalBody.querySelector('img')).toBeNull();
        expect(m.modalBody.textContent).toContain(PAYLOAD);
    });
});

describe('MarkdownManager.openChangelogModal — fetch-error path (markdown.ts:~526)', () => {
    it('the raw changelog.md response body renders as literal text, not markup', async () => {
        const m = makeBareMm();
        mockFetch(() => ({ ok: false, status: 500, text: PAYLOAD }));
        await m.openChangelogModal();
        expect(m.modalBody.querySelector('img')).toBeNull();
        expect(m.modalBody.textContent).toContain(PAYLOAD);
    });
});

describe('DiffController.loadRichDiff — fetch-error path (diff.ts:~949)', () => {
    it('a fetch-error message containing HTML renders as literal text, not markup', async () => {
        stubWebSocket();
        const mod = await import('../web/diff.js');
        const ctx = {
            diffModalBody: document.createElement('div'),
            app: { sessionsManager: { activeCWD: '/ws' } },
            commitSelect: { value: 'unstaged' },
            currentContextLines: 3,
        };
        mockFetch(() => ({ ok: false, status: 500, text: PAYLOAD }));
        await mod.DiffController.prototype.loadRichDiff.call(ctx);
        expect(ctx.diffModalBody.querySelector('img')).toBeNull();
        expect(ctx.diffModalBody.textContent).toContain(PAYLOAD);
    });
});

describe('SessionsManager.loadWorktrees — scan-error path (sessions.ts:~511)', () => {
    it('an error message containing HTML renders as literal text, not markup', async () => {
        const ctx = {
            sessionList: document.createElement('div'),
            activeWorkspace: '/ws',
            activeCWD: '',
            activeCoder: 'claude',
            worktreeDirtyRequestId: 0,
        };
        // The not-ok branch throws a fixed string ("Failed to scan
        // worktrees"), not attacker-controlled text. To reach this catch
        // with a payload we simulate a lower-level fetch rejection instead
        // (the network/DNS-failure shape) — whatever propagates up lands
        // in the same escapeHtml((e as Error).message) call at line 511.
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(PAYLOAD); }));
        await SessionsManager.prototype.loadWorktrees.call(ctx, null);
        expect(ctx.sessionList.querySelector('img')).toBeNull();
        expect(ctx.sessionList.textContent).toContain(PAYLOAD);
    });
});

describe('SessionsManager.loadWorktreeSessions — fetch-error path (sessions.ts:~680)', () => {
    it('a fetch-error message containing HTML renders as literal text, not markup', async () => {
        const ctx = { activeCoder: 'claude' };
        const container = document.createElement('div');
        mockFetch(() => ({ ok: false, status: 500, text: PAYLOAD }));
        await SessionsManager.prototype.loadWorktreeSessions.call(ctx, '/wt', container);
        expect(container.querySelector('img')).toBeNull();
        expect(container.textContent).toContain(PAYLOAD);
    });
});

describe('SyncManager.refreshMessages — fetch-error path (sync.ts:~153)', () => {
    it('a fetch-error message containing HTML renders as literal text via this.escapeHtml, not markup', async () => {
        const m = Object.create(SyncManager.prototype);
        m.coordinatorInput = document.createElement('input');
        m.messagesList = document.createElement('div');
        m.app = { sessionsManager: { config: { sync_coordinator: 'http://localhost:7070' } } };
        mockFetch(() => ({ ok: false, status: 500, text: PAYLOAD }));
        await m.refreshMessages();
        expect(m.messagesList.querySelector('img')).toBeNull();
        expect(m.messagesList.textContent).toContain(PAYLOAD);
    });
});
