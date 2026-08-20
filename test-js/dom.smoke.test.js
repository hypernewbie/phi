// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { setupDomHarness, mockFetch, stubWebSocket } from './_dom.js';

// B0 beachhead: proves the jsdom environment, the per-file docblock, and the
// shared reset/mocking discipline work before we invest in real DOM tests.

setupDomHarness();

describe('jsdom harness', () => {
    it('provides a working document/DOM', () => {
        const div = document.createElement('div');
        div.className = 'x';
        div.setAttribute('data-worktree-path', '/proj');
        document.body.appendChild(div);
        expect(document.querySelector('.x')).toBe(div);
        expect(
            document.querySelector('.x').getAttribute('data-worktree-path'),
        ).toBe('/proj');
    });

    it('provides localStorage', () => {
        localStorage.setItem('phi_last_chosen_project', '/proj');
        expect(localStorage.getItem('phi_last_chosen_project')).toBe('/proj');
    });

    it('resets DOM and localStorage between tests', () => {
        // The previous tests wrote to body and localStorage; teardown cleared them.
        expect(document.body.innerHTML).toBe('');
        expect(localStorage.getItem('phi_last_chosen_project')).toBeNull();
    });

    it('mockFetch returns JSON bodies for ok responses', async () => {
        const fn = mockFetch(() => [{ path: '/a' }, { path: '/b' }]);
        const res = await fetch('/api/git/worktrees?cwd=x');
        expect(res.ok).toBe(true);
        expect(await res.json()).toEqual([{ path: '/a' }, { path: '/b' }]);
        expect(fn).toHaveBeenCalledOnce();
    });

    it('mockFetch can simulate a non-ok response', async () => {
        mockFetch(() => ({ ok: false, status: 500 }));
        const res = await fetch('/x');
        expect(res.ok).toBe(false);
        expect(res.status).toBe(500);
    });

    it('stubWebSocket prevents real connections', () => {
        const WS = stubWebSocket();
        const ws = new WebSocket('ws://localhost/x');
        expect(ws).toBeInstanceOf(WS);
        expect(() => ws.send('x')).not.toThrow();
    });
});
