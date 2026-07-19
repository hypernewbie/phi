// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { TabManager } from '../web/terminal.js';

// Prompt history (Alt+Up / Alt+Down on the staged input textarea).
//   - sendStagedInput posts the trimmed text to /api/prompt-history/append.
//   - Alt+Up / Alt+Down cycle through recent entries for the active cwd.
//   - Typing any character resets the cycle cursor back to -1.
//
// Backend coverage is in pkg/prompt_history/prompt_history_test.go +
// prompt_history_handlers_test.go. These tests pin the client contract.

setupDomHarness();

function makeTm({ inputText = '' } = {}) {
    const tm = Object.create(TabManager.prototype);
    tm.tabs = new Map();
    tm.activePaneId = 'p1';

    tm.tabsContainer = document.createElement('div');
    document.body.appendChild(tm.tabsContainer);
    tm.inputBarContainer = document.createElement('div');
    document.body.appendChild(tm.inputBarContainer);
    tm.attachmentStrip = document.createElement('div');
    tm.inputBarContainer.appendChild(tm.attachmentStrip);
    tm.inputTextArea = document.createElement('textarea');
    tm.inputTextArea.value = inputText;
    tm.inputBarContainer.appendChild(tm.inputTextArea);
    tm.sendInputBtn = document.createElement('button');
    tm.inputBarContainer.appendChild(tm.sendInputBtn);

    tm.stagedAttachments = [];
    tm.lastInputValue = inputText;
    tm.adjustInputHeight = vi.fn();
    tm._spamScrollToBottom = vi.fn();
    tm._placeCursorAtEnd = vi.fn();

    // sendInput is called by sendStagedInput; spy it to succeed by
    // default (mirrors attachmentIntegration.test.js's pattern).
    tm.sendInput = vi.fn(() => true);

    tm.app = {
        showToast: vi.fn(),
        sessionsManager: { activeCWD: '/proj/a' },
    };

    // History state — fresh per test.
    tm._historyCache = [];
    tm._historyCursor = -1;
    tm._historyCwd = '';
    tm._historyLoaded = false;
    tm._historyPreCycleValue = undefined;

    tm.getActiveTab = () => ({
        paneId: 'p1', coder: 'pi', isDead: false,
        ws: { sendInput: vi.fn(), sendResize: vi.fn() },
    });

    return tm;
}

function dispatchKey(target, key, modifiers = {}) {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers });
    target.dispatchEvent(ev);
    return ev;
}

describe('sendStagedInput records to /api/prompt-history/append', () => {
    it('POSTs {text, cwd} when there is a non-empty prompt', async () => {
        const fetchSpy = mockFetch(() => ({ ok: true, count: 1 }));
        const tm = makeTm({ inputText: 'fix the bug' });

        tm.sendStagedInput();
        await new Promise((r) => setTimeout(r, 0));

        const appendCall = fetchSpy.mock.calls.find(
            (c) => typeof c[0] === 'string' && c[0].includes('/api/prompt-history/append')
        );
        expect(appendCall, 'expected fetch to /api/prompt-history/append').toBeTruthy();
        const body = JSON.parse(appendCall[1].body);
        expect(body.text).toBe('fix the bug');
        expect(body.cwd).toBe('/proj/a');
    });

    it('does NOT POST when the prompt is empty (even if attachments present)', async () => {
        // Attachments-only sends are valid (drop a screenshot, hit Send
        // with no text). But there's no "prompt text" to record.
        const fetchSpy = mockFetch(() => ({ ok: true, count: 1 }));
        const tm = makeTm({ inputText: '' });
        tm.stagedAttachments = [{ name: 'shot.png', path: '/x.png', type: 'image/png', sizeBytes: 1, source: 'drop' }];

        tm.sendStagedInput();
        await new Promise((r) => setTimeout(r, 0));

        const appendCall = fetchSpy.mock.calls.find(
            (c) => typeof c[0] === 'string' && c[0].includes('/api/prompt-history/append')
        );
        expect(appendCall).toBeUndefined();
    });

    it('records the trimmed text (not the raw textarea value with surrounding whitespace)', async () => {
        const fetchSpy = mockFetch(() => ({ ok: true, count: 1 }));
        const tm = makeTm({ inputText: '   lots of leading and trailing space   \n  ' });

        tm.sendStagedInput();
        await new Promise((r) => setTimeout(r, 0));

        const appendCall = fetchSpy.mock.calls.find((c) => c[0].includes('/api/prompt-history/append'));
        expect(JSON.parse(appendCall[1].body).text).toBe('lots of leading and trailing space');
    });

    it('resets the history cursor on send (next Alt+Up starts from newest)', async () => {
        mockFetch(() => ({ ok: true, count: 1 }));
        const tm = makeTm({ inputText: 'new prompt' });
        tm._historyCursor = 3; // mid-cycle

        tm.sendStagedInput();
        await new Promise((r) => setTimeout(r, 0));

        expect(tm._historyCursor).toBe(-1);
    });
});

