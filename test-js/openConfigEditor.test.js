// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mockFetch, setupDomHarness } from './_dom.js';
import { App } from '../web/app.js';

// Reproduces the "Add Command doesn't work" bug: openConfigEditor builds a
// <form> (body) but appends the footer (with the type=submit button) to the
// modal, NOT the form. A submit button outside its form does not submit on
// click, so clicking "Add Command" never resolves the promise. openConfigEditor
// does not use `this`, so we can invoke it against a bare object.

afterEach(() => {
    document
        .querySelectorAll('.config-editor-overlay .modal-close-btn')
        .forEach((button) => {
            button.click();
        });
});
setupDomHarness();

const openEditor = (over = {}) =>
    App.prototype.openConfigEditor.call(
        {},
        {
            title: 'Add Terminal Command',
            fields: [
                { id: 'name', label: 'Label' },
                { id: 'command', label: 'Command', multiline: true },
            ],
            submitLabel: 'Add Command',
            ...over,
        },
    );

// Resolve to a sentinel if the promise doesn't settle promptly, so a broken
// (never-resolving) submit shows up as a failed assertion instead of a hang.
const settleOr = (p, ms = 150) =>
    Promise.race([
        p,
        new Promise((r) => setTimeout(() => r('__timeout__'), ms)),
    ]);

const openPathEditor = (path = {}, field = {}) =>
    App.prototype.openConfigEditor.call(
        {},
        {
            title: 'Add Markdown Directory',
            fields: [
                {
                    id: 'dir',
                    label: 'Directory path',
                    required: false,
                    path: { startPath: '/ws', relativeTo: '/ws', ...path },
                    ...field,
                },
            ],
            submitLabel: 'Add',
        },
    );

const openFields = (fields, over = {}) =>
    App.prototype.openConfigEditor.call(
        {},
        {
            title: 'Path mode test',
            fields,
            submitLabel: 'Add',
            ...over,
        },
    );

const response = (path, parent = '/', entries = [], truncated = false) => ({
    path,
    parent,
    entries,
    truncated,
});

const installBrowse = (handler) =>
    mockFetch((url, options) => {
        const request = new URL(String(url), 'http://localhost');
        if (request.pathname !== '/api/fs/browse') {
            throw new Error(`Unexpected fetch: ${request.pathname}`);
        }
        return handler(request.searchParams.get('path'), request, options);
    });

const pathInput = () => document.getElementById('config-editor-dir');
const pathStatus = () => document.querySelector('.config-editor-path-status');
const treeHost = () => document.querySelector('.config-editor-path-tree');
const treeItem = (path) =>
    [
        ...document.querySelectorAll(
            '.config-editor-path-tree [role="treeitem"]',
        ),
    ].find((item) => item.dataset.path === path);
const waitForTreeItem = async (path) => {
    await vi.waitFor(() => {
        expect(
            document
                .querySelector('.config-editor-overlay')
                ?.classList.contains('hidden'),
        ).toBe(false);
        expect(treeItem(path)).toBeTruthy();
    });
    return treeItem(path);
};
const setPathDraft = (value) => {
    pathInput().value = value;
    pathInput().dispatchEvent(new Event('input', { bubbles: true }));
};
const revealPath = () =>
    document.querySelector('.config-editor-path-reveal').click();
const closePathEditor = () =>
    document.querySelector('.config-editor-overlay .modal-close-btn')?.click();

