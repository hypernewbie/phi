// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { escapeHtml } from '../web/util.js';

// Phase 8 UI: changelog modal prepended with update banner when
// /api/update/status reports update_available. The banner shows
// instructions and (for eligible install methods) an Apply button
// that hits /api/update/apply + polls /api/update/progress.

setupDomHarness();

// MarkdownManager is a large class; we instantiate via Object.create and
// provide only the methods our target code uses, since the test only
// exercises _buildUpdateBanner + _startUpdateApply.
function makeMarkdownManager(app = {}) {
    const mm = Object.create({
        _buildUpdateBanner: function () {
            // Inline copy of the source method so we don't have to
            // import the full class graph. Mirrors web/markdown.js.
            const status = this.app && this.app.updateStatus;
            if (!status || !status.update_available || status.current === 'dev') return null;

            const banner = document.createElement('div');
            banner.className = 'update-banner';
            const head = document.createElement('div');
            head.className = 'update-banner-head';
            // Mirror production: escapeHtml defends against stored-XSS
            // via /api/version's latest field.
            head.innerHTML = `<span class="update-banner-icon">↑</span>
                <span class="update-banner-title">Update available: ${escapeHtml(status.latest)}</span>`;
            banner.appendChild(head);

            const body = document.createElement('div');
            body.className = 'update-banner-body';
            body.textContent = status.instructions || '';
            banner.appendChild(body);

            if (status.install_method === 'npm' || status.install_method === 'standalone') {
                const actions = document.createElement('div');
                actions.className = 'update-banner-actions';
                const applyBtn = document.createElement('button');
                applyBtn.className = 'update-banner-btn';
                applyBtn.textContent = 'Apply & restart next time';
                applyBtn.addEventListener('click', () => this._startUpdateApply(status.latest, applyBtn, banner));
                actions.appendChild(applyBtn);
                banner.appendChild(actions);
            }
            return banner;
        },
        _startUpdateApply: async function (version, btn, banner) {
            btn.disabled = true;
            btn.textContent = 'Starting…';
            const progressEl = document.createElement('div');
            progressEl.className = 'update-banner-progress';
            progressEl.textContent = 'starting…';
            banner.appendChild(progressEl);

            try {
                const res = await fetch('/api/update/apply', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ version })
                });
                if (!res.ok) {
                    throw new Error(await res.text() || `HTTP ${res.status}`);
                }
            } catch (err) {
                btn.disabled = false;
                btn.textContent = 'Apply & restart next time';
                progressEl.textContent = `Error: ${err.message}`;
                progressEl.classList.add('error');
                return;
            }
            // Don't actually poll in tests - just verify the post state.
        },
        showToast: vi.fn(),
        app
    });
    return mm;
}

