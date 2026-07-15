// @vitest-environment jsdom
//
// AppLike surface smoke test.
//
// The 7 TS-converted modules consume the App class through a hand-rolled
// AppLike interface in web-src/types.d.ts. Nested manager handles
// (tabManager, sessionsManager, diffController, ...) are typed as `any`
// inside that interface, so a typo like `tabManager.swicthTab` (vs
// `switchTab`) compiles silently and only fails at runtime.
//
// This test imports the REAL converted manager classes (from their
// emitted web/*.js) and asserts that every method/field name the
// converted modules call exists on a freshly-constructed instance.
// If a manager loses/renames one, this test fails at CI time and we
// hear about it before any user does.
//
// Test budget: ~70 lines. Runs in <100ms (single instantiation per
// class + own-property checks). The smoke stays valid until
// terminal.js / app.js convert; once they do, the test continues
// working as a no-op safety net.

import { describe, it, expect, beforeAll } from 'vitest';
import { TabManager } from '../web/terminal.js';
import { SessionsManager } from '../web/sessions.js';
import { DiffController } from '../web/diff.js';
import { MarkdownManager } from '../web/markdown.js';
import { SyncManager } from '../web/sync.js';
import { KanbanManager } from '../web/kanban.js';
// App is imported dynamically because app.js's module evaluation
// calls window.addEventListener('DOMContentLoaded', ...) which jsdom
// fires synchronously, then the listener calls new App() and crashes
// against an under-populated jsdom. Dynamic import defers the
// evaluation past this test's stub phase.
let App;

// Minimum-DOM stub: enough IDs / elements to satisfy the constructors
// without throwing. The managers do `document.getElementById(...)` for a
// few setup anchors; jsdom returns null for ones we don't add. Where
// the constructor then dereferences the result without guarding
// (rare - we previously fixed all of these as `!` non-null asserts in
// the converted .ts sources), the smoke would crash and that's a
// real bug to know about.
function stubDom() {
    const ids = [
        // Terminal scaffolding (large list because TabManager attaches
        // listeners to many elements during construction)
        'tabs-container', 'tab-overflow-btn', 'tab-overflow-dropdown',
        'close-all-tabs-btn', 'reconnect-all-tabs-btn', 'refresh-console-btn',
        'mobile-close-all-tabs-btn', 'mobile-reconnect-all-tabs-btn',
        'mobile-refresh-console-btn', 'empty-state', 'cancel-input-btn',
        'copy-input-btn', 'direct-mode-toggle', 'input-bar-container',
        'input-textarea', 'presets-container', 'quick-commands-dropup',
        'model-presets-dropup', 'slash-presets-dropup', 'disconnect-banner',
        'ctrl-t-btn', 'terminals-wrapper', 'hostname-display',
        'empty-state-hostname', 'hostname-tabs-dropdown',
        // Sessions
        'session-list', 'new-session-btn', 'workspace-select',
        'add-workspace-btn', 'remove-workspace-btn', 'ws-modal',
        'ws-modal-close', 'ws-modal-input', 'ws-modal-suggestions',
        'ws-modal-cancel-btn', 'ws-modal-add-btn',
        // Diff
        'diff-panel', 'header-diff-toggle-btn', 'close-diff-btn',
        'refresh-diff-btn', 'diff-term-container', 'diff-action-bar',
        'rich-diff-btn', 'diff-modal', 'diff-modal-close',
        'diff-modal-body', 'diff-context-toggle-btn',
        'diff-layout-toggle-btn', 'diff-commit-select',
        // Markdown / help / changelog / restart
        'markdown-file-list', 'md-modal', 'md-modal-title',
        'md-modal-body', 'md-modal-close', 'md-modal-copy-btn',
        'restart-modal', 'restart-modal-close', 'restart-modal-cancel',
        'restart-modal-confirm', 'pi-help-btn', 'phi-changelog-btn',
        'phi-restart-btn',
        // Sync
        'sync-panel', 'sync-coordinator-input', 'sync-add-btn',
        'sync-form-container', 'sync-form-key', 'sync-form-value',
        'sync-form-cancel', 'sync-form-submit', 'sync-messages-list',
        // Misc
        'empty-workspace-path', 'pi-shortcut-send-btn', 'send-input-btn',
    ];
    for (const id of ids) {
        if (!document.getElementById(id)) {
            const el = document.createElement('div');
            el.id = id;
            document.body.appendChild(el);
        }
    }
}

