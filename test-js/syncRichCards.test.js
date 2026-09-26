// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { SyncManager, parseActionPayload } from '../web/sync.js';

setupDomHarness();

function bootstrapDom() {
    document.body.innerHTML = `
        <div id="sync-panel" class="sync-panel"></div>
    `;
}

function buildAppStub() {
    return {
        showToast: vi.fn(),
        sessionsManager: {
            config: { sync_coordinator: 'http://localhost:7070' },
            activeCWD: '/home/user/project',
            loadConfig: vi.fn().mockResolvedValue(undefined),
        },
        tabManager: {
            getActiveTab: vi.fn(() => ({
                cwd: '/home/user/project',
                directMode: false,
            })),
            sendRawInput: vi.fn(),
            inputTextArea: document.createElement('textarea'),
        },
        markdownManager: {
            previewFile: vi.fn().mockResolvedValue(undefined),
        },
        diffController: { isPanelOpen: true, activeTab: 'sync' },
    };
}

describe('parseActionPayload helper', () => {
    it('parses stringified JSON containing rich action keys', () => {
        const payload = JSON.stringify({
            title: 'Mockup Ready',
            preview: 'ui/login.png',
            url: 'http://localhost:5173',
            actions: [{ label: 'Run tests', command: 'pnpm test\r' }],
            toast: 'Ready for review!',
            auto_open: true,
        });

        const parsed = parseActionPayload(payload);
        expect(parsed).not.toBeNull();
        expect(parsed?.title).toBe('Mockup Ready');
        expect(parsed?.preview).toBe('ui/login.png');
        expect(parsed?.url).toBe('http://localhost:5173');
        expect(parsed?.actions).toHaveLength(1);
        expect(parsed?.toast).toBe('Ready for review!');
        expect(parsed?.auto_open).toBe(true);
    });

    it('parses raw object containing rich action keys', () => {
        const raw = {
            title: 'Server running',
            url: 'http://localhost:3000',
        };
        const parsed = parseActionPayload(raw);
        expect(parsed).toEqual(raw);
    });

    it('returns null for plain strings or non-JSON text', () => {
        expect(parseActionPayload('hello world')).toBeNull();
        expect(parseActionPayload('not json at all')).toBeNull();
        expect(parseActionPayload(12345)).toBeNull();
        expect(parseActionPayload(null)).toBeNull();
    });

    it('returns null for generic JSON objects without rich action keys', () => {
        expect(parseActionPayload('{"status": "ok", "code": 200}')).toBeNull();
        expect(parseActionPayload('["item1", "item2"]')).toBeNull();
    });
});

