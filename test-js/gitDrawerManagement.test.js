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
        expect(
            document
                .getElementById('git-management-recovery')
                .classList.contains('hidden'),
        ).toBe(true);
    });

    it.each([
        ['paused', 'Git action not sent: the sent marker could not be saved.'],
        [
            'unconfirmed',
            'Result unconfirmed. Inspect Git state before running again.',
        ],
        ['confirmed', 'Commit completed.'],
        [
            'failed',
            'Git commit failed. Partial effects are possible. Inspect Git before running again.',
        ],
    ])(
        'keeps the %s action status when metadata refresh fails',
        async (phase, status) => {
            const prepared = new DiffController(buildApp());
            const context = prepared.captureGitManageContext();
            localStorage.setItem(context.infoKey, JSON.stringify(COMMIT_INFO));
            localStorage.setItem(
                `${context.actionPrefix}restored`,
                JSON.stringify({
                    version: 1,
                    id: 'restored',
                    owner: 'previous-page',
                    action: 'commit',
                    target: TARGET,
                    phase,
                    createdAt: Date.now(),
                    status,
                    message: 'queued message',
                    indexToken: COMMIT_INFO.index_token,
                }),
            );
            const failedInfo = deferred();
            const fetch = mockFetch(() => failedInfo.promise);
            bootstrapDom();
            const controller = new DiffController(buildApp());
            const refresh = controller.refreshDiff();
            expect(
                document.getElementById('git-action-status').textContent,
            ).toBe(status);
            failedInfo.reject(new TypeError('offline'));
            await refresh;
            await vi.waitFor(() =>
                expect(controller.gitManageRequestKey).toBe(''),
            );
            expect(
                document.getElementById('git-action-status').textContent,
            ).toBe(status);
            expect(
                fetch.mock.calls.every(
                    ([, options]) => options.method === 'GET',
                ),
            ).toBe(true);
        },
    );

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

        first.cancelGitAction();
        expect(first.gitManageRecord).not.toBeNull();
        expect(first.gitManageStatus).toContain('ownership changed');
        expect(storedRecords()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    phase: 'queued',
                    owner: second.gitManagePageId,
                }),
            ]),
        );

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

    it.each([false, true])(
        'cancels an unsent action during its target read (reload: %s)',
        async (reload) => {
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
            const action = controller.startGitAction('pull');
            await vi.waitFor(() => expect(infoCalls).toBe(2));
            if (reload) {
                bootstrapDom();
                const reloaded = new DiffController(app);
                reloaded.captureGitManageContext();
                expect(reloaded.gitManageRecord.phase).toBe('paused');
            }
            document.getElementById('git-action-cancel-btn').click();
            expect(storedRecords().filter((record) => record?.action)).toEqual(
                [],
            );
            freshInfo.resolve({ ok: true, status: 200, json: INFO });
            await action;

            expect(actionCalls).toBe(0);
            expect(
                document.getElementById('git-action-status').textContent,
            ).toBe('Unsent Git action cancelled.');
        },
    );

    it('cannot cancel a restored action that another page has already sent', () => {
        const controller = new DiffController(buildApp());
        const context = controller.captureGitManageContext();
        const storageKey = `${context.actionPrefix}pending`;
        const record = {
            version: 1,
            id: 'pending',
            owner: 'previous-page',
            action: 'pull',
            target: TARGET,
            phase: 'queued',
            createdAt: Date.now(),
            status: 'Preparing Pull…',
        };
        localStorage.setItem(storageKey, JSON.stringify(record));
        bootstrapDom();
        const reloaded = new DiffController(buildApp());
        reloaded.captureGitManageContext();
        expect(reloaded.gitManageRecord.phase).toBe('paused');
        record.phase = 'sent';
        localStorage.setItem(storageKey, JSON.stringify(record));

        reloaded.cancelGitAction();

        expect(JSON.parse(localStorage.getItem(storageKey))).toEqual(record);
        expect(reloaded.gitManageRecord).not.toBeNull();
        expect(reloaded.gitManageStatus).toContain('ownership changed');
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

    it.each([
        {
            name: 'no staged changes',
            info: {
                ...COMMIT_INFO,
                has_staged: false,
                can_commit: false,
                commit_reason: 'Stage changes in Git before committing.',
            },
            message: 'ready to commit',
            expected: 'Stage changes in Git before committing.',
            commitEnabled: false,
        },
        {
            name: 'a whitespace message',
            info: COMMIT_INFO,
            message: '   ',
            expected: 'Enter a commit message.',
            commitEnabled: false,
        },
        {
            name: 'missing index information',
            info: { ...COMMIT_INFO, index_token: '' },
            message: 'ready to commit',
            expected:
                'Commit information is unavailable. Refresh to try again.',
            commitEnabled: false,
        },
        {
            name: 'a pending uncertain action',
            info: COMMIT_INFO,
            message: 'ready to commit',
            record: {
                id: 'pending',
                phase: 'unconfirmed',
                status: 'Result unconfirmed. Inspect Git state before running again.',
            },
            expected: 'Resolve the pending Git action before committing.',
            commitEnabled: false,
        },
        {
            name: 'a ready Commit without an upstream',
            info: {
                ...COMMIT_INFO,
                can_pull_push: false,
                reason: 'No upstream branch configured',
            },
            message: 'ready to commit',
            expected: '',
            commitEnabled: true,
        },
    ])(
        'shows the Commit prerequisite for $name without sending an action',
        async ({ info, message, record, expected, commitEnabled }) => {
            if (record) {
                const prepared = new DiffController(buildApp());
                const context = prepared.captureGitManageContext();
                localStorage.setItem(
                    `${context.actionPrefix}${record.id}`,
                    JSON.stringify({
                        version: 1,
                        owner: 'previous-page',
                        action: 'pull',
                        target: TARGET,
                        createdAt: Date.now(),
                        ...record,
                    }),
                );
            }
            bootstrapDom();
            const fetch = mockFetch((url) => {
                const path = new URL(url, window.location.href).pathname;
                if (path === '/api/git/info') return info;
                throw new Error(`Unexpected fetch ${url}`);
            });
            const controller = new DiffController(buildApp());
            await controller.refreshDiff();
            await vi.waitFor(() =>
                expect(controller.gitManageInfo).toBeTruthy(),
            );
            const input = document.getElementById('git-commit-message');
            input.value = message;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            if (record) {
                await vi.waitFor(() =>
                    expect(controller.gitManageRecord?.phase).toBe(
                        record.phase,
                    ),
                );
            }

            const hint = document.getElementById('git-commit-hint');
            expect(hint.textContent).toBe(expected);
            expect(hint.classList.contains('hidden')).toBe(!expected);
            expect(document.getElementById('git-commit-btn').disabled).toBe(
                !commitEnabled,
            );
            expect(
                fetch.mock.calls.filter(
                    ([, options]) => options.method === 'POST',
                ),
            ).toHaveLength(0);
        },
    );

    it.each([
        ['pull', 'Resume Pull'],
        ['push', 'Resume Push'],
        ['commit', 'Resume Commit'],
    ])(
        'names a restored paused %s without replaying it',
        async (action, resumeLabel) => {
            const prepared = new DiffController(buildApp());
            const context = prepared.captureGitManageContext();
            localStorage.setItem(
                `${context.actionPrefix}restored`,
                JSON.stringify({
                    version: 1,
                    id: 'restored',
                    owner: 'previous-page',
                    action,
                    target: TARGET,
                    phase: 'paused',
                    createdAt: Date.now(),
                    status: 'Queued Git action paused. Resume to verify before sending.',
                    message: 'queued message',
                    indexToken: COMMIT_INFO.index_token,
                }),
            );
            const fetch = mockFetch(() => {
                throw new Error('No request is allowed');
            });
            bootstrapDom();
            const controller = new DiffController(buildApp());
            controller.captureGitManageContext();

            expect(controller.gitManageRecord?.phase).toBe('paused');
            expect(
                document
                    .getElementById('git-management-recovery')
                    .classList.contains('hidden'),
            ).toBe(false);
            expect(
                document.getElementById('git-action-resume-btn').textContent,
            ).toBe(resumeLabel);
            expect(
                document.getElementById('git-action-status').textContent,
            ).toBe(
                `Queued ${action === 'pull' ? 'Pull' : action === 'push' ? 'Push' : 'Commit'} paused. ${resumeLabel} to verify before sending.`,
            );
            expect(fetch).not.toHaveBeenCalled();
        },
    );

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
                return { ok: false, status: 500, text: `${failure}\n` };
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

    it('does not hide an unconfirmed action behind a corrupt older record', () => {
        const controller = new DiffController(buildApp());
        const context = controller.captureGitManageContext();
        localStorage.setItem(`${context.actionPrefix}corrupt`, '{');
        localStorage.setItem(
            `${context.actionPrefix}pending`,
            JSON.stringify({
                version: 1,
                id: 'pending',
                owner: 'previous-page',
                action: 'pull',
                target: TARGET,
                phase: 'sent',
                createdAt: Date.now(),
                status: 'Sent',
            }),
        );

        bootstrapDom();
        const reloaded = new DiffController(buildApp());
        reloaded.captureGitManageContext();

        expect(reloaded.gitManageRecord?.phase).toBe('unconfirmed');
        expect(document.getElementById('git-pull-btn').disabled).toBe(true);
    });

    it('can cancel a local action whose initial persistence failed', async () => {
        mockFetch(() => {
            throw new Error('No request is allowed');
        });
        const controller = new DiffController(buildApp());
        controller.captureGitManageContext();
        controller.gitManageInfo = INFO;
        const storage = vi
            .spyOn(Storage.prototype, 'setItem')
            .mockImplementation(() => {
                throw new DOMException('storage full', 'QuotaExceededError');
            });
        await controller.startGitAction('pull');
        expect(controller.gitManageRecord?.phase).toBe('paused');
        storage.mockRestore();

        controller.cancelGitAction();

        expect(controller.gitManageRecord).toBeNull();
        expect(document.getElementById('git-pull-btn').disabled).toBe(false);
        expect(document.getElementById('git-action-status').textContent).toBe(
            'Unsent Git action cancelled.',
        );
    });

    it('bounds a sent request and ignores its late success without replay', async () => {
        vi.useFakeTimers();
        const action = deferred();
        let posts = 0;
        mockFetch((url) => {
            if (new URL(url, window.location.href).pathname === '/api/git/info')
                return COMMIT_INFO;
            posts++;
            return action.promise;
        });
        const controller = new DiffController(buildApp());
        controller.captureGitManageContext();
        controller.gitManageInfo = COMMIT_INFO;
        const input = document.getElementById('git-commit-message');
        input.value = 'keep after timeout';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const pending = controller.startGitAction('commit');
        await vi.waitFor(() => expect(posts).toBe(1));
        await vi.advanceTimersByTimeAsync(150_000);
        await pending;
        action.resolve({
            ok: true,
            status: 200,
            json: {
                action: 'commit',
                root: TARGET.root,
                output: 'Commit completed.',
            },
        });
        window.dispatchEvent(new Event('online'));
        await vi.advanceTimersByTimeAsync(60_000);

        expect(posts).toBe(1);
        expect(controller.gitManageRecord.phase).toBe('unconfirmed');
        expect(input.value).toBe('keep after timeout');
    });

    it('refreshes the visible Git view after a confirmed mutation', async () => {
        let committed = false;
        mockFetch((url) => {
            const path = new URL(url, window.location.href).pathname;
            if (path === '/api/git/info') return COMMIT_INFO;
            if (path === '/api/git/action') {
                committed = true;
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
            if (path === '/api/git/raw-log')
                return {
                    ok: true,
                    status: 200,
                    text: committed ? 'new commit subject' : 'old log',
                };
            throw new Error(`Unexpected fetch ${url}`);
        });
        const controller = new DiffController(buildApp());
        controller.activeTab = 'log';
        const writes = enableFakeTerminal(controller);
        await controller.refreshDiff();
        await vi.waitFor(() =>
            expect(controller.gitManageInfo?.can_commit).toBe(true),
        );
        document.getElementById('git-commit-message').value =
            'new commit subject';

        await controller.startGitAction('commit');

        await vi.waitFor(() =>
            expect(writes.join('')).toContain('new commit subject'),
        );
    });

    it('keeps a new workspace queue alive when the old sent request aborts', async () => {
        vi.useFakeTimers();
        let posts = 0;
        let infoCalls = 0;
        const oldAction = deferred();
        const otherInfo = {
            ...INFO,
            target: { ...TARGET, root: '/workspace/other' },
        };
        mockFetch((url) => {
            const parsed = new URL(url, window.location.href);
            if (parsed.pathname === '/api/git/info') {
                if (parsed.searchParams.get('cwd') !== '/workspace/other')
                    return INFO;
                infoCalls++;
                if (infoCalls === 1) throw new TypeError('offline');
                return otherInfo;
            }
            posts++;
            if (posts === 1) return oldAction.promise;
            return {
                ok: true,
                status: 200,
                json: {
                    action: 'pull',
                    root: otherInfo.target.root,
                    output: 'Pull completed.',
                },
            };
        });
        const app = buildApp();
        const controller = new DiffController(app);
        controller.captureGitManageContext();
        controller.gitManageInfo = INFO;
        const first = controller.startGitAction('pull');
        await vi.waitFor(() => expect(posts).toBe(1));
        app.sessionsManager.activeCWD = '/workspace/other';
        controller.captureGitManageContext();
        controller.gitManageInfo = otherInfo;
        await controller.startGitAction('pull');
        await first;
        await vi.advanceTimersByTimeAsync(1000);

        expect(posts).toBe(2);
        expect(controller.gitManageRecord.phase).toBe('confirmed');
        expect(storedRecords()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    phase: 'unconfirmed',
                    target: TARGET,
                }),
            ]),
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
