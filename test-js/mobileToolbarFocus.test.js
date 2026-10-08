// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';

setupDomHarness();
afterEach(() => vi.unstubAllGlobals());

function mobileManager() {
    vi.stubGlobal('matchMedia', (query) => ({
        matches: query.includes('pointer: coarse'),
    }));
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    const tab = { coder: 'bash', directMode: false };
    const manager = Object.assign(Object.create(TabManager.prototype), {
        inputTextArea: input,
        getActiveTab: () => tab,
        sendInput: vi.fn(() => true),
        _spamScrollToBottom: vi.fn(),
        focusActiveTerminal: vi.fn(),
        tabs: new Map(),
        activePaneId: 'pane',
        app: {
            quickCommands: [],
            codersPresetRegistry: {
                bash: { presets: [{ name: 'Ctrl-C', value: '\\x03' }] },
            },
        },
    });
    return { manager, input, tab };
}

it('virtual key taps send the key without reopening the mobile keyboard', () => {
    const { manager, input, tab } = mobileManager();
    const dropup = document.createElement('div');
    dropup.id = 'keys-presets-dropup';
    document.body.appendChild(dropup);
    input.focus();

    manager.renderKeysDropup();
    dropup.querySelector('.kb-key-btn').click();

    expect(manager.sendInput).toHaveBeenCalledWith(tab, '\x1b[H');
    expect(document.activeElement).not.toBe(input);
    expect(manager.focusActiveTerminal).not.toHaveBeenCalled();
});

it('quick command actions keep the mobile keyboard closed', () => {
    const { manager, input, tab } = mobileManager();
    Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: 400,
    });
    manager.app.quickCommands = [{ name: 'List', command: 'ls' }];
    manager.lastInputValue = '';
    manager.saveActiveDraft = vi.fn();
    manager.adjustInputHeight = vi.fn();
    const dropup = document.createElement('div');
    dropup.id = 'quick-commands-dropup';
    document.body.appendChild(dropup);
    manager.renderQuickCmdsDropup();
    input.focus();
    dropup.querySelector('.dropup-model-btn').click();
    expect(manager.sendInput).toHaveBeenCalledWith(tab, 'ls\r');
    expect(document.activeElement).not.toBe(input);
});

it('mobile shortcut chips and slash dropup selections suppress input focus', () => {
    const { manager, input, tab } = mobileManager();
    const presets = document.createElement('div');
    manager.presetsContainer = presets;
    document.body.appendChild(presets);
    Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: 400,
    });
    input.focus();
    manager.sendRawInput = vi.fn((_, options) => {
        if (options?.focusInputOnMobile === false) input.blur();
    });
    manager.renderPresets('bash');
    const utility = presets.querySelector('.preset-btn');
    utility.click();
    expect(manager.sendRawInput).toHaveBeenCalledWith(expect.any(String), {
        focusInputOnMobile: false,
    });
    expect(document.activeElement).not.toBe(input);

    const slashDropup = document.createElement('div');
    slashDropup.id = 'slash-presets-dropup';
    document.body.appendChild(slashDropup);
    manager.renderSlashDropup([{ name: 'Exit', value: '\x1b' }]);
    input.focus();
    slashDropup.querySelector('button.dropup-model-btn').click();
    expect(manager.sendRawInput).toHaveBeenLastCalledWith('\x1b', {
        focusInputOnMobile: false,
    });
    expect(document.activeElement).not.toBe(input);
    expect(tab.coder).toBe('bash');
});
