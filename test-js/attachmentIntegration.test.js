// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { TabManager } from '../web/terminal.js';

// Integration tests for the drag-drop + clipboard-image attachment flow.
// These exercise the wiring in web/terminal.js — drop event → upload →
// chip, paste event → upload → chip, chip remove, send integration.
//
// Pure helpers (formatAttachment, extractImageFiles, etc.) are tested in
// attachments.test.js. Here we only care that the wiring between the DOM
// and the helpers works end-to-end.

setupDomHarness();

function makeTm({ coder = 'claude', inputText = '' } = {}) {
    const tm = Object.create(TabManager.prototype);
    tm.tabs = new Map();
    tm.activePaneId = 'p1';

    // Mirror the real DOM shape the handlers depend on.
    tm.tabsContainer = document.createElement('div');
    tm.tabsContainer.id = 'tabs-container';
    document.body.appendChild(tm.tabsContainer);
    tm.inputBarContainer = document.createElement('div');
    tm.inputBarContainer.id = 'input-bar-container';
    document.body.appendChild(tm.inputBarContainer);
    tm.attachmentStrip = document.createElement('div');
    tm.attachmentStrip.id = 'attachment-strip';
    tm.inputBarContainer.appendChild(tm.attachmentStrip);
    tm.inputTextArea = document.createElement('textarea');
    tm.inputTextArea.id = 'input-textarea';
    tm.inputTextArea.value = inputText;
    tm.inputBarContainer.appendChild(tm.inputTextArea);
    tm.sendInputBtn = document.createElement('button');
    tm.inputBarContainer.appendChild(tm.sendInputBtn);

    tm.stagedAttachments = [];

    // sendInput is called by sendStagedInput. Spy it.
    tm.sendInput = vi.fn(() => true);
    tm.lastInputValue = '';
    tm.adjustInputHeight = vi.fn();
    tm._spamScrollToBottom = vi.fn();
    tm.app = {
        showToast: vi.fn(),
    };

    // Active tab the staged input will resolve to.
    tm.getActiveTab = () => ({
        paneId: 'p1',
        coder,
        isDead: false,
        ws: { sendInput: vi.fn(), sendResize: vi.fn() },
    });

    // Wire the handlers the way TabManager's constructor does, but
    // without invoking the rest of the constructor (PTY, sockets, etc.).
    tm._initAttachmentDropZone();
    tm._initAttachmentPasteHandler();

    return tm;
}

let serverResponse;
let lastUrl;
let lastInit;

beforeEach(() => {
    serverResponse = null;
    lastUrl = null;
    lastInit = null;
    mockFetch((url, options) => {
        lastUrl = url;
        lastInit = options;
        return serverResponse;
    });
});

function pngFile(name = 'shot.png', size = 8) {
    return new File([new Uint8Array(size)], name, { type: 'image/png' });
}

