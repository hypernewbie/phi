// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TabManager } from '../web/terminal.js';

const terminalJsSrc = readFileSync(
    path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        'web',
        'terminal.js',
    ),
    'utf8',
);

// F7 hardening: typing/clicking into a dead tab must never be a silent no-op.
// sendStagedInput/sendRawInput used to pre-check `activeTab.isDead` and
// `return` before sendInput()'s toast + reconnect overlay ever ran. Now they
// let sendInput() itself decide, and only run post-send side effects (clear
// draft, focus, clipboard sync) when the send actually succeeded.

function ctx(activeTab) {
    const c = Object.create(TabManager.prototype);
    c.app = { showToast: vi.fn(), syncRemoteClipboard: vi.fn() };
    c.getActiveTab = vi.fn(() => activeTab);
    c.adjustInputHeight = vi.fn();
    c._spamScrollToBottom = vi.fn();
    c._showReconnectOverlay = vi.fn();
    c.focusActiveTerminal = vi.fn();
    // sendStagedInput now reads stagedAttachments and the attachment
    // strip; both default to empty in the no-attachment path.
    c.stagedAttachments = [];
    c.attachmentStrip = { classList: { add: vi.fn(), remove: vi.fn() } };
    return c;
}

function deadTab() {
    return { isDead: true, ws: { sendInput: vi.fn(() => false) } };
}
function liveTab() {
    return {
        isDead: false,
        ws: { sendInput: vi.fn(() => true) },
        directMode: true,
    };
}

describe('sendStagedInput on a dead tab', () => {
    let c;
    beforeEach(() => {
        c = ctx(deadTab());
        c.inputTextArea = { value: 'unsent draft', focus: vi.fn() };
        c.lastInputValue = 'unsent draft';
    });

    it('surfaces the disconnected-tab toast instead of silently doing nothing', () => {
        TabManager.prototype.sendStagedInput.call(c);
        expect(c.app.showToast).toHaveBeenCalledWith(
            'Tab is disconnected — input not sent',
            expect.objectContaining({ type: 'error' }),
        );
        expect(c._showReconnectOverlay).toHaveBeenCalled();
    });

    it('does not clear the staged draft when the send fails', () => {
        TabManager.prototype.sendStagedInput.call(c);
        expect(c.inputTextArea.value).toBe('unsent draft');
    });
});

describe('sendStagedInput on a live tab', () => {
    it('sends, clears the draft, and does not toast', () => {
        const tab = liveTab();
        const c = ctx(tab);
        c.inputTextArea = { value: 'go go go', focus: vi.fn() };
        c.lastInputValue = 'go go go';

        TabManager.prototype.sendStagedInput.call(c);

        expect(tab.ws.sendInput).toHaveBeenCalled();
        expect(c.app.showToast).not.toHaveBeenCalled();
        expect(c.inputTextArea.value).toBe('');
    });
});

describe('sendRawInput on a dead tab', () => {
    it('surfaces the disconnected-tab toast and skips post-send side effects', () => {
        const tab = deadTab();
        const c = ctx(tab);

        TabManager.prototype.sendRawInput.call(c, '\x03');

        // sendInput() bails before ever touching tab.ws when isDead is true.
        expect(tab.ws.sendInput).not.toHaveBeenCalled();
        expect(c.app.showToast).toHaveBeenCalledWith(
            'Tab is disconnected — input not sent',
            expect.objectContaining({ type: 'error' }),
        );
        expect(c._spamScrollToBottom).not.toHaveBeenCalled();
    });
});

describe('sendRawInput on a live tab', () => {
    it('sends and runs post-send side effects without toasting', () => {
        const tab = liveTab();
        const c = ctx(tab);

        TabManager.prototype.sendRawInput.call(c, '\x03');

        expect(tab.ws.sendInput).toHaveBeenCalledWith('\x03');
        expect(c.app.showToast).not.toHaveBeenCalled();
        expect(c._spamScrollToBottom).toHaveBeenCalledWith(tab);
    });
});

describe('Ctrl+T preset button regression guard', () => {
    it('does not pre-check isDead before delegating to sendRawInput', () => {
        const start = terminalJsSrc.indexOf('this.ctrlTBtn.addEventListener');
        expect(start).toBeGreaterThan(-1);
        const end = terminalJsSrc.indexOf('});', start);
        const handlerBody = terminalJsSrc.slice(start, end);
        expect(handlerBody).not.toContain('isDead');
    });
});
