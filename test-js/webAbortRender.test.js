// @vitest-environment jsdom
//
// ─────────────────────────────────────────────────────────────────────────
// FUNDAMENTAL CONTRACT — DO NOT CHANGE.
//
// The desktop runs ONE embedded page (phi-app://app) for EVERY server and
// switches servers in place. Every switch replaces the page's BackendScope,
// and every request bound to the old scope dies with it.
//
// An abort is not a server answer. It is not a verdict on the user's
// input, and an internal abort reason ('The operation was aborted',
// 'Owner changed') must never surface as a toast, an alert, or rendered
// error text — the winning switch owns the surface, and a dead scope
// renders nothing. This file pins that by driving the REAL methods
// (hand-built `this`, never `new` — the established test-js pattern):
//
//   - the shared predicate (web/util.js isAbortError) — one definition
//     imported by app/auth/terminal/sessions/settings/diff;
//   - SessionsManager: spawnNewSession, openInlineRenamer, openReviewTab;
//   - DiffController: addCommand, deleteCommand, executeHiddenBatch.
//
// The settings modal's guards and the batch-scan/launch-shell toasts use
// the same predicate inside listener closures that are not reachable
// without the full modal; they are covered by the shared-predicate test
// and by code review rather than by driving the whole modal here.
//
// If a change makes any case here fail, the change is wrong — not the
// test.
// ─────────────────────────────────────────────────────────────────────────
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { isAbortError } from '../web/util.js';
import { SessionsManager } from '../web/sessions.js';
import { DiffController } from '../web/diff.js';

setupDomHarness();

const ABORT = Object.assign(new Error('The operation was aborted.'), {
    name: 'AbortError',
});

function failingFetch(error) {
    return vi.fn(async () => {
        throw error;
    });
}

describe('isAbortError (shared predicate)', () => {
    it('recognises abort errors by name, nothing else', () => {
        expect(isAbortError(ABORT)).toBe(true);
        expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true);
        expect(isAbortError(new Error('Owner changed'))).toBe(false);
        expect(isAbortError(new TypeError('fetch failed'))).toBe(false);
        expect(isAbortError(null)).toBe(false);
        expect(isAbortError(undefined)).toBe(false);
    });
});

// SessionsManager sites: hand-built `this`, never `new` the controller.
function makeSessionsCtx(over = {}) {
    const tabManager = {
        tabs: new Map(),
        createTab: vi.fn((paneId) => {
            tabManager.tabs.set(paneId, {
                termContainer: document.createElement('div'),
            });
        }),
        switchTab: vi.fn(),
        copyTextRobustly: vi.fn(),
    };
    return Object.assign(Object.create(SessionsManager.prototype), {
        activeCoder: 'shell',
        activeCWD: '/ws',
        activeWorkspace: '',
        app: {
            scope: { aborted: false },
            showToast: vi.fn(),
            tabManager,
        },
        loadSessions: vi.fn(async () => {}),
        fetchOpenCodeServiceStatus: vi.fn(),
        ...over,
    });
}

