// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, setupDomHarness, stubWebSocket } from './_dom.js';
import { DiffController } from '../web/diff.js';

setupDomHarness();

const TARGET = {
    root: '/workspace/project',
    head: 'a'.repeat(40),
    branch: 'main',
    remote: 'origin',
    remote_ref: 'refs/heads/main',
    remote_token: 'b'.repeat(64),
};
const INDEX_TOKEN = 'c'.repeat(64);

function stageInfo(overrides = {}) {
    return {
        notGitRepo: false,
        target: TARGET,
        can_pull_push: true,
        reason: '',
        has_staged: false,
        index_token: INDEX_TOKEN,
        can_commit: false,
        commit_reason: 'Stage changes first.',
        can_stage: true,
        ...overrides,
    };
}

function bootstrapDom() {
    document.body.innerHTML = `
        <div id="diff-panel"></div>
        <button id="header-diff-toggle-btn"></button>
        <button id="close-diff-btn"></button>
        <button id="refresh-diff-btn"></button>
        <button id="copy-diff-btn"></button>
        <div id="diff-term-container"></div>
        <select id="diff-commit-select"></select>
        <div id="diff-action-bar">
            <section id="git-management">
                <div id="git-target-label"></div>
                <div id="git-files" class="git-files hidden">
                    <div class="git-files-head">
                        <span class="git-files-title">Working tree</span>
                        <button id="git-stage-all-btn" type="button" disabled>Stage all</button>
                    </div>
                    <ul id="git-file-list" aria-label="Working tree files"></ul>
                    <div id="git-files-note" class="git-files-note hidden" role="status"></div>
                </div>
                <label for="git-commit-message">Commit message</label>
                <textarea id="git-commit-message" aria-describedby="git-commit-hint git-commit-draft-status"></textarea>
                <div id="git-commit-draft-status" class="hidden" role="status"></div>
                <div id="git-commit-hint" class="git-commit-hint hidden"></div>
                <button id="git-pull-btn" disabled>Pull</button>
                <button id="git-push-btn" disabled>Push</button>
                <button id="git-commit-btn" disabled>Commit staged</button>
                <div id="git-management-recovery" class="hidden">
                    <button id="git-action-resume-btn" class="hidden">Resume</button>
                    <button id="git-action-cancel-btn" class="hidden">Cancel</button>
                    <button id="git-action-dismiss-btn" class="hidden">Dismiss</button>
                </div>
                <div id="git-action-status" role="status" aria-live="polite"></div>
            </section>
        </div>
        <button id="rich-diff-btn"></button>
        <div id="diff-modal" class="hidden">
            <button id="diff-modal-close"></button>
            <div id="diff-modal-body"></div>
        </div>
    `;
}

function buildApp() {
    return {
        scope: {
            profileId: 'fixture-profile',
            origin: 'http://phi-fixture.test',
            signal: new AbortController().signal,
            headers: () => ({ 'X-Phi-Backend': 'fixture-profile' }),
        },
        sessionsManager: { activeCWD: '/workspace/project' },
        tabManager: { getActiveTab: () => ({ cwd: '/workspace/project' }) },
        showToast: vi.fn(),
    };
}

function rows() {
    return [...document.querySelectorAll('#git-file-list .git-file-row')].map(
        (row) => ({
            status: row.querySelector('.git-file-status')?.textContent || '',
            path: row.querySelector('.git-file-path')?.textContent || '',
            label: row.querySelector('.git-file-toggle')?.textContent || '',
            disabled: row.querySelector('.git-file-toggle')?.disabled === true,
        }),
    );
}

function rowButton(path) {
    return [
        ...document.querySelectorAll('#git-file-list .git-file-toggle'),
    ].find((button) => button.dataset.path === path);
}

function actionPosts(fetch) {
    return fetch.mock.calls
        .filter(([url]) => String(url).includes('/api/git/action'))
        .map(([, init]) => JSON.parse(String(init?.body)));
}

