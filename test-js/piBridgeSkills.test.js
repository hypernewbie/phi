// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';

vi.mock('../web/chat-pi/controller.js', () => ({
    rpcChatSend: vi.fn(() => true),
    destroyRpcChat: vi.fn(),
    getPiRpcStatus: vi.fn(() => null),
    getPiRpcControls: vi.fn(() => null),
    rpcChatModels: vi.fn(() => Promise.resolve([])),
    rpcChatThinkingLevels: vi.fn(() => Promise.resolve([])),
    rpcChatSetModel: vi.fn(() => Promise.resolve()),
    rpcChatSetThinking: vi.fn(() => Promise.resolve()),
    rpcChatReset: vi.fn(() => Promise.resolve()),
    rpcChatCompact: vi.fn(() => Promise.resolve()),
    rpcChatInterrupt: vi.fn(() => Promise.resolve()),
    closePiSubagentViewer: vi.fn(() => false),
    subscribePiRpcStatus: vi.fn(() => () => {}),
}));

import { TabManager } from '../web/terminal.js';

setupDomHarness();

afterEach(() => {
    vi.clearAllMocks();
});

function bridgeTab(over = {}) {
    const ws = {};
    return {
        ws,
        _piBridgeFresh: ws,
        paneId: 'pi-pane-1',
        coder: 'pi',
        isDead: false,
        directMode: false,
        piBridge: {
            state: 'managed',
            connected: true,
            model: 'a/x',
            capabilities: ['pi.lifecycle.v1', 'pi.models.v1', 'pi.skills.v1'],
        },
        ...over,
    };
}

function harness(tab) {
    const tm = Object.create(TabManager.prototype);
    tm.presetsContainer = document.createElement('div');
    tm.presetsContainer.className = 'presets-container';
    document.body.appendChild(tm.presetsContainer);
    const dropup = document.createElement('div');
    dropup.id = 'pi-rpc-skills-dropup';
    dropup.className = 'model-presets-dropup hidden';
    document.body.appendChild(dropup);
    tm.getActiveTab = vi.fn(() => tab);
    tm.tabs = new Map([[tab.paneId, tab]]);
    tm.app = { showToast: vi.fn(), codersPresetRegistry: {} };
    tm._piBridgeSkillsRequest = 0;
    tm._piBridgeSkillsContext = null;
    tm._piBridgeSkillPending = new Map();
    tm._piBridgeSkills = null;
    tm._piBridgeSkillQuery = '';
    tm._piBridgeSkillsTruncated = false;
    tm._piBridgeSkillsUnavailable = false;
    return { tm, dropup };
}

function skillsTrigger(tm) {
    return tm.presetsContainer.querySelector('.pi-rpc-skills-trigger');
}

