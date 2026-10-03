// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, setupDomHarness } from './_dom.js';
import { SessionsManager } from '../web/sessions.js';

setupDomHarness();

const managers = new Set();
afterEach(() => {
    for (const manager of managers) {
        if (!manager.wsModal.classList.contains('hidden')) {
            manager.closeWorkspaceModal();
        }
    }
    managers.clear();
});

function makeManager() {
    document.body.innerHTML = `
        <div id="session-list"></div>
        <button id="new-session-btn"></button>
        <select id="workspace-select"><option value="/configured">Workspace</option></select>
        <button id="add-workspace-btn">+</button>
        <button id="remove-workspace-btn"></button>
        <div id="ws-modal" class="modal-overlay hidden">
            <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="ws-modal-title">
                <div class="modal-header">
                    <h3 id="ws-modal-title">Add Workspace</h3>
                    <button id="ws-modal-close" type="button">×</button>
                </div>
                <div class="modal-body">
                    <label for="ws-modal-input">Path on this server</label>
                    <div class="path-input-row">
                        <div class="input-autocomplete-wrapper">
                            <input id="ws-modal-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="ws-modal-suggestions" aria-describedby="ws-modal-path-status">
                            <div id="ws-modal-suggestions" class="autocomplete-suggestions hidden" role="listbox"></div>
                        </div>
                        <button id="ws-modal-browse-btn" type="button">Reveal</button>
                    </div>
                    <div id="ws-modal-path-status" role="status" aria-live="polite"></div>
                    <div id="ws-modal-tree"></div>
                </div>
                <div class="modal-footer">
                    <button id="ws-modal-cancel-btn" type="button">Cancel</button>
                    <button id="ws-modal-add-btn" type="button">Add Workspace</button>
                </div>
            </div>
        </div>
    `;
    const manager = new SessionsManager({});
    managers.add(manager);
    return manager;
}

function response(path, parent, entries = [], truncated = false) {
    return { path, parent, entries, truncated };
}

function installFetch(handler) {
    return mockFetch((url, options) => {
        const request = new URL(String(url), 'http://localhost');
        if (request.pathname === '/api/fs/browse') {
            return handler(request.searchParams.get('path'), request, options);
        }
        if (request.pathname === '/api/fs/autocomplete') {
            return handler('autocomplete', request, options);
        }
        throw new Error(`Unexpected fetch: ${request.pathname}`);
    });
}

function pathInput() {
    return document.getElementById('ws-modal-input');
}

function row(path) {
    return [
        ...document.querySelectorAll('#ws-modal-tree [role="treeitem"]'),
    ].find((element) => element.dataset.path === path);
}

