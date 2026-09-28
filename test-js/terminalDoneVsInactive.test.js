// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabManager, detectTerminalBufferState } from '../web/terminal.js';

function createMockBuffer(lines, cursorY = 0, cursorX = 0) {
    const lineObjects = lines.map((text) => ({
        translateToString: (trimRight = false) =>
            trimRight ? text.trimEnd() : text,
    }));
    return {
        active: {
            length: lineObjects.length,
            baseY: 0,
            cursorY: Math.min(cursorY, Math.max(0, lineObjects.length - 1)),
            cursorX,
            getLine: (idx) => lineObjects[idx] || null,
        },
    };
}

describe('detectTerminalBufferState — spinner vs prompt detection', () => {
    it('detects Braille spinner in Claude Code and AI coding agent TUIs', () => {
        const lines = [
            '╭─── Claude Code ────────────╮',
            '│ ⠋ Thinking… (12s · esc to interrupt) │',
            '╰────────────────────────────╯',
        ];
        const term = { buffer: createMockBuffer(lines, 1) };
        const state = detectTerminalBufferState(term);
        expect(state.hasSpinner).toBe(true);
        expect(state.hasPrompt).toBe(false);
    });

    it('detects Braille spinner in tool execution output', () => {
        const lines = [
            'Running automated test suite',
            '⠹ Running vitest on terminal suites...',
        ];
        const term = { buffer: createMockBuffer(lines, 1) };
        const state = detectTerminalBufferState(term);
        expect(state.hasSpinner).toBe(true);
        expect(state.hasPrompt).toBe(false);
    });

    it('detects geometric / circle / arrow spinners', () => {
        const lines = ['◐ Generating response from model...'];
        const term = { buffer: createMockBuffer(lines, 0) };
        const state = detectTerminalBufferState(term);
        expect(state.hasSpinner).toBe(true);
        expect(state.hasPrompt).toBe(false);
    });

    it('detects in-progress status keywords with ellipsis', () => {
        const lines = ['Compiling assets…'];
        const term = { buffer: createMockBuffer(lines, 0) };
        const state = detectTerminalBufferState(term);
        expect(state.hasSpinner).toBe(true);
        expect(state.hasPrompt).toBe(false);
    });

    it('detects interrupt / cancel running hints', () => {
        const lines = ['Fetching context (esc to cancel)'];
        const term = { buffer: createMockBuffer(lines, 0) };
        const state = detectTerminalBufferState(term);
        expect(state.hasSpinner).toBe(true);
        expect(state.hasPrompt).toBe(false);
    });

    it('detects interactive prompt in Claude Code box when completed', () => {
        const lines = [
            '╭─── Claude Code ────────────╮',
            '│ >                          │',
            '╰────────────────────────────╯',
        ];
        // Cursor is on line 1 at the prompt
        const term = { buffer: createMockBuffer(lines, 1, 4) };
        const state = detectTerminalBufferState(term);
        expect(state.hasSpinner).toBe(false);
        expect(state.hasPrompt).toBe(true);
    });

    it('detects interactive shell prompts', () => {
        const bashTerm = {
            buffer: createMockBuffer(['hypernewbie@studio:~/code/phi$ '], 0),
        };
        expect(detectTerminalBufferState(bashTerm).hasPrompt).toBe(true);

        const zshTerm = {
            buffer: createMockBuffer(['phi (main) ❯ '], 0),
        };
        expect(detectTerminalBufferState(zshTerm).hasPrompt).toBe(true);

        const plainTerm = {
            buffer: createMockBuffer(['> '], 0),
        };
        expect(detectTerminalBufferState(plainTerm).hasPrompt).toBe(true);
    });

    it('detects interactive agent prompts for pi, agy, opencode', () => {
        expect(
            detectTerminalBufferState({
                buffer: createMockBuffer(['pi> '], 0),
            }).hasPrompt,
        ).toBe(true);

        expect(
            detectTerminalBufferState({
                buffer: createMockBuffer(['agy> '], 0),
            }).hasPrompt,
        ).toBe(true);

        expect(
            detectTerminalBufferState({
                buffer: createMockBuffer(['opencode> '], 0),
            }).hasPrompt,
        ).toBe(true);
    });

    it('rejects box borders, dividers, and markdown quotes as prompts', () => {
        const boxTerm = {
            buffer: createMockBuffer(['╰────────────────────────────╯'], 0),
        };
        expect(detectTerminalBufferState(boxTerm).hasPrompt).toBe(false);

        const dividerTerm = {
            buffer: createMockBuffer(['---'], 0),
        };
        expect(detectTerminalBufferState(dividerTerm).hasPrompt).toBe(false);

        const quoteTerm = {
            buffer: createMockBuffer(
                ['> Here is a markdown quote with text following the arrow'],
                0,
            ),
        };
        expect(detectTerminalBufferState(quoteTerm).hasPrompt).toBe(false);
    });
});

