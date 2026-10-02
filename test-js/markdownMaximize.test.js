// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { MarkdownManager } from '../web/markdown.js';

setupDomHarness();

function makeManager() {
    document.body.innerHTML = `
        <div id="markdown-file-list"></div>
        <div id="md-modal" class="md-modal-overlay">
            <div class="md-modal-content">
                <div id="md-modal-title"></div>
                <button id="md-modal-size-btn" aria-pressed="false" aria-label="Maximize preview"></button>
                <button id="md-modal-close"></button>
                <div id="md-modal-body"><p>Keep this content</p></div>
            </div>
        </div>`;
    return new MarkdownManager({
        showToast: vi.fn(),
        sessionsManager: { activeCWD: '/w' },
    });
}

describe('Markdown preview maximise', () => {
    it('toggles the in-page size with matching accessibility labels without remounting content', () => {
        const manager = makeManager();
        const content = manager.modal.querySelector('.md-modal-content');
        const paragraph = manager.modalBody.firstChild;
        manager.modalSizeToggleBtn.click();
        expect(content.classList.contains('md-modal-maximized')).toBe(true);
        expect(manager.modalSizeToggleBtn.getAttribute('aria-pressed')).toBe(
            'true',
        );
        expect(manager.modalSizeToggleBtn.getAttribute('aria-label')).toBe(
            'Restore preview size',
        );
        expect(manager.modalBody.firstChild).toBe(paragraph);
        manager.modalSizeToggleBtn.click();
        expect(content.classList.contains('md-modal-maximized')).toBe(false);
        expect(manager.modalSizeToggleBtn.getAttribute('aria-pressed')).toBe(
            'false',
        );
        expect(manager.modalSizeToggleBtn.title).toBe('Maximize preview');
    });

    it('still closes on Escape while maximized', () => {
        const manager = makeManager();
        manager.modalSizeToggleBtn.click();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(manager.modal.classList.contains('hidden')).toBe(true);
    });
});
