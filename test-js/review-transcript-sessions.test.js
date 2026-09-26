// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionsManager } from '../web/sessions.js';

afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
});

describe('legacy Review Transcript wiring', () => {
    it('keeps the session endpoint and refresh while using the renderer', async () => {
        const root = document.createElement('div');
        const tabs = new Map();
        const tabManager = {
            tabs,
            createTab: vi.fn((paneId) => {
                tabs.set(paneId, { termContainer: root });
            }),
            switchTab: vi.fn(),
            copyTextRobustly: vi.fn(),
        };
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => [{ role: 'assistant', text: 'hello' }],
        });
        const ctx = {
            activeWorkspace: 'workspace',
            app: { tabManager },
        };

        const session = {
            id: 'session-1',
            title: 'Saved chat',
            coder: 'opencode',
            cwd: '/work/demo',
        };
        await SessionsManager.prototype.openReviewTab.call(ctx, session);
        expect(tabManager.createTab.mock.calls[0][0]).toBe('review-session-1');
        await SessionsManager.prototype.openReviewTab.call(ctx, session);
        expect(tabManager.createTab).toHaveBeenCalledTimes(1);
        expect(tabManager.switchTab).toHaveBeenCalledWith('review-session-1');

        expect(fetchSpy).toHaveBeenCalledWith(
            '/api/session-transcript?coder=opencode&id=session-1&cwd=%2Fwork%2Fdemo',
        );
        expect(root.querySelector('.review-bubble').textContent).toContain(
            'hello',
        );

        root.querySelector('.review-refresh-btn').click();
        await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    });

    it('keeps the legacy key for an unknown restored coder', async () => {
        const tabs = new Map();
        const tabManager = {
            tabs,
            createTab: vi.fn((id) => {
                tabs.set(id, { termContainer: document.createElement('div') });
            }),
            switchTab: vi.fn(),
            copyTextRobustly: vi.fn(),
        };
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => [],
        });
        await SessionsManager.prototype.openReviewTab.call(
            { activeWorkspace: 'workspace', app: { tabManager } },
            { id: 'session-2', title: 'Old session', coder: 'old-coder' },
        );
        expect(tabManager.createTab.mock.calls[0][0]).toBe('review-session-2');
    });
});