describe('pollTerminalIdleAndNotifications — done vs inactive behavior', () => {
    let app;
    let manager;

    beforeEach(() => {
        vi.stubGlobal(
            'Audio',
            class {
                play() {
                    return Promise.resolve();
                }
            },
        );
        app = {
            showToast: vi.fn(),
            hostname: 'studio',
            setTerminalActivity: vi.fn(),
        };
        manager = {
            app,
            tabs: new Map(),
            activePaneId: 'tab-1',
            updateDocumentTitle: vi.fn(),
            syncBackendPin: vi.fn(),
            triggerAttentionNotification: vi.fn(),
            getActiveTab() {
                return this.tabs.get(this.activePaneId);
            },
        };
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('transitions busy tab to inactive/quiet without false done when app has a spinner', () => {
        const spinningLines = [
            '╭─── Claude Code ────────────╮',
            '│ ⠋ Thinking… (8s)           │',
            '╰────────────────────────────╯',
        ];
        const tabEl = document.createElement('div');
        const spinningTab = {
            paneId: 'tab-background',
            isBusy: true,
            lastOutputAt: Date.now() - 3500, // quiet for 3.5s
            busyStartTime: Date.now() - 12000,
            userTaskActive: true,
            coder: 'claude',
            tabEl,
            term: { buffer: createMockBuffer(spinningLines, 1) },
        };
        manager.tabs.set(spinningTab.paneId, spinningTab);

        TabManager.prototype.pollTerminalIdleAndNotifications.call(manager);

        // It transitions to inactive/quiet (isBusy: false) so title settles to Φ
        expect(spinningTab.isBusy).toBe(false);
        // BUT it must NOT trigger done/attention because the spinner is spinning!
        expect(spinningTab.isAttention).toBeFalsy();
        expect(tabEl.classList.contains('has-attention')).toBe(false);
        expect(manager.triggerAttentionNotification).not.toHaveBeenCalled();
        // userTaskActive remains true waiting for real completion
        expect(spinningTab.userTaskActive).toBe(true);
    });

    it('does NOT trigger done on long-inactive tabs waking up or receiving keepalive bytes', () => {
        const tabEl = document.createElement('div');
        const idleLines = ['hypernewbie@studio:~$ '];
        const inactiveTab = {
            paneId: 'tab-inactive',
            isBusy: true,
            lastOutputAt: Date.now() - 3500,
            busyStartTime: Date.now() - 3600000, // 1 hour ago!
            userTaskActive: false, // User NEVER asked it to do anything in this session!
            coder: 'pi',
            tabEl,
            term: { buffer: createMockBuffer(idleLines, 0) },
        };
        manager.tabs.set(inactiveTab.paneId, inactiveTab);

        TabManager.prototype.pollTerminalIdleAndNotifications.call(manager);

        // Transitions to quiet
        expect(inactiveTab.isBusy).toBe(false);
        // Does NOT fire false positive "Task Done"
        expect(inactiveTab.isAttention).toBeFalsy();
        expect(tabEl.classList.contains('has-attention')).toBe(false);
        expect(manager.triggerAttentionNotification).not.toHaveBeenCalled();
        expect(inactiveTab.busyStartTime).toBeNull();
    });

    it('triggers done/attention when an active task finishes at an interactive prompt', () => {
        const promptLines = ['Done writing the files and tests.', 'pi> '];
        const tabEl = document.createElement('div');
        const completedTab = {
            paneId: 'tab-background',
            isBusy: true,
            lastOutputAt: Date.now() - 3500,
            busyStartTime: Date.now() - 10000,
            userTaskActive: true, // User sent command!
            coder: 'pi',
            tabEl,
            term: { buffer: createMockBuffer(promptLines, 1) },
        };
        manager.tabs.set(completedTab.paneId, completedTab);

        TabManager.prototype.pollTerminalIdleAndNotifications.call(manager);

        expect(completedTab.isBusy).toBe(false);
        expect(completedTab.isAttention).toBe(true);
        expect(tabEl.classList.contains('has-attention')).toBe(true);
        expect(manager.triggerAttentionNotification).toHaveBeenCalledWith(
            completedTab,
            true,
        );
        expect(completedTab.userTaskActive).toBe(false);
    });

    it('does NOT trigger attention on the tab the user is actively focused on and viewing', () => {
        const promptLines = ['pi> '];
        const tabEl = document.createElement('div');
        const activeTab = {
            paneId: 'tab-1', // activePaneId is tab-1!
            isBusy: true,
            lastOutputAt: Date.now() - 3500,
            busyStartTime: Date.now() - 10000,
            userTaskActive: true,
            coder: 'pi',
            tabEl,
            term: { buffer: createMockBuffer(promptLines, 0) },
        };
        manager.tabs.set(activeTab.paneId, activeTab);

        TabManager.prototype.pollTerminalIdleAndNotifications.call(manager);

        expect(activeTab.isBusy).toBe(false);
        expect(activeTab.isAttention).toBeFalsy();
        expect(tabEl.classList.contains('has-attention')).toBe(false);
        expect(manager.triggerAttentionNotification).not.toHaveBeenCalled();
        expect(activeTab.userTaskActive).toBe(false);
    });
});
