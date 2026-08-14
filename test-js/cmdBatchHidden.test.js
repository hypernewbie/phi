// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';

describe('cmd panel hidden terminal and batch worktree actions', () => {
    setupDomHarness();

    let cmdPanelEl;
    let fakeApp;
    let fakeController;

    beforeEach(() => {
        cmdPanelEl = document.createElement('div');
        cmdPanelEl.id = 'cmd-panel';
        document.body.appendChild(cmdPanelEl);

        const inputTextArea = document.createElement('textarea');
        inputTextArea.value = '';
        inputTextArea.focus = vi.fn();

        fakeApp = {
            useExistingTerminalTab: true,
            useHiddenTerminal: false,
            terminalCommands: [
                { name: 'commit', command: 'git commit -m "update"' },
                { name: 'test', command: 'npm test' },
            ],
            tabManager: {
                inputTextArea,
                lastInputValue: '',
                tabs: new Map(),
                getActiveTab: () => null,
                switchTab: vi.fn(),
                sendInput: vi.fn(),
                adjustInputHeight: vi.fn(),
                _spamScrollToBottom: vi.fn(),
                createTab: vi.fn(),
            },
            sessionsManager: {
                activeWorkspace: '/repo',
                activeCWD: '/repo/wt1',
                loadWorktrees: vi.fn(),
                loadConfig: vi.fn(),
            },
            showToast: vi.fn(),
        };

        fakeController = {
            app: fakeApp,
            activeBatchResults: null,
        };
    });

    it('renders hidden terminal toggle and reuse toggle', async () => {
        const mod = await import('../web/diff.js');
        mod.DiffController.prototype.renderCmdPanel.call(fakeController);

        const hiddenToggle = document.getElementById('use-hidden-terminal-toggle');
        const reuseToggle = document.getElementById('use-existing-terminal-tab-toggle');

        expect(hiddenToggle).not.toBeNull();
        expect(reuseToggle).not.toBeNull();
        expect(hiddenToggle.checked).toBe(false);
        expect(reuseToggle.checked).toBe(true);
        expect(reuseToggle.disabled).toBe(false);
    });

    it('disables reuse toggle when hidden terminal toggle is on', async () => {
        fakeApp.useHiddenTerminal = true;
        const mod = await import('../web/diff.js');
        mod.DiffController.prototype.renderCmdPanel.call(fakeController);

        const hiddenToggle = document.getElementById('use-hidden-terminal-toggle');
        const reuseToggle = document.getElementById('use-existing-terminal-tab-toggle');

        expect(hiddenToggle.checked).toBe(true);
        expect(reuseToggle.disabled).toBe(true);
        expect(reuseToggle.parentElement.classList.contains('disabled')).toBe(true);
    });

    it('renders current, dirty, and all buttons for each command', async () => {
        const mod = await import('../web/diff.js');
        mod.DiffController.prototype.renderCmdPanel.call(fakeController);

        const runBtns = cmdPanelEl.querySelectorAll('.cmd-run-btn');
        const dirtyBtns = cmdPanelEl.querySelectorAll('.cmd-dirty-btn');
        const allBtns = cmdPanelEl.querySelectorAll('.cmd-all-btn');

        expect(runBtns.length).toBe(2);
        expect(dirtyBtns.length).toBe(2);
        expect(allBtns.length).toBe(2);
        expect(runBtns[0].textContent).toContain('commit');
        expect(dirtyBtns[0].textContent).toContain('Dirty');
        expect(allBtns[0].textContent).toContain('All');
    });

    it('clicking dirty button queries dirty worktrees and executes batch run', async () => {
        const fetchSpy = mockFetch((url) => {
            if (url.includes('/api/git/worktrees')) {
                return [{ path: '/repo/wt1' }, { path: '/repo/wt2' }, { path: '/repo/wt3' }];
            }
            if (url.includes('/api/git/worktree-dirty')) {
                return { '/repo/wt1': true, '/repo/wt2': false, '/repo/wt3': true };
            }
            if (url.includes('/api/cmd/batch-run')) {
                return {
                    results: [
                        { worktree: '/repo/wt1', success: true, exit_code: 0, output: 'committed 1', duration_ms: 100 },
                        { worktree: '/repo/wt3', success: true, exit_code: 0, output: 'committed 3', duration_ms: 150 },
                    ]
                };
            }
            return {};
        });

        const mod = await import('../web/diff.js');
        fakeController.executeHiddenBatch = mod.DiffController.prototype.executeHiddenBatch;
        fakeController.renderCmdPanel = vi.fn();

        await mod.DiffController.prototype.runCommand.call(fakeController, fakeApp.terminalCommands[0], 'dirty');

        const batchCalls = fetchSpy.mock.calls.filter(c => c[0].includes('/api/cmd/batch-run'));
        expect(batchCalls.length).toBe(1);
        const payload = JSON.parse(batchCalls[0][1].body);
        expect(payload.worktrees).toEqual(['/repo/wt1', '/repo/wt3']);
        expect(payload.command).toBe('git commit -m "update"');
        expect(fakeApp.showToast).toHaveBeenCalledWith(
            expect.stringContaining('Completed "commit" across 2 worktree(s)'),
            expect.objectContaining({ type: 'success' })
        );
    });

    it('clicking all button runs batch across all worktrees', async () => {
        const fetchSpy = mockFetch((url) => {
            if (url.includes('/api/git/worktrees')) {
                return [{ path: '/repo/wt1' }, { path: '/repo/wt2' }];
            }
            if (url.includes('/api/cmd/batch-run')) {
                return {
                    results: [
                        { worktree: '/repo/wt1', success: true, exit_code: 0, duration_ms: 50 },
                        { worktree: '/repo/wt2', success: true, exit_code: 0, duration_ms: 60 },
                    ]
                };
            }
            return {};
        });

        const mod = await import('../web/diff.js');
        fakeController.executeHiddenBatch = mod.DiffController.prototype.executeHiddenBatch;
        fakeController.renderCmdPanel = vi.fn();

        await mod.DiffController.prototype.runCommand.call(fakeController, fakeApp.terminalCommands[1], 'all');

        const batchCalls = fetchSpy.mock.calls.filter(c => c[0].includes('/api/cmd/batch-run'));
        expect(batchCalls.length).toBe(1);
        const payload = JSON.parse(batchCalls[0][1].body);
        expect(payload.worktrees).toEqual(['/repo/wt1', '/repo/wt2']);
        expect(payload.command).toBe('npm test');
    });

    it('running current with useHiddenTerminal routes to executeHiddenBatch with activeCWD', async () => {
        fakeApp.useHiddenTerminal = true;
        const fetchSpy = mockFetch((url) => {
            if (url.includes('/api/cmd/batch-run')) {
                return {
                    results: [
                        { worktree: '/repo/wt1', success: true, exit_code: 0, output: 'ok', duration_ms: 80 }
                    ]
                };
            }
            return {};
        });

        const mod = await import('../web/diff.js');
        fakeController.executeHiddenBatch = mod.DiffController.prototype.executeHiddenBatch;
        fakeController.renderCmdPanel = vi.fn();

        await mod.DiffController.prototype.runCommand.call(fakeController, fakeApp.terminalCommands[0], 'current');

        const batchCalls = fetchSpy.mock.calls.filter(c => c[0].includes('/api/cmd/batch-run'));
        expect(batchCalls.length).toBe(1);
        const payload = JSON.parse(batchCalls[0][1].body);
        expect(payload.worktrees).toEqual(['/repo/wt1']);
    });

    it('renders batch results in cmd panel when activeBatchResults is present', async () => {
        fakeController.activeBatchResults = {
            commandName: 'commit',
            scopeLabel: 'Dirty Worktrees (2)',
            worktrees: [
                { path: '/repo/wt1', name: 'wt1', glyph: '◆', status: 'success', exitCode: 0, durationMs: 120, output: '1 file changed' },
                { path: '/repo/wt2', name: 'wt2', glyph: '◇', status: 'error', exitCode: 1, durationMs: 90, error: 'failed' },
            ]
        };

        const mod = await import('../web/diff.js');
        mod.DiffController.prototype.renderCmdPanel.call(fakeController);

        const resultsCard = cmdPanelEl.querySelector('.cmd-batch-results');
        expect(resultsCard).not.toBeNull();
        expect(resultsCard.textContent).toContain('commit');
        expect(resultsCard.textContent).toContain('Dirty Worktrees (2)');

        const badges = resultsCard.querySelectorAll('.cmd-batch-badge');
        expect(badges.length).toBe(2);
        expect(badges[0].classList.contains('success')).toBe(true);
        expect(badges[0].textContent).toContain('120ms');
        expect(badges[1].classList.contains('error')).toBe(true);
        expect(badges[1].textContent).toContain('exit 1');
    });
});
