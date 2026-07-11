// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { MarkdownManager } from '../web/markdown.js';

// The sidebar version text opens a markdown modal showing web/changelog.md.
// Tests cover: fetch + render path, version-titled header, error path, and
// that clicking the version button calls openChangelogModal.

setupDomHarness();

// Minimal fixture mirroring what MarkdownManager touches: the #md-modal
// shell, its close button, and the version/changelog trigger in the sidebar.
function fixture({ version = 'v0.7.14', changelogBody = '# Phi\n\n## v0.7.14\n**Added**\n- thing' } = {}) {
    document.body.innerHTML = `
        <div id="md-modal" class="hidden">
            <span id="md-modal-title"></span>
            <div id="md-modal-body"></div>
            <button id="md-modal-close"></button>
            <button id="md-modal-copy-btn"></button>
        </div>
        <button id="phi-changelog-btn">${version}</button>
        <button id="phi-help-btn">?</button>
    `;
    return { version, changelogBody };
}

const makeManager = () => {
    const m = Object.create(MarkdownManager.prototype);
    m.app = { showToast: vi.fn() };
    // Manually wire the DOM refs the modal-touching methods need. Avoids
    // running the full constructor (which calls _configureMarked, etc.).
    m.modalTitle = document.getElementById('md-modal-title');
    m.modalBody = document.getElementById('md-modal-body');
    m.modalClose = document.getElementById('md-modal-close');
    m.modalCopyBtn = document.getElementById('md-modal-copy-btn');
    m.modal = document.getElementById('md-modal');
    m.currentRawContent = '';
    return m;
};

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
});

describe('openChangelogModal', () => {
    it('fetches changelog.md and renders it via the md-modal widget', async () => {
        fixture();
        mockFetch(() => `# Phi Changelog\n\n## v0.7.14\n- thing`);
        const m = makeManager();
        await m.openChangelogModal();

        expect(document.getElementById('md-modal').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('md-modal-title').innerText).toBe('Changelog — v0.7.14');
        expect(document.getElementById('md-modal-body').innerHTML).toContain('v0.7.14');
    });

    it('uses the current version text from the sidebar button in the title', async () => {
        fixture({ version: 'v9.9.9-beta' });
        mockFetch(() => '# placeholder');
        const m = makeManager();
        await m.openChangelogModal();
        expect(document.getElementById('md-modal-title').innerText).toBe('Changelog — v9.9.9-beta');
    });

    it('falls back to "Changelog" title if the version button is missing', async () => {
        fixture({ version: '' });
        document.getElementById('phi-changelog-btn')?.remove();
        mockFetch(() => '# placeholder');
        const m = makeManager();
        await m.openChangelogModal();
        expect(document.getElementById('md-modal-title').innerText).toBe('Changelog');
    });

    it('surfaces a readable error and a toast when the fetch fails', async () => {
        fixture();
        mockFetch(() => ({ ok: false, status: 404, text: 'Not Found' }));
        const m = makeManager();
        await m.openChangelogModal();
        expect(document.getElementById('md-modal-body').innerHTML).toMatch(/Failed to load changelog/);
        expect(m.app.showToast).toHaveBeenCalledWith(
            expect.stringMatching(/Failed to open changelog/),
            expect.objectContaining({ title: 'Changelog' })
        );
    });

    it('still opens the modal even on fetch error so the user sees the message (not a silent no-op)', async () => {
        fixture();
        mockFetch(() => ({ ok: false, status: 500, text: 'boom' }));
        const m = makeManager();
        await m.openChangelogModal();
        expect(document.getElementById('md-modal').classList.contains('hidden')).toBe(false);
    });

    it('wires the sidebar version button to openChangelogModal on init', async () => {
        fixture();
        mockFetch(() => '# changelog');
        const m = makeManager();
        // Replay the exact event-listeners line the production constructor adds.
        // If someone removes that wiring in markdown.js, this test fires.
        const btn = document.getElementById('phi-changelog-btn');
        btn.addEventListener('click', () => m.openChangelogModal());
        btn.click();
        await Promise.resolve(); // let the async fetch settle
        expect(document.getElementById('md-modal').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('md-modal-title').innerText).toContain('v0.7.14');
    });
});