function setDraft(input, value) {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function waitForRow(path) {
    await vi.waitFor(() => expect(row(path)).toBeTruthy());
    return row(path);
}

async function waitForSuggestions() {
    await vi.waitFor(() =>
        expect(
            document.querySelector('#ws-modal-suggestions .suggestion-item'),
        ).toBeTruthy(),
    );
}

describe('Add Workspace directory tree', () => {
    it('uses one named dialog with an editable field above the tree and one submit action', () => {
        const html = readFileSync('web/index.html', 'utf8');
        const start = html.indexOf('<!-- WORKSPACE MODAL DIALOG -->');
        const end = html.indexOf('<!-- Markdown Viewer Modal -->', start);
        const template = document.createElement('template');
        template.innerHTML = html.slice(start, end);
        const dialog = template.content.querySelector('[role="dialog"]');

        expect(
            template.content.querySelectorAll('[role="dialog"]'),
        ).toHaveLength(1);
        expect(dialog.getAttribute('aria-labelledby')).toBe('ws-modal-title');
        expect(dialog.querySelector('#ws-modal-input').disabled).toBe(false);
        expect(dialog.querySelector('#ws-modal-tree')).toBeTruthy();
        expect(dialog.querySelector('#ws-modal-path-status')).toBeTruthy();
        expect(
            dialog.querySelector('#ws-modal-browse-btn').textContent.trim(),
        ).toBe('Reveal');
        expect(dialog.querySelector('#ws-modal-browse-btn').type).toBe(
            'button',
        );
        expect(dialog.querySelector('#ws-modal-add-btn').type).toBe('button');
        expect(
            template.content.querySelector('.path-picker-overlay'),
        ).toBeNull();
        expect(dialog.querySelector('.path-picker-overlay')).toBeNull();
    });

    it('starts at activeWorkspace rather than activeCWD and leaves the draft empty', async () => {
        const fetchMock = installFetch((path) =>
            response(path, '/', [{ name: 'child', path: `${path}/child` }]),
        );
        const manager = makeManager();
        manager.activeWorkspace = '/configured/workspace';
        manager.activeCWD = '/selected/git-worktree';
        manager.openWorkspaceModal();

        expect(pathInput().value).toBe('');
        expect(document.activeElement).toBe(pathInput());
        await waitForRow('/configured/workspace');
        expect(fetchMock.mock.calls[0][0]).toBe(
            '/api/fs/browse?path=%2Fconfigured%2Fworkspace',
        );
        expect(
            fetchMock.mock.calls.some(([url]) =>
                String(url).endsWith('path=%2F'),
            ),
        ).toBe(false);
    });

    it('uses server Home when there is no active workspace', async () => {
        const fetchMock = installFetch((path) =>
            path === '~'
                ? response('/server/home', '/', [])
                : response(path, '/', []),
        );
        const manager = makeManager();
        manager.activeWorkspace = '';
        manager.activeCWD = '/unrelated/worktree';
        manager.openWorkspaceModal();

        await waitForRow('/server/home');
        expect(fetchMock.mock.calls[0][0]).toBe('/api/fs/browse?path=~');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not overwrite text typed while the initial root is loading', async () => {
        let resolveRoot;
        installFetch((path) =>
            path === '/configured'
                ? new Promise((resolve) => (resolveRoot = resolve))
                : [],
        );
        const manager = makeManager();
        manager.activeWorkspace = '/configured';
        manager.openWorkspaceModal();
        setDraft(pathInput(), '/typed/while/loading');

        resolveRoot(response('/configured', '/', []));
        await waitForRow('/configured');
        expect(pathInput().value).toBe('/typed/while/loading');
        expect(
            document.getElementById('ws-modal').classList.contains('hidden'),
        ).toBe(false);
    });

    it('keeps branches visible and separates row selection from disclosure', async () => {
        installFetch((path) => {
            const listings = {
                '/ws': response('/ws', '/', [
                    { name: 'alpha', path: '/ws/alpha' },
                    { name: 'beta', path: '/ws/beta' },
                ]),
                '/ws/alpha': response('/ws/alpha', '/ws', [
                    { name: 'nested', path: '/ws/alpha/nested' },
                ]),
                '/ws/beta': response('/ws/beta', '/ws', [
                    { name: 'leaf', path: '/ws/beta/leaf' },
                ]),
            };
            return listings[path];
        });
        const manager = makeManager();
        manager.activeWorkspace = '/ws';
        manager.openWorkspaceModal();
        await waitForRow('/ws/beta');

        row('/ws/alpha').querySelector('.directory-tree-disclosure').click();
        await waitForRow('/ws/alpha/nested');
        row('/ws/beta').querySelector('.directory-tree-disclosure').click();
        await waitForRow('/ws/beta/leaf');
        expect(pathInput().value).toBe('');

        row('/ws/alpha').querySelector('.directory-tree-name').click();
        expect(pathInput().value).toBe('/ws/alpha');
        expect(row('/ws/alpha').getAttribute('aria-selected')).toBe('true');
        row('/ws/alpha').querySelector('.directory-tree-disclosure').click();
        expect(row('/ws/alpha/nested')).toBeUndefined();
        expect(row('/ws/beta/leaf')).toBeTruthy();
        expect(
            document.getElementById('ws-modal').classList.contains('hidden'),
        ).toBe(false);
    });

    it('reveals Enter paths without submitting and keeps focus in the input', async () => {
        const fetchMock = installFetch((path) => {
            const listings = {
                '/ws': response('/ws', '/', [
                    { name: 'branch', path: '/ws/branch' },
                    { name: 'sibling', path: '/ws/sibling' },
                ]),
                '/ws/branch/nested path': response(
                    '/ws/branch/nested path',
                    '/ws/branch',
                    [],
                ),
                '/ws/branch': response('/ws/branch', '/ws', [
                    { name: 'nested path', path: '/ws/branch/nested path' },
                ]),
                autocomplete: [],
            };
            return listings[path];
        });
        const manager = makeManager();
        manager.activeWorkspace = '/ws';
        manager.openWorkspaceModal();
        await waitForRow('/ws/sibling');
        setDraft(pathInput(), '/ws/branch/nested path');
        pathInput().dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
                cancelable: true,
            }),
        );

        await waitForRow('/ws/branch/nested path');
        await vi.waitFor(() =>
            expect(pathInput().value).toBe('/ws/branch/nested path'),
        );
        expect(row('/ws/branch').getAttribute('aria-expanded')).toBe('true');
        expect(row('/ws/sibling')).toBeTruthy();
        expect(document.activeElement).toBe(pathInput());
        expect(
            document.getElementById('ws-modal').classList.contains('hidden'),
        ).toBe(false);
        expect(
            fetchMock.mock.calls.some(
                ([url, options]) =>
                    new URL(String(url), 'http://localhost').pathname ===
                        '/api/config/workspaces' || options?.method === 'POST',
            ),
        ).toBe(false);
    });

    it('accepts an autocomplete suggestion and reveals it on the same Enter', async () => {
        const fetchMock = installFetch((path) => {
            if (path === 'autocomplete') return ['/ws/suggested path'];
            if (path === '/ws') {
                return response('/ws', '/', [
                    { name: 'suggested path', path: '/ws/suggested path' },
                ]);
            }
            return response('/ws/suggested path', '/ws', []);
        });
        const manager = makeManager();
        manager.activeWorkspace = '/ws';
        manager.openWorkspaceModal();
        await waitForRow('/ws/suggested path');
        setDraft(pathInput(), '/ws/sug');
        await waitForSuggestions();
        pathInput().dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'ArrowDown',
                bubbles: true,
                cancelable: true,
            }),
        );
        pathInput().dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
                cancelable: true,
            }),
        );

        await vi.waitFor(() =>
            expect(pathInput().value).toBe('/ws/suggested path'),
        );
        expect(pathInput().getAttribute('aria-expanded')).toBe('false');
        expect(pathInput().hasAttribute('aria-activedescendant')).toBe(false);
        expect(
            fetchMock.mock.calls.some(([url]) =>
                String(url).includes(encodeURIComponent('/ws/suggested path')),
            ),
        ).toBe(true);
        expect(
            document.getElementById('ws-modal').classList.contains('hidden'),
        ).toBe(false);
    });

    it('uses the server-provided parent for Up without changing the draft', async () => {
        const fetchMock = installFetch((path) => {
            if (path === '/ws') {
                return response('/ws', '/home', [
                    { name: 'child', path: '/ws/child' },
                ]);
            }
            if (path === '/home') {
                return response('/home', '/', [{ name: 'ws', path: '/ws' }]);
            }
            if (path === 'autocomplete') return [];
            return response(path, '/', []);
        });
        const manager = makeManager();
        manager.activeWorkspace = '/ws';
        manager.openWorkspaceModal();
        await waitForRow('/ws/child');
        setDraft(pathInput(), '/draft/path');

        document.querySelector('.directory-tree-up').click();
        await waitForRow('/home');
        expect(pathInput().value).toBe('/draft/path');
        expect(
            document.querySelector('.directory-tree-location').textContent,
        ).toBe('Browsing: /home');
        expect(
            fetchMock.mock.calls.some(
                ([url]) =>
                    new URL(String(url), 'http://localhost').searchParams.get(
                        'path',
                    ) === '/home',
            ),
        ).toBe(true);
        expect(
            fetchMock.mock.calls.some(
                ([url, options]) =>
                    new URL(String(url), 'http://localhost').pathname ===
                        '/api/config/workspaces' || options?.method === 'POST',
            ),
        ).toBe(false);
    });

    it('shows an inline path error without replacing the draft or previous tree', async () => {
        installFetch((path) => {
            if (path === '/ws') {
                return response('/ws', '/', [
                    { name: 'kept', path: '/ws/kept' },
                ]);
            }
            if (path === 'autocomplete') return [];
            return { ok: false, status: 404, json: {} };
        });
        const manager = makeManager();
        manager.activeWorkspace = '/ws';
        manager.openWorkspaceModal();
        await waitForRow('/ws/kept');
        setDraft(pathInput(), '/missing');
        pathInput().dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
                cancelable: true,
            }),
        );

        await vi.waitFor(() =>
            expect(
                document.getElementById('ws-modal-path-status').textContent,
            ).toContain('not an accessible directory'),
        );
        expect(pathInput().value).toBe('/missing');
        expect(row('/ws/kept')).toBeTruthy();
    });

    it('invalidates late autocomplete after a newer draft', async () => {
        let resolveOld;
        installFetch((path, request) => {
            if (path !== 'autocomplete') return response('/ws', '/', []);
            const value = request.searchParams.get('path');
            if (value === '/old') {
                return new Promise((resolve) => (resolveOld = resolve));
            }
            if (value === '/new') return ['/new/suggestion'];
            return [];
        });
        const manager = makeManager();
        manager.activeWorkspace = '/ws';
        manager.openWorkspaceModal();
        await waitForRow('/ws');
        setDraft(pathInput(), '/old');
        await vi.waitFor(() => expect(resolveOld).toBeTypeOf('function'));
        setDraft(pathInput(), '/new');
        await waitForSuggestions();
        resolveOld(['/old/stale']);
        await Promise.resolve();

        expect(pathInput().value).toBe('/new');
        expect(document.querySelector('.suggestion-item').textContent).toBe(
            '/new/suggestion',
        );
    });

    it('invalidates autocomplete after a tree selection', async () => {
        let resolveSuggestions;
        installFetch((path) => {
            if (path === '/ws') {
                return response('/ws', '/', [
                    { name: 'chosen', path: '/ws/chosen' },
                ]);
            }
            if (path === 'autocomplete') {
                return new Promise((resolve) => (resolveSuggestions = resolve));
            }
            return response(path, '/', []);
        });
        const manager = makeManager();
        manager.activeWorkspace = '/ws';
        manager.openWorkspaceModal();
        await waitForRow('/ws/chosen');
        setDraft(pathInput(), '/stale');
        await vi.waitFor(() =>
            expect(resolveSuggestions).toBeTypeOf('function'),
        );
        row('/ws/chosen').querySelector('.directory-tree-name').click();
        resolveSuggestions(['/stale/suggestion']);
        await Promise.resolve();

        expect(pathInput().value).toBe('/ws/chosen');
        expect(document.querySelector('.suggestion-item')).toBeNull();
    });

    it('lets a pointer autocomplete choice fill the field without revealing or submitting', async () => {
        const fetchMock = installFetch((path) => {
            if (path === 'autocomplete') return ['/ws/suggestion'];
            return response('/ws', '/', [{ name: 'child', path: '/ws/child' }]);
        });
        const manager = makeManager();
        manager.activeWorkspace = '/ws';
        manager.openWorkspaceModal();
        await waitForRow('/ws/child');
        setDraft(pathInput(), '/ws/sug');
        await waitForSuggestions();
        document.querySelector('.suggestion-item').click();

        expect(pathInput().value).toBe('/ws/suggestion');
        expect(document.activeElement).toBe(pathInput());
        expect(document.querySelector('.suggestion-item')).toBeNull();
        expect(
            fetchMock.mock.calls.filter(
                ([url]) =>
                    new URL(String(url), 'http://localhost').pathname ===
                    '/api/fs/browse',
            ),
        ).toHaveLength(1);
        expect(
            document.getElementById('ws-modal').classList.contains('hidden'),
        ).toBe(false);
    });

    it('submits the current field path after resolving it, not a prior row selection', async () => {
        installFetch((path) => {
            if (path === '/ws') {
                return response('/ws', '/', [
                    { name: 'selected', path: '/ws/selected' },
                ]);
            }
            if (path === 'autocomplete') return [];
            return response('/canonical/current', '/canonical', []);
        });
        const manager = makeManager();
        manager.activeWorkspace = '/ws';
        const add = vi.spyOn(manager, 'addWorkspace').mockResolvedValue();
        manager.openWorkspaceModal();
        await waitForRow('/ws/selected');
        row('/ws/selected').querySelector('.directory-tree-name').click();
        setDraft(pathInput(), '/typed/current');
        document.getElementById('ws-modal-add-btn').click();

        await vi.waitFor(() => expect(add).toHaveBeenCalledOnce());
        expect(add).toHaveBeenCalledWith('/canonical/current');
        expect(
            document.getElementById('ws-modal').classList.contains('hidden'),
        ).toBe(true);
    });

    it('rejects an empty submission inline and prevents duplicate pending submissions', async () => {
        let resolveTarget;
        const fetchMock = installFetch((path) => {
            if (path === '/ws') return response('/ws', '/', []);
            if (path === 'autocomplete') return [];
            return new Promise((resolve) => (resolveTarget = resolve));
        });
        const manager = makeManager();
        manager.activeWorkspace = '/ws';
        const add = vi.spyOn(manager, 'addWorkspace').mockResolvedValue();
        manager.openWorkspaceModal();
        await waitForRow('/ws');
        document.getElementById('ws-modal-add-btn').click();
        expect(
            document.getElementById('ws-modal-path-status').textContent,
        ).toContain('Enter a directory path');
        expect(add).not.toHaveBeenCalled();

        setDraft(pathInput(), '/pending');
        const addButton = document.getElementById('ws-modal-add-btn');
        addButton.click();
        await vi.waitFor(() => expect(resolveTarget).toBeTypeOf('function'));
        addButton.click();
        expect(addButton.disabled).toBe(true);
        expect(
            fetchMock.mock.calls.filter(
                ([url]) =>
                    new URL(String(url), 'http://localhost').pathname ===
                        '/api/fs/browse' &&
                    new URL(String(url), 'http://localhost').searchParams.get(
                        'path',
                    ) === '/pending',
            ),
        ).toHaveLength(1);
        resolveTarget(response('/pending', '/', []));
        await vi.waitFor(() => expect(add).toHaveBeenCalledOnce());
    });

    it('does not submit an old draft after the field changes during resolution', async () => {
        let resolveOldPath;
        installFetch((path) => {
            if (path === '/ws') return response('/ws', '/', []);
            if (path === 'autocomplete') return [];
            return new Promise((resolve) => (resolveOldPath = resolve));
        });
        const manager = makeManager();
        manager.activeWorkspace = '/ws';
        const add = vi.spyOn(manager, 'addWorkspace').mockResolvedValue();
        manager.openWorkspaceModal();
        await waitForRow('/ws');
        setDraft(pathInput(), '/old-draft');
        document.getElementById('ws-modal-add-btn').click();
        await vi.waitFor(() => expect(resolveOldPath).toBeTypeOf('function'));

        setDraft(pathInput(), '/new-draft');
        resolveOldPath(response('/old-draft', '/', []));
        await vi.waitFor(() => expect(manager.wsSubmitPending).toBe(false));

        expect(pathInput().value).toBe('/new-draft');
        expect(add).not.toHaveBeenCalled();
        expect(row('/ws')).toBeTruthy();
        expect(
            document.getElementById('ws-modal').classList.contains('hidden'),
        ).toBe(false);
    });

    it.each(['resolve', 'reject'])(
        'releases a cancelled pre-POST lock immediately without letting its late %s unlock a newer submission',
        async (settlement) => {
            const pending = new Map();
            installFetch((path) => {
                if (path === '/ws') return response('/ws', '/', []);
                if (path === 'autocomplete') return [];
                return new Promise((resolve, reject) =>
                    pending.set(path, { resolve, reject }),
                );
            });
            const manager = makeManager();
            manager.activeWorkspace = '/ws';
            const add = vi.spyOn(manager, 'addWorkspace').mockResolvedValue();
            manager.openWorkspaceModal();
            await waitForRow('/ws');
            setDraft(pathInput(), '/slow');
            const oldSubmission = manager.submitWorkspaceModal();
            await vi.waitFor(() => expect(pending.has('/slow')).toBe(true));

            document.getElementById('ws-modal-cancel-btn').click();
            expect(manager.wsSubmitPending).toBe(false);
            manager.openWorkspaceModal();
            await waitForRow('/ws');
            setDraft(pathInput(), '/good');
            const newSubmission = manager.submitWorkspaceModal();
            await vi.waitFor(() => expect(pending.has('/good')).toBe(true));
            expect(document.getElementById('ws-modal-add-btn').disabled).toBe(
                true,
            );

            if (settlement === 'resolve') {
                pending.get('/slow').resolve(response('/slow', '/', []));
            } else {
                pending.get('/slow').reject(new Error('late browse failure'));
            }
            await oldSubmission;
            expect(manager.wsSubmitPending).toBe(true);
            expect(document.getElementById('ws-modal-add-btn').disabled).toBe(
                true,
            );

            pending.get('/good').resolve(response('/good', '/', []));
            await newSubmission;
            expect(add).toHaveBeenCalledExactlyOnceWith('/good');
            expect(manager.wsSubmitPending).toBe(false);
        },
    );

    it('keeps a started workspace POST locked across Cancel and reopen', async () => {
        installFetch((path) =>
            path === 'autocomplete' ? [] : response(path, '/', []),
        );
        const manager = makeManager();
        manager.activeWorkspace = '/ws';
        let finishPost;
        const add = vi
            .spyOn(manager, 'addWorkspace')
            .mockImplementation(
                () => new Promise((resolve) => (finishPost = resolve)),
            );
        manager.openWorkspaceModal();
        await waitForRow('/ws');
        setDraft(pathInput(), '/target');
        const submission = manager.submitWorkspaceModal();
        await vi.waitFor(() => expect(add).toHaveBeenCalledOnce());
        expect(manager.wsSubmitPostStarted).toBe(true);

        document.getElementById('ws-modal-cancel-btn').click();
        manager.openWorkspaceModal();
        await waitForRow('/ws');
        expect(document.getElementById('ws-modal-add-btn').disabled).toBe(true);
        await manager.submitWorkspaceModal();
        expect(add).toHaveBeenCalledOnce();

        finishPost();
        await submission;
        expect(manager.wsSubmitPending).toBe(false);
        expect(document.getElementById('ws-modal-add-btn').disabled).toBe(
            false,
        );
        expect(
            document.getElementById('ws-modal').classList.contains('hidden'),
        ).toBe(false);
    });

    it('does not submit when cancelled before path resolution finishes', async () => {
        let resolveTarget;
        installFetch((path) => {
            if (path === '/ws') return response('/ws', '/', []);
            if (path === 'autocomplete') return [];
            return new Promise((resolve) => (resolveTarget = resolve));
        });
        const manager = makeManager();
        manager.activeWorkspace = '/ws';
        const add = vi.spyOn(manager, 'addWorkspace').mockResolvedValue();
        manager.openWorkspaceModal();
        await waitForRow('/ws');
        setDraft(pathInput(), '/pending');
        document.getElementById('ws-modal-add-btn').click();
        await vi.waitFor(() => expect(resolveTarget).toBeTypeOf('function'));
        document.getElementById('ws-modal-cancel-btn').click();
        resolveTarget(response('/pending', '/', []));
        await vi.waitFor(() => expect(manager.wsSubmitPending).toBe(false));

        expect(add).not.toHaveBeenCalled();
        expect(
            document.getElementById('ws-modal').classList.contains('hidden'),
        ).toBe(true);
    });

    it('preserves the draft and tree for missing, file, and unreadable targets', async () => {
        installFetch((path) => {
            if (path === '/ws') {
                return response('/ws', '/', [
                    { name: 'kept', path: '/ws/kept' },
                ]);
            }
            if (path === 'autocomplete') return [];
            if (path === '/missing' || path === '/file') {
                return { ok: false, status: 404, json: {} };
            }
            return Promise.reject(new Error('permission denied'));
        });
        const manager = makeManager();
        manager.activeWorkspace = '/ws';
        manager.openWorkspaceModal();
        await waitForRow('/ws/kept');

        for (const path of ['/missing', '/file', '/unreadable']) {
            setDraft(pathInput(), path);
            expect(
                document.getElementById('ws-modal-path-status').textContent,
            ).toBe('');
            pathInput().dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'Enter',
                    bubbles: true,
                    cancelable: true,
                }),
            );
            await vi.waitFor(() =>
                expect(
                    document.getElementById('ws-modal-path-status').textContent,
                ).toContain('not an accessible directory'),
            );
            expect(pathInput().value).toBe(path);
            expect(row('/ws/kept')).toBeTruthy();
        }
    });

    it('discards autocomplete responses after close and reopen', async () => {
        let resolveOld;
        installFetch((path, request) => {
            if (path !== 'autocomplete') return response('/ws', '/', []);
            const value = request.searchParams.get('path');
            if (value === '/old') {
                return new Promise((resolve) => (resolveOld = resolve));
            }
            if (value === '/new') return ['/new/suggestion'];
            return [];
        });
        const manager = makeManager();
        manager.activeWorkspace = '/ws';
        manager.openWorkspaceModal();
        await waitForRow('/ws');
        setDraft(pathInput(), '/old');
        await vi.waitFor(() => expect(resolveOld).toBeTypeOf('function'));
        document.getElementById('ws-modal-cancel-btn').click();

        manager.openWorkspaceModal();
        await waitForRow('/ws');
        setDraft(pathInput(), '/new');
        await waitForSuggestions();
        resolveOld(['/old/stale']);
        await Promise.resolve();

        expect(pathInput().value).toBe('/new');
        expect(document.querySelector('.suggestion-item').textContent).toBe(
            '/new/suggestion',
        );
        expect(
            document.getElementById('ws-modal').classList.contains('hidden'),
        ).toBe(false);
    });

    it('keeps the editor open and reports a failed workspace POST', async () => {
        installFetch((path) =>
            path === '/ws'
                ? response('/ws', '/', [])
                : response('/resolved', '/', []),
        );
        const manager = makeManager();
        manager.activeWorkspace = '/ws';
        vi.spyOn(manager, 'addWorkspace').mockRejectedValue(
            new Error('workspace POST failed'),
        );
        manager.openWorkspaceModal();
        await waitForRow('/ws');
        setDraft(pathInput(), '/requested');
        document.getElementById('ws-modal-add-btn').click();

        await vi.waitFor(() =>
            expect(
                document.getElementById('ws-modal-path-status').textContent,
            ).toBe('workspace POST failed'),
        );
        expect(pathInput().value).toBe('/resolved');
        expect(
            document.getElementById('ws-modal').classList.contains('hidden'),
        ).toBe(false);
        expect(document.getElementById('ws-modal-add-btn').disabled).toBe(
            false,
        );
    });

    it('does not POST when a cancelled path resolution rejects later', async () => {
        let rejectTarget;
        installFetch((path) => {
            if (path === '/ws') return response('/ws', '/', []);
            if (path === 'autocomplete') return [];
            return new Promise((_resolve, reject) => (rejectTarget = reject));
        });
        const manager = makeManager();
        manager.activeWorkspace = '/ws';
        const add = vi.spyOn(manager, 'addWorkspace').mockResolvedValue();
        manager.openWorkspaceModal();
        await waitForRow('/ws');
        setDraft(pathInput(), '/pending');
        document.getElementById('ws-modal-add-btn').click();
        await vi.waitFor(() => expect(rejectTarget).toBeTypeOf('function'));
        document.getElementById('ws-modal-cancel-btn').click();
        rejectTarget(new Error('late browse failure'));
        await vi.waitFor(() => expect(manager.wsSubmitPending).toBe(false));

        expect(add).not.toHaveBeenCalled();
        expect(
            document.getElementById('ws-modal').classList.contains('hidden'),
        ).toBe(true);
    });

    it('does not let an Up-invalidated Reveal completion steal tree focus', async () => {
        let resolveReveal;
        installFetch((path) => {
            if (path === '/ws') {
                return response('/ws', '/', [
                    { name: 'child', path: '/ws/child' },
                ]);
            }
            if (path === '/') {
                return response('/', '', [{ name: 'ws', path: '/ws' }]);
            }
            if (path === 'autocomplete') return [];
            return new Promise((resolve) => (resolveReveal = resolve));
        });
        const manager = makeManager();
        manager.activeWorkspace = '/ws';
        manager.openWorkspaceModal();
        await waitForRow('/ws/child');
        setDraft(pathInput(), '/slow');
        const reveal = manager.revealWorkspacePath();
        await vi.waitFor(() => expect(resolveReveal).toBeTypeOf('function'));

        document.querySelector('.directory-tree-up').click();
        await vi.waitFor(() =>
            expect(
                document.querySelector('.directory-tree-location').textContent,
            ).toBe('Browsing: /'),
        );
        row('/ws').focus();
        resolveReveal(response('/slow', '/', []));
        await reveal;

        expect(document.activeElement).toBe(row('/ws'));
        expect(pathInput().value).toBe('/slow');
    });

    it('does not let a collapsed-branch Reveal completion steal tree focus', async () => {
        let resolveReveal;
        installFetch((path) => {
            if (path === '/ws') {
                return response('/ws', '/', [
                    { name: 'branch', path: '/ws/branch' },
                ]);
            }
            if (path === '/ws/branch') {
                return response('/ws/branch', '/ws', [
                    { name: 'child', path: '/ws/branch/child' },
                ]);
            }
            if (path === 'autocomplete') return [];
            return new Promise((resolve) => (resolveReveal = resolve));
        });
        const manager = makeManager();
        manager.activeWorkspace = '/ws';
        manager.openWorkspaceModal();
        await waitForRow('/ws/branch');
        row('/ws/branch').querySelector('.directory-tree-disclosure').click();
        await waitForRow('/ws/branch/child');
        setDraft(pathInput(), '/ws/branch/target');
        const reveal = manager.revealWorkspacePath();
        await vi.waitFor(() => expect(resolveReveal).toBeTypeOf('function'));

        row('/ws/branch').querySelector('.directory-tree-disclosure').click();
        row('/ws').focus();
        resolveReveal(response('/ws/branch/target', '/ws/branch', []));
        await reveal;

        expect(document.activeElement).toBe(row('/ws'));
        expect(pathInput().value).toBe('/ws/branch/target');
    });

    it('reports addWorkspace success or failure while preserving the POST shape', async () => {
        const fetchMock = mockFetch((_url, options) => {
            expect(options.method).toBe('POST');
            return { ok: true, json: {} };
        });
        const manager = makeManager();
        manager.loadConfig = vi.fn().mockResolvedValue();
        manager.updateWorkspaceSelectWidth = vi.fn();
        manager.loadWorktrees = vi.fn();
        await manager.addWorkspace('/resolved/path');

        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
            path: '/resolved/path',
        });
        expect(manager.activeWorkspace).toBe('/resolved/path');
        expect(manager.loadConfig).toHaveBeenCalledOnce();
        expect(manager.loadWorktrees).toHaveBeenCalledOnce();
    });

    it('keeps tree focus separate from selection and selects with Enter or Space', async () => {
        const fetchMock = installFetch((path) => {
            if (path === 'autocomplete') return [];
            return response('/ws', '/', [
                { name: 'alpha', path: '/ws/alpha' },
                { name: 'beta', path: '/ws/beta' },
            ]);
        });
        const manager = makeManager();
        manager.activeWorkspace = '/ws';
        manager.openWorkspaceModal();
        await waitForRow('/ws/beta');
        const press = (target, key, init = {}) =>
            target.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key,
                    bubbles: true,
                    cancelable: true,
                    ...init,
                }),
            );

        row('/ws').focus();
        press(row('/ws'), 'ArrowDown');
        expect(document.activeElement).toBe(row('/ws/alpha'));
        expect(pathInput().value).toBe('');
        press(row('/ws/alpha'), 'Enter');
        expect(pathInput().value).toBe('/ws/alpha');
        expect(row('/ws/alpha').getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(row('/ws/alpha'));
        press(row('/ws/alpha'), 'ArrowDown');
        press(row('/ws/beta'), ' ');
        expect(pathInput().value).toBe('/ws/beta');
        expect(row('/ws/alpha').getAttribute('aria-selected')).toBe('false');
        expect(row('/ws/beta').getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(row('/ws/beta'));
        pathInput().focus();
        expect(row('/ws/beta').getAttribute('aria-selected')).toBe('true');
        expect(
            row('/ws/beta').querySelector('.directory-tree-row').classList,
        ).toContain('is-selected');
        expect(document.activeElement).toBe(pathInput());
        expect(
            fetchMock.mock.calls.some(
                ([url, options]) =>
                    new URL(String(url), 'http://localhost').pathname ===
                        '/api/config/workspaces' || options?.method === 'POST',
            ),
        ).toBe(false);
    });

    it('contains focus, wraps Tab at dialog edges, and cleans up on Escape', async () => {
        const manager = makeManager();
        manager.activeWorkspace = '/ws';
        installFetch(() => response('/ws', '/', []));
        const opener = manager.addWorkspaceBtn;
        opener.focus();
        const closeSpy = vi.spyOn(manager, 'closeWorkspaceModal');
        opener.click();
        await waitForRow('/ws');
        const modal = document.getElementById('ws-modal');
        const press = (target, key, shiftKey = false) => {
            const event = new KeyboardEvent('keydown', {
                key,
                bubbles: true,
                cancelable: true,
                shiftKey,
            });
            target.dispatchEvent(event);
            return event;
        };

        const treeRoot = row('/ws');
        treeRoot.focus();
        expect(press(treeRoot, 'Tab').defaultPrevented).toBe(false);
        expect(press(treeRoot, 'Tab', true).defaultPrevented).toBe(false);

        const close = document.getElementById('ws-modal-close');
        close.focus();
        const backwards = press(close, 'Tab', true);
        expect(backwards.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(
            document.getElementById('ws-modal-add-btn'),
        );
        const forwards = press(document.activeElement, 'Tab');
        expect(forwards.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(close);

        const outside = document.createElement('button');
        document.body.appendChild(outside);
        outside.focus();
        expect(document.activeElement).toBe(pathInput());
        treeRoot.focus();
        const escapeFromTree = press(treeRoot, 'Escape');
        expect(escapeFromTree.defaultPrevented).toBe(true);
        expect(modal.classList.contains('hidden')).toBe(true);
        expect(document.getElementById('ws-modal-tree').childElementCount).toBe(
            0,
        );
        expect(document.activeElement).toBe(opener);
        expect(manager.wsModalKeydownHandler).toBeNull();
        expect(manager.wsModalFocusinHandler).toBeNull();

        opener.click();
        await waitForRow('/ws');
        const escapeFromInput = press(pathInput(), 'Escape');
        expect(escapeFromInput.defaultPrevented).toBe(true);
        expect(closeSpy).toHaveBeenCalledTimes(2);
        expect(document.activeElement).toBe(opener);
    });

    it('does not intercept IME Enter or native clipboard shortcuts in the field', async () => {
        const fetchMock = installFetch((path) => {
            if (path === 'autocomplete') return [];
            if (path === '/ws') return response('/ws', '/', []);
            return response('/revealed target', '/', []);
        });
        const manager = makeManager();
        manager.activeWorkspace = '/ws';
        manager.openWorkspaceModal();
        await waitForRow('/ws');
        setDraft(pathInput(), '/target');

        const compositionStart = new Event('compositionstart', {
            bubbles: true,
        });
        pathInput().dispatchEvent(compositionStart);
        const imeEnter = new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
            isComposing: true,
        });
        pathInput().dispatchEvent(imeEnter);
        expect(imeEnter.defaultPrevented).toBe(false);
        expect(
            fetchMock.mock.calls.filter(
                ([url]) =>
                    new URL(String(url), 'http://localhost').pathname ===
                    '/api/fs/browse',
            ),
        ).toHaveLength(1);

        for (const [key, modifiers] of [
            ['a', { ctrlKey: true }],
            ['c', { ctrlKey: true }],
            ['v', { ctrlKey: true }],
            ['x', { metaKey: true }],
        ]) {
            const shortcut = new KeyboardEvent('keydown', {
                key,
                bubbles: true,
                cancelable: true,
                ...modifiers,
            });
            pathInput().dispatchEvent(shortcut);
            expect(shortcut.defaultPrevented).toBe(false);
        }
        const paste = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(paste, 'clipboardData', {
            value: { getData: vi.fn(() => '/pasted/path') },
        });
        pathInput().dispatchEvent(paste);
        expect(paste.defaultPrevented).toBe(false);

        pathInput().dispatchEvent(
            new Event('compositionend', { bubbles: true }),
        );
        pathInput().dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
                cancelable: true,
            }),
        );
        await vi.waitFor(() =>
            expect(pathInput().value).toBe('/revealed target'),
        );
        expect(
            document.getElementById('ws-modal').classList.contains('hidden'),
        ).toBe(false);
    });

    it('uses a bounded tree region at desktop, short, and narrow sizes', () => {
        makeManager();
        const css = readFileSync('web/style.css', 'utf8');
        expect(pathInput().getAttribute('role')).toBe('combobox');
        expect(pathInput().getAttribute('aria-describedby')).toBe(
            'ws-modal-path-status',
        );
        expect(css).toContain('#ws-modal .modal-body');
        expect(css).toContain('overflow: visible !important');
        expect(css).toContain('max-height: min(42vh, 360px)');
        expect(css).toContain('@media (max-height: 600px)');
        expect(css).toContain('max-height: 24vh');
        expect(css).toContain('@media (max-width: 480px)');
        expect(css).toContain(
            '.directory-tree-item[aria-selected="true"] > .directory-tree-row',
        );
        expect(css).toContain(
            '.directory-tree-item:focus-visible > .directory-tree-row',
        );
    });

    it('restores focus to the opener and sends no POST on cancellation', async () => {
        const fetchMock = installFetch((path) => response(path, '/', []));
        const manager = makeManager();
        manager.activeWorkspace = '/ws';
        manager.addWorkspaceBtn.focus();
        manager.openWorkspaceModal();
        await waitForRow('/ws');
        document.getElementById('ws-modal-cancel-btn').click();

        expect(document.activeElement).toBe(manager.addWorkspaceBtn);
        expect(
            fetchMock.mock.calls.some(
                ([url, options]) =>
                    new URL(String(url), 'http://localhost').pathname ===
                        '/api/config/workspaces' || options?.method === 'POST',
            ),
        ).toBe(false);
    });
});
