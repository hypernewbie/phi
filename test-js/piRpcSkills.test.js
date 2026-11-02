// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';

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
import { getPiRpcControls, rpcChatSend } from '../web/chat-pi/controller.js';

setupDomHarness();

afterEach(() => {
    vi.clearAllMocks();
});

// The Pi (term) tab gets a Skills picker from the bridge. The RPC pane
// owns the same knob from its control state: the session publishes skill
// command names, and a pick sends /name through the prompt path.
function rpcTab(over = {}) {
    return {
        paneId: 'pi-rpc:/work/demo',
        coder: 'pi-rpc',
        isDead: false,
        directMode: false,
        ...over,
    };
}

function harness(tab, controls) {
    getPiRpcControls.mockReturnValue(controls ?? null);
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
    tm._piRpcCompactPending = new Set();
    tm._piRpcResetPending = new Set();
    tm._piRpcSkillQuery = '';
    tm._setPiRpcActionVisibility = vi.fn();
    tm._sendPiRpcCompact = vi.fn();
    tm._onPiRpcResetResult = vi.fn();
    tm._piRpcError = vi.fn();
    tm._toggleDropup = vi.fn();
    tm.renderPresets('pi-rpc');
    return { tm, dropup };
}

const readyControls = (skills) => ({
    ready: true,
    exited: false,
    busy: false,
    queueDepth: 0,
    hasTranscript: true,
    model: 'pi-4',
    thinking: 'high',
    skills,
});

describe('pi rpc skills control', () => {
    it('renders the knob only when the session published skills', () => {
        const withSkills = harness(rpcTab(), readyControls(['rpe', 'tao']));
        const trigger = withSkills.tm.presetsContainer.querySelector(
            '.pi-rpc-skills-trigger',
        );
        expect(trigger).toBeTruthy();
        expect(trigger.textContent).toBe('Skills ▾');
        expect(trigger.disabled).toBe(false);

        const empty = harness(rpcTab(), readyControls([]));
        expect(
            empty.tm.presetsContainer.querySelector('.pi-rpc-skills-trigger'),
        ).toBeNull();

        const offline = harness(rpcTab(), {
            ...readyControls(['rpe']),
            ready: false,
            exited: true,
        });
        const dead = offline.tm.presetsContainer.querySelector(
            '.pi-rpc-skills-trigger',
        );
        expect(dead.disabled).toBe(true);
    });

    it('lists, filters, and sends /name through the prompt path', async () => {
        const { tm, dropup } = harness(
            rpcTab(),
            readyControls(['rpe', 'tao-en', 'ste']),
        );
        tm._renderPiRpcSkillsDropup();
        // The trigger unhides through _toggleDropup, stubbed here.
        dropup.classList.remove('hidden');
        expect(dropup.classList.contains('hidden')).toBe(false);
        const rows = [...dropup.querySelectorAll('.dropup-model-btn')].map(
            (btn) => btn.textContent,
        );
        expect(rows).toEqual(['rpe', 'tao-en', 'ste']);

        const search = dropup.querySelector('.pi-rpc-model-search');
        search.value = 'tao';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        const filtered = [...dropup.querySelectorAll('.dropup-model-btn')].map(
            (btn) => btn.textContent,
        );
        expect(filtered).toEqual(['tao-en']);

        dropup.querySelector('.dropup-model-btn')?.click();
        expect(rpcChatSend).toHaveBeenCalledWith(
            'pi-rpc:/work/demo',
            '/tao-en',
        );
    });
});
