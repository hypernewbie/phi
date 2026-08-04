// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { MarkdownManager } from '../web/markdown.js';

// Phase 8 UI: changelog modal prepended with update banner when
// /api/update/status reports update_available. The banner shows
// instructions and (for eligible install methods) an Apply button
// that hits /api/update/apply + polls /api/update/progress.

setupDomHarness();

// Drive the real MarkdownManager.prototype methods via Object.create,
// skipping the constructor (which wires up a dozen DOM elements _buildUpdateBanner
// and _startUpdateApply never touch). Mirrors the pattern in changelogPopup.test.js.
function makeMarkdownManager(app = {}) {
    const mm = Object.create(MarkdownManager.prototype);
    mm.app = { ...app };
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
        // npm shim owns the child lifecycle -> no "restart now" chaining button.
        expect(banner.querySelector('.update-banner-btn-restart')).toBeFalsy();
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

    it('renders "Apply & restart now" button for standalone installs, wired to _startUpdateApplyAndRestart', () => {
        const spy = vi.spyOn(MarkdownManager.prototype, '_startUpdateApplyAndRestart').mockImplementation(() => {});
        const mm = makeMarkdownManager({
            updateStatus: {
                current: 'v0.8.0', latest: 'v0.8.2', update_available: true,
                install_method: 'standalone', instructions: 'Download'
            }
        });
        const banner = mm._buildUpdateBanner();
        const restartBtn = banner.querySelector('.update-banner-btn-restart');
        const applyBtn = banner.querySelector('.update-banner-btn');
        expect(restartBtn).toBeTruthy();
        expect(restartBtn.textContent).toBe('Apply & restart now');

        document.body.appendChild(banner);
        restartBtn.click();

        expect(spy).toHaveBeenCalledWith('v0.8.2', restartBtn, applyBtn, banner);
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
        expect(banner.querySelector('.update-banner-btn-restart')).toBeFalsy();
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

    // The first case installs fake timers to defuse production's poll
    // setTimeout (see below). Restoring in an afterEach — rather than at
    // the tail of the test body — means an assertion failure above still
    // leaves real timers in place for the next test, instead of hanging
    // its real setTimeout wait for 5s and reporting a second, spurious
    // failure on top of the real one.
    afterEach(() => {
        vi.useRealTimers();
    });

    it('click on Apply button POSTs /api/update/apply with version', async () => {
        const fakeFetch = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fakeFetch);
        // Production polls /api/update/progress 500ms after a successful
        // apply POST. Fake timers let us assert the immediate post-click
        // state without a real setTimeout outliving this test.
        vi.useFakeTimers();

        // npm (not standalone) so '.update-banner-btn' matches exactly one
        // element — standalone also renders '.update-banner-btn-restart',
        // which carries the same 'update-banner-btn' class.
        const mm = makeMarkdownManager({
            updateStatus: {
                current: 'v0.8.0', latest: 'v0.8.2', update_available: true,
                install_method: 'npm', instructions: 'npm update'
            }
        });
        const banner = mm._buildUpdateBanner();
        document.body.appendChild(banner);
        const btn = banner.querySelector('.update-banner-btn');
        btn.click();

        // Flush the microtask chain up to (but not through) the poll's setTimeout.
        await vi.advanceTimersByTimeAsync(0);

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
                install_method: 'npm', instructions: 'npm update'
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