describe('bridge skills control', () => {
    it('shows the control only on bridge-live Pi tabs', () => {
        const live = bridgeTab();
        const liveHarness = harness(live);
        liveHarness.tm.renderPresets('pi');
        expect(skillsTrigger(liveHarness.tm)).toBeTruthy();

        const absent = bridgeTab({
            piBridge: { state: 'plain', connected: false, capabilities: [] },
        });
        const absentHarness = harness(absent);
        absentHarness.tm.renderPresets('pi');
        expect(skillsTrigger(absentHarness.tm)).toBeFalsy();

        const noCapability = bridgeTab({
            piBridge: {
                state: 'managed',
                connected: true,
                capabilities: ['pi.lifecycle.v1', 'pi.models.v1'],
            },
        });
        const noCapHarness = harness(noCapability);
        noCapHarness.tm.renderPresets('pi');
        expect(skillsTrigger(noCapHarness.tm)).toBeFalsy();
    });

    it('sends no request without the capability', async () => {
        const fetchMock = mockFetch(() => ({
            skills: [{ name: 'demo-skill', description: 'demo' }],
        }));
        global.fetch = fetchMock;
        const tab = bridgeTab({
            piBridge: {
                state: 'managed',
                connected: true,
                capabilities: ['pi.lifecycle.v1'],
            },
        });
        const { tm } = harness(tab);
        tm.renderPresets('pi');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('lists the live skills with their descriptions', async () => {
        const fetchMock = mockFetch((url) => {
            if (url.includes('/api/pi-bridge/skills?'))
                return {
                    skills: [
                        { name: 'demo-skill', description: 'demo' },
                        { name: 'other-skill', description: 'another' },
                    ],
                    truncated: false,
                    unavailable: false,
                };
            return { ok: false, status: 404 };
        });
        global.fetch = fetchMock;
        const tab = bridgeTab();
        const { tm, dropup } = harness(tab);
        tm.renderPresets('pi');
        skillsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.textContent).toContain('demo-skill');
        });
        expect(dropup.textContent).toContain('demo');
        expect(dropup.textContent).toContain('other-skill');
        expect(fetchMock).toHaveBeenCalled();
    });

    it('shows the unavailable copy when the list cannot be represented', async () => {
        const fetchMock = mockFetch(() => ({
            skills: [],
            truncated: false,
            unavailable: true,
        }));
        global.fetch = fetchMock;
        const tab = bridgeTab();
        const { tm, dropup } = harness(tab);
        tm.renderPresets('pi');
        skillsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.textContent).toContain('Pi skill list unavailable');
        });
    });

    it('posts the skill and closes the picker on success', async () => {
        const fetchMock = mockFetch((url, options) => {
            if (url.includes('/api/pi-bridge/skills?'))
                return {
                    skills: [{ name: 'demo-skill', description: 'demo' }],
                    truncated: false,
                    unavailable: false,
                };
            expect(options?.method).toBe('POST');
            expect(JSON.parse(options.body)).toEqual({
                pane: 'pi-pane-1',
                name: 'demo-skill',
            });
            return { json: { ok: true, reason: '' } };
        });
        global.fetch = fetchMock;
        const tab = bridgeTab();
        const { tm, dropup } = harness(tab);
        tm.renderPresets('pi');
        skillsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.textContent).toContain('demo-skill');
        });
        dropup.querySelector('.dropup-model-btn').click();
        await vi.waitFor(() => {
            expect(tm.app.showToast).toHaveBeenCalled();
        });
        expect(dropup.classList.contains('hidden')).toBe(true);
    });

    it('toasts the refusal reason and keeps the picker open', async () => {
        const fetchMock = mockFetch((url) => {
            if (
                url.includes('/api/pi-bridge/skill') &&
                !url.includes('/api/pi-bridge/skills?')
            )
                return { json: { ok: false, reason: 'unknown-skill' } };
            return {
                skills: [{ name: 'demo-skill', description: 'demo' }],
                truncated: false,
                unavailable: false,
            };
        });
        global.fetch = fetchMock;
        const tab = bridgeTab();
        const { tm, dropup } = harness(tab);
        tm.renderPresets('pi');
        skillsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.textContent).toContain('demo-skill');
        });
        dropup.querySelector('.dropup-model-btn').click();
        await vi.waitFor(() => {
            expect(tm.app.showToast).toHaveBeenCalled();
        });
        const message = tm.app.showToast.mock.calls.at(-1)[0];
        expect(message).toContain('unknown-skill');
        expect(dropup.classList.contains('hidden')).toBe(false);
    });

    it('reports an unknown outcome when the invoke round trip fails', async () => {
        const fetchMock = mockFetch((url) => {
            if (
                url.includes('/api/pi-bridge/skill') &&
                !url.includes('/api/pi-bridge/skills?')
            )
                throw new Error('offline');
            return {
                skills: [{ name: 'demo-skill', description: 'demo' }],
                truncated: false,
                unavailable: false,
            };
        });
        global.fetch = fetchMock;
        const tab = bridgeTab();
        const { tm, dropup } = harness(tab);
        tm.renderPresets('pi');
        skillsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.textContent).toContain('demo-skill');
        });
        dropup.querySelector('.dropup-model-btn').click();
        await vi.waitFor(() => {
            expect(tm.app.showToast).toHaveBeenCalled();
        });
        expect(tm.app.showToast.mock.calls.at(-1)[0]).toContain('unknown');
        // A failed invoke is never retried automatically.
        const invokes = fetchMock.mock.calls.filter((call) => {
            const url = String(call[0]);
            return (
                url.includes('/api/pi-bridge/skill') &&
                !url.includes('/api/pi-bridge/skills?')
            );
        });
        expect(invokes).toHaveLength(1);
    });
});