describe('Alt+Up / Alt+Down cycle prompt history', () => {
    it('Alt+Up from -1 fetches /recent then jumps to the most-recent entry', async () => {
        // Server returns newest-first.
        mockFetch((url) => {
            if (url.includes('/api/prompt-history/recent')) {
                return [
                    { ts: '2026-07-19T12:00:00Z', cwd: '/proj/a', text: 'newest' },
                    { ts: '2026-07-19T11:00:00Z', cwd: '/proj/a', text: 'middle' },
                    { ts: '2026-07-19T10:00:00Z', cwd: '/proj/a', text: 'oldest' },
                ];
            }
            throw new Error('unexpected: ' + url);
        });
        const tm = makeTm({ inputText: '' });
        await tm._cyclePromptHistory('older');
        expect(tm.inputTextArea.value).toBe('newest');
        expect(tm._historyCursor).toBe(0);
    });

    it('subsequent Alt+Up advances the cursor to older entries', async () => {
        mockFetch((url) => {
            if (url.includes('/api/prompt-history/recent')) {
                return [
                    { ts: 't3', cwd: '/p', text: 'newest' },
                    { ts: 't2', cwd: '/p', text: 'middle' },
                    { ts: 't1', cwd: '/p', text: 'oldest' },
                ];
            }
            throw new Error('unexpected: ' + url);
        });
        const tm = makeTm({ inputText: '' });
        await tm._cyclePromptHistory('older'); // 0
        expect(tm.inputTextArea.value).toBe('newest');
        await tm._cyclePromptHistory('older'); // 1
        expect(tm.inputTextArea.value).toBe('middle');
        await tm._cyclePromptHistory('older'); // 2
        expect(tm.inputTextArea.value).toBe('oldest');
        expect(tm._historyCursor).toBe(2);
        // Pressing Alt+Up past the oldest stays at the oldest.
        await tm._cyclePromptHistory('older');
        expect(tm.inputTextArea.value).toBe('oldest');
        expect(tm._historyCursor).toBe(2);
    });

    it('Alt+Down retreats toward newer entries; past newest restores pre-cycle draft', async () => {
        mockFetch((url) => {
            if (url.includes('/api/prompt-history/recent')) {
                return [
                    { ts: 't3', cwd: '/p', text: 'newest' },
                    { ts: 't2', cwd: '/p', text: 'middle' },
                ];
            }
            throw new Error('unexpected: ' + url);
        });
        const tm = makeTm({ inputText: 'my draft before cycling' });
        await tm._cyclePromptHistory('older'); // 0
        expect(tm.inputTextArea.value).toBe('newest');
        await tm._cyclePromptHistory('newer'); // back to -1
        expect(tm.inputTextArea.value).toBe('my draft before cycling');
        expect(tm._historyCursor).toBe(-1);
    });

    it('sends cwd in the /recent request, taken from activeCWD', async () => {
        let sawUrl = null;
        mockFetch((url) => {
            sawUrl = url;
            return [];
        });
        const tm = makeTm({ inputText: '' });
        tm.app.sessionsManager.activeCWD = '/proj/beta';
        await tm._cyclePromptHistory('older');
        expect(sawUrl).toBeTruthy();
        expect(decodeURIComponent(sawUrl)).toContain('cwd=/proj/beta');
    });

    it('the real keydown listener (_initPromptHistoryKeydown) routes Alt+Up / Alt+Down to the cycle method', async () => {
        mockFetch(() => []);
        const tm = makeTm({ inputText: '' });
        const spy = vi.spyOn(tm, '_cyclePromptHistory').mockResolvedValue(undefined);
        tm._initPromptHistoryKeydown(); // exact production wiring, no re-implementation

        dispatchKey(tm.inputTextArea, 'ArrowUp', { altKey: true });
        dispatchKey(tm.inputTextArea, 'ArrowDown', { altKey: true });
        expect(spy).toHaveBeenCalledWith('older');
        expect(spy).toHaveBeenCalledWith('newer');
    });

    it('plain ArrowUp (no Alt) does NOT trigger the history cycle via the real listener', async () => {
        mockFetch(() => []);
        const tm = makeTm({ inputText: '' });
        const spy = vi.spyOn(tm, '_cyclePromptHistory').mockResolvedValue(undefined);
        tm._initPromptHistoryKeydown();

        dispatchKey(tm.inputTextArea, 'ArrowUp'); // no altKey
        expect(spy).not.toHaveBeenCalled();
    });

    it('Ctrl/Shift/Meta + Up is NOT intercepted (other shortcuts keep working)', async () => {
        mockFetch(() => []);
        const tm = makeTm({ inputText: '' });
        const spy = vi.spyOn(tm, '_cyclePromptHistory').mockResolvedValue(undefined);
        tm._initPromptHistoryKeydown();

        dispatchKey(tm.inputTextArea, 'ArrowUp', { altKey: true, ctrlKey: true });
        dispatchKey(tm.inputTextArea, 'ArrowUp', { altKey: true, shiftKey: true });
        dispatchKey(tm.inputTextArea, 'ArrowUp', { altKey: true, metaKey: true });
        expect(spy).not.toHaveBeenCalled();
    });

    it('typing any character resets the cycle cursor to -1, via the real input listener', async () => {
        mockFetch(() => [{ ts: 't', cwd: '/p', text: 'history entry' }]);
        const tm = makeTm({ inputText: '' });
        tm._initPromptHistoryKeydown(); // installs the real 'input' reset listener
        await tm._cyclePromptHistory('older');
        expect(tm._historyCursor).toBe(0);

        tm.inputTextArea.value = 'history entryX';
        tm.inputTextArea.dispatchEvent(new Event('input', { bubbles: true }));
        expect(tm._historyCursor).toBe(-1);
    });
});
