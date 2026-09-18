// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TabManager } from '../web/terminal.js';

describe('Ctrl+` input box toggle shortcut', () => {
    let tabManager;
    let inputTextArea;
    let inputBarContainer;
    let mockTerm;

    function makeEvent(over = {}) {
        const e = {
            type: 'keydown',
            ctrlKey: true,
            altKey: false,
            metaKey: false,
            shiftKey: false,
            key: '`',
            code: 'Backquote',
            defaultPrevented: false,
            ...over,
        };
        e.preventDefault = vi.fn(() => {
            e.defaultPrevented = true;
        });
        return e;
    }

    beforeEach(() => {
        document.body.innerHTML = `
            <div id="input-bar-container" class="input-bar-container">
                <textarea id="input-textarea"></textarea>
            </div>
        `;
        inputTextArea = document.getElementById('input-textarea');
        inputBarContainer = document.getElementById('input-bar-container');

        mockTerm = {
            focus: vi.fn(),
        };

        tabManager = Object.create(TabManager.prototype);
        tabManager.inputTextArea = inputTextArea;
        tabManager.inputBarContainer = inputBarContainer;
        tabManager.getActiveTab = vi.fn(() => ({
            term: mockTerm,
            directMode: false,
        }));
    });

    describe('handleInputToggleShortcut validation', () => {
        it('triggers on Ctrl+`', () => {
            const e = makeEvent({ key: '`', code: 'Backquote' });
            const handled = tabManager.handleInputToggleShortcut(e);
            expect(handled).toBe(true);
            expect(e.preventDefault).toHaveBeenCalled();
            expect(document.activeElement).toBe(inputTextArea);
        });

        it('triggers on Ctrl+~ (Shift held with backquote)', () => {
            const e = makeEvent({ key: '~', shiftKey: true });
            const handled = tabManager.handleInputToggleShortcut(e);
            expect(handled).toBe(true);
            expect(e.preventDefault).toHaveBeenCalled();
            expect(document.activeElement).toBe(inputTextArea);
        });

        it('triggers when key is code Backquote even if key differs', () => {
            const e = makeEvent({ key: 'Dead', code: 'Backquote' });
            const handled = tabManager.handleInputToggleShortcut(e);
            expect(handled).toBe(true);
            expect(e.preventDefault).toHaveBeenCalled();
        });

        it('ignores Cmd+` (macOS window cycle shortcut)', () => {
            const e = makeEvent({ metaKey: true, ctrlKey: false });
            const handled = tabManager.handleInputToggleShortcut(e);
            expect(handled).toBe(false);
            expect(e.preventDefault).not.toHaveBeenCalled();
        });

        it('ignores Alt+`', () => {
            const e = makeEvent({ altKey: true });
            const handled = tabManager.handleInputToggleShortcut(e);
            expect(handled).toBe(false);
            expect(e.preventDefault).not.toHaveBeenCalled();
        });

        it('ignores plain ` without Ctrl (literal backtick typing)', () => {
            const e = makeEvent({ ctrlKey: false });
            const handled = tabManager.handleInputToggleShortcut(e);
            expect(handled).toBe(false);
            expect(e.preventDefault).not.toHaveBeenCalled();
        });

        it('ignores already prevented events', () => {
            const e = makeEvent({ defaultPrevented: true });
            const handled = tabManager.handleInputToggleShortcut(e);
            expect(handled).toBe(false);
        });
    });

    describe('two-way toggle behavior', () => {
        it('focuses input box and positions caret at the end when terminal/page has focus', () => {
            inputTextArea.value = 'hello world';
            inputTextArea.blur();

            tabManager.toggleInputFocus();

            expect(document.activeElement).toBe(inputTextArea);
            expect(inputTextArea.selectionStart).toBe(11);
            expect(inputTextArea.selectionEnd).toBe(11);
        });

        it('returns focus to active terminal when input box is currently focused', () => {
            inputTextArea.focus();
            expect(document.activeElement).toBe(inputTextArea);

            tabManager.toggleInputFocus();

            expect(mockTerm.focus).toHaveBeenCalledTimes(1);
        });

        it('does not focus input when input-bar-container is hidden', () => {
            inputBarContainer.classList.add('hidden');
            inputTextArea.blur();

            tabManager.toggleInputFocus();

            expect(document.activeElement).not.toBe(inputTextArea);
        });
    });

    describe('integration with global tab shortcuts and key listeners', () => {
        it('intercepts Ctrl+` in handleGlobalTabShortcuts', () => {
            const e = makeEvent();
            tabManager.handleGlobalTabShortcuts(e);
            expect(e.preventDefault).toHaveBeenCalled();
            expect(document.activeElement).toBe(inputTextArea);
        });

        it('is wired into terminal attachCustomKeyEventHandler', async () => {
            const { readFileSync } = await import('node:fs');
            const termSrc = readFileSync('web/terminal.js', 'utf8');
            expect(termSrc).toContain('handleInputToggleShortcut');
        });

        it('is wired into app.js initGlobalShortcuts', async () => {
            const { readFileSync } = await import('node:fs');
            const appSrc = readFileSync('web/app.js', 'utf8');
            expect(appSrc).toContain('handleInputToggleShortcut');
        });
    });
});