describe('openConfigEditor', () => {
    it('resolves with field values when the submit button is clicked', async () => {
        const promise = openEditor();
        document.getElementById('config-editor-name').value = 'tests';
        document.getElementById('config-editor-command').value = 'npm test';

        const submitBtn = document.querySelector(
            '.config-editor-footer .btn-accent',
        );
        expect(submitBtn).toBeTruthy();
        submitBtn.click();

        const result = await settleOr(promise);
        expect(result).toEqual({ name: 'tests', command: 'npm test' });
    });

    it('resolves null when cancelled', async () => {
        const promise = openEditor();
        const cancelBtn = document.querySelector(
            '.config-editor-footer .btn:not(.btn-accent)',
        );
        cancelBtn.click();
        const result = await settleOr(promise);
        expect(result).toBeNull();
    });

    it('does not close and discard the draft when the backdrop is clicked', async () => {
        const promise = openEditor();
        document.getElementById('config-editor-name').value = 'tests';
        document.getElementById('config-editor-command').value = 'npm test';

        document.querySelector('.config-editor-overlay').click();
        expect(await settleOr(promise, 80)).toBe('__timeout__');

        document
            .querySelector('.config-editor-footer .btn:not(.btn-accent)')
            .click();
        expect(await settleOr(promise)).toBeNull();
    });

    it('does not submit while a required field is empty', async () => {
        const promise = openEditor();
        // leave name empty, fill command
        document.getElementById('config-editor-command').value = 'npm test';
        document.querySelector('.config-editor-footer .btn-accent').click();
        const result = await settleOr(promise, 80);
        expect(result).toBe('__timeout__'); // stayed open, no resolution
    });

    it('permits padded pattern input and returns its trimmed value', async () => {
        const promise = openFields([
            {
                id: 'level',
                label: 'Thinking level',
                pattern: '\\s*(?:off|high)\\s*',
            },
        ]);
        const input = document.getElementById('config-editor-level');
        input.value = ' high ';
        document.querySelector('.config-editor-footer .btn-accent').click();
        await expect(promise).resolves.toEqual({ level: 'high' });
    });

    it('keeps a pattern-invalid draft open for correction', async () => {
        const promise = openFields([
            {
                id: 'level',
                label: 'Thinking level',
                pattern: '\\s*(?:off|high)\\s*',
            },
        ]);
        const input = document.getElementById('config-editor-level');
        input.value = ' turbo ';
        document.querySelector('.config-editor-footer .btn-accent').click();
        expect(await settleOr(promise, 40)).toBe('__timeout__');
        expect(input.value).toBe(' turbo ');
        expect(document.querySelector('.config-editor-overlay')).toBeTruthy();
    });
});

