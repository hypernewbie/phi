// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../web/chat-pi/tab.js', () => ({
    openPiRpcChatTab: vi.fn(),
}));

import { openPiRpcChatTab } from '../web/chat-pi/tab.js';
import { SessionsManager } from '../web/sessions.js';

function context(activeCoder, container) {
    const tabManager = {
        tabs: new Map(),
        getActiveTab: vi.fn(() => null),
    };
    const scope = {
        profileId: '',
        origin: window.location.origin,
        headers: () => ({}),
        signal: new AbortController().signal,
    };
    const store = { responses: new Map() };
    const sessionList = document.createElement('div');
    sessionList.appendChild(container);
    document.body.appendChild(sessionList);
    return Object.assign(Object.create(SessionsManager.prototype), {
        activeCoder,
        activeWorkspace: '/work',
        activeCWD: '/work/demo',
        sessionListPageSize: 10,
        sessionList,
        sessionRequests: new Map(),
        worktreeReads: new Map(),
        worktreeRootGeneration: 0,
        worktreeRootOwner: { scope, coder: activeCoder, workspace: '/work' },
        app: { tabManager, scope, getActiveStore: () => store },
        launchSession: vi.fn(),
        _showSessionContextMenu: vi.fn(),
        tabManager,
    });
}

function response(rows) {
    return {
        ok: true,
        json: async () => rows,
        text: async () => '',
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    document.body.replaceChildren();
});

describe('Pi RPC sessions surface', () => {
    it('labels the Pi review action Open Pi RPC and forwards its path/title', async () => {
        const container = document.createElement('div');
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            response([
                {
                    id: 'session-id',
                    coder: 'pi',
                    cwd: '/work/demo',
                    session_path: '/work/demo/.pi/session.jsonl',
                    title: 'Historical chat',
                    time_updated: '2026-08-20T00:00:00Z',
                },
            ]),
        );
        const ctx = context('pi', container);

        await SessionsManager.prototype.loadWorktreeSessions.call(
            ctx,
            '/work/demo',
            container,
        );
        const button = container.querySelector('.review-btn');
        expect(button.getAttribute('aria-label')).toBe('Open Pi RPC');
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(openPiRpcChatTab).toHaveBeenCalledWith(
            ctx.tabManager,
            '/work/demo',
            '/work/demo/.pi/session.jsonl',
            'Historical chat',
        );
    });

    it('falls back to the worktree CWD when a Pi session row omits cwd', async () => {
        const container = document.createElement('div');
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            response([
                {
                    id: 'session-id',
                    coder: 'pi',
                    session_path: '/work/demo/.pi/session.jsonl',
                    title: 'Historical chat',
                    time_updated: '2026-08-20T00:00:00Z',
                },
            ]),
        );
        const ctx = context('pi', container);

        await SessionsManager.prototype.loadWorktreeSessions.call(
            ctx,
            '/work/fallback',
            container,
        );
        container
            .querySelector('.review-btn')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(openPiRpcChatTab).toHaveBeenCalledWith(
            ctx.tabManager,
            '/work/fallback',
            '/work/demo/.pi/session.jsonl',
            'Historical chat',
        );
    });

    it('does not render New pi chat action — native is top New Session', async () => {
        const empty = document.createElement('div');
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(response([]));
        await SessionsManager.prototype.loadWorktreeSessions.call(
            context('pi', empty),
            '/work/demo',
            empty,
        );
        expect(empty.textContent).not.toContain('New pi chat');

        vi.restoreAllMocks();
        const populated = document.createElement('div');
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            response([
                {
                    id: 'session-id',
                    coder: 'pi',
                    cwd: '/work/demo',
                    session_path: '/work/demo/.pi/session.jsonl',
                    title: 'Historical chat',
                    time_updated: '2026-08-20T00:00:00Z',
                },
            ]),
        );
        await SessionsManager.prototype.loadWorktreeSessions.call(
            context('pi', populated),
            '/work/demo',
            populated,
        );
        expect(populated.textContent).not.toContain('New pi chat');
    });

    it('does not retain an overlay mount global', () => {
        expect(window.mountChatPiOverlay).toBeUndefined();
        expect(document.getElementById('phi-chat-pi-overlay')).toBeNull();
    });
});
