// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

// Tests the consume-before-switch ordering fix in DiffController.runCommand:
// the command prefix is cleared from the textarea BEFORE any reuse-tab
// switch happens. With per-tab drafts (Milestone 1), switchTab parks
// whatever is currently in the textarea onto the outgoing tab and restores
// the incoming tab's own parked draft — so clearing the prefix AFTER the
// switch would park the (already-sent) prefix on the outgoing tab and then
// stomp the just-restored draft of the target tab.

function makeHarness({ prefix = 'my prefix' } = {}) {
    const inputTextArea = document.createElement('textarea');
    inputTextArea.value = prefix;
    inputTextArea.focus = vi.fn();
    // Alive shell target in the same cwd; non-shell active tab forces the
    // reuse-switch path (rules in findReusableShellTab, diff.ts:33).
    const activeTab = { paneId: 'A', coder: 'claude', isDead: false, cwd: '/ws', ws: {} };
    const shellTab = { paneId: 'S', coder: 'bash', isDead: false, cwd: '/ws', ws: {} };
    const valueAtSwitch = { seen: null };
    const tabManager = {
        inputTextArea,
        lastInputValue: prefix,
        tabs: new Map([['A', activeTab], ['S', shellTab]]),
        getActiveTab: () => activeTab,
        switchTab: vi.fn(() => { valueAtSwitch.seen = inputTextArea.value; }),
        sendInput: vi.fn(),
        adjustInputHeight: vi.fn(),
        _spamScrollToBottom: vi.fn(),
    };
    const fakeThis = {
        app: {
            tabManager,
            sessionsManager: { activeCWD: '/ws' },
            useExistingTerminalTab: true,
        },
    };
    return { fakeThis, tabManager, valueAtSwitch, shellTab };
}

describe('runCommand consume-before-switch ordering', () => {
    it('clears the draft before switching tabs', async () => {
        const { fakeThis, tabManager, valueAtSwitch } = makeHarness();
        const mod = await import('../web/diff.js');
        await mod.DiffController.prototype.runCommand.call(fakeThis, { command: 'git status' });

        expect(tabManager.switchTab).toHaveBeenCalledWith('S');
        expect(valueAtSwitch.seen).toBe('');
        expect(tabManager.lastInputValue).toBe('');
    });

    it('sends the combined command containing the consumed prefix', async () => {
        const { fakeThis, tabManager, shellTab } = makeHarness();
        const mod = await import('../web/diff.js');
        await mod.DiffController.prototype.runCommand.call(fakeThis, { command: 'git status' });

        expect(tabManager.sendInput).toHaveBeenCalled();
        const [sentTab, payload] = tabManager.sendInput.mock.calls[0];
        expect(sentTab).toBe(shellTab);
        expect(payload).toContain('my prefix git status');
    });

    it('does not clear the textarea after the switch', async () => {
        const { fakeThis, tabManager, valueAtSwitch } = makeHarness();
        const inputTextArea = tabManager.inputTextArea;
        tabManager.switchTab = vi.fn(() => {
            valueAtSwitch.seen = inputTextArea.value;
            inputTextArea.value = 'restored draft of S';   // simulate M1's restore
        });
        const mod = await import('../web/diff.js');
        await mod.DiffController.prototype.runCommand.call(fakeThis, { command: 'git status' });
        expect(valueAtSwitch.seen).toBe('');
        expect(inputTextArea.value).toBe('restored draft of S');
    });
});
