// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { SessionsManager } from '../web/sessions.js';

// B3: covers SessionsManager.highlightActiveWorktree — the exact method fixed
// in bcb3ee5 (normalizePath comparison, and passing the section's own path
// secPath — not the incoming cwdPath — into loadWorktreeSessions). Tiny
// surface: document.querySelectorAll + a this.loadWorktreeSessions spy.

setupDomHarness();

function addSection(path, { containerHtml = '', active = false, expanded = false } = {}) {
    const sec = document.createElement('div');
    sec.className = 'worktree-section';
    if (active) sec.classList.add('active');
    if (expanded) sec.classList.add('expanded');
    sec.setAttribute('data-worktree-path', path);
    const container = document.createElement('div');
    container.className = 'worktree-sessions-container';
    container.innerHTML = containerHtml;
    sec.appendChild(container);
    document.body.appendChild(sec);
    return sec;
}

const ctx = () => ({ loadWorktreeSessions: vi.fn() });
const call = (c, cwdPath) => SessionsManager.prototype.highlightActiveWorktree.call(c, cwdPath);
const hasActive = (sec) => sec.classList.contains('active');
const hasExpanded = (sec) => sec.classList.contains('expanded');

describe('highlightActiveWorktree', () => {
    it('does nothing when cwdPath is falsy', () => {
        const a = addSection('/a', { active: true, expanded: true });
        const c = ctx();
        call(c, '');
        // untouched
        expect(hasActive(a)).toBe(true);
        expect(c.loadWorktreeSessions).not.toHaveBeenCalled();
    });

    it('activates + expands the matching section and clears the others', () => {
        const a = addSection('/a', { active: true, expanded: true });
        const b = addSection('/b');
        const c = ctx();
        call(c, '/b');
        expect(hasActive(b)).toBe(true);
        expect(hasExpanded(b)).toBe(true);
        expect(hasActive(a)).toBe(false);
        expect(hasExpanded(a)).toBe(false);
    });

    it('matches across separators/case via normalizePath (bcb3ee5)', () => {
        const sec = addSection('C:/Proj');
        const c = ctx();
        call(c, 'c:\\proj\\');
        expect(hasActive(sec)).toBe(true);
        expect(hasExpanded(sec)).toBe(true);
    });

    it('loads sessions using the section path (secPath), not the incoming cwdPath', () => {
        addSection('C:/Proj'); // empty container -> should trigger a load
        const c = ctx();
        call(c, 'c:\\proj'); // different spelling of the same path
        expect(c.loadWorktreeSessions).toHaveBeenCalledTimes(1);
        // The bcb3ee5 fix: pass the section's own attribute value, not cwdPath.
        expect(c.loadWorktreeSessions.mock.calls[0][0]).toBe('C:/Proj');
    });

    it('loads sessions when the container is still showing "Scanning sessions..."', () => {
        addSection('/a', { containerHtml: '<div>Scanning sessions...</div>' });
        const c = ctx();
        call(c, '/a');
        expect(c.loadWorktreeSessions).toHaveBeenCalledTimes(1);
    });

    it('does NOT reload sessions when the container already has content', () => {
        addSection('/a', { containerHtml: '<div class="session-item">real</div>' });
        const c = ctx();
        call(c, '/a');
        expect(c.loadWorktreeSessions).not.toHaveBeenCalled();
    });
});
