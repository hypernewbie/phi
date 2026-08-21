// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { SessionsManager } from '../web/sessions.js';

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

        await SessionsManager.prototype.openReviewTab.call(ctx, {
            id: 'session-1',
            title: 'Saved chat',
            coder: 'opencode',
            cwd: '/work/demo',
        });

        expect(fetchSpy).toHaveBeenCalledWith(
            '/api/session-transcript?coder=opencode&id=session-1&cwd=%2Fwork%2Fdemo',
        );
        expect(root.querySelector('.review-bubble').textContent).toContain(
            'hello',
        );

        root.querySelector('.review-refresh-btn').click();
        await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    });
});
