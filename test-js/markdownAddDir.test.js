// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { App } from '../web/app.js';
import { MarkdownManager } from '../web/markdown.js';

setupDomHarness();

afterEach(() => {
    document
        .querySelectorAll('.config-editor-overlay .modal-close-btn')
        .forEach((button) => {
            button.click();
        });
});

function makeManager(app) {
    const manager = Object.create(MarkdownManager.prototype);
    manager.app = app;
    manager.refreshFiles = vi.fn(async () => {});
    return manager;
}

const markdownDirPosts = (fetchMock) =>
    fetchMock.mock.calls.filter(
        ([url, options]) =>
            url === '/api/config/markdown-dirs' && options?.method === 'POST',
    );

const editorPath = (options) => options.fields[0].path;

function makeEditorApp(result, sessionsManager = {}) {
    return {
        openConfigEditor: vi.fn().mockResolvedValue(result),
        sessionsManager,
    };
}

function response(path, parent, entries = []) {
    return { path, parent, entries, truncated: false };
}

describe('_promptAddDir', () => {
    let fetchMock;

    beforeEach(() => {
        fetchMock = mockFetch();
    });

    it('captures a nonempty active cwd once before opening the editor and keeps that base', async () => {
        let cwd = '/workspace';
        let cwdReads = 0;
        let resolveEditor;
        const sessionsManager = {
            get activeCWD() {
                cwdReads++;
                return cwd;
            },
            loadConfig: vi.fn().mockResolvedValue(undefined),
        };
        const editorResult = new Promise((resolve) => {
            resolveEditor = resolve;
        });
        const app = {
            sessionsManager,
            openConfigEditor: vi.fn((options) => {
                expect(cwdReads).toBe(1);
                expect(options.subtitle).toBe(
                    'Relative to workspace or absolute, for example ./docs',
                );
                expect(options.fields[0].id).toBe('dir');
                expect(options.fields[0].placeholder).toBe(
                    './docs or /absolute/path',
                );
                expect(options.submitLabel).toBe('Add');
                expect(editorPath(options)).toEqual({
                    startPath: '/workspace',
                    relativeTo: '/workspace',
                });
                return editorResult;
            }),
        };
        const manager = makeManager(app);
        const pending = manager._promptAddDir();

        expect(app.openConfigEditor).toHaveBeenCalledTimes(1);
        cwd = '/workspace/changed';
        resolveEditor(null);
        await pending;

        expect(cwdReads).toBe(1);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('starts at home and omits relativeTo when the session manager is missing', async () => {
        const app = { openConfigEditor: vi.fn().mockResolvedValue(null) };
        expect('sessionsManager' in app).toBe(false);
        const manager = makeManager(app);

        await manager._promptAddDir();

        expect(editorPath(app.openConfigEditor.mock.calls[0][0])).toEqual({
            startPath: '~',
        });
        expect(
            'relativeTo' in editorPath(app.openConfigEditor.mock.calls[0][0]),
        ).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
        ['missing cwd', {}],
        ['empty cwd', { activeCWD: '' }],
    ])(
        'starts at home and omits relativeTo with a %s',
        async (_label, sessionsManager) => {
            const app = makeEditorApp(null, sessionsManager);
            const manager = makeManager(app);

            await manager._promptAddDir();

            expect(editorPath(app.openConfigEditor.mock.calls[0][0])).toEqual({
                startPath: '~',
            });
            expect(
                'relativeTo' in
                    editorPath(app.openConfigEditor.mock.calls[0][0]),
            ).toBe(false);
            expect(fetchMock).not.toHaveBeenCalled();
        },
    );

    it.each([
        ['cancel', null],
        ['missing result', undefined],
        ['null field', { dir: null }],
        ['empty field', { dir: '' }],
        ['whitespace-only field', { dir: ' \t\n ' }],
    ])('does not POST a %s result', async (_label, result) => {
        const loadConfig = vi.fn().mockResolvedValue(undefined);
        const app = makeEditorApp(result, {
            activeCWD: '/workspace',
            loadConfig,
        });
        const manager = makeManager(app);

        await manager._promptAddDir();

        expect(markdownDirPosts(fetchMock)).toHaveLength(0);
        expect(loadConfig).not.toHaveBeenCalled();
        expect(manager.refreshFiles).not.toHaveBeenCalled();
    });

    it.each([
        ['current directory', '.', '.'],
        ['relative path', './docs', './docs'],
        ['outside absolute path', '/outside/docs', '/outside/docs'],
        ['parent-relative path', '../shared', '../shared'],
        ['literal tilde path', '~/docs', '~/docs'],
    ])(
        'POSTs the %s without extra conversion',
        async (_label, value, expected) => {
            const app = makeEditorApp(
                { dir: value },
                {
                    activeCWD: '/workspace',
                    loadConfig: vi.fn().mockResolvedValue(undefined),
                },
            );
            const manager = makeManager(app);

            await manager._promptAddDir();

            expect(markdownDirPosts(fetchMock)).toHaveLength(1);
            expect(JSON.parse(markdownDirPosts(fetchMock)[0][1].body)).toEqual({
                dir: expected,
            });
        },
    );

    it('POSTs before config reload and Markdown refresh', async () => {
        const events = [];
        fetchMock = mockFetch(() => {
            events.push('POST');
            return {};
        });
        const loadConfig = vi.fn(async () => {
            events.push('reload');
        });
        const app = makeEditorApp(
            { dir: './docs' },
            {
                activeCWD: '/workspace',
                loadConfig,
            },
        );
        const manager = makeManager(app);
        manager.refreshFiles = vi.fn(async () => {
            events.push('refresh');
        });

        await manager._promptAddDir();

        expect(events).toEqual(['POST', 'reload', 'refresh']);
        expect(loadConfig).toHaveBeenCalledTimes(1);
        expect(manager.refreshFiles).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['missing app', undefined, './docs'],
        ['missing app absolute path', undefined, '/outside/docs'],
        ['missing manager', {}, '../shared'],
        ['missing manager absolute path', {}, '/outside/docs'],
    ])('uses the fallback prompt with a %s', async (_label, app, value) => {
        const prompt = vi.fn(() => value);
        const consoleError = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});
        vi.stubGlobal('prompt', prompt);
        const manager = makeManager(app);

        await manager._promptAddDir();

        expect(prompt).toHaveBeenCalledTimes(1);
        expect(prompt.mock.calls[0][0]).toContain(
            'relative to workspace or absolute',
        );
        expect(prompt.mock.calls[0][0]).not.toMatch(/~/u);
        expect(markdownDirPosts(fetchMock)).toHaveLength(1);
        expect(JSON.parse(markdownDirPosts(fetchMock)[0][1].body)).toEqual({
            dir: value,
        });
        expect(consoleError).toHaveBeenCalledTimes(1);
    });

    it.each([null, '', ' \t '])(
        'does not POST when the fallback prompt returns %j',
        async (value) => {
            const prompt = vi.fn(() => value);
            vi.stubGlobal('prompt', prompt);
            const manager = makeManager(undefined);

            await manager._promptAddDir();

            expect(prompt.mock.calls[0][0]).toContain(
                'relative to workspace or absolute',
            );
            expect(markdownDirPosts(fetchMock)).toHaveLength(0);
        },
    );

    it('selects from the real embedded tree without POSTing until explicit Add', async () => {
        fetchMock = mockFetch((url) => {
            if (url === '/api/config/markdown-dirs') return {};
            const path = new URL(url, 'http://localhost').searchParams.get(
                'path',
            );
            return path === '/workspace'
                ? response('/workspace', '/', [
                      { name: 'docs', path: '/workspace/docs' },
                  ])
                : response(path, '/workspace', []);
        });
        const loadConfig = vi.fn().mockResolvedValue(undefined);
        const sessionsManager = { activeCWD: '/workspace', loadConfig };
        const app = { sessionsManager };
        app.openConfigEditor = vi.fn((options) =>
            App.prototype.openConfigEditor.call(app, options),
        );
        const manager = makeManager(app);
        const pending = manager._promptAddDir();

        await vi.waitFor(() =>
            expect(
                [
                    ...document.querySelectorAll(
                        '.config-editor-path-tree [role="treeitem"]',
                    ),
                ].find((item) => item.dataset.path === '/workspace/docs'),
            ).toBeTruthy(),
        );
        const selectedRow = [
            ...document.querySelectorAll(
                '.config-editor-path-tree [role="treeitem"]',
            ),
        ].find((item) => item.dataset.path === '/workspace/docs');
        selectedRow.querySelector('.directory-tree-name').click();

        expect(document.getElementById('config-editor-dir').value).toBe(
            './docs',
        );
        expect(markdownDirPosts(fetchMock)).toHaveLength(0);
        expect(document.querySelector('.config-editor-overlay')).toBeTruthy();

        document.querySelector('.config-editor-footer .btn-accent').click();
        await pending;

        expect(markdownDirPosts(fetchMock)).toHaveLength(1);
        expect(JSON.parse(markdownDirPosts(fetchMock)[0][1].body)).toEqual({
            dir: './docs',
        });
        expect(loadConfig).toHaveBeenCalledTimes(1);
        expect(manager.refreshFiles).toHaveBeenCalledTimes(1);
    });
});
