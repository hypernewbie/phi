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
const INFO = {
    notGitRepo: false,
    target: TARGET,
    can_pull_push: true,
    reason: '',
};
const COMMIT_INFO = {
    ...INFO,
    has_staged: true,
    index_token: 'c'.repeat(64),
    can_commit: true,
    commit_reason: '',
};

function bootstrapDom() {
    document.body.innerHTML = `
        <div id="diff-panel"></div>
        <button id="header-diff-toggle-btn"></button>
        <button id="close-diff-btn"></button>
        <button id="refresh-diff-btn"></button>
        <button id="copy-diff-btn"></button>
        <div id="diff-term-container"></div>
        <div id="markdown-file-list" class="hidden"></div>
        <div id="cmd-panel" class="hidden"></div>
        <div id="sync-panel" class="hidden"></div>
        <div id="file-tree-list" class="hidden"></div>
        <div id="file-tree-toolbar" class="hidden"></div>
        <select id="diff-commit-select"></select>
        <div id="diff-action-bar">
            <section id="git-management">
                <div id="git-target-label"></div>
                <label for="git-commit-message">Commit message</label>
                <textarea id="git-commit-message"></textarea>
                <div id="git-commit-draft-status" class="hidden" role="status"></div>
                <button id="git-pull-btn" disabled>Pull</button>
                <button id="git-push-btn" disabled>Push</button>
                <button id="git-commit-btn" disabled>Commit staged</button>
                <button id="git-action-resume-btn" class="hidden">Resume</button>
                <button id="git-action-cancel-btn" class="hidden">Cancel</button>
                <button id="git-action-dismiss-btn" class="hidden">Dismiss</button>
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

function storedRecords() {
    return Array.from({ length: localStorage.length }, (_, index) => {
        const key = localStorage.key(index);
        if (!key) return null;
        try {
            return JSON.parse(localStorage.getItem(key) || 'null');
        } catch {
            return null;
        }
    }).filter(Boolean);
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

function enableFakeTerminal(controller) {
    const writes = [];
    controller.term = {
        cols: 80,
        rows: 24,
        options: { fontSize: 14 },
        reset: vi.fn(),
        clear: vi.fn(),
        resize: vi.fn(),
        write: vi.fn((text) => writes.push(String(text))),
    };
    controller.fitAddon = {
        proposeDimensions: () => ({ cols: 80, rows: 24 }),
        fit: vi.fn(),
    };
    controller.isPanelOpen = true;
    return writes;
}

describe('Git drawer action safety', () => {
    beforeEach(() => {
        bootstrapDom();
        stubWebSocket();
    });

    it('waits for a workspace before requesting Git information', async () => {
        const app = buildApp();
        app.sessionsManager.activeCWD = '';
        const fetch = mockFetch(() => {
            throw new Error('Git requests need a selected workspace');
        });
        const controller = new DiffController(app);

        await controller.refreshDiff();

        expect(fetch).not.toHaveBeenCalled();
        expect(document.getElementById('git-action-status').textContent).toBe(
            'Select a workspace to view Git actions.',
        );
    });

    it('paints a saved Git view before refresh and keeps it on network failure', async () => {
        const firstStatus = deferred();
        let statusCalls = 0;
        mockFetch((url) => {
            const path = new URL(url, window.location.href).pathname;
            if (path === '/api/git/info')
                return { ok: true, status: 200, json: INFO };
            if (path === '/api/git/raw-status') {
                statusCalls++;
                return firstStatus.promise;
            }
            throw new Error(`Unexpected fetch ${url}`);
        });

        const controller = new DiffController(buildApp());
        controller.activeTab = 'status';
        const writes = enableFakeTerminal(controller);
        const context = controller.captureGitManageContext();
        controller.cacheGitView(
            context,
            TARGET.root,
            'status',
            'recent',
            'saved status view',
            TARGET.head,
            TARGET.branch,
        );

        const refresh = controller.refreshDiff();
        await vi.waitFor(() => expect(statusCalls).toBe(1));
        expect(writes.join('')).toContain('saved status view');
        firstStatus.resolve({
            ok: true,
            status: 200,
            text: 'fresh status view',
        });
        await refresh;
        expect(writes.join('')).toContain('fresh status view');

        const failedStatus = deferred();
        statusCalls = 0;
        mockFetch((url) => {
            const path = new URL(url, window.location.href).pathname;
            if (path === '/api/git/info')
                return { ok: true, status: 200, json: INFO };
            if (path === '/api/git/raw-status') {
                statusCalls++;
                return failedStatus.promise;
            }
            throw new Error(`Unexpected fetch ${url}`);
        });
        const failedRefresh = controller.refreshDiff();
        await vi.waitFor(() => expect(statusCalls).toBe(1));
        expect(writes.join('')).toContain('fresh status view');
        failedStatus.reject(new TypeError('offline'));
        await failedRefresh;
        expect(writes.join('')).toContain('fresh status view');
        expect(writes.at(-1)).toContain('Failed to load:');
    });

    it('retries an unsent action after the Git information request recovers', async () => {
        vi.useFakeTimers();
        let infoCalls = 0;
        let actionCalls = 0;
        mockFetch((url) => {
            const path = new URL(url, window.location.href).pathname;
            if (path === '/api/git/info') {
                infoCalls++;
                if (infoCalls === 2) throw new TypeError('offline');
                return { ok: true, status: 200, json: INFO };
            }
            if (path === '/api/git/action') {
                actionCalls++;
                return {
                    ok: true,
                    status: 200,
                    json: {
                        action: 'pull',
                        root: TARGET.root,
                        output: 'Pull completed.',
                    },
                };
            }
            throw new Error(`Unexpected fetch ${url}`);
        });

        const app = buildApp();
        const controller = new DiffController(app);
        await controller.refreshDiff();
        await vi.waitFor(() => {
            expect(document.getElementById('git-pull-btn').disabled).toBe(
                false,
            );
        });

        document.getElementById('git-pull-btn').click();
        await vi.waitFor(() => {
            expect(
                document.getElementById('git-action-status').textContent,
            ).toContain('retrying Pull in 1s');
        });
        expect(actionCalls).toBe(0);

        await vi.advanceTimersByTimeAsync(1000);
        await vi.waitFor(() => {
            expect(
                document.getElementById('git-action-status').textContent,
            ).toBe('Pull completed.');
        });
        expect(infoCalls).toBeGreaterThanOrEqual(3);
        expect(actionCalls).toBe(1);
    });

    it('lets only the page that resumed a queued action send it', async () => {
        const firstInfo = deferred();
        const secondInfo = deferred();
        let infoCalls = 0;
        let actionCalls = 0;
        mockFetch((url) => {
            const path = new URL(url, window.location.href).pathname;
            if (path === '/api/git/info') {
                infoCalls++;
                return infoCalls === 1 ? firstInfo.promise : secondInfo.promise;
            }
            if (path === '/api/git/action') {
                actionCalls++;
                return {
                    ok: true,
                    status: 200,
                    json: {
                        action: 'pull',
                        root: TARGET.root,
                        output: 'Pull completed.',
                    },
                };
            }
            throw new Error(`Unexpected fetch ${url}`);
        });

        const first = new DiffController(buildApp());
        const firstContext = first.captureGitManageContext();
        first.gitManageInfo = INFO;
        first.gitManageInfoKey = firstContext.infoKey;
        first.gitManageMemory.set(firstContext.infoKey, INFO);
        const firstAction = first.startGitAction('pull');
        await vi.waitFor(() => expect(infoCalls).toBe(1));

        const second = new DiffController(buildApp());
        second.captureGitManageContext();
        expect(second.gitManageRecord.phase).toBe('paused');
        const secondAction = second.resumeGitAction();
        await vi.waitFor(() => expect(infoCalls).toBe(2));

        firstInfo.resolve({ ok: true, status: 200, json: INFO });
        await firstAction;
        expect(actionCalls).toBe(0);
        secondInfo.resolve({ ok: true, status: 200, json: INFO });
        await secondAction;
        expect(actionCalls).toBe(1);
        expect(storedRecords()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ phase: 'confirmed' }),
            ]),
        );
    });

    it('evicts a saved Git view once when persisting the sent marker hits quota', async () => {
        let actionCalls = 0;
        mockFetch((url, options) => {
            const path = new URL(url, window.location.href).pathname;
            if (path === '/api/git/info') return INFO;
            if (path === '/api/git/action') {
                actionCalls++;
                const record = storedRecords().find(
                    (item) => item?.phase === 'sent',
                );
                expect(record).toBeDefined();
                expect(localStorage.getItem(viewKey)).toBeNull();
                return {
                    ok: true,
                    status: 200,
                    json: {
                        action: 'pull',
                        root: TARGET.root,
                        output: 'Pull completed.',
                    },
                };
            }
            throw new Error(`Unexpected fetch ${url}`);
        });

        const app = buildApp();
        const controller = new DiffController(app);
        const context = controller.captureGitManageContext();
        controller.gitManageInfo = INFO;
        controller.gitManageInfoKey = context.infoKey;
        controller.gitManageMemory.set(context.infoKey, INFO);
        controller.cacheGitView(
            context,
            TARGET.root,
            'status',
            'recent',
            'saved status view',
        );
        const viewKey = Array.from(
            { length: localStorage.length },
            (_, index) => localStorage.key(index),
        ).find((key) => key?.startsWith('phi_git_view_v1:'));
        expect(viewKey).toBeDefined();

        const originalSetItem = Storage.prototype.setItem;
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(
            function (key, value) {
                let record;
                try {
                    record = JSON.parse(value);
                } catch {
                    // Not an action record.
                }
                if (record?.phase === 'sent' && localStorage.getItem(viewKey)) {
                    throw new DOMException(
                        'quota exceeded',
                        'QuotaExceededError',
                    );
                }
                return originalSetItem.call(this, key, value);
            },
        );

        await controller.startGitAction('pull');
        expect(actionCalls).toBe(1);
    });

    it('does not dispatch when Cancel is clicked during the fresh-target read', async () => {
        const freshInfo = deferred();
        let infoCalls = 0;
        let actionCalls = 0;
        mockFetch((url) => {
            const path = new URL(url, window.location.href).pathname;
            if (path === '/api/git/info') {
                infoCalls++;
                return infoCalls === 2
                    ? freshInfo.promise
                    : { ok: true, status: 200, json: INFO };
            }
            if (path === '/api/git/action') {
                actionCalls++;
                return { ok: true, status: 200, json: {} };
            }
            throw new Error(`Unexpected fetch ${url}`);
        });

        const app = buildApp();
        const controller = new DiffController(app);
        await controller.refreshDiff();
        await vi.waitFor(() => {
            expect(document.getElementById('git-pull-btn').disabled).toBe(
                false,
            );
        });
        document.getElementById('git-pull-btn').click();
        await vi.waitFor(() => expect(infoCalls).toBe(2));
        document.getElementById('git-action-cancel-btn').click();
        freshInfo.resolve({ ok: true, status: 200, json: INFO });
        await Promise.resolve();
        await Promise.resolve();

        expect(actionCalls).toBe(0);
        expect(document.getElementById('git-action-status').textContent).toBe(
            'Unsent Git action cancelled.',
        );
    });

    it('paints immediately, persists sent before POST, and never replays an uncertain action', async () => {
        const freshInfo = deferred();
        let infoCalls = 0;
        let actionCalls = 0;
        let postSawSentMarker = false;
        const fetch = mockFetch((url, options) => {
            const path = new URL(url, window.location.href).pathname;
            if (path === '/api/git/info') {
                infoCalls++;
                return infoCalls === 2
                    ? freshInfo.promise
                    : { ok: true, status: 200, json: INFO };
            }
            if (path === '/api/git/action') {
                actionCalls++;
                postSawSentMarker = storedRecords().some(
                    (record) => record?.phase === 'sent',
                );
                expect(options.headers['X-Phi-Backend']).toBe(
                    'fixture-profile',
                );
                return {
                    ok: false,
                    status: 504,
                    text: 'Gateway timeout',
                };
            }
            throw new Error(`Unexpected fetch ${url}`);
        });

        const app = buildApp();
        const controller = new DiffController(app);
        await controller.refreshDiff();
        await vi.waitFor(() => {
            expect(document.getElementById('git-pull-btn').disabled).toBe(
                false,
            );
        });

        document.getElementById('git-pull-btn').click();
        await vi.waitFor(() => {
            expect(infoCalls).toBe(2);
            expect(
                document.getElementById('git-action-status').textContent,
            ).toBe('Preparing Pull…');
            expect(document.getElementById('git-pull-btn').disabled).toBe(true);
        });

        freshInfo.resolve({ ok: true, status: 200, json: INFO });
        await vi.waitFor(() => {
            expect(actionCalls).toBe(1);
            expect(
                document.getElementById('git-action-status').textContent,
            ).toBe(
                'Result unconfirmed. Inspect Git state before running again.',
            );
        });
        expect(postSawSentMarker).toBe(true);
        expect(
            fetch.mock.calls.filter(([, options]) => options.method === 'POST'),
        ).toHaveLength(1);

        bootstrapDom();
        const reloaded = new DiffController(app);
        await reloaded.refreshDiff();
        await vi.waitFor(() => {
            expect(
                document.getElementById('git-action-status').textContent,
            ).toBe(
                'Result unconfirmed. Inspect Git state before running again.',
            );
        });
        expect(
            document
                .getElementById('git-action-dismiss-btn')
                .classList.contains('hidden'),
        ).toBe(false);
        expect(actionCalls).toBe(1);
        expect(
            fetch.mock.calls.filter(([, options]) => options.method === 'POST'),
        ).toHaveLength(1);
    });

    it('persists a Commit draft and sends an immutable staged snapshot', async () => {
        const firstAction = deferred();
        let actionCalls = 0;
        let firstBody;
        mockFetch((url, options) => {
            const path = new URL(url, window.location.href).pathname;
            if (path === '/api/git/info') return COMMIT_INFO;
            if (path === '/api/git/action') {
                actionCalls++;
                const body = JSON.parse(options.body);
                if (actionCalls === 1) {
                    firstBody = body;
                    return firstAction.promise;
                }
                return {
                    ok: true,
                    status: 200,
                    json: {
                        action: 'commit',
                        root: TARGET.root,
                        output: 'Commit completed.',
                    },
                };
            }
            throw new Error(`Unexpected fetch ${url}`);
        });

        const controller = new DiffController(buildApp());
        await controller.refreshDiff();
        const input = document.getElementById('git-commit-message');
        input.value = 'submitted message';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await vi.waitFor(() =>
            expect(document.getElementById('git-commit-btn').disabled).toBe(
                false,
            ),
        );
        const draftKey = Array.from(
            { length: localStorage.length },
            (_, index) => localStorage.key(index),
        ).find((key) => key?.endsWith(':commit-draft'));
        expect(draftKey).toBeDefined();
        expect(localStorage.getItem(draftKey)).toBe('submitted message');

        const firstCommit = controller.startGitAction('commit');
        await vi.waitFor(() => expect(actionCalls).toBe(1));
        expect(firstBody).toEqual({
            cwd: '/workspace/project',
            action: 'commit',
            target: { ...TARGET, remote: '', remote_ref: '', remote_token: '' },
            message: 'submitted message',
            index_token: COMMIT_INFO.index_token,
        });
        expect(storedRecords()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    action: 'commit',
                    phase: 'sent',
                    message: 'submitted message',
                    indexToken: COMMIT_INFO.index_token,
                }),
            ]),
        );

        input.value = 'newer draft';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        firstAction.resolve({
            ok: true,
            status: 200,
            json: {
                action: 'commit',
                root: TARGET.root,
                output: 'Commit completed.',
            },
        });
        await firstCommit;
        expect(input.value).toBe('newer draft');
        expect(localStorage.getItem(draftKey)).toBe('newer draft');

        input.value = 'clear after confirmation';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await controller.startGitAction('commit');
        expect(input.value).toBe('');
        expect(localStorage.getItem(draftKey)).toBe('');
        expect(actionCalls).toBe(2);
    });

    it('restores an uncertain Commit without replaying it', async () => {
        let actionCalls = 0;
        const fetch = mockFetch((url) => {
            const path = new URL(url, window.location.href).pathname;
            if (path === '/api/git/info') return COMMIT_INFO;
            if (path === '/api/git/action') {
                actionCalls++;
                return { ok: false, status: 504, text: 'Gateway timeout' };
            }
            throw new Error(`Unexpected fetch ${url}`);
        });

        const app = buildApp();
        const controller = new DiffController(app);
        await controller.refreshDiff();
        await vi.waitFor(() =>
            expect(controller.gitManageInfo?.can_commit).toBe(true),
        );
        const input = document.getElementById('git-commit-message');
        input.value = 'keep after uncertainty';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await controller.startGitAction('commit');
        expect(actionCalls).toBe(1);
        expect(document.getElementById('git-action-status').textContent).toBe(
            'Result unconfirmed. Inspect Git state before running again.',
        );

        bootstrapDom();
        const reloaded = new DiffController(app);
        await reloaded.refreshDiff();
        expect(document.getElementById('git-commit-message').value).toBe(
            'keep after uncertainty',
        );
        expect(document.getElementById('git-commit-btn').disabled).toBe(true);
        expect(
            document
                .getElementById('git-action-dismiss-btn')
                .classList.contains('hidden'),
        ).toBe(false);
        expect(actionCalls).toBe(1);
        expect(
            fetch.mock.calls.filter(([, options]) => options.method === 'POST'),
        ).toHaveLength(1);
    });

    it('keeps workspace drafts separate in memory when storage is unavailable', async () => {
        mockFetch((url) => {
            const path = new URL(url, window.location.href).pathname;
            if (path === '/api/git/info') return COMMIT_INFO;
            throw new Error(`Unexpected fetch ${url}`);
        });
        const controller = new DiffController(buildApp());
        await controller.refreshDiff();
        await vi.waitFor(() =>
            expect(controller.gitManageInfo?.can_commit).toBe(true),
        );
        const input = document.getElementById('git-commit-message');
        const originalSetItem = Storage.prototype.setItem;
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(
            function (key, value) {
                if (String(key).endsWith(':commit-draft')) {
                    throw new DOMException(
                        'storage unavailable',
                        'SecurityError',
                    );
                }
                return originalSetItem.call(this, key, value);
            },
        );

        input.value = 'project A draft';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(input.value).toBe('project A draft');
        controller.app.sessionsManager.activeCWD = '/workspace/other';
        controller.captureGitManageContext();
        expect(input.value).toBe('');
        controller.app.sessionsManager.activeCWD = '/workspace/project';
        controller.captureGitManageContext();
        expect(input.value).toBe('project A draft');
    });

    it('preserves the Commit draft after Git rejects the commit', async () => {
        let actionCalls = 0;
        const failure =
            'Git commit failed. Partial effects are possible. Inspect Git before running again.';
        mockFetch((url) => {
            const path = new URL(url, window.location.href).pathname;
            if (path === '/api/git/info') return COMMIT_INFO;
            if (path === '/api/git/action') {
                actionCalls++;
                return { ok: false, status: 500, text: failure };
            }
            throw new Error(`Unexpected fetch ${url}`);
        });

        const controller = new DiffController(buildApp());
        await controller.refreshDiff();
        await vi.waitFor(() =>
            expect(controller.gitManageInfo?.can_commit).toBe(true),
        );
        const input = document.getElementById('git-commit-message');
        input.value = 'keep after Git failure';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await controller.startGitAction('commit');

        const draftKey = Array.from(
            { length: localStorage.length },
            (_, index) => localStorage.key(index),
        ).find((key) => key?.endsWith(':commit-draft'));
        expect(actionCalls).toBe(1);
        expect(input.value).toBe('keep after Git failure');
        expect(localStorage.getItem(draftKey)).toBe('keep after Git failure');
        expect(document.getElementById('git-action-status').textContent).toBe(
            failure,
        );
    });

    it('keeps the draft editable when browser storage rejects it', () => {
        const controller = new DiffController(buildApp());
        const input = document.getElementById('git-commit-message');
        const originalSetItem = Storage.prototype.setItem;
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(
            function (key, value) {
                if (String(key).endsWith(':commit-draft')) {
                    throw new DOMException(
                        'quota exceeded',
                        'QuotaExceededError',
                    );
                }
                return originalSetItem.call(this, key, value);
            },
        );

        input.value = 'keep in the open page';
        input.dispatchEvent(new Event('input', { bubbles: true }));

        expect(input.value).toBe('keep in the open page');
        expect(
            document.getElementById('git-commit-draft-status').textContent,
        ).toBe('Draft not saved on this device. Keep this page open.');
    });
});
