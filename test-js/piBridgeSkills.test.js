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
            generation: '1',
            capabilities: ['pi.lifecycle.v1', 'pi.models.v1', 'pi.skills.v1'],
        },
        ...over,
    };
}

// The skill list answers with the origin of the peer that served it.
// A click must carry that origin back to the bridge.
function skillList(extra = {}) {
    return {
        skills: [{ name: 'demo-skill', description: 'demo' }],
        truncated: false,
        unavailable: false,
        process_id: 'proc-1',
        generation: '1',
        ...extra,
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
        const fetchMock = mockFetch(() => skillList());
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
                return skillList({
                    skills: [
                        { name: 'demo-skill', description: 'demo' },
                        { name: 'other-skill', description: 'another' },
                    ],
                });
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
        const fetchMock = mockFetch(() =>
            skillList({ skills: [], unavailable: true }),
        );
        global.fetch = fetchMock;
        const tab = bridgeTab();
        const { tm, dropup } = harness(tab);
        tm.renderPresets('pi');
        skillsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.textContent).toContain('Pi skill list unavailable');
        });
    });

    it('shows the empty copy when the session knows no skill', async () => {
        const fetchMock = mockFetch(() => skillList({ skills: [] }));
        global.fetch = fetchMock;
        const tab = bridgeTab();
        const { tm, dropup } = harness(tab);
        tm.renderPresets('pi');
        skillsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.textContent).toContain('No Pi skills available');
        });
    });

    it('marks a partial list', async () => {
        const fetchMock = mockFetch(() => skillList({ truncated: true }));
        global.fetch = fetchMock;
        const tab = bridgeTab();
        const { tm, dropup } = harness(tab);
        tm.renderPresets('pi');
        skillsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.textContent).toContain('Partial skill list');
        });
    });

    it('posts the skill with the list origin and closes the picker on success', async () => {
        const fetchMock = mockFetch((url, options) => {
            if (url.includes('/api/pi-bridge/skills?')) return skillList();
            expect(options?.method).toBe('POST');
            expect(JSON.parse(options.body)).toEqual({
                pane: 'pi-pane-1',
                name: 'demo-skill',
                process_id: 'proc-1',
                generation: '1',
            });
            return { json: { ok: true, reason: '' } };
        });
        global.fetch = fetchMock;
        const tab = bridgeTab();
        // The browser view lags the bridge: the origin of the answer
        // is what the click must carry.
        tab.piBridge.generation = '77';
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
            return skillList();
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
            return skillList();
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
            () =>
                new Promise((resolve) => {
                    release = () => resolve(skillList());
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
        const fetchMock = mockFetch(() => skillList());
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
        const fetchMock = mockFetch(() => skillList());
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
    // The list carries the origin of the peer that served it, so the
    // mock follows the runtime the browser currently sees.
    function invokeMock(tab) {
        let release;
        const fetchMock = mockFetch((url) => {
            if (
                url.includes('/api/pi-bridge/skill') &&
                !url.includes('/api/pi-bridge/skills?')
            )
                return new Promise((resolve) => {
                    release = () => resolve({ ok: false, status: 503 });
                });
            return skillList({ generation: tab.piBridge.generation });
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
        const tab = bridgeTab();
        const io = invokeMock(tab);
        global.fetch = io.fetchMock;
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

    it('reports an unknown outcome once when the socket is replaced mid-dispatch', async () => {
        const tab = bridgeTab();
        const io = invokeMock(tab);
        global.fetch = io.fetchMock;
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
        // dispatch. The dispatch may still have landed, so the outcome
        // is unknown and the user learns it exactly once.
        tab.ws = {};
        tab._piBridgeFresh = tab.ws;
        io.release();
        await vi.waitFor(() => {
            expect(tm.app.showToast).toHaveBeenCalled();
        });
        expect(tm.app.showToast.mock.calls.at(-1)[0]).toContain('unknown');
        // An uncertain dispatch is never resent.
        expect(io.invokes()).toHaveLength(1);
    });

    it('drops a list reply that belongs to a replaced socket', async () => {
        let release;
        const fetchMock = mockFetch(
            () =>
                new Promise((resolve) => {
                    release = () => resolve(skillList());
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
        const fetchMock = mockFetch(() => skillList());
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

    it('refuses a stale origin instead of claiming an unknown outcome', async () => {
        const fetchMock = mockFetch((url) => {
            if (
                url.includes('/api/pi-bridge/skill') &&
                !url.includes('/api/pi-bridge/skills?')
            )
                return { json: { ok: false, reason: 'unavailable' } };
            return skillList();
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
        // The bridge refused before dispatch: the outcome is known.
        expect(tm.app.showToast.mock.calls.at(-1)[0]).toContain('unavailable');
        expect(tm.app.showToast.mock.calls.at(-1)[0]).not.toContain('unknown');
        // A refused dispatch is never resent.
        const invokes = fetchMock.mock.calls.filter((call) => {
            const url = String(call[0]);
            return (
                url.includes('/api/pi-bridge/skill') &&
                !url.includes('/api/pi-bridge/skills?')
            );
        });
        expect(invokes).toHaveLength(1);
    });

    it('keeps the rows when the browser view lags the answering runtime', async () => {
        const tab = bridgeTab();
        const fetchMock = mockFetch((url) => {
            if (
                url.includes('/api/pi-bridge/skill') &&
                !url.includes('/api/pi-bridge/skills?')
            )
                return { json: { ok: true, reason: '' } };
            // The peer moved on: the answer names generation 2 while
            // the browser still shows generation 1.
            return skillList({ generation: '2' });
        });
        global.fetch = fetchMock;
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
        // The click carries the origin of the answer, not the browser's
        // lagging view.
        const invoke = fetchMock.mock.calls.find((call) => {
            const url = String(call[0]);
            return (
                url.includes('/api/pi-bridge/skill') &&
                !url.includes('/api/pi-bridge/skills?')
            );
        });
        expect(JSON.parse(invoke[1].body).generation).toBe('2');
    });

    it('does not lock the rows of a replacement runtime', async () => {
        const tab = bridgeTab();
        const io = invokeMock(tab);
        global.fetch = io.fetchMock;
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

        // The runtime is replaced while the dispatch is still in flight.
        tab.piBridge.generation = '2';
        tm.renderPresets('pi');
        skillsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.textContent).toContain('demo-skill');
        });
        // The older runtime's dispatch must not disable the new rows.
        expect(dropup.querySelector('.dropup-model-btn').disabled).toBe(false);
    });

    it('keeps a list answer that arrives after the runtime moved on', async () => {
        let release;
        const fetchMock = mockFetch(
            () =>
                new Promise((resolve) => {
                    release = () => resolve(skillList({ generation: '2' }));
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

        // The bridge publishes the next generation while the answer is
        // still in flight: the browser's view moves on before the
        // answer names the runtime that served it.
        tab.piBridge.generation = '2';
        tm.renderPresets('pi');

        release();
        await vi.waitFor(() => {
            expect(dropup.textContent).toContain('demo-skill');
        });
    });

    it('restores the control when a skills-only peer confirms a new socket', () => {
        const tab = bridgeTab({
            piBridge: {
                state: 'managed',
                connected: true,
                model: 'a/x',
                generation: '1',
                capabilities: ['pi.lifecycle.v1', 'pi.skills.v1'],
            },
        });
        const { tm } = harness(tab);
        const live = { ...tab.piBridge, telemetry_revision: '3' };
        tm._acceptPiBridgeState(tab, live);
        tm.renderPresets('pi');
        expect(skillsTrigger(tm)).toBeTruthy();

        // A new browser socket drops freshness until the current
        // socket confirms the state again.
        tm._setCurrentTabSocket(tab, {});
        expect(skillsTrigger(tm)).toBeFalsy();

        // The confirmation brings the control back: the presets row
        // moves with the skills capability, not only with the other
        // bridge capabilities.
        tm._acceptPiBridgeState(tab, live);
        expect(skillsTrigger(tm)).toBeTruthy();
    });

    it('bounds a stalled skill request', async () => {
        vi.useFakeTimers();
        try {
            const fetchMock = vi.fn((url, options) => {
                if (String(url).includes('/api/pi-bridge/skills?'))
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => skillList(),
                    });
                // The invoke never answers: only the browser deadline
                // ends it.
                return new Promise((_resolve, reject) => {
                    options?.signal?.addEventListener('abort', () => {
                        const error = new Error('aborted');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
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
            await vi.advanceTimersByTimeAsync(10001);
            await vi.waitFor(() => {
                expect(tm.app.showToast).toHaveBeenCalled();
            });
            // The deadline makes the outcome unknown, never a resend.
            expect(tm.app.showToast.mock.calls.at(-1)[0]).toContain('unknown');
            const invokes = fetchMock.mock.calls.filter((call) => {
                const url = String(call[0]);
                return (
                    url.includes('/api/pi-bridge/skill') &&
                    !url.includes('/api/pi-bridge/skills?')
                );
            });
            expect(invokes).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('lists no rows when the answer carries no origin', async () => {
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
            expect(dropup.textContent).toContain('Pi skill list unavailable');
        });
        // No row can be dispatched without an origin, so none is shown.
        expect(dropup.querySelector('.dropup-model-btn')).toBeFalsy();
    });
});

describe('bridge skills offline behavior', () => {
    it('keeps the last good list when the picker is reopened', async () => {
        let calls = 0;
        const fetchMock = mockFetch((url) => {
            if (!url.includes('/api/pi-bridge/skills?')) return skillList();
            calls += 1;
            // The first answer lands; the refresh that follows fails.
            if (calls === 1) return skillList();
            return { ok: false, status: 503 };
        });
        global.fetch = fetchMock;
        const tab = bridgeTab();
        const { tm, dropup } = harness(tab);
        tm.renderPresets('pi');
        skillsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.textContent).toContain('demo-skill');
        });

        // The picker closes; the answer stays.
        tm._closePiRpcDropups(true);
        expect(dropup.textContent).not.toContain('demo-skill');

        // Reopening shows the last good answer at once: no spinner, no
        // wait for the network.
        skillsTrigger(tm).click();
        expect(dropup.textContent).toContain('demo-skill');
        expect(dropup.textContent).not.toContain('Loading');

        // The failed refresh keeps the list and says it may be stale.
        await vi.waitFor(() => {
            expect(dropup.textContent).toContain('Refresh failed');
        });
        expect(dropup.textContent).toContain('demo-skill');

        // Filtering rebuilds the rows. The warning is state, so it
        // stays: the rows are still the last known ones.
        const filter = dropup.querySelector('.pi-rpc-model-search');
        filter.value = 'demo';
        filter.dispatchEvent(new Event('input'));
        expect(dropup.textContent).toContain('demo-skill');
        expect(dropup.textContent).toContain('Refresh failed');
    });

    it('bounds a stalled skill list request', async () => {
        vi.useFakeTimers();
        try {
            const fetchMock = vi.fn((url, options) => {
                // The list never answers: only the browser deadline
                // ends it.
                return new Promise((_resolve, reject) => {
                    options?.signal?.addEventListener('abort', () => {
                        const error = new Error('aborted');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            });
            global.fetch = fetchMock;
            const tab = bridgeTab();
            const { tm, dropup } = harness(tab);
            tm.renderPresets('pi');
            skillsTrigger(tm).click();
            expect(dropup.textContent).toContain('Loading');
            await vi.advanceTimersByTimeAsync(5001);
            await vi.waitFor(() => {
                expect(dropup.textContent).toContain('timed out');
            });
        } finally {
            vi.useRealTimers();
        }
    });
});