describe('bridge skills loss and reconnect', () => {
    it('closes the picker and drops a late reply when the peer is lost', async () => {
        let release;
        const fetchMock = mockFetch(
            (url) =>
                new Promise((resolve) => {
                    release = () =>
                        resolve({
                            skills: [
                                { name: 'demo-skill', description: 'demo' },
                            ],
                            truncated: false,
                            unavailable: false,
                        });
                }),
        );
        global.fetch = fetchMock;
        const tab = bridgeTab();
        const { tm, dropup } = harness(tab);
        tm.renderPresets('pi');
        skillsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.textContent).toContain('Loading');
        });

        // The peer goes away while the list is in flight.
        tab.piBridge.connected = false;
        tm.renderPresets('pi');
        expect(dropup.classList.contains('hidden')).toBe(true);

        release();
        await new Promise((r) => setTimeout(r, 10));
        // The late reply must not repopulate the closed picker.
        expect(dropup.textContent).not.toContain('demo-skill');
    });

    it('ignores a click on a detached row after eligibility is lost', async () => {
        const fetchMock = mockFetch(() => ({
            skills: [{ name: 'demo-skill', description: 'demo' }],
            truncated: false,
            unavailable: false,
        }));
        global.fetch = fetchMock;
        const tab = bridgeTab();
        const { tm, dropup } = harness(tab);
        tm.renderPresets('pi');
        skillsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.textContent).toContain('demo-skill');
        });
        const row = dropup.querySelector('.dropup-model-btn');
        const callsBefore = fetchMock.mock.calls.length;

        tab.piBridge.connected = false;
        tm.renderPresets('pi');
        row.click();
        await new Promise((r) => setTimeout(r, 10));
        // No invoke request, no error toast: the bridge is simply gone.
        expect(fetchMock.mock.calls.length).toBe(callsBefore);
        expect(tm.app.showToast).not.toHaveBeenCalled();
    });

    it('works again after the capability returns', async () => {
        const fetchMock = mockFetch(() => ({
            skills: [{ name: 'demo-skill', description: 'demo' }],
            truncated: false,
            unavailable: false,
        }));
        global.fetch = fetchMock;
        const tab = bridgeTab();
        const { tm, dropup } = harness(tab);

        tab.piBridge.connected = false;
        tm.renderPresets('pi');
        expect(skillsTrigger(tm)).toBeFalsy();

        tab.piBridge.connected = true;
        tm.renderPresets('pi');
        expect(skillsTrigger(tm)).toBeTruthy();
        skillsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.textContent).toContain('demo-skill');
        });
    });
});