describe('attachment wiring — drop', () => {
    it('uploads a dropped image and chips it (drop anywhere on page)', async () => {
        serverResponse = {
            path: '/home/u/.phi/clipboard/clip-1-aaaa.png',
            name: 'clip-1-aaaa.png',
            sizeBytes: 8,
            mimeType: 'image/png',
        };
        const tm = makeTm();

        // Simulate dropping on the terminal pane — a sibling of the
        // input bar, not inside it. The page-wide handler should still
        // catch it. This is the regression test for "drag and drop
        // literally doesn't work" when the user drops where their
        // cursor naturally is.
        const terminalPane = document.createElement('div');
        terminalPane.className = 'term-container';
        document.body.appendChild(terminalPane);

        const file = pngFile('dropped.png');
        const dt = { files: [file], types: ['Files'] };
        const event = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: dt });
        terminalPane.dispatchEvent(event);

        await vi.waitFor(() => {
            expect(
                tm.attachmentStrip.querySelectorAll('.attachment-chip'),
            ).toHaveLength(1);
        });

        expect(lastUrl).toBe('/api/attachments');
        expect(lastInit.method).toBe('POST');
        expect(lastInit.body).toBeInstanceOf(FormData);

        const chip = tm.attachmentStrip.querySelector('.attachment-chip');
        expect(chip.getAttribute('data-id')).toMatch(/^att-/);
        expect(tm.stagedAttachments).toHaveLength(1);
        expect(tm.stagedAttachments[0].path).toBe(
            '/home/u/.phi/clipboard/clip-1-aaaa.png',
        );
        expect(tm.stagedAttachments[0].source).toBe('drop');
        expect(tm.attachmentStrip.classList.contains('hidden')).toBe(false);
        // Visual feedback was toggled and reset.
        expect(tm.inputBarContainer.classList.contains('is-drop-target')).toBe(
            false,
        );
    });

    it('skips drops that land inside a .tab element (tab reorder wins)', async () => {
        serverResponse = { path: '/x.png', name: 'x.png' };
        const tm = makeTm();

        // Add a tab element to the DOM. Drop on the tab should be
        // ignored by the attachment handler (closest('.tab') check).
        const tab = document.createElement('div');
        tab.className = 'tab';
        document.body.appendChild(tab);

        // Spy on the chip adder so we test the CURRENT handler, not
        // accumulated handlers from previous tests.
        const addSpy = vi.spyOn(tm, '_addAttachmentChip');

        const file = pngFile('tabdrop.png');
        const dt = { files: [file], types: ['Files'] };
        const event = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: dt });
        tab.dispatchEvent(event);

        await new Promise((r) => setTimeout(r, 20));
        expect(addSpy).not.toHaveBeenCalled();
        expect(tm.stagedAttachments).toHaveLength(0);
    });

    it('skips non-image files in the drop', async () => {
        serverResponse = { path: '/x.png', name: 'x.png' };
        const tm = makeTm();
        const textFile = new File([new Uint8Array(8)], 'note.txt', {
            type: 'text/plain',
        });
        const event = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', {
            value: { files: [textFile] },
        });
        tm.inputBarContainer.dispatchEvent(event);

        // Give async handlers a tick; nothing should happen.
        await new Promise((r) => setTimeout(r, 10));
        expect(tm.stagedAttachments).toHaveLength(0);
        expect(lastUrl).toBeNull();
    });
});

describe('attachment wiring — paste', () => {
    it('uploads a pasted image and chips it', async () => {
        serverResponse = {
            path: '/home/u/.phi/clipboard/clip-2-bbbb.png',
            name: 'clip-2-bbbb.png',
            sizeBytes: 8,
            mimeType: 'image/png',
        };
        const tm = makeTm();

        const blob = new Blob([new Uint8Array(8)], { type: 'image/png' });
        const items = [
            { kind: 'file', type: 'image/png', getAsFile: () => blob },
        ];
        const event = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', { value: { items } });
        tm.inputTextArea.dispatchEvent(event);

        await vi.waitFor(() => {
            expect(
                tm.attachmentStrip.querySelectorAll('.attachment-chip'),
            ).toHaveLength(1);
        });

        expect(lastUrl).toBe('/api/attachments');
        expect(tm.stagedAttachments[0].source).toBe('paste');
    });

    it('does not intercept text-only pastes', async () => {
        const tm = makeTm();
        const event = new Event('paste', { bubbles: true, cancelable: true });
        // No `items` with kind=file → handler returns early.
        Object.defineProperty(event, 'clipboardData', { value: { items: [] } });
        const prevented = !tm.inputTextArea.dispatchEvent(event); // dispatchEvent returns false if preventDefault called
        // preventDefault should NOT have been called for text-only paste.
        expect(event.defaultPrevented).toBe(false);
        expect(tm.stagedAttachments).toHaveLength(0);
        expect(lastUrl).toBeNull();
    });
});

