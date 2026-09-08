// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';

vi.mock('../web/chat-pi/controller.js', () => ({
    mountRpcChat: vi.fn(),
    rpcChatSend: vi.fn(),
    destroyRpcChat: vi.fn(),
    getPiRpcStatus: vi.fn(() => null),
    getPiRpcControls: vi.fn(() => null),
    rpcChatModels: vi.fn(),
    rpcChatThinkingLevels: vi.fn(),
    rpcChatSetModel: vi.fn(),
    rpcChatSetThinking: vi.fn(),
    rpcChatReset: vi.fn(),
    rpcChatCompact: vi.fn(),
    rpcChatInterrupt: vi.fn(),
    closePiSubagentViewer: vi.fn(),
    rpcChatSetName: vi.fn(),
    subscribePiRpcStatus: vi.fn(() => () => {}),
    syncPiSubagentStrip: vi.fn(),
}));

import { TabManager } from '../web/terminal.js';
import { mountRpcChat } from '../web/chat-pi/controller.js';

setupDomHarness();

// Pi RPC tab persistence: a fresh UUID pane becomes durable the moment the
// backend publishes its file-backed session path, an explicit null (Clear)
// never falls back to a legacy pane-ID path, and restore feeds the exact
// stored path into both createTab and mountRpcChat.

function makeTm() {
    const tm = Object.create(TabManager.prototype);
    tm.tabs = new Map();
    tm.app = {};
    return tm;
}

function savedTabs() {
    const raw = localStorage.getItem('phi_pi_rpc_tabs');
    return raw ? JSON.parse(raw) : null;
}

describe('savePiRpcTabs', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.clearAllMocks();
    });

    it('saves a random fresh pane with its durable stored session path', () => {
        const tm = makeTm();
        tm.tabs.set('pi-rpc:9c1f0e11-1111', {
            paneId: 'pi-rpc:9c1f0e11-1111',
            coder: 'pi-rpc',
            cwd: '/w',
            title: 'Pi RPC · w',
            workspace: '',
            sessionPath: '/w/.pi/a.jsonl',
        });
        tm.savePiRpcTabs();
        expect(savedTabs()).toEqual([
            {
                paneId: 'pi-rpc:9c1f0e11-1111',
                cwd: '/w',
                title: 'Pi RPC · w',
                workspace: '',
                sessionPath: '/w/.pi/a.jsonl',
            },
        ]);
    });

    it('migrates a legacy path-based pane without the sessionPath property', () => {
        const tm = makeTm();
        const legacyPath = '/w/.pi/legacy.jsonl';
        tm.tabs.set(`pi-rpc:session:${encodeURIComponent(legacyPath)}`, {
            paneId: `pi-rpc:session:${encodeURIComponent(legacyPath)}`,
            coder: 'pi-rpc',
            cwd: '/w',
            title: 'Legacy',
            workspace: '',
        });
        tm.savePiRpcTabs();
        expect(savedTabs()[0].sessionPath).toBe(legacyPath);
    });

    it('does not fall back to the pane ID when sessionPath is explicitly null', () => {
        const tm = makeTm();
        const oldPath = '/w/.pi/cleared.jsonl';
        tm.tabs.set(`pi-rpc:session:${encodeURIComponent(oldPath)}`, {
            paneId: `pi-rpc:session:${encodeURIComponent(oldPath)}`,
            coder: 'pi-rpc',
            cwd: '/w',
            title: 'Cleared',
            workspace: '',
            sessionPath: null,
        });
        tm.savePiRpcTabs();
        expect(savedTabs()[0].sessionPath).toBeNull();
    });
});

