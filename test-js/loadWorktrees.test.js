// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { SessionsManager } from '../web/sessions.js';

// B2: exercises the REAL SessionsManager.loadWorktrees against a real jsdom
// DOM, with a hand-built `this` (never `new` the controller) so we only
// declare the small surface the method actually depends on. This is the exact
// logic behind the worktree/tab-sync fixes (d862975 / bcb3ee5): active-CWD
// selection precedence and which .worktree-section gets .active/.expanded.

setupDomHarness();

// Build the minimal `this` loadWorktrees needs. Collaborators are spies;
// sessionList is a real jsdom node so we can assert on produced DOM.
function makeCtx(over = {}) {
    const sessionList = document.createElement('div');
    document.body.appendChild(sessionList);
    return {
        sessionList,
        activeWorkspace: '/ws',
        activeCWD: '',
        activeCoder: 'opencode',
        worktreeDirtyRequestId: 0,
        loadWorktreeSessions: vi.fn(),
        loadWorktreeDirtyStates: vi.fn(),
        highlightActiveSession: vi.fn(),
        saveWorktreeState: vi.fn(async () => {}),
        app: {
            diffController: { refreshDiff: vi.fn() },
            tabManager: { getActiveTab: vi.fn(() => null) },
        },
        ...over,
    };
}

async function run(ctx, targetCwd, worktrees) {
    mockFetch(() => worktrees);
    await SessionsManager.prototype.loadWorktrees.call(ctx, targetCwd);
}

const sections = (ctx) => Array.from(ctx.sessionList.querySelectorAll('.worktree-section'));
const paths = (ctx) => sections(ctx).map((s) => s.getAttribute('data-worktree-path'));
const activePath = (ctx) => {
    const s = ctx.sessionList.querySelector('.worktree-section.active');
    return s ? s.getAttribute('data-worktree-path') : null;
};

beforeEach(() => vi.clearAllMocks());

describe('loadWorktrees — empty / missing', () => {
    it('shows "No worktrees found" and renders no sections', async () => {
        const ctx = makeCtx();
        await run(ctx, null, []);
        expect(sections(ctx)).toHaveLength(0);
        expect(ctx.sessionList.textContent).toContain('No worktrees found');
    });

    it('handles a null response the same way', async () => {
        const ctx = makeCtx();
        await run(ctx, null, null);
        expect(sections(ctx)).toHaveLength(0);
    });
});

describe('loadWorktrees — active-CWD selection precedence', () => {
    const wts = [{ path: '/a' }, { path: '/b', active: true }, { path: '/c' }];

    it('1. targetCwd argument wins', async () => {
        const ctx = makeCtx({ activeCWD: '/c' });
        await run(ctx, '/a', wts);
        expect(ctx.activeCWD).toBe('/a');
        expect(activePath(ctx)).toBe('/a');
    });

    it('2. keeps an existing activeCWD that is still present', async () => {
        const ctx = makeCtx({ activeCWD: '/c' });
        await run(ctx, null, wts);
        expect(ctx.activeCWD).toBe('/c'); // not overridden by the active:true /b
        expect(activePath(ctx)).toBe('/c');
    });

    it('3. falls back to the active worktree when activeCWD is gone', async () => {
        const ctx = makeCtx({ activeCWD: '/gone' });
        await run(ctx, null, wts);
        expect(ctx.activeCWD).toBe('/b');
    });

    it('4. falls back to worktrees[0] when nothing matches and none active', async () => {
        const ctx = makeCtx({ activeCWD: '/gone' });
        await run(ctx, null, [{ path: '/a' }, { path: '/c' }]);
        expect(ctx.activeCWD).toBe('/a');
    });
});

describe('loadWorktrees — produced DOM', () => {
    it('marks exactly the current-CWD section active + expanded', async () => {
        const ctx = makeCtx({ activeCWD: '' });
        await run(ctx, '/b', [{ path: '/a' }, { path: '/b' }, { path: '/c' }]);
        const active = ctx.sessionList.querySelectorAll('.worktree-section.active');
        expect(active).toHaveLength(1);
        expect(active[0].getAttribute('data-worktree-path')).toBe('/b');
        expect(active[0].classList.contains('expanded')).toBe(true);
    });

    it('expands wt.expanded sections even when not current', async () => {
        const ctx = makeCtx();
        await run(ctx, '/a', [{ path: '/a' }, { path: '/b', expanded: true }]);
        const b = ctx.sessionList.querySelector('[data-worktree-path="/b"]');
        expect(b.classList.contains('expanded')).toBe(true);
        expect(b.classList.contains('active')).toBe(false);
    });

    it('renders one section per worktree with the right data-worktree-path', async () => {
        const ctx = makeCtx();
        await run(ctx, '/a', [{ path: '/a' }, { path: '/b' }]);
        expect(paths(ctx)).toEqual(['/a', '/b']);
    });

    it('matches current CWD across separators/case via normalizePath', async () => {
        const ctx = makeCtx();
        await run(ctx, 'C:\\Proj', [{ path: 'c:/proj' }, { path: '/other' }]);
        expect(activePath(ctx)).toBe('c:/proj');
    });
});

describe('loadWorktrees — no-workspace section', () => {
    it('is NOT appended for non-agy coders', async () => {
        const ctx = makeCtx({ activeCoder: 'opencode' });
        await run(ctx, '/a', [{ path: '/a' }]);
        expect(paths(ctx)).not.toContain('--no-workspace--');
    });

    it('IS appended for the agy coder', async () => {
        const ctx = makeCtx({ activeCoder: 'agy' });
        await run(ctx, '/a', [{ path: '/a' }]);
        expect(paths(ctx)).toContain('--no-workspace--');
    });
});

describe('loadWorktrees — collaborators + side effects', () => {
    it('persists the chosen workspace to localStorage', async () => {
        const ctx = makeCtx({ activeWorkspace: '/ws' });
        await run(ctx, '/a', [{ path: '/a' }]);
        expect(localStorage.getItem('phi_last_chosen_project')).toBe('/ws');
    });

    it('kicks off dirty-state loading with an incremented request id', async () => {
        const ctx = makeCtx({ activeWorkspace: '/ws', worktreeDirtyRequestId: 0 });
        await run(ctx, '/a', [{ path: '/a' }]);
        expect(ctx.loadWorktreeDirtyStates).toHaveBeenCalledWith('/ws', 1);
        expect(ctx.worktreeDirtyRequestId).toBe(1);
    });

    it('loads sessions for the active (expanded) worktree', async () => {
        const ctx = makeCtx();
        await run(ctx, '/b', [{ path: '/a' }, { path: '/b' }]);
        const calledPaths = ctx.loadWorktreeSessions.mock.calls.map((c) => c[0]);
        expect(calledPaths).toContain('/b');
        expect(calledPaths).not.toContain('/a');
    });
});