describe('attachment wiring — chip management', () => {
    it('renders one chip per attachment', async () => {
        serverResponse = { path: '/a.png', name: 'a.png', sizeBytes: 8 };
        const tm = makeTm();
        await tm._addAttachmentChip({
            id: 'x',
            name: 'a.png',
            path: '/a.png',
            type: 'image/png',
            sizeBytes: 8,
            source: 'paste',
        });
        await tm._addAttachmentChip({
            id: 'y',
            name: 'b.png',
            path: '/b.png',
            type: 'image/png',
            sizeBytes: 8,
            source: 'paste',
        });
        expect(
            tm.attachmentStrip.querySelectorAll('.attachment-chip'),
        ).toHaveLength(2);
        expect(tm.attachmentStrip.classList.contains('hidden')).toBe(false);
    });

    it('removes a chip via the remove button', async () => {
        const tm = makeTm();
        await tm._addAttachmentChip({
            id: 'x',
            name: 'a.png',
            path: '/a.png',
            type: 'image/png',
            sizeBytes: 8,
            source: 'paste',
        });
        expect(
            tm.attachmentStrip.querySelectorAll('.attachment-chip'),
        ).toHaveLength(1);
        tm._removeAttachmentChip('x');
        expect(
            tm.attachmentStrip.querySelectorAll('.attachment-chip'),
        ).toHaveLength(0);
        expect(tm.stagedAttachments).toHaveLength(0);
        // Strip hides itself when empty.
        expect(tm.attachmentStrip.classList.contains('hidden')).toBe(true);
    });

    it('de-dupes attachments with the same path', async () => {
        const tm = makeTm();
        await tm._addAttachmentChip({
            id: 'x',
            name: 'a.png',
            path: '/a.png',
            type: 'image/png',
            sizeBytes: 8,
            source: 'paste',
        });
        await tm._addAttachmentChip({
            id: 'y',
            name: 'a.png',
            path: '/a.png',
            type: 'image/png',
            sizeBytes: 8,
            source: 'paste',
        });
        expect(tm.stagedAttachments).toHaveLength(1);
    });
});

describe('attachment wiring — send integration', () => {
    it('sends attachment paths after text, one per line', () => {
        const tm = makeTm({ coder: 'claude' });
        tm.inputTextArea.value = 'Look at this';
        tm.stagedAttachments = [
            {
                id: 'x',
                name: 'a.png',
                path: '/a.png',
                type: 'image/png',
                sizeBytes: 8,
                source: 'paste',
            },
            {
                id: 'y',
                name: 'b.png',
                path: '/b.png',
                type: 'image/png',
                sizeBytes: 8,
                source: 'paste',
            },
        ];

        tm.sendStagedInput();

        expect(tm.sendInput).toHaveBeenCalledTimes(1);
        const sent = tm.sendInput.mock.calls[0][1];
        // claude → @path syntax; text first, paths newline-separated.
        expect(sent).toContain('Look at this');
        expect(sent).toContain('@/a.png');
        expect(sent).toContain('@/b.png');
    });

    it('uses raw path for bash coder', () => {
        const tm = makeTm({ coder: 'bash' });
        tm.inputTextArea.value = 'cat this';
        tm.stagedAttachments = [
            {
                id: 'x',
                name: 'a.png',
                path: '/a.png',
                type: 'image/png',
                sizeBytes: 8,
                source: 'paste',
            },
        ];

        tm.sendStagedInput();

        const sent = tm.sendInput.mock.calls[0][1];
        expect(sent).toContain('/a.png');
        expect(sent).not.toContain('@/a.png');
    });

    it('sends attachments-only when textarea is empty (no early-return)', () => {
        const tm = makeTm({ coder: 'claude' });
        tm.inputTextArea.value = '';
        tm.stagedAttachments = [
            {
                id: 'x',
                name: 'a.png',
                path: '/a.png',
                type: 'image/png',
                sizeBytes: 8,
                source: 'paste',
            },
        ];

        tm.sendStagedInput();

        expect(tm.sendInput).toHaveBeenCalledTimes(1);
        expect(tm.sendInput.mock.calls[0][1]).toContain('@/a.png');
    });

    it('clears stagedAttachments after send', () => {
        const tm = makeTm({ coder: 'claude' });
        tm.inputTextArea.value = 'hi';
        tm.stagedAttachments = [
            {
                id: 'x',
                name: 'a.png',
                path: '/a.png',
                type: 'image/png',
                sizeBytes: 8,
                source: 'paste',
            },
        ];
        tm.sendStagedInput();
        expect(tm.stagedAttachments).toHaveLength(0);
        expect(tm.attachmentStrip.classList.contains('hidden')).toBe(true);
        expect(tm.inputTextArea.value).toBe('');
    });

    it('early-returns only when both textarea and attachments are empty', () => {
        const tm = makeTm({ coder: 'claude' });
        tm.inputTextArea.value = '';
        tm.stagedAttachments = [];
        tm.sendStagedInput();
        expect(tm.sendInput).not.toHaveBeenCalled();
    });
});