describe('bridge skills runtime fencing', () => {
    function invokeMock() {
        let release;
        const fetchMock = mockFetch((url) => {
            if (
                url.includes('/api/pi-bridge/skill') &&
                !url.includes('/api/pi-bridge/skills?')
            )
                return new Promise((resolve) => {
                    release = () => resolve({ ok: false, status: 503 });
                });
            return {
                skills: [{ name: 'demo-skill', description: 'demo' }],
                truncated: false,
                unavailable: false,
            };
        });
        return {
            fetchMock,
            release: () => release(),
            started: () => release !== undefined,
            invokes: () =>
                fetchMock.mock.calls.filter((call) => {
                    const url = String(call[0]);
                    return (
                        url.includes('/api/pi-bridge/skill') &&
                        !url.includes('/api/pi-bridge/skills?')
                    );
                }),
        };
    }

    it('reports an unknown outcome once when the peer is lost mid-dispatch', async () => {
        const io = invokeMock();
        global.fetch = io.fetchMock;
        const tab = bridgeTab();
        const { tm, dropup } = harness(tab);
        tm.renderPresets('pi');
        skillsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.textContent).toContain('demo-skill');
        });
        dropup.querySelector('.dropup-model-btn').click();
        await vi.waitFor(() => {
            expect(io.started()).toBe(true);
        });

        // The peer goes away while the dispatch is still in flight.
        tab.piBridge.connected = false;
        tm.renderPresets('pi');
        expect(dropup.classList.contains('hidden')).toBe(true);

        // The bridge answers with a failure: the skill may still have
        // landed, so the outcome is unknown, not refused.
        io.release();
        await vi.waitFor(() => {
            expect(tm.app.showToast).toHaveBeenCalled();
        });
        expect(tm.app.showToast.mock.calls.at(-1)[0]).toContain('unknown');
        // An uncertain dispatch is never resent.
        expect(io.invokes()).toHaveLength(1);
    });

    it('stays silent when the socket is replaced mid-dispatch', async () => {
        const io = invokeMock();
        global.fetch = io.fetchMock;
        const tab = bridgeTab();
        const { tm, dropup } = harness(tab);
        tm.renderPresets('pi');
        skillsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.textContent).toContain('demo-skill');
        });
        dropup.querySelector('.dropup-model-btn').click();
        await vi.waitFor(() => {
            expect(io.started()).toBe(true);
        });

        // A new browser socket replaces the runtime that received the
        // dispatch: the waiter is stale and settles silently.
        tab.ws = {};
        tab._piBridgeFresh = tab.ws;
        io.release();
        await new Promise((r) => setTimeout(r, 10));
        expect(tm.app.showToast).not.toHaveBeenCalled();
        expect(io.invokes()).toHaveLength(1);
    });

    it('drops a list reply that belongs to a replaced socket', async () => {
        let release;
        const fetchMock = mockFetch(
            () =>
                new Promise((resolve) => {
                    release = () =>
                        resolve({
                            skills: [
                                { name: 'demo-skill', description: 'demo' },
                            ],
                            truncated: false,
                            unavailable: false,
                        });
                }),
        );
        global.fetch = fetchMock;
        const tab = bridgeTab();
        const { tm, dropup } = harness(tab);
        tm.renderPresets('pi');
        skillsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.textContent).toContain('Loading');
        });

        // The browser socket is replaced while the list is in flight.
        tab.ws = {};
        tab._piBridgeFresh = null;
        tm.renderPresets('pi');

        release();
        await new Promise((r) => setTimeout(r, 10));
        // The late reply must not populate the new runtime's picker.
        expect(dropup.textContent).not.toContain('demo-skill');
    });

    it('ignores a row click after the runtime generation moved', async () => {
        const fetchMock = mockFetch(() => ({
            skills: [{ name: 'demo-skill', description: 'demo' }],
            truncated: false,
            unavailable: false,
        }));
        global.fetch = fetchMock;
        const tab = bridgeTab();
        const { tm, dropup } = harness(tab);
        tm.renderPresets('pi');
        skillsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.textContent).toContain('demo-skill');
        });
        const row = dropup.querySelector('.dropup-model-btn');
        const callsBefore = fetchMock.mock.calls.length;

        // The runtime was replaced: the retained rows are stale.
        tab.piBridge.generation = '2';
        row.click();
        await new Promise((r) => setTimeout(r, 10));
        expect(fetchMock.mock.calls.length).toBe(callsBefore);
        expect(tm.app.showToast).not.toHaveBeenCalled();
    });
});