describe('restorePiRpcTabs', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.clearAllMocks();
    });

    function stubCreateTab(tm) {
        tm.createTab = vi.fn((paneId) => {
            tm.tabs.set(paneId, {
                paneId,
                coder: 'pi-rpc',
                termContainer: document.createElement('div'),
            });
        });
    }

    it('passes a stored random-pane session path to createTab and mountRpcChat', () => {
        localStorage.setItem(
            'phi_pi_rpc_tabs',
            JSON.stringify([
                {
                    paneId: 'pi-rpc:9c1f0e11-1111',
                    cwd: '/w',
                    title: 'Pi RPC · w',
                    workspace: '',
                    sessionPath: '/w/.pi/a.jsonl',
                },
            ]),
        );
        const tm = makeTm();
        stubCreateTab(tm);
        tm.restorePiRpcTabs();
        expect(tm.createTab).toHaveBeenCalledWith(
            'pi-rpc:9c1f0e11-1111',
            '',
            'Pi RPC · w',
            'pi-rpc',
            '',
            '/w',
            true,
            false,
            '',
            '/w/.pi/a.jsonl',
        );
        expect(mountRpcChat).toHaveBeenCalledWith(
            'pi-rpc:9c1f0e11-1111',
            expect.any(HTMLElement),
            '/w',
            '/w/.pi/a.jsonl',
        );
    });

    it('mounts a fresh chat when the stored path is null', () => {
        localStorage.setItem(
            'phi_pi_rpc_tabs',
            JSON.stringify([
                {
                    paneId: 'pi-rpc:9c1f0e11-2222',
                    cwd: '/w',
                    title: 'Pi RPC · w',
                    workspace: '',
                    sessionPath: null,
                },
            ]),
        );
        const tm = makeTm();
        stubCreateTab(tm);
        tm.restorePiRpcTabs();
        expect(tm.createTab).toHaveBeenCalledWith(
            'pi-rpc:9c1f0e11-2222',
            '',
            'Pi RPC · w',
            'pi-rpc',
            '',
            '/w',
            true,
            false,
            '',
            null,
        );
        expect(mountRpcChat).toHaveBeenCalledWith(
            'pi-rpc:9c1f0e11-2222',
            expect.any(HTMLElement),
            '/w',
        );
        expect(mountRpcChat.mock.calls[0]).toHaveLength(3);
    });
});

describe('_promotePiRpcSessionPath', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.clearAllMocks();
    });

    it('promotes a published path onto the tab and saves only on change', () => {
        const tm = makeTm();
        const tab = {
            paneId: 'pi-rpc:fresh',
            coder: 'pi-rpc',
            sessionPath: null,
        };
        tm.tabs.set('pi-rpc:fresh', tab);
        tm.savePiRpcTabs = vi.fn();

        tm._promotePiRpcSessionPath('pi-rpc:fresh', {
            sessionPath: '/w/.pi/first-reply.jsonl',
        });
        expect(tab.sessionPath).toBe('/w/.pi/first-reply.jsonl');
        expect(tm.savePiRpcTabs).toHaveBeenCalledTimes(1);

        // Same path again: no additional save.
        tm._promotePiRpcSessionPath('pi-rpc:fresh', {
            sessionPath: '/w/.pi/first-reply.jsonl',
        });
        expect(tm.savePiRpcTabs).toHaveBeenCalledTimes(1);
    });

    it('ignores empty paths and non-pi-rpc panes', () => {
        const tm = makeTm();
        const other = { paneId: 'pty-1', coder: 'bash' };
        tm.tabs.set('pty-1', other);
        tm.savePiRpcTabs = vi.fn();

        tm._promotePiRpcSessionPath('pty-1', { sessionPath: '/x.jsonl' });
        tm._promotePiRpcSessionPath('pi-rpc:missing', {
            sessionPath: '/x.jsonl',
        });
        tm._promotePiRpcSessionPath('pty-1', {});
        expect(tm.savePiRpcTabs).not.toHaveBeenCalled();
        expect(other.sessionPath).toBeUndefined();
    });
});

describe('_onPiRpcResetResult', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.clearAllMocks();
    });

    it('clears the saved tab path on an accepted reset', () => {
        const tm = makeTm();
        const tab = {
            paneId: 'pi-rpc:session:%2Fw%2F.pi%2Fold.jsonl',
            coder: 'pi-rpc',
            sessionPath: '/w/.pi/old.jsonl',
        };
        tm.tabs.set(tab.paneId, tab);

        tm._onPiRpcResetResult(tab.paneId, { cancelled: false, reset: true });
        expect(tab.sessionPath).toBeNull();
        expect(savedTabs()[0].sessionPath).toBeNull();
    });

    it('keeps the saved tab path when Pi cancels the reset', () => {
        const tm = makeTm();
        const paneId = 'pi-rpc:fresh';
        const tab = {
            paneId,
            coder: 'pi-rpc',
            sessionPath: '/w/.pi/old.jsonl',
        };
        tm.tabs.set(paneId, tab);
        tm.savePiRpcTabs = vi.fn();

        tm._onPiRpcResetResult(paneId, { cancelled: true });
        expect(tab.sessionPath).toBe('/w/.pi/old.jsonl');
        expect(tm.savePiRpcTabs).not.toHaveBeenCalled();
    });
});