function stubApp() {
    // Bare minimum AppLike surface — every method/field we exercise.
    // We return `this` from methods so the managers can chain if they want.
    const tabManager = {
        tabs: new Map(),
        createTab() { return null; },
        switchTab() {},
        getActiveTab() { return null; },
        sendInput() {},
        copyTextRobustly() {},
        adjustInputHeight() {},
        renderPresets() {},
        fitActiveTerminal() {},
        _spamScrollToBottom() {},
        inputTextArea: { value: '', focus() {}, select() {} },
        lastInputValue: '',
    };
    return {
        showToast() {},
        applyAccentTheme() {},
        setTerminalActivity() {},
        accentColorSelect: { value: '' },
        tabManager,
        sessionsManager: {
            activeCWD: '',
            activeWorkspace: '',
            config: {},
            loadConfig: async () => {},
            loadSessions: async () => {},
            loadWorktrees: async () => {},
        },
        diffController: {
            refreshDiff: () => {},
            isPanelOpen: true,
            activeTab: 'markdown',
        },
        markdownManager: { refreshFiles: () => {} },
        syncManager: { refreshMessages: async () => {} },
        markdownDirs: [],
        modelPresets: {},
        quickCommands: [],
        terminalCommands: [],
        useExistingTerminalTab: false,
        updateStatus: null,
        hostname: '',
        openConfigEditor: async () => null,
        importCmdsConfig: async () => {},
        exportTerminalCommandsConfig: () => {},
    };
}

let app;
beforeAll(async () => {
    stubDom();
    app = stubApp();
    // Lazy import for App - importing at module top crashes jsdom via
    // the DOMContentLoaded handler in web/app.js line 1537.
    const m = await import('../web/app.js');
    App = m.App;
});

// Each entry is { cls, name, kind: 'method' | 'field' }. Fields are
// checked by instantiating the manager with the stub app and reading
// the resulting instance.
const expectations = [
    { cls: 'TabManager', newFn: () => new TabManager(app),
      method: ['switchTab', 'createTab', 'getActiveTab', 'sendInput',
               'copyTextRobustly', 'adjustInputHeight', 'renderPresets',
               'fitActiveTerminal', '_spamScrollToBottom'],
      field:  ['tabs', 'inputTextArea', 'lastInputValue'] },
    { cls: 'SessionsManager', newFn: () => new SessionsManager(app),
      method: ['loadConfig', 'loadSessions', 'loadWorktrees'],
      field:  ['activeCWD', 'activeWorkspace', 'config'] },
    { cls: 'DiffController', newFn: () => new DiffController(app),
      method: ['refreshDiff'],
      field:  ['isPanelOpen', 'activeTab'] },
    { cls: 'MarkdownManager', newFn: () => new MarkdownManager(app),
      method: ['refreshFiles'],
      field:  [] },
    { cls: 'SyncManager', newFn: () => new SyncManager(app),
      method: ['refreshMessages'],
      field:  [] },
    { cls: 'KanbanManager', newFn: () => new KanbanManager(app),
      method: [],
      field:  [] },
];

// App itself is in web/app.js (still JS). We don't instantiate it
// (the constructor runs DOMContentLoaded and full bootstrap) but we
// can read its prototype. The 5 converted modules call these methods
// on the App class; if any get renamed, runtime breaks silently.
const appExpectations = [
    { name: 'showToast', kind: 'method' },
    { name: 'applyAccentTheme', kind: 'method' },
    { name: 'setTerminalActivity', kind: 'method' },
    { name: 'openConfigEditor', kind: 'method' },
    { name: 'exportTerminalCommandsConfig', kind: 'method' },
    { name: 'importCmdsConfig', kind: 'method' },
];

describe('manager surface smoke', () => {
    for (const { cls, newFn, method, field } of expectations) {
        for (const name of method) {
            it(`${cls}.prototype.${name} is a function`, () => {
                expect(typeof newFn()[name]).toBe('function');
            });
        }
        for (const name of field) {
            it(`${cls} instance has ${name} field`, () => {
                expect(name in newFn()).toBe(true);
            });
        }
    }

    // App prototype checks via Class.prototype (no instantiation).
    // Note: this only verifies the methods exist on the class
    // definition - instance-level state changes (e.g., showToast
    // bound in the bootstrap) are covered by the playwright/manual
    // smoke flow.
    for (const { name, kind } of appExpectations) {
        it(`App.${name} exists (${kind})`, () => {
            if (kind === 'method') {
                expect(typeof App.prototype[name]).toBe('function');
            } else {
                expect(name in App.prototype).toBe(true);
            }
        });
    }
});