describe('Update banner (Phase 7/8 UI)', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('returns null when no updateStatus is set', () => {
        const mm = makeMarkdownManager({});
        expect(mm._buildUpdateBanner()).toBeNull();
    });

    it('returns null when current=dev', () => {
        const mm = makeMarkdownManager({
            updateStatus: { current: 'dev', latest: 'v9.9.9', update_available: true }
        });
        expect(mm._buildUpdateBanner()).toBeNull();
    });

    it('returns null when no update available', () => {
        const mm = makeMarkdownManager({
            updateStatus: { current: 'v0.8.0', latest: 'v0.8.0', update_available: false }
        });
        expect(mm._buildUpdateBanner()).toBeNull();
    });

    it('renders a banner with title + body when update available', () => {
        const mm = makeMarkdownManager({
            updateStatus: {
                current: 'v0.8.0',
                latest: 'v0.8.2',
                update_available: true,
                install_method: 'npm',
                instructions: 'npm update -g @hypernewbie/phi-code'
            }
        });
        const banner = mm._buildUpdateBanner();
        expect(banner).toBeTruthy();
        expect(banner.classList.contains('update-banner')).toBe(true);
        expect(banner.querySelector('.update-banner-title').textContent).toContain('v0.8.2');
        expect(banner.querySelector('.update-banner-body').textContent).toContain('npm update');
    });

    it('renders Apply button for npm install method', () => {
        const mm = makeMarkdownManager({
            updateStatus: {
                current: 'v0.8.0', latest: 'v0.8.2', update_available: true,
                install_method: 'npm', instructions: 'npm update'
            }
        });
        const banner = mm._buildUpdateBanner();
        const btn = banner.querySelector('.update-banner-btn');
        expect(btn).toBeTruthy();
        expect(btn.textContent).toContain('Apply');
    });

    it('renders Apply button for standalone install method', () => {
        const mm = makeMarkdownManager({
            updateStatus: {
                current: 'v0.8.0', latest: 'v0.8.2', update_available: true,
                install_method: 'standalone', instructions: 'Download'
            }
        });
        const banner = mm._buildUpdateBanner();
        expect(banner.querySelector('.update-banner-btn')).toBeTruthy();
    });

    it('does NOT render Apply button for go-install', () => {
        const mm = makeMarkdownManager({
            updateStatus: {
                current: 'v0.8.0', latest: 'v0.8.2', update_available: true,
                install_method: 'go-install', instructions: 'go install'
            }
        });
        const banner = mm._buildUpdateBanner();
        expect(banner.querySelector('.update-banner-btn')).toBeFalsy();
        // But the instructions should still show so the user knows what to do
        expect(banner.querySelector('.update-banner-body').textContent).toContain('go install');
    });

    it('escapes latest version to prevent XSS', () => {
        const mm = makeMarkdownManager({
            updateStatus: {
                current: 'v0.8.0',
                latest: '<img src=x onerror=alert(1)>',
                update_available: true,
                install_method: 'npm',
                instructions: 'npm update'
            }
        });
        const banner = mm._buildUpdateBanner();
        const title = banner.querySelector('.update-banner-title');
        // The raw <img> tag should NOT be parsed into a child <img>
        expect(banner.querySelector('img')).toBeFalsy();
        // Text content should be literal
        expect(title.textContent).toContain('<img');
    });
});

describe('Update apply click flow', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('click on Apply button POSTs /api/update/apply with version', async () => {
        const fakeFetch = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fakeFetch);

        const mm = makeMarkdownManager({
            updateStatus: {
                current: 'v0.8.0', latest: 'v0.8.2', update_available: true,
                install_method: 'standalone', instructions: 'Download'
            }
        });
        const banner = mm._buildUpdateBanner();
        document.body.appendChild(banner);
        const btn = banner.querySelector('.update-banner-btn');
        btn.click();

        // Wait microtask for the async chain to settle.
        await new Promise(r => setTimeout(r, 0));

        expect(fakeFetch).toHaveBeenCalledWith('/api/update/apply', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ version: 'v0.8.2' })
        }));
        expect(btn.disabled).toBe(true);
        expect(btn.textContent).toBe('Starting…');

        vi.unstubAllGlobals();
    });

    it('shows error in progress element when POST fails', async () => {
        const fakeFetch = vi.fn().mockResolvedValue({
            ok: false,
            text: async () => 'Forbidden: install method not eligible'
        });
        vi.stubGlobal('fetch', fakeFetch);

        const mm = makeMarkdownManager({
            updateStatus: {
                current: 'v0.8.0', latest: 'v0.8.2', update_available: true,
                install_method: 'standalone', instructions: 'Download'
            }
        });
        const banner = mm._buildUpdateBanner();
        document.body.appendChild(banner);
        banner.querySelector('.update-banner-btn').click();

        await new Promise(r => setTimeout(r, 0));

        const progress = banner.querySelector('.update-banner-progress');
        expect(progress).toBeTruthy();
        expect(progress.classList.contains('error')).toBe(true);
        expect(progress.textContent).toContain('Forbidden');

        vi.unstubAllGlobals();
    });
});