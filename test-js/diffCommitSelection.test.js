// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { DiffController } from '../web/diff.js';

setupDomHarness();

function context() {
    document.body.innerHTML = `
        <button class="diff-tab-btn active" data-tab="sync">sync</button>
        <button class="diff-tab-btn" data-tab="diff">diff</button>
        <select id="diff-commit-select"><option value="unstaged">Unstaged Changes</option></select>
    `;
    return Object.assign(Object.create(DiffController.prototype), {
        app: { sessionsManager: { activeCWD: '/project' } },
        commitSelect: document.getElementById('diff-commit-select'),
        syncCommitTarget: null,
        activeTab: 'sync',
        isPanelOpen: true,
        togglePanel: vi.fn(),
        _setPanel: vi.fn(),
        refreshDiff: vi.fn().mockResolvedValue(undefined),
        openRichDiffModal: vi.fn().mockResolvedValue(undefined),
    });
}

function commitsResponse(
    commits = [{ hash: 'abcdef0', subject: 'Recent commit' }],
) {
    return { ok: true, json: async () => commits };
}

describe('Sync Board commit selection', () => {
    it('selects the hash before refreshing or opening the pretty diff, even outside the recent list', async () => {
        const ctx = context();
        ctx.refreshDiff.mockImplementation(async () => {
            expect(ctx.commitSelect.value).toBe('678d343');
        });
        ctx.openRichDiffModal.mockImplementation(async () => {
            expect(ctx.commitSelect.value).toBe('678d343');
        });
        await ctx.openCommitDiff('678d343', true);
        expect(ctx.activeTab).toBe('diff');
        expect(document.querySelector('.diff-tab-btn.active').dataset.tab).toBe(
            'diff',
        );
        expect(ctx.refreshDiff).toHaveBeenCalledWith(true);
        expect(ctx.openRichDiffModal).toHaveBeenCalledOnce();
        expect(ctx.commitSelect.selectedOptions[0].textContent).toContain(
            '678d343',
        );
    });

    it('keeps a requested commit selected across recent-list refreshes', async () => {
        const ctx = context();
        await ctx.openCommitDiff('678d343');
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => commitsResponse()),
        );
        await ctx.loadCommits();
        await ctx.loadCommits();
        expect(ctx.commitSelect.value).toBe('678d343');
        expect(
            Array.from(ctx.commitSelect.options).filter(
                (o) => o.value === '678d343',
            ),
        ).toHaveLength(1);
        expect(ctx.openRichDiffModal).not.toHaveBeenCalled();
    });

    it('a recent-list request already in flight cannot reset a later card selection', async () => {
        const ctx = context();
        let resolve;
        vi.stubGlobal(
            'fetch',
            vi.fn(
                () =>
                    new Promise((done) => {
                        resolve = done;
                    }),
            ),
        );
        const loading = ctx.loadCommits();
        await ctx.openCommitDiff('678d343');
        resolve(commitsResponse());
        await loading;
        expect(ctx.commitSelect.value).toBe('678d343');
    });

    it('does not carry a card selection into another project or accept its late commit list', async () => {
        const ctx = context();
        await ctx.openCommitDiff('678d343');
        let resolve;
        vi.stubGlobal(
            'fetch',
            vi.fn(
                () =>
                    new Promise((done) => {
                        resolve = done;
                    }),
            ),
        );
        const loading = ctx.loadCommits();
        ctx.app.sessionsManager.activeCWD = '/other-project';
        resolve(commitsResponse());
        await loading;
        expect(ctx.commitSelect.value).toBe('678d343'); // old response did not touch the selector
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => commitsResponse()),
        );
        await ctx.loadCommits();
        expect(ctx.commitSelect.value).toBe('unstaged');
        expect(ctx.syncCommitTarget).toBeNull();
    });

    it('rejects invalid hashes without changing the selected view', async () => {
        const ctx = context();
        await expect(ctx.openCommitDiff('--all', true)).rejects.toThrow(
            'Invalid Git commit hash',
        );
        expect(ctx.activeTab).toBe('sync');
        expect(ctx.commitSelect.value).toBe('unstaged');
        expect(ctx.refreshDiff).not.toHaveBeenCalled();
        expect(ctx.openRichDiffModal).not.toHaveBeenCalled();
    });
});