describe('SessionsManager never shows an abort reason', () => {
    beforeEach(() => {
        vi.stubGlobal('alert', vi.fn());
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('spawnNewSession: an aborted spawn toasts nothing; a real failure still toasts', async () => {
        const ctx = makeSessionsCtx();
        vi.stubGlobal('fetch', failingFetch(ABORT));
        await ctx.spawnNewSession();
        expect(ctx.app.showToast).not.toHaveBeenCalled();

        ctx.app.showToast.mockClear();
        vi.stubGlobal('fetch', failingFetch(new Error('daemon offline')));
        await ctx.spawnNewSession();
        expect(ctx.app.showToast).toHaveBeenCalledWith('daemon offline', {
            type: 'error',
        });
    });

    it('openInlineRenamer: an interrupted rename never alerts and the pending input survives', async () => {
        const ctx = makeSessionsCtx();
        const item = document.createElement('div');
        const title = document.createElement('span');
        title.className = 'session-title';
        title.textContent = 'Old';
        item.appendChild(title);
        document.body.appendChild(item);

        ctx.openInlineRenamer(item, 'sess-1', 'Old');
        const input = item.querySelector('.rename-input');
        expect(input).not.toBeNull();
        input.value = 'New';
        vi.stubGlobal('fetch', failingFetch(ABORT));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // No alert with an internal abort reason; the rename stays in its
        // saving state (the winning switch owns whatever comes next) and
        // a late blur cannot turn the abort into a failure either.
        expect(alert).not.toHaveBeenCalled();
        expect(input.isConnected).toBe(true);
        input.dispatchEvent(new Event('blur'));
        await Promise.resolve();
        await Promise.resolve();
        expect(alert).not.toHaveBeenCalled();
        expect(ctx.loadSessions).not.toHaveBeenCalled();
    });

    it('openInlineRenamer: a real failure alerts and restores the old title', async () => {
        const ctx = makeSessionsCtx();
        const item = document.createElement('div');
        const title = document.createElement('span');
        title.className = 'session-title';
        item.appendChild(title);
        document.body.appendChild(item);

        ctx.openInlineRenamer(item, 'sess-1', 'Old');
        const input = item.querySelector('.rename-input');
        input.value = 'New';
        vi.stubGlobal('fetch', failingFetch(new Error('disk full')));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(alert).toHaveBeenCalledWith('Failed to rename: disk full');
        // finish(currentTitle) ran: the title span is back.
        expect(item.querySelector('.session-title')?.textContent).toBe('Old');
    });

    it('openReviewTab: an aborted transcript load renders no error block', async () => {
        const ctx = makeSessionsCtx();
        vi.stubGlobal('fetch', failingFetch(ABORT));
        await ctx.openReviewTab({
            id: 's1',
            title: 'T',
            coder: 'shell',
            cwd: '/w',
        });
        const termContainer =
            ctx.app.tabManager.tabs.get('review-s1')?.termContainer;
        expect(termContainer).toBeTruthy();
        expect(termContainer.querySelector('.review-error')).toBeNull();
    });

    it('openReviewTab: a real transcript failure still renders its error', async () => {
        const ctx = makeSessionsCtx();
        vi.stubGlobal('fetch', failingFetch(new Error('HTTP 500')));
        await ctx.openReviewTab({
            id: 's1',
            title: 'T',
            coder: 'shell',
            cwd: '/w',
        });
        const termContainer =
            ctx.app.tabManager.tabs.get('review-s1')?.termContainer;
        expect(
            termContainer.querySelector('.review-error')?.textContent,
        ).toContain('HTTP 500');
    });
});

// DiffController sites: same pattern.
function makeDiffCtx(over = {}) {
    const inputArea = document.createElement('textarea');
    inputArea.value = '';
    const tabManager = {
        inputTextArea: inputArea,
        lastInputValue: '',
        adjustInputHeight: vi.fn(),
        _resetPiRecall: vi.fn(),
    };
    return Object.assign(Object.create(DiffController.prototype), {
        app: {
            scope: { aborted: false },
            showToast: vi.fn(),
            tabManager,
            sessionsManager: { loadConfig: vi.fn(), loadSessions: vi.fn() },
        },
        activeBatchResults: null,
        diffModalBody: document.createElement('div'),
        renderCmdPanel: vi.fn(),
        ...over,
    });
}

describe('DiffController never shows an abort reason', () => {
    beforeEach(() => {
        vi.stubGlobal('alert', vi.fn());
        vi.stubGlobal(
            'confirm',
            vi.fn(() => true),
        );
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('addCommand: an aborted save toasts nothing; a real failure still toasts', async () => {
        const ctx = makeDiffCtx({
            app: Object.assign(makeDiffCtx().app, {
                openConfigEditor: vi.fn(async () => ({
                    name: 'tests',
                    command: 'npm test',
                })),
            }),
        });
        vi.stubGlobal('fetch', failingFetch(ABORT));
        await ctx.addCommand();
        expect(ctx.app.showToast).not.toHaveBeenCalled();

        ctx.app.showToast.mockClear();
        vi.stubGlobal('fetch', failingFetch(new Error('config locked')));
        await ctx.addCommand();
        expect(ctx.app.showToast).toHaveBeenCalledWith('config locked', {
            type: 'error',
            title: 'Commands',
        });
    });

    it('deleteCommand: an aborted delete alerts nothing; a real failure still alerts', async () => {
        const ctx = makeDiffCtx();
        vi.stubGlobal('fetch', failingFetch(ABORT));
        await ctx.deleteCommand({ name: 'tests' });
        expect(alert).not.toHaveBeenCalled();

        vi.stubGlobal('fetch', failingFetch(new Error('readonly store')));
        await ctx.deleteCommand({ name: 'tests' });
        expect(alert).toHaveBeenCalledWith(
            'Delete command failed: readonly store',
        );
    });

    it('executeHiddenBatch: an aborted batch keeps rows running and toasts nothing', async () => {
        const ctx = makeDiffCtx();
        vi.stubGlobal('fetch', failingFetch(ABORT));
        await ctx.executeHiddenBatch(
            { name: 'lint', command: 'pnpm lint' },
            ['/repo/alpha'],
            'Dirty Worktrees (1)',
        );
        const row = ctx.activeBatchResults.worktrees[0];
        expect(row.status).toBe('running');
        expect(row.error).toBeUndefined();
        expect(ctx.app.showToast).not.toHaveBeenCalled();
    });

    it('executeHiddenBatch: a real batch failure marks the rows and toasts', async () => {
        const ctx = makeDiffCtx();
        vi.stubGlobal('fetch', failingFetch(new Error('queue full')));
        await ctx.executeHiddenBatch(
            { name: 'lint', command: 'pnpm lint' },
            ['/repo/alpha'],
            'Dirty Worktrees (1)',
        );
        const row = ctx.activeBatchResults.worktrees[0];
        expect(row.status).toBe('error');
        expect(row.error).toBe('queue full');
        expect(ctx.app.showToast).toHaveBeenCalledWith(
            'Batch execution failed: queue full',
            { type: 'error', title: 'Batch Command' },
        );
    });
});