function gitRoutes({
    info = () => stageInfo(),
    files = () => [],
    truncated = false,
    action = () => ({ action: 'stage', root: TARGET.root, output: 'ok' }),
} = {}) {
    const fetch = mockFetch((url, init) => {
        const path = new URL(String(url), window.location.href).pathname;
        if (path === '/api/git/info') return info();
        if (path === '/api/git/status-files')
            return { files: files(), truncated };
        if (path === '/api/git/action')
            return { ok: true, status: 200, json: action(init) };
        return { ok: false, status: 404, text: 'Not found' };
    });
    return fetch;
}

describe('Git drawer staging', () => {
    beforeEach(() => {
        bootstrapDom();
        stubWebSocket();
        localStorage.clear();
    });

    it('lists working tree files with a stage or unstage action', async () => {
        gitRoutes({
            files: () => [
                { path: 'src/new.ts', index: ' ', worktree: '?' },
                { path: 'src/old.ts', index: 'M', worktree: ' ' },
                { path: 'src/both.ts', index: 'M', worktree: 'M' },
            ],
        });
        const controller = new DiffController(buildApp());
        await controller.refreshDiff();
        await vi.waitFor(() => expect(rows()).toHaveLength(3));

        expect(document.getElementById('git-files').classList).not.toContain(
            'hidden',
        );
        expect(rows()).toEqual([
            {
                status: '?',
                path: 'src/new.ts',
                label: 'Stage',
                disabled: false,
            },
            {
                status: 'M',
                path: 'src/old.ts',
                label: 'Unstage',
                disabled: false,
            },
            {
                status: 'M',
                path: 'src/both.ts',
                label: 'Unstage',
                disabled: false,
            },
        ]);
    });

    it('hides staging controls when the server does not advertise can_stage', async () => {
        const { can_stage, ...legacy } = stageInfo();
        expect(can_stage).toBe(true);
        gitRoutes({
            info: () => legacy,
            files: () => [{ path: 'src/new.ts', index: ' ', worktree: '?' }],
        });
        const controller = new DiffController(buildApp());
        await controller.refreshDiff();
        await vi.waitFor(() =>
            expect(
                document.getElementById('git-target-label').textContent,
            ).toContain('/workspace/project'),
        );

        expect(document.getElementById('git-files').classList).toContain(
            'hidden',
        );
        expect(rows()).toHaveLength(0);
    });

    it('stages one file with the index token and keeps the working tree', async () => {
        let staged = false;
        const fetch = gitRoutes({
            info: () =>
                staged
                    ? stageInfo({
                          has_staged: true,
                          can_commit: true,
                          commit_reason: '',
                          index_token: 'd'.repeat(64),
                      })
                    : stageInfo(),
            files: () =>
                staged
                    ? [{ path: 'src/new.ts', index: 'A', worktree: ' ' }]
                    : [{ path: 'src/new.ts', index: ' ', worktree: '?' }],
            action: () => {
                staged = true;
                return { action: 'stage', root: TARGET.root, output: 'ok' };
            },
        });
        const controller = new DiffController(buildApp());
        await controller.refreshDiff();
        await vi.waitFor(() => expect(rows()).toHaveLength(1));
        document.getElementById('git-commit-message').value = 'stage a file';

        rowButton('src/new.ts').click();
        await vi.waitFor(() => expect(actionPosts(fetch)).toHaveLength(1));
        const [body] = actionPosts(fetch);
        expect(body).toMatchObject({
            cwd: '/workspace/project',
            action: 'stage',
            index_token: INDEX_TOKEN,
            paths: ['src/new.ts'],
            target: { root: TARGET.root, head: TARGET.head },
        });
        expect(body.message).toBeUndefined();
        await vi.waitFor(() => expect(rows()[0].label).toBe('Unstage'));
        await vi.waitFor(() =>
            expect(document.getElementById('git-commit-btn').disabled).toBe(
                false,
            ),
        );
    });

    it('unstages one file and reports the action to the server', async () => {
        let unstaged = false;
        const fetch = gitRoutes({
            info: () => stageInfo({ has_staged: true, can_commit: true }),
            files: () =>
                unstaged
                    ? [{ path: 'src/old.ts', index: ' ', worktree: 'M' }]
                    : [{ path: 'src/old.ts', index: 'M', worktree: ' ' }],
            action: () => {
                unstaged = true;
                return { action: 'unstage', root: TARGET.root, output: 'ok' };
            },
        });
        const controller = new DiffController(buildApp());
        await controller.refreshDiff();
        await vi.waitFor(() => expect(rows()[0]?.label).toBe('Unstage'));

        rowButton('src/old.ts').click();
        await vi.waitFor(() => expect(actionPosts(fetch)).toHaveLength(1));
        expect(actionPosts(fetch)[0]).toMatchObject({
            action: 'unstage',
            paths: ['src/old.ts'],
            index_token: INDEX_TOKEN,
        });
        await vi.waitFor(() => expect(rows()[0]?.label).toBe('Stage'));
    });

    it('stages every unstaged file with Stage all', async () => {
        const fetch = gitRoutes({
            files: () => [
                { path: 'a.txt', index: ' ', worktree: 'M' },
                { path: 'b.txt', index: ' ', worktree: '?' },
                { path: 'c.txt', index: 'M', worktree: ' ' },
            ],
        });
        const controller = new DiffController(buildApp());
        await controller.refreshDiff();
        await vi.waitFor(() => expect(rows()).toHaveLength(3));
        expect(document.getElementById('git-stage-all-btn').disabled).toBe(
            false,
        );

        document.getElementById('git-stage-all-btn').click();
        await vi.waitFor(() => expect(actionPosts(fetch)).toHaveLength(1));
        expect(actionPosts(fetch)[0]).toMatchObject({
            action: 'stage',
            paths: ['a.txt', 'b.txt'],
        });
    });

    it('keeps the last file list and explains a rejected index', async () => {
        let calls = 0;
        const fetch = mockFetch((url) => {
            const path = new URL(String(url), window.location.href).pathname;
            if (path === '/api/git/info') return stageInfo();
            if (path === '/api/git/status-files') {
                calls++;
                return {
                    files: [{ path: 'a.txt', index: ' ', worktree: 'M' }],
                };
            }
            if (path === '/api/git/action')
                return {
                    ok: false,
                    status: 409,
                    text: 'Git index changed. Refresh before staging again.',
                };
            return { ok: false, status: 404, text: 'Not found' };
        });
        const controller = new DiffController(buildApp());
        await controller.refreshDiff();
        await vi.waitFor(() => expect(rows()).toHaveLength(1));
        expect(calls).toBeGreaterThan(0);

        rowButton('a.txt').click();
        await vi.waitFor(() =>
            expect(
                document.getElementById('git-files-note').textContent,
            ).toContain('staged set changed'),
        );
        expect(rows()).toHaveLength(1);
        expect(rows()[0].label).toBe('Stage');
        expect(actionPosts(fetch)).toHaveLength(1);
    });

    it('explains a truncated file list instead of hiding files silently', async () => {
        gitRoutes({
            files: () => [
                { path: 'a.txt', index: ' ', worktree: '?' },
                { path: 'b.txt', index: ' ', worktree: '?' },
            ],
            truncated: true,
        });
        const controller = new DiffController(buildApp());
        await controller.refreshDiff();
        await vi.waitFor(() =>
            expect(
                document.getElementById('git-files-note').textContent,
            ).toContain('more files than this list can show'),
        );
        expect(rows()).toHaveLength(2);
    });

    it('runs one staging batch at a time', async () => {
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const fetch = gitRoutes({
            files: () => [{ path: 'a.txt', index: ' ', worktree: '?' }],
            action: () => {
                release();
                return { action: 'stage', root: TARGET.root, output: 'ok' };
            },
        });
        const controller = new DiffController(buildApp());
        await controller.refreshDiff();
        await vi.waitFor(() => expect(rows()).toHaveLength(1));

        const first = controller.stageGitPaths('stage', ['a.txt']);
        rowButton('a.txt').click();
        await gate;
        expect(actionPosts(fetch)).toHaveLength(1);
        expect(rowButton('a.txt').disabled).toBe(true);
        await first;
        await vi.waitFor(() => expect(rowButton('a.txt').disabled).toBe(false));
    });

    it('ignores a file list read that started before a stage batch', async () => {
        const releases = [];
        let reads = 0;
        const fetch = mockFetch((url) => {
            const path = new URL(String(url), window.location.href).pathname;
            if (path === '/api/git/info') return stageInfo();
            if (path === '/api/git/status-files') {
                reads++;
                if (reads === 1)
                    return {
                        files: [{ path: 'a.txt', index: ' ', worktree: '?' }],
                    };
                // Every later read waits, so the test decides what arrives
                // first: the slow pre-batch answer or the post-batch one.
                return new Promise((resolve) => {
                    releases.push((files) => resolve({ files }));
                });
            }
            if (path === '/api/git/action')
                return { ok: true, status: 200, text: 'Stage completed.' };
            return { ok: false, status: 404, text: 'Not found' };
        });
        const controller = new DiffController(buildApp());
        await controller.refreshDiff();
        await vi.waitFor(() => expect(rows()).toHaveLength(1));

        // A slow read is already in flight when the user stages the file.
        void controller.refreshDiff();
        await vi.waitFor(() => expect(releases).toHaveLength(1));
        rowButton('a.txt').click();
        await vi.waitFor(() => expect(releases).toHaveLength(2));

        // The stale answer lands first and must not reach the list or cache.
        releases[0]([{ path: 'a.txt', index: ' ', worktree: '?' }]);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(rows()[0].label).toBe('Stage');

        // The post-batch answer is the one that counts.
        releases[1]([{ path: 'a.txt', index: 'A', worktree: ' ' }]);
        await vi.waitFor(() => expect(rows()[0].label).toBe('Unstage'));
        const cached = JSON.parse(
            localStorage.getItem(controller.gitFilesKey) || 'null',
        );
        expect(cached.files).toEqual([
            { path: 'a.txt', index: 'A', worktree: ' ' },
        ]);
        expect(actionPosts(fetch)).toHaveLength(1);
    });

    it('does not fetch the file list while the drawer is closed', async () => {
        const fetch = gitRoutes({
            files: () => [{ path: 'src/new.ts', index: ' ', worktree: '?' }],
        });
        const controller = new DiffController(buildApp());
        controller.togglePanel(false);
        await controller.refreshDiff();
        await vi.waitFor(() =>
            expect(
                fetch.mock.calls.filter(([url]) =>
                    String(url).includes('/api/git/status-files'),
                ),
            ).toHaveLength(0),
        );
        expect(rows()).toHaveLength(0);
        expect(fetch.mock.calls.length).toBeGreaterThan(0);
    });

    it('degrades to a note when the file list request fails', async () => {
        mockFetch((url) => {
            const path = new URL(String(url), window.location.href).pathname;
            if (path === '/api/git/info') return stageInfo();
            if (path === '/api/git/status-files')
                throw new TypeError('offline');
            return { ok: false, status: 404, text: 'Not found' };
        });
        const controller = new DiffController(buildApp());
        await controller.refreshDiff();
        await vi.waitFor(() =>
            expect(
                document.getElementById('git-files-note').textContent,
            ).toContain('File list is unavailable'),
        );
        expect(document.getElementById('git-files').classList).not.toContain(
            'hidden',
        );
    });
});