describe('SyncManager rich action cards rendering and interaction', () => {
    beforeEach(() => {
        bootstrapDom();
        mockFetch(() => []);
        vi.spyOn(SyncManager.prototype, 'refreshMessages').mockImplementation(
            () => Promise.resolve(),
        );
    });

    it('renders rich action card elements (title, desc, preview button, link, command buttons)', async () => {
        const app = buildAppStub();
        const mgr = new SyncManager(app);

        const now = new Date(Date.now() - 60000).toISOString(); // 1 minute ago (not recent)
        const messages = [
            {
                key: 'feature:preview PHI_NOTIF',
                value: JSON.stringify({
                    title: 'New Dashboard',
                    description: 'Dashboard preview and dev server',
                    preview: 'assets/dashboard.png',
                    url: 'http://localhost:5173/dash',
                    actions: [
                        {
                            label: 'Run E2E',
                            command: 'pnpm test:e2e\r',
                            style: 'primary',
                        },
                        {
                            label: 'Stage Git',
                            command: 'git status',
                            stage: true,
                        },
                    ],
                }),
                created_at: now,
                updated_at: now,
            },
        ];

        mgr.renderMessages(messages);
        await new Promise((r) => setTimeout(r, 0));

        const card = mgr.messagesList.querySelector('.sync-card');
        expect(card).not.toBeNull();

        // Check Title and Description
        const titleEl = card?.querySelector('.sync-action-title');
        expect(titleEl?.textContent).toBe('New Dashboard');

        const descEl = card?.querySelector('.sync-action-desc');
        expect(descEl?.textContent).toBe('Dashboard preview and dev server');

        // Check Preview button and image thumbnail
        const previewBtn = card?.querySelector('.sync-preview-btn');
        expect(previewBtn).not.toBeNull();
        expect(previewBtn?.textContent).toContain('Preview dashboard.png');

        const imgThumb = card?.querySelector('.sync-image-thumb');
        expect(imgThumb).not.toBeNull();

        // Check Link chip
        const linkBtn = card?.querySelector('.sync-link-btn');
        expect(linkBtn).not.toBeNull();
        expect(linkBtn?.getAttribute('href')).toBe(
            'http://localhost:5173/dash',
        );
        expect(linkBtn?.getAttribute('target')).toBe('_blank');

        // Check Action buttons
        const actionBtns = card?.querySelectorAll('.sync-action-cmd-btn');
        expect(actionBtns).toHaveLength(2);
        expect(actionBtns?.[0].textContent).toBe('Run E2E');
        expect(actionBtns?.[0].classList.contains('style-primary')).toBe(true);
        expect(actionBtns?.[1].textContent).toBe('Stage Git');
    });

    it('clicks preview button to trigger MarkdownManager.previewFile', async () => {
        const app = buildAppStub();
        const mgr = new SyncManager(app);

        const messages = [
            {
                key: 'test:file',
                value: JSON.stringify({
                    preview: 'docs/architecture.png',
                }),
                updated_at: new Date().toISOString(),
            },
        ];

        mgr.renderMessages(messages);
        await new Promise((r) => setTimeout(r, 0));

        const previewBtn = mgr.messagesList.querySelector('.sync-preview-btn');
        previewBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));

        expect(app.markdownManager.previewFile).toHaveBeenCalledTimes(1);
        expect(app.markdownManager.previewFile).toHaveBeenCalledWith(
            { path: 'docs/architecture.png', name: 'architecture.png' },
            '/home/user/project',
        );
    });

    it('clicks command button to send input to tabManager', () => {
        const app = buildAppStub();
        const mgr = new SyncManager(app);

        const messages = [
            {
                key: 'test:actions',
                value: JSON.stringify({
                    actions: [
                        { label: 'Test Direct', command: 'npm test\r' },
                        { label: 'Test AutoCR', command: 'git status' },
                    ],
                }),
                updated_at: new Date().toISOString(),
            },
        ];

        mgr.renderMessages(messages);

        const actionBtns = mgr.messagesList.querySelectorAll(
            '.sync-action-cmd-btn',
        );
        // Click first button (explicit \r)
        actionBtns[0]?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
        );
        expect(app.tabManager.sendRawInput).toHaveBeenCalledWith('npm test\r');

        // Click second button (implicit \r appended)
        actionBtns[1]?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
        );
        expect(app.tabManager.sendRawInput).toHaveBeenCalledWith(
            'git status\r',
        );
    });

    it('clicks staged command button to set input bar value without executing', () => {
        const app = buildAppStub();
        const mgr = new SyncManager(app);

        const messages = [
            {
                key: 'test:stage',
                value: JSON.stringify({
                    actions: [
                        {
                            label: 'Review Command',
                            command: 'rm -rf /tmp/test',
                            stage: true,
                        },
                    ],
                }),
                updated_at: new Date().toISOString(),
            },
        ];

        mgr.renderMessages(messages);

        const btn = mgr.messagesList.querySelector('.sync-action-cmd-btn');
        btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(app.tabManager.sendRawInput).not.toHaveBeenCalled();
        expect(app.tabManager.inputTextArea.value).toBe('rm -rf /tmp/test');
    });

    it('does NOT automatically pop open preview or links even when auto_open is present', async () => {
        const app = buildAppStub();
        const mgr = new SyncManager(app);

        // Created 2 seconds ago (recent)
        const recentTime = new Date(Date.now() - 2000).toISOString();
        const messages = [
            {
                key: 'auto:open:key',
                value: JSON.stringify({
                    preview: 'output/result.png',
                    auto_open: true,
                }),
                created_at: recentTime,
                updated_at: recentTime,
            },
        ];

        mgr.renderMessages(messages);
        await new Promise((r) => setTimeout(r, 0));

        // Auto-open is intentionally disabled to avoid hijacking the user's workspace
        expect(app.markdownManager.previewFile).not.toHaveBeenCalled();
    });

    it('does NOT render preview button or thumbnail if file does not exist on the machine', async () => {
        const app = buildAppStub();
        mockFetch((url) => {
            if (url.includes('/api/file/asset')) {
                return { ok: false, status: 404 };
            }
            return [];
        });
        const mgr = new SyncManager(app);

        const messages = [
            {
                key: 'missing:file',
                value: JSON.stringify({
                    title: 'Missing Asset',
                    preview: 'missing/file.png',
                }),
                updated_at: new Date().toISOString(),
            },
        ];

        mgr.renderMessages(messages);
        await new Promise((r) => setTimeout(r, 0));

        const previewBtn = mgr.messagesList.querySelector('.sync-preview-btn');
        const imgThumb = mgr.messagesList.querySelector('.sync-image-thumb');
        expect(previewBtn).toBeNull();
        expect(imgThumb).toBeNull();
    });

    it('rejects client-local Windows paths (c:\\...) and does NOT render preview or thumbnail', async () => {
        const app = buildAppStub();
        const mgr = new SyncManager(app);

        const messages = [
            {
                key: 'alien:windows:path',
                value: JSON.stringify({
                    title: 'Alien Path',
                    preview: 'C:\\show_user.png',
                }),
                updated_at: new Date().toISOString(),
            },
        ];

        mgr.renderMessages(messages);
        await new Promise((r) => setTimeout(r, 0));

        const previewBtn = mgr.messagesList.querySelector('.sync-preview-btn');
        const imgThumb = mgr.messagesList.querySelector('.sync-image-thumb');
        expect(previewBtn).toBeNull();
        expect(imgThumb).toBeNull();
    });

    it('openFilePreview shows error toast when file does not exist', async () => {
        const app = buildAppStub();
        mockFetch((url) => {
            if (url.includes('/api/file/asset')) {
                return { ok: false, status: 404 };
            }
            return [];
        });
        const mgr = new SyncManager(app);

        await mgr.openFilePreview('nonexistent.txt');
        expect(app.showToast).toHaveBeenCalledWith(
            expect.stringContaining('file does not exist on this machine'),
            { type: 'error' },
        );
        expect(app.markdownManager.previewFile).not.toHaveBeenCalled();
    });

    it('automatically shows toast when toast field is present on fresh messages', () => {
        const app = buildAppStub();
        const mgr = new SyncManager(app);

        const recentTime = new Date(Date.now() - 1000).toISOString();
        const messages = [
            {
                key: 'toast:key',
                value: JSON.stringify({
                    title: 'Done',
                    toast: 'Build succeeded in 4.2s!',
                }),
                created_at: recentTime,
                updated_at: recentTime,
            },
        ];

        mgr.renderMessages(messages);

        expect(app.showToast).toHaveBeenCalledTimes(1);
        expect(app.showToast).toHaveBeenCalledWith('Build succeeded in 4.2s!', {
            type: 'info',
        });
    });

    it('renders plain text and non-action JSON in standard collapsed value container', () => {
        const app = buildAppStub();
        const mgr = new SyncManager(app);

        const messages = [
            {
                key: 'plain:text',
                value: 'Simple note to another agent',
                updated_at: '2026-09-26T12:00:02.000Z',
            },
            {
                key: 'plain:json',
                value: '{"just": "data", "num": 10}',
                updated_at: '2026-09-26T12:00:01.000Z',
            },
        ];

        mgr.renderMessages(messages);

        const cards = mgr.messagesList.querySelectorAll('.sync-card');
        expect(cards).toHaveLength(2);

        // Neither should have .sync-action-card
        expect(cards[0].querySelector('.sync-action-card')).toBeNull();
        expect(cards[1].querySelector('.sync-action-card')).toBeNull();

        // Both should have .sync-card-value.collapsed
        const val0 = cards[0].querySelector('.sync-card-value');
        expect(val0?.textContent).toBe('Simple note to another agent');
        expect(val0?.classList.contains('collapsed')).toBe(true);

        const val1 = cards[1].querySelector('.sync-card-value');
        expect(val1?.textContent).toBe('{"just": "data", "num": 10}');
        expect(val1?.classList.contains('collapsed')).toBe(true);
    });

    it('toggles raw JSON view on rich action cards', () => {
        const app = buildAppStub();
        const mgr = new SyncManager(app);

        const messages = [
            {
                key: 'toggle:raw',
                value: JSON.stringify({
                    title: 'Raw View Test',
                    preview: 'pic.png',
                }),
                updated_at: new Date().toISOString(),
            },
        ];

        mgr.renderMessages(messages);

        const card = mgr.messagesList.querySelector('.sync-card');
        const rawEl = card?.querySelector('.sync-action-raw');
        const toggleBtn = card?.querySelector('.sync-raw-toggle');

        expect(rawEl?.classList.contains('hidden')).toBe(true);

        toggleBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(rawEl?.classList.contains('hidden')).toBe(false);

        toggleBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(rawEl?.classList.contains('hidden')).toBe(true);
    });

    it('onSyncChanged debounces and calls refreshMessages', async () => {
        const app = buildAppStub();
        const mgr = new SyncManager(app);

        mgr.refreshMessages = vi.fn().mockResolvedValue(undefined);

        // Fire multiple sync-changed events rapidly
        mgr.onSyncChanged({ type: 'sync-changed', key: 'k1' });
        mgr.onSyncChanged({ type: 'sync-changed', key: 'k2' });
        mgr.onSyncChanged({ type: 'sync-changed', key: 'k3' });

        expect(mgr.refreshMessages).not.toHaveBeenCalled();

        await new Promise((r) => setTimeout(r, 100));

        // Coalesced into a single refresh
        expect(mgr.refreshMessages).toHaveBeenCalledTimes(1);
    });
});
