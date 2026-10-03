// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { mockFetch, setupDomHarness } from './_dom.js';
import { mountDirectoryTree } from '../web/path-picker.js';

setupDomHarness();

function response(path, parent, entries = [], truncated = false) {
    return { path, parent, entries, truncated };
}

function mountTree(startPath, onSelect = vi.fn()) {
    document.body.innerHTML = '<div id="tree-host"></div>';
    const host = document.getElementById('tree-host');
    const controller = mountDirectoryTree(host, { startPath, onSelect });
    return { controller, host, onSelect };
}

function item(path) {
    return [...document.querySelectorAll('[role="treeitem"]')].find(
        (element) => element.dataset.path === path,
    );
}

async function waitForItem(path) {
    await vi.waitFor(() => expect(item(path)).toBeTruthy());
    return item(path);
}

function expand(path) {
    const row = item(path);
    if (!row) throw new Error(`Missing tree row for ${path}`);
    row.querySelector('.directory-tree-disclosure').click();
}

function requestedPath(url) {
    return new URL(String(url), 'http://localhost').searchParams.get('path');
}

describe('embedded directory tree', () => {
    it('loads and expands the initial root without selecting it', async () => {
        const fetchMock = mockFetch(() =>
            response('/workspace', '/home', [
                { name: 'project', path: '/workspace/project' },
            ]),
        );
        const { controller, host, onSelect } = mountTree('/workspace');
        const root = await waitForItem('/workspace');

        expect(fetchMock).toHaveBeenCalledWith(
            '/api/fs/browse?path=%2Fworkspace',
        );
        expect(root.getAttribute('aria-expanded')).toBe('true');
        expect(root.getAttribute('aria-selected')).toBe('false');
        expect(host.querySelector('.directory-tree-location').textContent).toBe(
            'Browsing: /workspace',
        );
        expect(onSelect).not.toHaveBeenCalled();
        controller.destroy();
    });

    it('keeps nested branches and siblings visible while expanding in place', async () => {
        const fetchMock = mockFetch((url) => {
            const path = requestedPath(url);
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
                '/ws/alpha/nested': response(
                    '/ws/alpha/nested',
                    '/ws/alpha',
                    [],
                ),
            };
            return listings[path];
        });
        const { controller } = mountTree('/ws');
        await waitForItem('/ws/beta');

        expand('/ws/alpha');
        await waitForItem('/ws/alpha/nested');
        expand('/ws/beta');
        await waitForItem('/ws/beta/leaf');
        expand('/ws/alpha/nested');
        await waitForItem('/ws/alpha/nested');

        expect(item('/ws/alpha').getAttribute('aria-level')).toBe('2');
        expect(item('/ws/alpha').getAttribute('aria-posinset')).toBe('1');
        expect(item('/ws/alpha').getAttribute('aria-setsize')).toBe('2');
        expect(item('/ws/beta').getAttribute('aria-posinset')).toBe('2');
        expect(item('/ws/beta').getAttribute('aria-setsize')).toBe('2');
        expect(item('/ws/alpha/nested').getAttribute('aria-level')).toBe('3');
        expect(item('/ws/beta').isConnected).toBe(true);
        expect(item('/ws/beta/leaf').isConnected).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(4);

        expand('/ws/alpha');
        expect(item('/ws/alpha/nested')).toBeUndefined();
        expect(item('/ws/beta')).toBeTruthy();
        expect(item('/ws/beta/leaf')).toBeTruthy();
        controller.destroy();
    });

    it('deduplicates Reveal against a pending load of the same root branch', async () => {
        let resolveRoot;
        const fetchMock = mockFetch(
            () => new Promise((resolve) => (resolveRoot = resolve)),
        );
        const { controller } = mountTree('/ws');
        const reveal = controller.reveal('/ws');
        await vi.waitFor(() => expect(resolveRoot).toBeTypeOf('function'));
        expect(fetchMock).toHaveBeenCalledTimes(1);

        resolveRoot(
            response('/ws', '/', [{ name: 'child', path: '/ws/child' }]),
        );
        await expect(reveal).resolves.toBe('/ws');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(item('/ws').getAttribute('aria-selected')).toBe('true');
        controller.destroy();
    });

    it('distinguishes disclosure from folder selection and keeps the root selectable', async () => {
        const onSelect = vi.fn();
        mockFetch(() =>
            response('/ws', '/', [{ name: 'folder', path: '/ws/folder' }]),
        );
        const { controller } = mountTree('/ws', onSelect);
        await waitForItem('/ws/folder');

        item('/ws/folder').querySelector('.directory-tree-disclosure').click();
        expect(onSelect).not.toHaveBeenCalled();
        expect(item('/ws/folder').getAttribute('aria-selected')).toBe('false');

        item('/ws').querySelector('.directory-tree-name').click();
        expect(onSelect).toHaveBeenCalledExactlyOnceWith('/ws');
        expect(item('/ws').getAttribute('aria-selected')).toBe('true');
        expect(item('/ws/folder').getAttribute('aria-selected')).toBe('false');
        controller.destroy();
    });

    it('double-click expands once and never submits or closes a dialog', async () => {
        const fetchMock = mockFetch((url) =>
            requestedPath(url) === '/ws'
                ? response('/ws', '/', [{ name: 'folder', path: '/ws/folder' }])
                : response('/ws/folder', '/ws', []),
        );
        const { controller, onSelect } = mountTree('/ws');
        await waitForItem('/ws/folder');
        const label = item('/ws/folder').querySelector('.directory-tree-name');
        label.dispatchEvent(
            new MouseEvent('click', { bubbles: true, detail: 1 }),
        );
        label.dispatchEvent(
            new MouseEvent('click', { bubbles: true, detail: 2 }),
        );
        label.dispatchEvent(
            new MouseEvent('dblclick', {
                bubbles: true,
                cancelable: true,
                detail: 2,
            }),
        );

        await vi.waitFor(() => {
            expect(item('/ws/folder').hasAttribute('aria-expanded')).toBe(
                false,
            );
            expect(item('/ws/folder').textContent).toContain(
                'No visible subdirectories.',
            );
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(onSelect).toHaveBeenCalledOnce();
        expect(document.querySelector('.path-picker-overlay')).toBeNull();
        controller.destroy();
    });

    it('reveals a typed path with spaces and selects it without firing onSelect', async () => {
        const target = '/outside/a folder with spaces';
        const fetchMock = mockFetch((url) => {
            const path = requestedPath(url);
            return path === target
                ? response(target, '/outside', [])
                : response('/initial', '/', []);
        });
        const { controller, host, onSelect } = mountTree('/initial');
        await waitForItem('/initial');

        await expect(controller.reveal(target)).resolves.toBe(target);
        expect(fetchMock.mock.calls[1][0]).toBe(
            `/api/fs/browse?path=${encodeURIComponent(target)}`,
        );
        expect(item(target).getAttribute('aria-selected')).toBe('true');
        expect(host.querySelector('.directory-tree-location').textContent).toBe(
            `Browsing: ${target}`,
        );
        expect(onSelect).not.toHaveBeenCalled();
        controller.destroy();
    });

    it('reveals a descendant by opening only its ancestor chain', async () => {
        const fetchMock = mockFetch((url) => {
            const path = requestedPath(url);
            const listings = {
                '/work': response('/work', '/', [
                    { name: 'branch', path: '/work/branch' },
                    { name: 'sibling', path: '/work/sibling' },
                ]),
                '/work/branch/target': response(
                    '/work/branch/target',
                    '/work/branch',
                    [],
                ),
                '/work/branch': response('/work/branch', '/work', [
                    { name: 'target', path: '/work/branch/target' },
                ]),
            };
            return listings[path];
        });
        const { controller, onSelect } = mountTree('/work');
        await waitForItem('/work/sibling');

        await expect(controller.reveal('/work/branch/target')).resolves.toBe(
            '/work/branch/target',
        );
        expect(item('/work/branch').getAttribute('aria-expanded')).toBe('true');
        expect(item('/work/branch/target').getAttribute('aria-selected')).toBe(
            'true',
        );
        expect(item('/work/sibling')).toBeTruthy();
        expect(fetchMock.mock.calls.map(([url]) => requestedPath(url))).toEqual(
            ['/work', '/work/branch/target', '/work/branch'],
        );
        expect(onSelect).not.toHaveBeenCalled();
        controller.destroy();
    });

    it('uses segment boundaries and supports POSIX roots and Windows drive spelling', async () => {
        mockFetch((url) => {
            const path = requestedPath(url);
            if (path === '/') {
                return response('/', '', [{ name: 'folder', path: '/folder' }]);
            }
            if (path === '/folder') return response('/folder', '/', []);
            if (path === 'C:\\Work') {
                return response('C:\\Work', 'C:\\', [
                    { name: 'Folder', path: 'C:\\Work\\Folder' },
                ]);
            }
            if (path === 'c:/work/folder') {
                return response('c:/WORK/Folder', 'c:/work', []);
            }
            return response('/dir/foo', '/', []);
        });
        const posix = mountTree('/');
        await waitForItem('/folder');
        await expect(posix.controller.reveal('/folder')).resolves.toBe(
            '/folder',
        );
        posix.controller.destroy();

        const windows = mountTree('C:\\Work');
        await waitForItem('C:\\Work\\Folder');
        await expect(windows.controller.reveal('c:/work/folder')).resolves.toBe(
            'c:/WORK/Folder',
        );
        expect(item('c:/WORK/Folder').dataset.path).toBe('c:/WORK/Folder');
        windows.controller.destroy();
    });

    it('treats a prefix collision as an outside root, not a descendant', async () => {
        const fetchMock = mockFetch((url) => {
            const path = requestedPath(url);
            return path === '/dir/foo'
                ? response('/dir/foo', '/dir', [])
                : response('/dir/foobar/child', '/dir/foobar', []);
        });
        const { controller } = mountTree('/dir/foo');
        await waitForItem('/dir/foo');

        await expect(controller.reveal('/dir/foobar/child')).resolves.toBe(
            '/dir/foobar/child',
        );
        expect(fetchMock.mock.calls.map(([url]) => requestedPath(url))).toEqual(
            ['/dir/foo', '/dir/foobar/child'],
        );
        expect(item('/dir/foobar/child')).toBeTruthy();
        expect(item('/dir/foo')).toBeUndefined();
        controller.destroy();
    });

    it('keeps an exact target reachable when its parent listing omits it', async () => {
        mockFetch((url) => {
            const path = requestedPath(url);
            return path === '/work'
                ? response('/work', '/', [], true)
                : response('/work/.hidden', '/work', []);
        });
        const { controller, host } = mountTree('/work');
        await waitForItem('/work');

        await expect(controller.reveal('/work/.hidden')).resolves.toBe(
            '/work/.hidden',
        );
        expect(item('/work/.hidden').getAttribute('aria-selected')).toBe(
            'true',
        );
        expect(host.textContent).toContain('separate root');
        controller.destroy();
    });

    it('shows retry and empty states, and exposes unknown sibling count when truncated', async () => {
        let attempts = 0;
        mockFetch((url) => {
            const path = requestedPath(url);
            if (path === '/ws') {
                return response(
                    '/ws',
                    '/',
                    [{ name: 'retry-me', path: '/ws/retry-me' }],
                    true,
                );
            }
            if (path === '/ws/retry-me' && attempts++ === 0) {
                return { ok: false, status: 500, json: {} };
            }
            return response('/ws/retry-me', '/ws', []);
        });
        const { controller } = mountTree('/ws');
        await waitForItem('/ws/retry-me');
        expect(item('/ws/retry-me').getAttribute('aria-setsize')).toBe('-1');
        expect(
            document.querySelector('.directory-tree-truncated'),
        ).toBeTruthy();

        expand('/ws/retry-me');
        await vi.waitFor(() =>
            expect(
                item('/ws/retry-me').querySelector('.directory-tree-retry')
                    .hidden,
            ).toBe(false),
        );
        const retry = item('/ws/retry-me').querySelector(
            '.directory-tree-retry',
        );
        expect(retry.type).toBe('button');
        expect(retry.tabIndex).toBe(0);
        expect(retry.getAttribute('aria-label')).toBe('Retry loading retry-me');
        expect(
            [...document.querySelectorAll('[role="treeitem"]')].filter(
                (treeItem) => treeItem.tabIndex === 0,
            ),
        ).toHaveLength(1);
        retry.focus();
        expect(document.activeElement).toBe(retry);
        retry.click();
        await vi.waitFor(() =>
            expect(item('/ws/retry-me').textContent).toContain(
                'No visible subdirectories.',
            ),
        );
        expect(item('/ws/retry-me').hasAttribute('aria-expanded')).toBe(false);
        controller.destroy();
    });

    it('renders server names and paths as text, not HTML', async () => {
        const unsafe = '<img src=x onerror=alert(1)>';
        mockFetch(() =>
            response('/ws', '/', [{ name: unsafe, path: `/ws/${unsafe}` }]),
        );
        const { controller } = mountTree('/ws');
        await waitForItem('/ws/<img src=x onerror=alert(1)>');

        expect(document.querySelector('#tree-host img')).toBeNull();
        expect(item('/ws/<img src=x onerror=alert(1)>').textContent).toContain(
            unsafe,
        );
        controller.destroy();
    });

    it('preserves the previous tree when an explicit path cannot be read', async () => {
        mockFetch((url) => {
            const path = requestedPath(url);
            if (path === '/initial') return response('/initial', '/', []);
            return { ok: false, status: 404, json: {} };
        });
        const { controller } = mountTree('/initial');
        await waitForItem('/initial');

        await expect(controller.reveal('/missing')).rejects.toThrow();
        expect(item('/initial')).toBeTruthy();
        expect(item('/missing')).toBeUndefined();
        controller.destroy();
    });

    it('permits a new Reveal after the initial root fails', async () => {
        mockFetch((url) => {
            const path = requestedPath(url);
            return path === '/bad-start'
                ? { ok: false, status: 404, json: {} }
                : response('/good', '/', []);
        });
        const { controller } = mountTree('/bad-start');
        await vi.waitFor(() =>
            expect(
                item('/bad-start').querySelector('.directory-tree-retry')
                    .hidden,
            ).toBe(false),
        );

        await expect(controller.reveal('/good')).resolves.toBe('/good');
        expect(item('/good')).toBeTruthy();
        controller.destroy();
    });

    it('keeps two branch requests independent', async () => {
        const pending = new Map();
        mockFetch((url) => {
            const path = requestedPath(url);
            if (path === '/ws') {
                return response('/ws', '/', [
                    { name: 'alpha', path: '/ws/alpha' },
                    { name: 'beta', path: '/ws/beta' },
                ]);
            }
            return new Promise((resolve) => pending.set(path, resolve));
        });
        const { controller } = mountTree('/ws');
        await waitForItem('/ws/beta');
        expand('/ws/alpha');
        expand('/ws/beta');
        await vi.waitFor(() => expect(pending.size).toBe(2));

        pending.get('/ws/beta')(
            response('/ws/beta', '/ws', [
                { name: 'b-child', path: '/ws/beta/b-child' },
            ]),
        );
        await waitForItem('/ws/beta/b-child');
        expect(item('/ws/alpha').getAttribute('aria-busy')).toBe('true');
        pending.get('/ws/alpha')(
            response('/ws/alpha', '/ws', [
                { name: 'a-child', path: '/ws/alpha/a-child' },
            ]),
        );
        await waitForItem('/ws/alpha/a-child');
        controller.destroy();
    });

    it('ignores a branch response after collapse', async () => {
        let resolveBranch;
        mockFetch((url) =>
            requestedPath(url) === '/ws'
                ? response('/ws', '/', [{ name: 'folder', path: '/ws/folder' }])
                : new Promise((resolve) => (resolveBranch = resolve)),
        );
        const { controller } = mountTree('/ws');
        await waitForItem('/ws/folder');
        expand('/ws/folder');
        await vi.waitFor(() => expect(resolveBranch).toBeTypeOf('function'));
        expand('/ws/folder');
        resolveBranch(
            response('/ws/folder', '/ws', [
                { name: 'late', path: '/ws/folder/late' },
            ]),
        );
        await Promise.resolve();
        await Promise.resolve();

        expect(item('/ws/folder').getAttribute('aria-expanded')).toBe('false');
        expect(item('/ws/folder/late')).toBeUndefined();
        controller.destroy();
    });

    it('ignores old branches after root replacement and newer Reveal', async () => {
        let resolveBranch;
        let resolveFirstReveal;
        mockFetch((url) => {
            const path = requestedPath(url);
            if (path === '/old') {
                return response('/old', '/', [
                    { name: 'pending', path: '/old/pending' },
                ]);
            }
            if (path === '/old/pending') {
                return new Promise((resolve) => (resolveBranch = resolve));
            }
            if (path === '/first') {
                return new Promise((resolve) => (resolveFirstReveal = resolve));
            }
            return response('/second', '/', []);
        });
        const { controller } = mountTree('/old');
        await waitForItem('/old/pending');
        expand('/old/pending');
        await vi.waitFor(() => expect(resolveBranch).toBeTypeOf('function'));

        const first = controller.reveal('/first');
        const second = controller.reveal('/second');
        await expect(second).resolves.toBe('/second');
        resolveBranch(
            response('/old/pending', '/old', [
                { name: 'orphan', path: '/old/pending/orphan' },
            ]),
        );
        resolveFirstReveal(response('/first', '/', []));
        await expect(first).resolves.toBeNull();
        await Promise.resolve();
        await Promise.resolve();

        expect(item('/second')).toBeTruthy();
        expect(item('/old/pending/orphan')).toBeUndefined();
        controller.destroy();
    });

    it('uses the server parent on Up and retains the old expanded subtree', async () => {
        const fetchMock = mockFetch((url) => {
            const path = requestedPath(url);
            const listings = {
                '/work': response('/work', '/home', [
                    { name: 'src', path: '/work/src' },
                ]),
                '/work/src': response('/work/src', '/work', [
                    { name: 'nested', path: '/work/src/nested' },
                ]),
                '/home': response('/home', '/', [
                    { name: 'work', path: '/work' },
                    { name: 'other', path: '/home/other' },
                ]),
            };
            return listings[path];
        });
        const { controller, onSelect } = mountTree('/work');
        await waitForItem('/work/src');
        expand('/work/src');
        await waitForItem('/work/src/nested');

        document.querySelector('.directory-tree-up').click();
        await waitForItem('/home');
        expect(item('/work/src/nested')).toBeTruthy();
        expect(item('/home/other')).toBeTruthy();
        expect(fetchMock.mock.calls.map(([url]) => requestedPath(url))).toEqual(
            ['/work', '/work/src', '/home'],
        );
        expect(onSelect).not.toHaveBeenCalled();
        controller.destroy();
    });

    it('does not let an older Up cancel a newer outside Reveal', async () => {
        let resolveUp;
        let resolveReveal;
        const fetchMock = mockFetch((url) => {
            const path = requestedPath(url);
            if (path === '/ws') return response('/ws', '/', []);
            if (path === '/') {
                return new Promise((resolve) => (resolveUp = resolve));
            }
            return new Promise((resolve) => (resolveReveal = resolve));
        });
        const { controller, host } = mountTree('/ws');
        await waitForItem('/ws');
        await vi.waitFor(() =>
            expect(document.querySelector('.directory-tree-up').disabled).toBe(
                false,
            ),
        );

        document.querySelector('.directory-tree-up').click();
        await vi.waitFor(() => expect(resolveUp).toBeTypeOf('function'));
        const reveal = controller.reveal('/elsewhere');
        await vi.waitFor(() => expect(resolveReveal).toBeTypeOf('function'));

        resolveUp(response('/', '', [{ name: 'ws', path: '/ws' }]));
        await fetchMock.mock.results[1].value;
        await Promise.resolve();
        await Promise.resolve();
        expect(host.querySelector('.directory-tree-location').textContent).toBe(
            'Browsing: /ws',
        );

        resolveReveal(response('/elsewhere', '/', []));
        await expect(reveal).resolves.toBe('/elsewhere');
        expect(host.querySelector('.directory-tree-location').textContent).toBe(
            'Browsing: /elsewhere',
        );
        controller.destroy();
    });

    it('does not let an older Up replace a newer in-root Reveal', async () => {
        let resolveUp;
        let resolveReveal;
        const fetchMock = mockFetch((url) => {
            const path = requestedPath(url);
            if (path === '/ws') {
                return response('/ws', '/', [
                    { name: 'target', path: '/ws/target' },
                ]);
            }
            if (path === '/') {
                return new Promise((resolve) => (resolveUp = resolve));
            }
            return new Promise((resolve) => (resolveReveal = resolve));
        });
        const { controller, host } = mountTree('/ws');
        await waitForItem('/ws/target');

        document.querySelector('.directory-tree-up').click();
        await vi.waitFor(() => expect(resolveUp).toBeTypeOf('function'));
        const reveal = controller.reveal('/ws/target');
        await vi.waitFor(() => expect(resolveReveal).toBeTypeOf('function'));
        resolveReveal(response('/ws/target', '/ws', []));
        await expect(reveal).resolves.toBe('/ws/target');

        resolveUp(response('/', '', [{ name: 'ws', path: '/ws' }]));
        await fetchMock.mock.results[1].value;
        await Promise.resolve();
        await Promise.resolve();
        expect(host.querySelector('.directory-tree-location').textContent).toBe(
            'Browsing: /ws',
        );
        expect(item('/ws/target').getAttribute('aria-selected')).toBe('true');
        controller.destroy();
    });

    it.each(['resolve', 'reject'])(
        'restarts an expanded branch after Up invalidates its pending load (%s)',
        async (settlement) => {
            const branchRequests = [];
            const fetchMock = mockFetch((url) => {
                const path = requestedPath(url);
                if (path === '/ws') {
                    return response('/ws', '/', [
                        { name: 'slow', path: '/ws/slow' },
                    ]);
                }
                if (path === '/') {
                    return response('/', '', [{ name: 'ws', path: '/ws' }]);
                }
                return new Promise((resolve, reject) =>
                    branchRequests.push({ resolve, reject }),
                );
            });
            const { controller } = mountTree('/ws');
            await waitForItem('/ws/slow');
            expand('/ws/slow');
            await vi.waitFor(() => expect(branchRequests).toHaveLength(1));

            document.querySelector('.directory-tree-up').click();
            await waitForItem('/ws/slow');
            await vi.waitFor(() => expect(branchRequests).toHaveLength(2));
            expect(item('/ws/slow').getAttribute('aria-expanded')).toBe('true');
            expect(item('/ws/slow').getAttribute('aria-busy')).toBe('true');

            if (settlement === 'resolve') {
                branchRequests[0].resolve(
                    response('/ws/slow', '/ws', [
                        { name: 'stale', path: '/ws/slow/stale' },
                    ]),
                );
            } else {
                branchRequests[0].reject(new Error('late branch failure'));
            }
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            expect(item('/ws/slow').getAttribute('aria-busy')).toBe('true');
            expect(item('/ws/slow/stale')).toBeUndefined();

            branchRequests[1].resolve(
                response('/ws/slow', '/ws', [
                    { name: 'child', path: '/ws/slow/child' },
                ]),
            );
            await waitForItem('/ws/slow/child');
            expect(item('/ws/slow/stale')).toBeUndefined();
            expect(item('/ws/slow').getAttribute('aria-busy')).toBe(null);
            expect(
                fetchMock.mock.calls.map(([url]) => requestedPath(url)),
            ).toEqual(['/ws', '/ws/slow', '/', '/ws/slow']);
            controller.destroy();
        },
    );

    it('keeps an expanded branch loading when Up fails', async () => {
        let resolveBranch;
        let rejectUp;
        mockFetch((url) => {
            const path = requestedPath(url);
            if (path === '/ws') {
                return response('/ws', '/', [
                    { name: 'slow', path: '/ws/slow' },
                ]);
            }
            if (path === '/ws/slow') {
                return new Promise((resolve) => (resolveBranch = resolve));
            }
            return new Promise((_resolve, reject) => (rejectUp = reject));
        });
        const { controller, host } = mountTree('/ws');
        await waitForItem('/ws/slow');
        expand('/ws/slow');
        await vi.waitFor(() => expect(resolveBranch).toBeTypeOf('function'));

        document.querySelector('.directory-tree-up').click();
        await vi.waitFor(() => expect(rejectUp).toBeTypeOf('function'));
        rejectUp(new Error('parent unavailable'));
        await vi.waitFor(() =>
            expect(
                host.querySelector('.directory-tree-status').textContent,
            ).toBe('Unable to browse the parent directory.'),
        );
        expect(item('/ws/slow').getAttribute('aria-expanded')).toBe('true');
        expect(item('/ws/slow').getAttribute('aria-busy')).toBe('true');

        resolveBranch(
            response('/ws/slow', '/ws', [
                { name: 'child', path: '/ws/slow/child' },
            ]),
        );
        await waitForItem('/ws/slow/child');
        expect(item('/ws/slow').getAttribute('aria-busy')).toBe(null);
        controller.destroy();
    });

    it('disables Up at an empty filesystem parent without another request', async () => {
        const fetchMock = mockFetch(() => response('/', '', []));
        const { controller } = mountTree('/');
        await waitForItem('/');
        const up = document.querySelector('.directory-tree-up');
        expect(up.disabled).toBe(true);
        up.click();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        controller.destroy();
    });

    it('compares Windows drive roots and drive-letter case without rewriting returned paths', async () => {
        const fetchMock = mockFetch((url) => {
            const path = requestedPath(url);
            return path === 'C:\\'
                ? response('C:\\', '', [
                      { name: 'Project', path: 'C:\\Project' },
                  ])
                : response('c:/Project', 'c:/', []);
        });
        const { controller } = mountTree('C:\\');
        await waitForItem('C:\\Project');

        await expect(controller.reveal('c:/project')).resolves.toBe(
            'c:/Project',
        );
        expect(item('c:/Project').dataset.path).toBe('c:/Project');
        expect(fetchMock.mock.calls.map(([url]) => requestedPath(url))).toEqual(
            ['C:\\', 'c:/project'],
        );
        expect(document.querySelector('.directory-tree-up').disabled).toBe(
            true,
        );
        controller.destroy();
    });

    it('scrolls the focused row rather than its treeitem container', async () => {
        mockFetch(() =>
            response('/ws', '/', [
                { name: 'first', path: '/ws/first' },
                { name: 'last', path: '/ws/last' },
            ]),
        );
        const { controller } = mountTree('/ws');
        await waitForItem('/ws/last');
        const root = item('/ws');
        const rootRow = root.querySelector('.directory-tree-row');
        root.scrollIntoView = vi.fn();
        rootRow.scrollIntoView = vi.fn();
        root.focus();
        root.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'End',
                bubbles: true,
                cancelable: true,
            }),
        );
        expect(document.activeElement).toBe(item('/ws/last'));
        item('/ws/last').dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Home',
                bubbles: true,
                cancelable: true,
            }),
        );

        expect(document.activeElement).toBe(root);
        expect(rootRow.scrollIntoView).toHaveBeenCalledWith({
            block: 'nearest',
        });
        expect(root.scrollIntoView).not.toHaveBeenCalled();
        controller.destroy();
    });

    it('supports visible-row arrows, Home/End, and repeated-letter type-ahead', async () => {
        mockFetch(() =>
            response('/ws', '/', [
                { name: 'alpha', path: '/ws/alpha' },
                { name: 'amber', path: '/ws/amber' },
                { name: 'beta', path: '/ws/beta' },
                { name: 'bravo', path: '/ws/bravo' },
            ]),
        );
        const { controller, onSelect } = mountTree('/ws');
        await waitForItem('/ws/bravo');
        const press = (target, key) =>
            target.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key,
                    bubbles: true,
                    cancelable: true,
                }),
            );

        item('/ws').focus();
        press(item('/ws'), 'ArrowDown');
        expect(document.activeElement).toBe(item('/ws/alpha'));
        expect(item('/ws/alpha').getAttribute('aria-selected')).toBe('false');
        press(item('/ws/alpha'), 'ArrowDown');
        expect(document.activeElement).toBe(item('/ws/amber'));
        press(item('/ws/amber'), 'ArrowUp');
        expect(document.activeElement).toBe(item('/ws/alpha'));
        press(item('/ws/alpha'), 'Home');
        expect(document.activeElement).toBe(item('/ws'));
        press(item('/ws'), 'End');
        expect(document.activeElement).toBe(item('/ws/bravo'));
        press(item('/ws/bravo'), 'Home');
        press(item('/ws'), 'a');
        expect(document.activeElement).toBe(item('/ws/alpha'));
        press(item('/ws/alpha'), 'a');
        expect(document.activeElement).toBe(item('/ws/amber'));
        press(item('/ws/amber'), 'a');
        expect(document.activeElement).toBe(item('/ws/alpha'));
        expect(
            [...document.querySelectorAll('[role="treeitem"]')].filter(
                (treeItem) => treeItem.tabIndex === 0,
            ),
        ).toHaveLength(1);
        expect(onSelect).not.toHaveBeenCalled();
        controller.destroy();
    });

    it('uses Right/Left for expansion and skips hidden descendants in navigation', async () => {
        mockFetch((url) => {
            const path = requestedPath(url);
            if (path === '/ws') {
                return response('/ws', '/', [
                    { name: 'alpha', path: '/ws/alpha' },
                    { name: 'beta', path: '/ws/beta' },
                ]);
            }
            return response('/ws/alpha', '/ws', [
                { name: 'nested', path: '/ws/alpha/nested' },
            ]);
        });
        const { controller, onSelect } = mountTree('/ws');
        await waitForItem('/ws/beta');
        const press = (target, key) =>
            target.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key,
                    bubbles: true,
                    cancelable: true,
                }),
            );

        item('/ws').focus();
        press(item('/ws'), 'ArrowRight');
        expect(document.activeElement).toBe(item('/ws/alpha'));
        press(item('/ws/alpha'), 'ArrowRight');
        await waitForItem('/ws/alpha/nested');
        expect(item('/ws/alpha').getAttribute('aria-expanded')).toBe('true');
        expect(document.activeElement).toBe(item('/ws/alpha'));
        press(item('/ws/alpha'), 'ArrowRight');
        expect(document.activeElement).toBe(item('/ws/alpha/nested'));
        press(item('/ws/alpha/nested'), 'ArrowLeft');
        expect(document.activeElement).toBe(item('/ws/alpha'));
        press(item('/ws/alpha'), 'ArrowLeft');
        expect(document.activeElement).toBe(item('/ws/alpha'));
        expect(item('/ws/alpha/nested')).toBeUndefined();
        press(item('/ws/alpha'), 'ArrowDown');
        expect(document.activeElement).toBe(item('/ws/beta'));
        expect(item('/ws/beta').isConnected).toBe(true);
        expect(onSelect).not.toHaveBeenCalled();
        controller.destroy();
    });

    it('selects focused rows with Enter and Space without moving tree focus', async () => {
        const onSelect = vi.fn();
        mockFetch(() =>
            response('/ws', '/', [{ name: 'folder', path: '/ws/folder' }]),
        );
        const { controller } = mountTree('/ws', onSelect);
        await waitForItem('/ws/folder');
        const keydown = (target, key) =>
            target.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key,
                    bubbles: true,
                    cancelable: true,
                }),
            );

        item('/ws').focus();
        keydown(item('/ws'), 'Enter');
        expect(onSelect).toHaveBeenLastCalledWith('/ws');
        expect(document.activeElement).toBe(item('/ws'));
        item('/ws/folder').focus();
        keydown(item('/ws/folder'), ' ');
        expect(onSelect).toHaveBeenLastCalledWith('/ws/folder');
        expect(item('/ws/folder').getAttribute('aria-selected')).toBe('true');
        expect(item('/ws').getAttribute('aria-selected')).toBe('false');
        expect(document.activeElement).toBe(item('/ws/folder'));
        controller.destroy();
    });

    it('keeps empty folders selectable leaves without a false expand action', async () => {
        const fetchMock = mockFetch((url) =>
            requestedPath(url) === '/ws'
                ? response('/ws', '/', [{ name: 'empty', path: '/ws/empty' }])
                : response('/ws/empty', '/ws', []),
        );
        const { controller } = mountTree('/ws');
        await waitForItem('/ws/empty');
        const empty = item('/ws/empty');
        expect(empty.getAttribute('aria-expanded')).toBe('false');
        empty.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'ArrowRight',
                bubbles: true,
                cancelable: true,
            }),
        );
        await vi.waitFor(() =>
            expect(empty.hasAttribute('aria-expanded')).toBe(false),
        );
        empty.focus();
        empty.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'ArrowRight',
                bubbles: true,
                cancelable: true,
            }),
        );
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(document.activeElement).toBe(empty);
        controller.destroy();
    });

    it('invalidates a Reveal after a newer draft and disposes idempotently', async () => {
        let resolveBrowse;
        mockFetch(() => new Promise((resolve) => (resolveBrowse = resolve)));
        const { controller, host } = mountTree('/start');
        const reveal = controller.reveal('/elsewhere');
        controller.invalidateDraft();
        resolveBrowse(response('/elsewhere', '/', []));
        await expect(reveal).resolves.toBeNull();
        expect(item('/start')).toBeTruthy();

        controller.destroy();
        controller.destroy();
        expect(host.childElementCount).toBe(0);
    });
});
