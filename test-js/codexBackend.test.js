// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';
import {
    getCoder,
    hasModelSwitch,
    hasSessions,
    formatAttachment,
} from '../web/coders.js';

setupDomHarness();

describe('Codex native model selection', () => {
    it('seeds a visible staged backend without old model names', () => {
        const coder = getCoder('codex');
        expect(coder.sidebar_visible).toBe(true);
        expect(coder.input_mode).toBe('staged');
        expect(hasSessions('codex')).toBe(true);
        expect(hasModelSwitch('codex')).toBe(true);
        expect(formatAttachment('codex', '/project/main.cpp')).toBe(
            '@/project/main.cpp',
        );
    });

    it('Models opens the native picker instead of a model-preset dropdown or inline /model argument', () => {
        const tab = { coder: 'codex', directMode: false };
        const tm = Object.assign(Object.create(TabManager.prototype), {
            app: {
                codersPresetRegistry: {
                    codex: { presets: [{ name: '/model', value: '/model\r' }] },
                },
                sessionsManager: {},
            },
            presetsContainer: document.createElement('div'),
            getActiveTab: () => tab,
            sendSlashCommand: vi.fn(),
            _toggleDropup: vi.fn(),
            _updatePiThinkingButton: vi.fn(),
        });
        tm.renderPresets('codex');
        const buttons = [...tm.presetsContainer.querySelectorAll('button')];
        buttons.find((button) => button.innerText === '🤖 Models').click();
        expect(tm.sendSlashCommand).toHaveBeenCalledWith(tab, '/model');
        expect(tm._toggleDropup).not.toHaveBeenCalled();
        buttons.find((button) => button.innerText === '/model').click();
        expect(tm.sendSlashCommand).toHaveBeenLastCalledWith(tab, '/model');
    });

    it('wraps staged input in bracketed paste for codex even when short', () => {
        const tab = { coder: 'codex', directMode: false };
        const tm = Object.assign(Object.create(TabManager.prototype), {
            app: {
                sessionsManager: {},
            },
            inputTextArea: { value: 'short prompt', focus: vi.fn() },
            stagedAttachments: [],
            attachmentStrip: { classList: { add: vi.fn(), remove: vi.fn() } },
            getActiveTab: () => tab,
            sendInput: vi.fn().mockReturnValue(true),
            saveActiveDraft: vi.fn(),
            adjustInputHeight: vi.fn(),
            _spamScrollToBottom: vi.fn(),
        });
        tm.sendStagedInput();
        expect(tm.sendInput).toHaveBeenCalledWith(
            tab,
            '\x1b[200~short prompt\x1b[201~\r',
        );
    });
});