describe('openConfigEditor path fields', () => {
    it('renders one labeled path input, tree, Reveal control, and footer submit action', async () => {
        installBrowse((path) => response(path, '/', []));
        const promise = openPathEditor();
        const modal = document.querySelector('.config-editor-path-modal');
        const label = modal.querySelector('.config-editor-path-label');
        const input = pathInput();

        expect(modal.getAttribute('role')).toBe('dialog');
        expect(modal.getAttribute('aria-modal')).toBe('true');
        expect(modal.getAttribute('aria-labelledby')).toBe(
            modal.querySelector('h3').id,
        );
        expect(
            document.querySelectorAll('.config-editor-overlay [role="dialog"]'),
        ).toHaveLength(1);
        expect(input.id).toBe('config-editor-dir');
        expect(input.name).toBe('dir');
        expect(label.htmlFor).toBe(input.id);
        expect(label.contains(input)).toBe(false);
        const field = modal.querySelector('.config-editor-path-field');
        expect(field.children[0]).toBe(label);
        expect(field.children[1].classList).toContain('config-editor-path-row');
        expect(field.children[2]).toBe(
            modal.querySelector('.config-editor-path-status'),
        );
        expect(field.children[3]).toBe(
            modal.querySelector('.config-editor-path-tree'),
        );
        expect(modal.querySelectorAll('.config-editor-path-tree')).toHaveLength(
            1,
        );
        expect(
            modal.querySelectorAll('.config-editor-path-reveal'),
        ).toHaveLength(1);
        expect(modal.querySelector('.config-editor-path-reveal').type).toBe(
            'button',
        );
        expect(
            modal.querySelectorAll('.config-editor-footer .btn-accent'),
        ).toHaveLength(1);
        expect(
            modal.querySelector('.config-editor-footer .btn-accent').type,
        ).toBe('submit');
        const root = await waitForTreeItem('/ws');
        expect(root.getAttribute('aria-selected')).toBe('false');
        closePathEditor();
        await expect(promise).resolves.toBeNull();
    });

    it('keeps ordinary fields and path:true on their existing markup path', async () => {
        const promise = openFields([
            { id: 'ordinary', label: 'Ordinary field' },
            { id: 'shorthand', label: 'Shorthand path', path: true },
        ]);
        expect(document.querySelector('.config-editor-path-modal')).toBeNull();
        expect(
            document.querySelectorAll('.config-editor-path-field'),
        ).toHaveLength(0);
        expect(
            document.querySelectorAll('.config-editor-path-reveal'),
        ).toHaveLength(0);
        expect(
            document.querySelectorAll('.config-editor-path-tree'),
        ).toHaveLength(0);
        expect(
            document.getElementById('config-editor-ordinary').closest('label'),
        ).toBeTruthy();
        expect(
            document.getElementById('config-editor-shorthand').closest('label'),
        ).toBeTruthy();
        closePathEditor();
        await expect(promise).resolves.toBeNull();
    });

    it.each([
        ['/absolute/start', '/absolute/start', '/absolute/start'],
        ['~', undefined, '/server/home'],
    ])(
        'loads the initial %s root without replacing a prefilled or typed draft',
        async (startPath, relativeTo, returnedRoot) => {
            let resolveRoot;
            const fetchMock = installBrowse(
                () => new Promise((resolve) => (resolveRoot = resolve)),
            );
            const promise = openPathEditor(
                { startPath, relativeTo },
                { value: '/prefilled/draft' },
            );
            expect(pathInput().value).toBe('/prefilled/draft');
            await vi.waitFor(() => expect(resolveRoot).toBeTypeOf('function'));
            expect(fetchMock.mock.calls[0][0]).toBe(
                `/api/fs/browse?path=${encodeURIComponent(startPath)}`,
            );
            setPathDraft('/typed/while/loading');
            resolveRoot(response(returnedRoot, '/', []));
            await waitForTreeItem(returnedRoot);
            expect(pathInput().value).toBe('/typed/while/loading');
            closePathEditor();
            await expect(promise).resolves.toBeNull();
        },
    );

    it('formats root, descendant, and outside selections without submitting', async () => {
        const fetchMock = installBrowse((path) => {
            if (path === '/ws') {
                return response('/ws', '/home', [
                    { name: 'docs', path: '/ws/docs' },
                ]);
            }
            if (path === '/home') {
                return response('/home', '/', [
                    { name: 'ws', path: '/ws' },
                    { name: 'outside', path: '/outside' },
                ]);
            }
            return response(path, '/', []);
        });
        const promise = openPathEditor();
        await waitForTreeItem('/ws/docs');

        treeItem('/ws').querySelector('.directory-tree-name').click();
        expect(pathInput().value).toBe('.');
        treeItem('/ws/docs').querySelector('.directory-tree-name').click();
        expect(pathInput().value).toBe('./docs');
        document.querySelector('.directory-tree-up').click();
        await waitForTreeItem('/outside');
        treeItem('/outside').querySelector('.directory-tree-name').click();
        expect(pathInput().value).toBe('/outside');
        expect(document.querySelector('.config-editor-overlay')).toBeTruthy();
        expect(
            fetchMock.mock.calls.some(
                ([, options]) => options?.method === 'POST',
            ),
        ).toBe(false);
        expect(await settleOr(promise, 40)).toBe('__timeout__');
    });

    it('preserves tree navigation, tree focus, and draft on keyboard actions and Up', async () => {
        installBrowse((path) => {
            if (path === '/ws') {
                return response('/ws', '/home', [
                    { name: 'branch', path: '/ws/branch' },
                ]);
            }
            if (path === '/ws/branch') {
                return response('/ws/branch', '/ws', [
                    { name: 'nested', path: '/ws/branch/nested' },
                ]);
            }
            if (path === '/home') {
                return response('/home', '/', [{ name: 'ws', path: '/ws' }]);
            }
            return response(path, '/', []);
        });
        const promise = openPathEditor();
        await waitForTreeItem('/ws/branch');

        const root = treeItem('/ws');
        root.focus();
        const down = new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
        });
        root.dispatchEvent(down);
        expect(down.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(treeItem('/ws/branch'));
        treeItem('/ws/branch')
            .querySelector('.directory-tree-disclosure')
            .click();
        await waitForTreeItem('/ws/branch/nested');

        const branch = treeItem('/ws/branch');
        branch.focus();
        const space = new KeyboardEvent('keydown', {
            key: ' ',
            bubbles: true,
            cancelable: true,
        });
        branch.dispatchEvent(space);
        expect(space.defaultPrevented).toBe(true);
        expect(pathInput().value).toBe('./branch');
        expect(branch.getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(branch);

        root.focus();
        const enter = new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        });
        root.dispatchEvent(enter);
        expect(enter.defaultPrevented).toBe(true);
        expect(pathInput().value).toBe('.');
        document.querySelector('.directory-tree-up').click();
        await waitForTreeItem('/home');
        expect(pathInput().value).toBe('.');
        expect(document.querySelector('.config-editor-overlay')).toBeTruthy();
        expect(await settleOr(promise, 40)).toBe('__timeout__');
    });

    it('resolves relative Reveal drafts from the fixed start path and preserves absolute forms', async () => {
        const responses = new Map([
            ['/fixed/base/.', response('/fixed/base', '/fixed')],
            ['/fixed/base/./docs', response('/fixed/base/docs', '/fixed/base')],
            ['/fixed/base/../shared', response('/fixed/shared', '/fixed')],
            ['/outside/a folder', response('/outside/a folder', '/')],
            ['C:\\Work\\App', response('C:\\Work\\App', '')],
            [
                '\\\\server\\share\\Folder With Spaces',
                response('\\\\server\\share\\Folder With Spaces', ''),
            ],
            [
                '/fixed/base/space folder',
                response('/fixed/base/space folder', '/fixed/base'),
            ],
        ]);
        const fetchMock = installBrowse((path) =>
            path === '/fixed/base'
                ? response('/fixed/base', '/fixed', [])
                : (responses.get(path) ?? response(path, '/', [])),
        );
        const promise = openPathEditor({
            startPath: '/fixed/base',
            relativeTo: '/fixed/base',
        });
        await waitForTreeItem('/fixed/base');
        await vi.waitFor(() =>
            expect(
                treeItem('/fixed/base').getAttribute('aria-busy'),
            ).toBeNull(),
        );

        setPathDraft('.');
        revealPath();
        await vi.waitFor(() =>
            expect(treeItem('/fixed/base').getAttribute('aria-selected')).toBe(
                'true',
            ),
        );
        expect(pathInput().value).toBe('.');
        expect(
            fetchMock.mock.calls.map(([url]) =>
                new URL(String(url), 'http://localhost').searchParams.get(
                    'path',
                ),
            ),
        ).toEqual(['/fixed/base', '/fixed/base/.']);

        const cases = [
            ['./docs', '/fixed/base/./docs', './docs', '/fixed/base/docs'],
            [
                '../shared',
                '/fixed/base/../shared',
                '/fixed/shared',
                '/fixed/shared',
            ],
            [
                '/outside/a folder',
                '/outside/a folder',
                '/outside/a folder',
                '/outside/a folder',
            ],
            [
                'C:\\Work\\App',
                'C:\\Work\\App',
                'C:\\Work\\App',
                'C:\\Work\\App',
            ],
            [
                '\\\\server\\share\\Folder With Spaces',
                '\\\\server\\share\\Folder With Spaces',
                '\\\\server\\share\\Folder With Spaces',
                '\\\\server\\share\\Folder With Spaces',
            ],
            [
                '  space folder  ',
                '/fixed/base/space folder',
                './space folder',
                '/fixed/base/space folder',
            ],
        ];
        for (const [draft, requestPath, result, selectedPath] of cases) {
            setPathDraft(draft);
            revealPath();
            await vi.waitFor(() =>
                expect(
                    fetchMock.mock.calls.some(
                        ([url]) =>
                            new URL(
                                String(url),
                                'http://localhost',
                            ).searchParams.get('path') === requestPath,
                    ),
                ).toBe(true),
            );
            await vi.waitFor(() =>
                expect(
                    treeItem(selectedPath)?.getAttribute('aria-selected'),
                ).toBe('true'),
            );
            expect(pathInput().value).toBe(result);
        }
        closePathEditor();
        await expect(promise).resolves.toBeNull();
    });

    it.each([
        ['/ws/a\\b', '/ws/a\\b/child'],
        ['/ws/a\\', '/ws/a\\/child'],
        ['/', '/child'],
        ['C:\\', 'C:\\/child'],
    ])(
        'preserves directory names and roots when revealing a child from %s',
        async (startPath, child) => {
            const fetchMock = installBrowse((path) =>
                path === startPath
                    ? response(startPath, '/ws', [
                          { name: 'child', path: child },
                      ])
                    : response(path, startPath, []),
            );
            const promise = openPathEditor({
                startPath,
                relativeTo: startPath,
            });
            await waitForTreeItem(child);
            setPathDraft('child');
            revealPath();
            await vi.waitFor(() => expect(pathInput().value).toBe('./child'));
            expect(
                fetchMock.mock.calls.map(([url]) =>
                    new URL(String(url), 'http://localhost').searchParams.get(
                        'path',
                    ),
                ),
            ).toContain(child);
            closePathEditor();
            await expect(promise).resolves.toBeNull();
        },
    );

    it('keeps the visible draft unchanged until a successful Reveal response', async () => {
        let resolveTarget;
        const fetchMock = installBrowse((path) => {
            if (path === '/ws') {
                return response('/ws', '/', [
                    { name: 'docs', path: '/ws/docs' },
                ]);
            }
            return new Promise((resolve) => (resolveTarget = resolve));
        });
        const promise = openPathEditor();
        await waitForTreeItem('/ws/docs');
        setPathDraft('  docs  ');
        revealPath();
        await vi.waitFor(() => expect(resolveTarget).toBeTypeOf('function'));

        expect(pathInput().value).toBe('  docs  ');
        expect(
            fetchMock.mock.calls.some(
                ([url]) =>
                    new URL(String(url), 'http://localhost').searchParams.get(
                        'path',
                    ) === '/ws/docs',
            ),
        ).toBe(true);
        resolveTarget(response('/ws/docs', '/ws', []));
        await vi.waitFor(() => expect(pathInput().value).toBe('./docs'));
        closePathEditor();
        await expect(promise).resolves.toBeNull();
    });

    it('joins home-relative Reveal input to ~ and keeps a full returned path without a relative base', async () => {
        const fetchMock = installBrowse((path) => {
            if (path === '~') {
                return response('/home/user', '/', [
                    { name: 'docs', path: '/home/user/docs' },
                ]);
            }
            if (path === '~/docs') {
                return response('/home/user/docs', '/home/user', []);
            }
            return response(path, '/', []);
        });
        const promise = openPathEditor({
            startPath: '~',
            relativeTo: undefined,
        });
        await waitForTreeItem('/home/user/docs');
        setPathDraft('docs');
        revealPath();
        await vi.waitFor(() =>
            expect(fetchMock.mock.calls.map(([url]) => url)).toContain(
                '/api/fs/browse?path=~%2Fdocs',
            ),
        );
        await vi.waitFor(() =>
            expect(pathInput().value).toBe('/home/user/docs'),
        );
        closePathEditor();
        await expect(promise).resolves.toBeNull();
    });

    it('reveals once on Enter without submitting and restores input focus on success', async () => {
        const fetchMock = installBrowse((path) => {
            if (path === '/ws') {
                return response('/ws', '/', [
                    { name: 'docs', path: '/ws/docs' },
                ]);
            }
            return response('/ws/docs', '/ws', []);
        });
        const promise = openPathEditor();
        await waitForTreeItem('/ws/docs');
        setPathDraft('docs');
        const enter = new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        });
        pathInput().dispatchEvent(enter);
        expect(enter.defaultPrevented).toBe(true);
        await vi.waitFor(() => expect(pathInput().value).toBe('./docs'));
        expect(document.activeElement).toBe(pathInput());
        expect(
            fetchMock.mock.calls.filter(
                ([url]) =>
                    new URL(String(url), 'http://localhost').searchParams.get(
                        'path',
                    ) === '/ws/docs',
            ),
        ).toHaveLength(1);
        expect(document.querySelector('.config-editor-overlay')).toBeTruthy();
        expect(await settleOr(promise, 40)).toBe('__timeout__');
    });

    it('keeps empty and failed Reveal drafts and the previous tree', async () => {
        const fetchMock = installBrowse((path) => {
            if (path === '/ws') {
                return response('/ws', '/', [
                    { name: 'kept', path: '/ws/kept' },
                ]);
            }
            return { ok: false, status: 404, json: {} };
        });
        const promise = openPathEditor();
        await waitForTreeItem('/ws/kept');
        setPathDraft('   ');
        revealPath();
        expect(pathStatus().textContent).toBe(
            'Enter a directory path to reveal.',
        );
        expect(pathInput().value).toBe('   ');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(treeItem('/ws/kept')).toBeTruthy();

        setPathDraft('/missing');
        revealPath();
        await vi.waitFor(() =>
            expect(pathStatus().textContent).toBe(
                'This path is not an accessible directory.',
            ),
        );
        expect(pathInput().value).toBe('/missing');
        expect(treeItem('/ws/kept')).toBeTruthy();
        closePathEditor();
        await expect(promise).resolves.toBeNull();
    });

    it('ignores a Reveal completion after a newer input draft', async () => {
        let resolveSlow;
        installBrowse((path) =>
            path === '/ws'
                ? response('/ws', '/', [])
                : new Promise((resolve) => (resolveSlow = resolve)),
        );
        const promise = openPathEditor();
        await waitForTreeItem('/ws');
        setPathDraft('/slow');
        revealPath();
        await vi.waitFor(() => expect(resolveSlow).toBeTypeOf('function'));
        const root = treeItem('/ws');
        root.focus();
        setPathDraft('/new draft');
        resolveSlow(response('/slow', '/', []));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(pathInput().value).toBe('/new draft');
        expect(pathStatus().textContent).toBe('');
        expect(document.activeElement).toBe(root);
        expect(treeItem('/ws')).toBeTruthy();
        closePathEditor();
        await expect(promise).resolves.toBeNull();
    });

    it('ignores a Reveal completion after a newer row selection and retains tree focus', async () => {
        let resolveSlow;
        installBrowse((path) => {
            if (path === '/ws') {
                return response('/ws', '/', [
                    { name: 'kept', path: '/ws/kept' },
                ]);
            }
            return new Promise((resolve) => (resolveSlow = resolve));
        });
        const promise = openPathEditor();
        await waitForTreeItem('/ws/kept');
        setPathDraft('/slow');
        revealPath();
        await vi.waitFor(() => expect(resolveSlow).toBeTypeOf('function'));
        treeItem('/ws/kept').querySelector('.directory-tree-name').click();
        const selected = treeItem('/ws/kept');
        expect(pathInput().value).toBe('./kept');
        expect(document.activeElement).toBe(selected);
        resolveSlow(response('/slow', '/', []));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(pathInput().value).toBe('./kept');
        expect(pathStatus().textContent).toBe('');
        expect(document.activeElement).toBe(selected);
        expect(treeItem('/ws/kept')).toBeTruthy();
        closePathEditor();
        await expect(promise).resolves.toBeNull();
    });

    it('ignores an older Reveal completion after another Reveal', async () => {
        const pending = [];
        installBrowse((path) =>
            path === '/ws'
                ? response('/ws', '/', [])
                : new Promise((resolve) => pending.push(resolve)),
        );
        const promise = openPathEditor();
        await waitForTreeItem('/ws');
        setPathDraft('/target');
        revealPath();
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        revealPath();
        await vi.waitFor(() => expect(pending).toHaveLength(2));
        const root = treeItem('/ws');
        root.focus();

        pending[0](response('/old-result', '/', []));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(pathInput().value).toBe('/target');
        expect(document.activeElement).toBe(root);
        expect(treeItem('/ws')).toBeTruthy();

        pending[1](response('/target', '/', []));
        await vi.waitFor(() =>
            expect(document.activeElement).toBe(pathInput()),
        );
        expect(pathInput().value).toBe('/target');
        closePathEditor();
        await expect(promise).resolves.toBeNull();
    });

    it('ignores a Reveal invalidated by Up without changing the draft or focus', async () => {
        let resolveSlow;
        installBrowse((path) => {
            if (path === '/ws') {
                return response('/ws', '/home', [
                    { name: 'child', path: '/ws/child' },
                ]);
            }
            if (path === '/home') {
                return response('/home', '/', [{ name: 'ws', path: '/ws' }]);
            }
            return new Promise((resolve) => (resolveSlow = resolve));
        });
        const promise = openPathEditor();
        await waitForTreeItem('/ws/child');
        setPathDraft('/slow');
        revealPath();
        await vi.waitFor(() => expect(resolveSlow).toBeTypeOf('function'));
        document.querySelector('.directory-tree-up').click();
        await waitForTreeItem('/home');
        const parent = treeItem('/home');
        parent.focus();
        resolveSlow(response('/slow', '/', []));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(pathInput().value).toBe('/slow');
        expect(pathStatus().textContent).toBe('');
        expect(document.activeElement).toBe(parent);
        expect(treeItem('/home')).toBeTruthy();
        closePathEditor();
        await expect(promise).resolves.toBeNull();
    });

    it('submits the current trimmed manual draft immediately during a pending Reveal', async () => {
        let resolveSlow;
        installBrowse((path) =>
            path === '/ws'
                ? response('/ws', '/', [])
                : new Promise((resolve) => (resolveSlow = resolve)),
        );
        const opener = document.createElement('button');
        document.body.appendChild(opener);
        opener.focus();
        const promise = openPathEditor();
        await waitForTreeItem('/ws');
        setPathDraft('  ./manual  ');
        revealPath();
        await vi.waitFor(() => expect(resolveSlow).toBeTypeOf('function'));
        const oldHost = treeHost();
        document.querySelector('.config-editor-footer .btn-accent').click();
        await expect(promise).resolves.toEqual({ dir: './manual' });
        expect(document.activeElement).toBe(opener);

        resolveSlow(response('/ws/manual', '/ws', []));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(oldHost.childElementCount).toBe(0);
        expect(document.querySelector('.config-editor-overlay')).toBeNull();
    });

    it('blocks required-empty submission and preserves a manual literal tilde on Add', async () => {
        const fetchMock = installBrowse((path) => response(path, '/', []));
        const promise = openFields([
            {
                id: 'dir',
                label: 'Directory path',
                required: true,
                path: { startPath: '/ws' },
            },
        ]);
        await waitForTreeItem('/ws');
        document.querySelector('.config-editor-footer .btn-accent').click();
        expect(await settleOr(promise, 40)).toBe('__timeout__');
        expect(document.querySelector('.config-editor-overlay')).toBeTruthy();

        setPathDraft('  ~  ');
        document.querySelector('.config-editor-footer .btn-accent').click();
        await expect(promise).resolves.toEqual({ dir: '~' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each(['Cancel', 'Close', 'Escape'])(
        '%s destroys the controller, releases listeners, and ignores pending responses',
        async (action) => {
            let resolveSlow;
            const fetchMock = installBrowse((path) =>
                path === '/ws'
                    ? response('/ws', '/', [])
                    : new Promise((resolve) => (resolveSlow = resolve)),
            );
            const opener = document.createElement('button');
            document.body.appendChild(opener);
            opener.focus();
            const addListener = vi.spyOn(document, 'addEventListener');
            const removeListener = vi.spyOn(document, 'removeEventListener');
            const promise = openPathEditor();
            await waitForTreeItem('/ws');
            const input = pathInput();
            const host = treeHost();
            const status = pathStatus();
            setPathDraft('/slow');
            revealPath();
            await vi.waitFor(() => expect(resolveSlow).toBeTypeOf('function'));

            const keydownRegistration = addListener.mock.calls
                .filter(([type]) => type === 'keydown')
                .at(-1);
            const focusinRegistration = addListener.mock.calls
                .filter(([type]) => type === 'focusin')
                .at(-1);
            expect(keydownRegistration[2]).toBe(true);
            expect(focusinRegistration[2]).toBe(true);

            if (action === 'Cancel') {
                document
                    .querySelector(
                        '.config-editor-footer .btn:not(.btn-accent)',
                    )
                    .click();
            } else if (action === 'Close') {
                closePathEditor();
            } else {
                const outsideKeydown = vi.fn();
                window.addEventListener('keydown', outsideKeydown);
                const escapeEvent = new KeyboardEvent('keydown', {
                    key: 'Escape',
                    bubbles: true,
                    cancelable: true,
                });
                input.dispatchEvent(escapeEvent);
                expect(escapeEvent.defaultPrevented).toBe(true);
                expect(outsideKeydown).not.toHaveBeenCalled();
                window.removeEventListener('keydown', outsideKeydown);
            }
            await expect(promise).resolves.toBeNull();
            expect(host.childElementCount).toBe(0);
            expect(opener).toBe(document.activeElement);
            expect(removeListener).toHaveBeenCalledWith(
                'keydown',
                keydownRegistration[1],
                true,
            );
            expect(removeListener).toHaveBeenCalledWith(
                'focusin',
                focusinRegistration[1],
                true,
            );

            const laterFocus = document.createElement('button');
            document.body.appendChild(laterFocus);
            laterFocus.focus();
            resolveSlow(response('/slow', '/', []));
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(input.value).toBe('/slow');
            expect(status.textContent).toBe('');
            expect(document.activeElement).toBe(laterFocus);
            expect(host.childElementCount).toBe(0);
            expect(fetchMock).toHaveBeenCalledTimes(2);
        },
    );

    it('replaces an existing editor through Close and restores the opener after the new editor closes', async () => {
        installBrowse((path) => response(path, '/', []));
        const opener = document.createElement('button');
        document.body.appendChild(opener);
        opener.focus();
        const oldPromise = openPathEditor({ startPath: '/old' });
        await waitForTreeItem('/old');
        const oldHost = treeHost();

        const newPromise = openPathEditor({ startPath: '/new' });
        await expect(oldPromise).resolves.toBeNull();
        expect(
            document.querySelectorAll('.config-editor-overlay'),
        ).toHaveLength(1);
        await waitForTreeItem('/new');
        expect(oldHost.childElementCount).toBe(0);
        await vi.waitFor(() =>
            expect(document.activeElement).toBe(pathInput()),
        );

        closePathEditor();
        await expect(newPromise).resolves.toBeNull();
        expect(document.activeElement).toBe(opener);
    });

    it('does not reopen or focus an editor from its opening frame after cleanup', async () => {
        const frames = [];
        vi.stubGlobal('requestAnimationFrame', (callback) => {
            frames.push(callback);
            return frames.length;
        });
        installBrowse((path) => response(path, '/', []));
        const opener = document.createElement('button');
        document.body.appendChild(opener);
        opener.focus();
        const promise = openPathEditor();
        const oldInput = pathInput();
        const oldHost = treeHost();
        closePathEditor();
        await expect(promise).resolves.toBeNull();
        const laterFocus = document.createElement('button');
        document.body.appendChild(laterFocus);
        laterFocus.focus();
        for (const callback of frames) callback(0);

        expect(document.querySelector('.config-editor-overlay')).toBeNull();
        expect(oldHost.childElementCount).toBe(0);
        expect(document.activeElement).toBe(laterFocus);
        expect(oldInput.isConnected).toBe(false);
    });

    it('contains Tab focus, excludes hidden/disabled tree controls, and restores the opener', async () => {
        installBrowse((path) =>
            path === '/ws'
                ? response('/ws', '', [{ name: 'branch', path: '/ws/branch' }])
                : response(path, '/', []),
        );
        const opener = document.createElement('button');
        document.body.appendChild(opener);
        opener.focus();
        const promise = openPathEditor();
        await waitForTreeItem('/ws/branch');
        const modal = document.querySelector('.config-editor-path-modal');
        await vi.waitFor(() =>
            expect(
                document
                    .querySelector('.config-editor-overlay')
                    .classList.contains('hidden'),
            ).toBe(false),
        );
        const close = modal.querySelector('.modal-close-btn');
        const submit = modal.querySelector('.config-editor-footer .btn-accent');
        const hiddenRetry = treeItem('/ws/branch').querySelector(
            '.directory-tree-retry',
        );
        const up = modal.querySelector('.directory-tree-up');
        expect(hiddenRetry.hidden).toBe(true);
        expect(
            treeItem('/ws/branch').querySelector(
                '.directory-tree-group[hidden]',
            ),
        ).toBeTruthy();
        expect(up.disabled).toBe(true);

        close.focus();
        const backwards = new KeyboardEvent('keydown', {
            key: 'Tab',
            shiftKey: true,
            bubbles: true,
            cancelable: true,
        });
        close.dispatchEvent(backwards);
        expect(backwards.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(submit);
        const forwards = new KeyboardEvent('keydown', {
            key: 'Tab',
            bubbles: true,
            cancelable: true,
        });
        submit.dispatchEvent(forwards);
        expect(forwards.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(close);

        const app = readFileSync('web/app.js', 'utf8');
        expect(app).toContain('!element.disabled');
        expect(app).toContain('!element.hidden');
        expect(app).toContain("!element.closest('[hidden], .hidden')");
        hiddenRetry.focus();
        if (document.activeElement === hiddenRetry) {
            const hiddenTab = new KeyboardEvent('keydown', {
                key: 'Tab',
                bubbles: true,
                cancelable: true,
            });
            hiddenRetry.dispatchEvent(hiddenTab);
            expect(hiddenTab.defaultPrevented).toBe(true);
            expect(document.activeElement).toBe(close);
        }

        const outside = document.createElement('button');
        document.body.appendChild(outside);
        outside.focus();
        expect(document.activeElement).toBe(pathInput());
        closePathEditor();
        await expect(promise).resolves.toBeNull();
        expect(document.activeElement).toBe(opener);
        outside.focus();
        expect(document.activeElement).toBe(outside);
    });

    it('does not intercept IME Enter or native clipboard shortcuts', async () => {
        const fetchMock = installBrowse((path) =>
            path === '/ws'
                ? response('/ws', '/', [])
                : response('/revealed target', '/', []),
        );
        const promise = openPathEditor();
        await waitForTreeItem('/ws');
        setPathDraft('/target');
        pathInput().dispatchEvent(
            new Event('compositionstart', { bubbles: true }),
        );
        const imeEnter = new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        });
        pathInput().dispatchEvent(imeEnter);
        expect(imeEnter.defaultPrevented).toBe(false);
        const legacyImeEnter = new KeyboardEvent('keydown', {
            key: 'Enter',
            keyCode: 229,
            bubbles: true,
            cancelable: true,
        });
        pathInput().dispatchEvent(legacyImeEnter);
        expect(legacyImeEnter.defaultPrevented).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);

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
        const enter = new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        });
        pathInput().dispatchEvent(enter);
        expect(enter.defaultPrevented).toBe(true);
        await vi.waitFor(() =>
            expect(pathInput().value).toBe('/revealed target'),
        );
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(document.querySelector('.config-editor-overlay')).toBeTruthy();
        closePathEditor();
        await expect(promise).resolves.toBeNull();
    });

    it('keeps ordinary label typography away from directory-tree spans', () => {
        const css = readFileSync('web/style.css', 'utf8');
        expect(css).toContain('.config-editor-field > span,');
        expect(css).toContain('.config-editor-path-label');
        expect(css).not.toContain('.config-editor-field span {');
        expect(css).toContain('.config-editor-path-field');
        expect(css).toContain('.config-editor-path-row');
        expect(css).toContain('.config-editor-path-status');
        expect(css).toContain('.config-editor-path-tree');
        expect(css).toContain('width: min(600px, calc(100vw - 24px))');
    });
});
