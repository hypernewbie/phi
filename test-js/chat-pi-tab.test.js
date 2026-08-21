// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../web/chat-pi/controller.js', () => ({
    mountRpcChat: vi.fn(),
}));

import { mountRpcChat } from '../web/chat-pi/controller.js';
import { openPiRpcChatTab } from '../web/chat-pi/tab.js';

describe('openPiRpcChatTab', () => {
    beforeEach(() => vi.clearAllMocks());

    it('creates one client tab per cwd and switches on repeat', () => {
        const tabs = new Map();
        const createTab = vi.fn((paneId) => {
            tabs.set(paneId, { termContainer: document.createElement('div') });
        });
        const switchTab = vi.fn();
        const manager = { tabs, createTab, switchTab };

        openPiRpcChatTab(manager, '/work/demo');
        expect(createTab).toHaveBeenCalledWith(
            'pi-rpc:/work/demo',
            '',
            'Pi RPC · demo',
            'pi-rpc',
            '',
            '/work/demo',
        );
        expect(mountRpcChat).toHaveBeenCalledWith(
            'pi-rpc:/work/demo',
            expect.any(HTMLElement),
            '/work/demo',
        );

        openPiRpcChatTab(manager, '/work/demo');
        expect(createTab).toHaveBeenCalledTimes(1);
        expect(switchTab).toHaveBeenCalledWith('pi-rpc:/work/demo');
    });

    it('uses Phi terminal font settings for the Pi RPC container', () => {
        const tabs = new Map();
        const container = document.createElement('div');
        const createTab = vi.fn((paneId) => {
            tabs.set(paneId, { termContainer: container });
        });
        const manager = {
            app: {
                sessionsManager: { activeWorkspace: '/work' },
                terminalFontFamily: 'Iosevka Term, monospace',
                terminalFontSize: 19,
            },
            tabs,
            createTab,
            switchTab: vi.fn(),
        };

        openPiRpcChatTab(manager, '/work/demo');

        expect(container.style.fontFamily).toContain('Iosevka Term');
        expect(container.style.fontSize).toBe('19px');
    });

    it('keys resumed tabs by exact session path and keeps historical titles', () => {
        const tabs = new Map();
        const createTab = vi.fn((paneId, _sid, title) => {
            tabs.set(paneId, { termContainer: document.createElement('div') });
            expect(title).toMatch(/Historical/);
        });
        const switchTab = vi.fn();
        const manager = { tabs, createTab, switchTab };
        const firstPath = '/work/demo/.pi/session one.jsonl';
        const secondPath = '/work/demo/.pi/session-two.jsonl';

        openPiRpcChatTab(manager, '/work/demo', firstPath, 'Historical one');
        openPiRpcChatTab(manager, '/work/demo', secondPath, 'Historical two');
        openPiRpcChatTab(manager, '/work/demo', firstPath, 'Historical one');

        expect(createTab).toHaveBeenCalledTimes(2);
        expect(createTab).toHaveBeenNthCalledWith(
            1,
            `pi-rpc:session:${encodeURIComponent(firstPath)}`,
            '',
            'Historical one',
            'pi-rpc',
            '',
            '/work/demo',
        );
        expect(createTab).toHaveBeenNthCalledWith(
            2,
            `pi-rpc:session:${encodeURIComponent(secondPath)}`,
            '',
            'Historical two',
            'pi-rpc',
            '',
            '/work/demo',
        );
        expect(switchTab).toHaveBeenCalledWith(
            `pi-rpc:session:${encodeURIComponent(firstPath)}`,
        );
        expect(mountRpcChat).toHaveBeenNthCalledWith(
            1,
            `pi-rpc:session:${encodeURIComponent(firstPath)}`,
            expect.any(HTMLElement),
            '/work/demo',
            firstPath,
        );
    });
});
