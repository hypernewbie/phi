// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

import {
    destroyRpcChat,
    getPiRpcControls,
    getPiRpcStatus,
    rpcChatModels,
    rpcChatReset,
    rpcChatCompact,
    rpcChatInterrupt,
    closePiSubagentViewer,
    rpcChatSend,
    rpcChatSetModel,
    rpcChatSetThinking,
    rpcChatThinkingLevels,
    subscribePiRpcStatus,
} from '../web/chat-pi/controller.js';
import { TabManager } from '../web/terminal.js';

setupDomHarness();

afterEach(() => {
    vi.clearAllMocks();
    getPiRpcStatus.mockImplementation(() => null);
    getPiRpcControls.mockImplementation(() => null);
    rpcChatModels.mockImplementation(() => Promise.resolve([]));
    rpcChatThinkingLevels.mockImplementation(() => Promise.resolve([]));
    rpcChatSetModel.mockImplementation(() => Promise.resolve());
    rpcChatSetThinking.mockImplementation(() => Promise.resolve());
    rpcChatReset.mockImplementation(() => Promise.resolve());
    rpcChatCompact.mockImplementation(() => Promise.resolve());
    rpcChatInterrupt.mockImplementation(() => Promise.resolve());
    closePiSubagentViewer.mockImplementation(() => false);
    subscribePiRpcStatus.mockImplementation(() => () => {});
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = readFileSync(join(ROOT, 'web/style.css'), 'utf8');

function maskCssComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
        comment.replace(/[^\n]/g, ' '),
    );
}

function extractMobileBlocks(css) {
    const masked = maskCssComments(css);
    const blocks = [];
    const re = /@media\s*\(max-width:\s*768px\)\s*\{/g;
    let match = re.exec(masked);
    while (match !== null) {
        const contentStart = match.index + match[0].length;
        let depth = 1;
        let i = contentStart;
        while (i < masked.length && depth > 0) {
            const ch = masked[i];
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
            i++;
        }
        if (depth !== 0) throw new Error('Unclosed mobile CSS block');
        blocks.push({
            content: css.slice(contentStart, i - 1),
            start: match.index,
            contentStart,
            end: i,
        });
        match = re.exec(masked);
    }
    return blocks;
}

function removeMobileBlocks(css, blocks) {
    let result = '';
    let cursor = 0;
    for (const block of blocks) {
        result += css.slice(cursor, block.start);
        cursor = block.end;
    }
    return result + css.slice(cursor);
}

function extractRuleRecords(css, sourceOffset = 0) {
    const masked = maskCssComments(css);
    const records = [];
    let statementStart = 0;
    let i = 0;
    while (i < masked.length) {
        if (masked[i] !== '{') {
            i++;
            continue;
        }
        const selectors = masked.slice(statementStart, i).trim();
        let depth = 1;
        let end = i + 1;
        while (end < masked.length && depth > 0) {
            const ch = masked[end];
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
            end++;
        }
        if (depth !== 0) throw new Error('Unclosed CSS rule');
        if (selectors && !selectors.startsWith('@')) {
            records.push({
                selectors,
                body: css.slice(i + 1, end - 1),
                start: sourceOffset + statementStart,
                end: sourceOffset + end,
            });
        }
        statementStart = end;
        i = end;
    }
    return records;
}

function findExactRule(rules, selector) {
    return (
        rules.find((rule) =>
            rule.selectors
                .split(',')
                .some((candidate) => candidate.trim() === selector),
        ) || null
    );
}

function hasDeclaration(body, property, value) {
    const declaration = `${property}: ${value}`.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&',
    );
    return new RegExp(`(?:^|[;\\n])\\s*${declaration}\\s*;`).test(
        maskCssComments(body),
    );
}

function expectRuleDeclarations(rules, selector, declarations) {
    const rule = findExactRule(rules, selector);
    expect(rule, `CSS rule not found for ${selector}`).toBeTruthy();
    for (const [property, value] of Object.entries(declarations)) {
        expect(
            hasDeclaration(rule.body, property, value),
            `${selector} must declare ${property}: ${value}`,
        ).toBe(true);
    }
    return rule;
}

const MOBILE_BLOCKS = extractMobileBlocks(CSS);
const BASE_CSS = removeMobileBlocks(CSS, MOBILE_BLOCKS);

function stagedContext(tab) {
    const tm = Object.create(TabManager.prototype);
    tm.getActiveTab = vi.fn(() => tab);
    tm.sendInput = vi.fn(() => true);
    tm.inputTextArea = document.createElement('textarea');
    tm.inputTextArea.value = 'hello from Pi RPC';
    tm.stagedAttachments = [];
    tm.attachmentStrip = { classList: { add: vi.fn(), remove: vi.fn() } };
    tm.app = {
        showToast: vi.fn(),
        syncRemoteClipboard: vi.fn(),
        sessionsManager: { activeCWD: '/work/demo' },
    };
    tm._renderAttachmentStrip = vi.fn();
    tm.adjustInputHeight = vi.fn();
    tm._spamScrollToBottom = vi.fn();
    return tm;
}

describe('Pi RPC TabManager boundaries', () => {
    it('keeps the status bar between input and presets in the static DOM', () => {
        const html = readFileSync(join(ROOT, 'web/index.html'), 'utf8');
        const input = html.indexOf('id="input-bar-container"');
        const status = html.indexOf('id="pi-rpc-status-bar"');
        const presets = html.indexOf('id="presets-container"');
        expect(input).toBeGreaterThanOrEqual(0);
        expect(status).toBeLessThan(input);
        expect(input).toBeLessThan(presets);
        expect(html).toContain('id="pi-rpc-model-dropup"');
        expect(html).toContain('id="pi-rpc-thinking-dropup"');
    });

    it('renders the four Pi RPC status items with a combined Cache R/W field', () => {
        const bar = document.createElement('div');
        const tab = { paneId: 'pi-rpc:one', coder: 'pi-rpc' };
        getPiRpcStatus.mockReturnValue({
            cwd: '/work/one',
            model: 'pi-4',
            thinking: 'high',
            inputTokens: 0,
            outputTokens: 1200,
            contextUsedTokens: 42000,
            contextWindowTokens: 200000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            skills: ['review', 'test'],
        });
        const tm = Object.create(TabManager.prototype);
        tm.piRpcStatusBar = bar;
        tm.getActiveTab = vi.fn(() => tab);
        tm.piThinkingBtn = document.createElement('button');
        tm._piThinkingLevels = new Map();

        tm.renderPiRpcStatusBar();

        expect(bar.classList.contains('hidden')).toBe(false);
        expect(bar.textContent).toContain('/work/one');
        expect(bar.textContent).toContain('↑0');
        expect(bar.textContent).toContain('↓1.2K');
        expect(bar.textContent).toContain('pi-4');
        expect(bar.textContent).toContain('high');
        expect(bar.querySelector('.pi-rpc-status-cwd')).not.toBeNull();
        expect(bar.querySelector('.pi-rpc-status-tokens')).not.toBeNull();
        expect(bar.querySelector('.pi-rpc-status-model')).not.toBeNull();
        expect(bar.querySelector('.pi-rpc-status-meter')).not.toBeNull();
        expect(bar.querySelector('[tabindex="0"]')).toBeNull();
    });

    it('renders only Model, Thinking, and Reset Chat for Pi RPC', () => {
        const row = document.createElement('div');
        const tab = { paneId: 'pi-rpc:controls', coder: 'pi-rpc' };
        getPiRpcControls.mockReturnValue({
            ready: true,
            exited: false,
            busy: false,
            queueDepth: 0,
            hasTranscript: true,
            model: 'pi-4',
            thinking: 'high',
        });
        const tm = Object.create(TabManager.prototype);
        tm.presetsContainer = row;
        tm.getActiveTab = vi.fn(() => tab);
        tm.cancelInputBtn = document.createElement('button');
        tm.copyInputBtn = document.createElement('button');
        tm.directModeToggle = document.createElement('button');
        tm._piRpcResetPending = new Set();

        tm.renderPresets('pi-rpc');

        expect(
            [...row.querySelectorAll('button')].map(
                (button) => button.textContent,
            ),
        ).toEqual([
            'Compact',
            'Clear',
            '⚡ Cmds ▾',
            '🤖 Models ▾',
            'Thinking ▾',
        ]);
        expect(row.querySelector('.presets-divider')).not.toBeNull();
        expect(row.querySelector('.mobile-nav-btn')).toBeNull();
        expect(row.querySelector('.pi-rpc-reset-btn').disabled).toBe(false);
        expect(row.querySelector('.pi-rpc-reset-btn').textContent).toBe('Clear');
        expect(tm.cancelInputBtn.classList.contains('hidden')).toBe(false);
        expect(tm.copyInputBtn.classList.contains('hidden')).toBe(true);
        expect(tm.directModeToggle.classList.contains('hidden')).toBe(true);
    });

    it('falls back to an em dash for empty Pi model and thinking values', () => {
        const row = document.createElement('div');
        const tab = { paneId: 'pi-rpc:empty-controls', coder: 'pi-rpc' };
        getPiRpcControls.mockReturnValue({
            ready: true,
            exited: false,
            busy: false,
            queueDepth: 0,
            hasTranscript: false,
            model: '',
            thinking: '',
        });
        const tm = Object.create(TabManager.prototype);
        tm.presetsContainer = row;
        tm.getActiveTab = vi.fn(() => tab);
        tm.cancelInputBtn = document.createElement('button');
        tm.copyInputBtn = document.createElement('button');
        tm.directModeToggle = document.createElement('button');
        tm._piRpcResetPending = new Set();

        tm.renderPresets('pi-rpc');

        expect(
            [...row.querySelectorAll('button')].map(
                (button) => button.textContent,
            ),
        ).toEqual(['Compact', 'Clear', '⚡ Cmds ▾', '🤖 Models ▾', 'Thinking ▾']);
        expect(row.querySelector('.pi-rpc-model-trigger').title).toBe('—');
        expect(row.querySelector('.pi-rpc-thinking-trigger').title).toBe('—');
    });

    it('renders the Context meter with progressbar semantics and color states', () => {
        function mountMeter(rawStatus) {
            const row = document.createElement('div');
            const bar = document.createElement('div');
            const tab = { paneId: 'pi-rpc:meter', coder: 'pi-rpc' };
            getPiRpcStatus.mockReturnValue(rawStatus);
            getPiRpcControls.mockReturnValue({
                ready: true,
                exited: false,
                busy: false,
                queueDepth: 0,
                hasTranscript: false,
                model: 'm',
                thinking: 'low',
            });
            const tm = Object.create(TabManager.prototype);
            tm.presetsContainer = row;
            tm.piRpcStatusBar = bar;
            tm.piThinkingBtn = document.createElement('button');
            tm._piThinkingLevels = new Map();
            tm.getActiveTab = vi.fn(() => tab);
            tm.cancelInputBtn = document.createElement('button');
            tm.copyInputBtn = document.createElement('button');
            tm.directModeToggle = document.createElement('button');
            tm._piRpcResetPending = new Set();
            tm.renderPresets('pi-rpc');
            tm.renderPiRpcStatusBar();
            const meter = bar.querySelector('.pi-rpc-context-meter');
            const fill = meter?.querySelector('.pi-rpc-context-meter-fill');
            const text = meter?.querySelector('.pi-rpc-context-meter-text');
            return { row, meter, fill, text };
        }

        // Unknown state — no raw context values.
        const unknown = mountMeter({ cwd: '/work/meter' });
        expect(unknown.meter).toBeTruthy();
        expect(unknown.meter.getAttribute('role')).toBe('progressbar');
        expect(unknown.meter.getAttribute('aria-valuemin')).toBe('0');
        expect(unknown.meter.getAttribute('aria-valuemax')).toBe('100');
        expect(unknown.meter.hasAttribute('aria-valuenow')).toBe(false);
        expect(unknown.fill.style.width).toBe('0%');
        for (const cls of ['--green', '--yellow', '--red']) {
            expect(
                unknown.fill.classList.contains(
                    `pi-rpc-context-meter-fill${cls}`,
                ),
            ).toBe(false);
        }
        expect(unknown.meter.getAttribute('aria-label')).toBe('Context: —');
        expect(unknown.text.textContent).toBe('—');

        // Known states — exact boundaries. Compact formatting: 3990 -> 4K.
        const knownCases = [
            {
                raw: { contextUsedTokens: 3990, contextWindowTokens: 10000 },
                color: 'green',
                valuenow: '39.9',
                width: '39.9%',
                label: 'Context: 4K / 10K',
                text: '4K / 10K',
            },
            {
                // 39.999% exact: green by exact ratio, rounded display 40.
                raw: { contextUsedTokens: 39999, contextWindowTokens: 100000 },
                color: 'green',
                valuenow: '40',
                width: '40%',
                label: 'Context: 40K / 100K',
                text: '40K / 100K',
            },
            {
                raw: { contextUsedTokens: 4000, contextWindowTokens: 10000 },
                color: 'yellow',
                valuenow: '40',
                width: '40%',
                label: 'Context: 4K / 10K',
                text: '4K / 10K',
            },
            {
                raw: { contextUsedTokens: 7000, contextWindowTokens: 10000 },
                color: 'yellow',
                valuenow: '70',
                width: '70%',
                label: 'Context: 7K / 10K',
                text: '7K / 10K',
            },
            {
                raw: { contextUsedTokens: 7010, contextWindowTokens: 10000 },
                color: 'red',
                valuenow: '70.1',
                width: '70.1%',
                label: 'Context: 7K / 10K',
                text: '7K / 10K',
            },
            {
                raw: { contextUsedTokens: 15000, contextWindowTokens: 10000 },
                color: 'red',
                valuenow: '100',
                width: '100%',
                label: 'Context: 15K / 10K',
                text: '15K / 10K',
            },
        ];
        for (const { raw, color, valuenow, width, label, text } of knownCases) {
            const m = mountMeter(raw);
            expect(
                m.fill.classList.contains(
                    `pi-rpc-context-meter-fill--${color}`,
                ),
                `color for ${valuenow}`,
            ).toBe(true);
            expect(m.meter.getAttribute('aria-valuenow')).toBe(valuenow);
            expect(m.fill.style.width).toBe(width);
            expect(m.meter.getAttribute('aria-label')).toBe(label);
            expect(m.text.textContent).toBe(text);
        }

        // Unknown state — missing, null, zero, or negative window.
        const unknownWindow = [
            { contextUsedTokens: 1000 },
            { contextUsedTokens: 1000, contextWindowTokens: null },
            { contextUsedTokens: 1000, contextWindowTokens: 0 },
            { contextUsedTokens: 1000, contextWindowTokens: -1 },
        ];
        for (const raw of unknownWindow) {
            const m = mountMeter(raw);
            expect(
                m.meter.hasAttribute('aria-valuenow'),
                'valuenow absent for unknown window',
            ).toBe(false);
            for (const cls of ['--green', '--yellow', '--red']) {
                expect(
                    m.fill.classList.contains(
                        `pi-rpc-context-meter-fill${cls}`,
                    ),
                ).toBe(false);
            }
            expect(m.fill.style.width).toBe('0%');
        }
    });

    it('keeps Pi typography scoped and restores its narrow-screen sizing', () => {
        const baseRules = extractRuleRecords(BASE_CSS);
        const baseContracts = {
            '.pi-rpc-context-meter': {
                position: 'relative',
                'min-width': '140px',
                'min-height': '22px',
                overflow: 'hidden',
                'border-radius': '4px',
            },
            '.pi-rpc-context-meter-fill': {
                position: 'absolute',
                height: '100%',
                width: '0',
            },
            '.pi-rpc-context-meter-text': {
                position: 'relative',
                'font-size': '11px',
                'font-weight': '500',
            },
            '.pi-rpc-status-label': {
                'font-size': '10px',
                'font-weight': '600',
            },
            '.pi-rpc-status-value': {
                'font-size': '11px',
                'font-weight': '400',
            },
            '.presets-container > .pi-rpc-model-trigger': {
                'font-size': '11px',
                'font-weight': '500',
            },
            '.presets-container > .pi-rpc-thinking-trigger': {
                'font-size': '11px',
                'font-weight': '500',
            },
            '.presets-container > .pi-rpc-reset-btn': {
                'font-size': '11px',
                'font-weight': '500',
            },
            '.presets-container > .pi-rpc-compact-btn': {
                'font-size': '11px',
                'font-weight': '500',
            },
            '#pi-rpc-model-dropup .dropup-header': {
                'font-size': '10px',
                'font-weight': '600',
            },
            '#pi-rpc-thinking-dropup .dropup-header': {
                'font-size': '10px',
                'font-weight': '600',
            },
            '#pi-rpc-model-dropup .dropup-model-btn': {
                'font-size': '11px',
                'font-weight': '400',
            },
            '#pi-rpc-thinking-dropup .dropup-model-btn': {
                'font-size': '11px',
                'font-weight': '400',
            },
            '#pi-rpc-model-dropup .pi-rpc-dropup-meta': {
                'font-size': '10px',
                'font-weight': '400',
            },
            '#pi-rpc-model-dropup .pi-rpc-dropup-message': {
                'font-size': '11px',
                'font-weight': '400',
            },
            '#pi-rpc-thinking-dropup .pi-rpc-dropup-message': {
                'font-size': '11px',
                'font-weight': '400',
            },
        };
        for (const [selector, declarations] of Object.entries(baseContracts)) {
            expectRuleDeclarations(baseRules, selector, declarations);
        }

        const mobileRuleSets = MOBILE_BLOCKS.map((block) => ({
            block,
            rules: extractRuleRecords(block.content, block.contentStart),
        }));
        const finalMobile = [...mobileRuleSets].reverse().find(({ rules }) => {
            const genericPreset = findExactRule(rules, '.preset-btn');
            return (
                genericPreset &&
                hasDeclaration(
                    genericPreset.body,
                    'font-size',
                    '10px !important',
                )
            );
        });
        expect(finalMobile).toBeTruthy();
        const genericPreset = expectRuleDeclarations(
            finalMobile.rules,
            '.preset-btn',
            { 'font-size': '10px !important' },
        );
        const piControlSelectors = [
            '.presets-container > .pi-rpc-model-trigger',
            '.presets-container > .pi-rpc-thinking-trigger',
            '.presets-container > .pi-rpc-compact-btn',
            '.presets-container > .pi-rpc-reset-btn',
        ];
        const piControlRules = piControlSelectors.map((selector) =>
            expectRuleDeclarations(finalMobile.rules, selector, {
                'font-size': 'inherit !important',
                'min-height': '24px',
                height: 'auto !important',
                'line-height': 'normal !important',
            }),
        );
        expect(new Set(piControlRules).size).toBe(1);
        expect(piControlRules[0].start).toBeGreaterThan(genericPreset.start);
        const piMeterNarrow = expectRuleDeclarations(
            finalMobile.rules,
            '.presets-container > .pi-rpc-context-meter',
            {
                'font-size': 'inherit !important',
                'min-height': '24px',
                height: 'auto !important',
                'line-height': 'normal !important',
            },
        );
        expect(piMeterNarrow.start).toBeGreaterThan(piControlRules[0].start);
        const genericHeader = expectRuleDeclarations(
            baseRules,
            '.dropup-header',
            { 'font-size': '10px' },
        );
        expect(maskCssComments(genericHeader.body)).not.toMatch(
            /font-size:\s*inherit/,
        );
        const genericModelButton = expectRuleDeclarations(
            baseRules,
            '.dropup-model-btn',
            { 'font-size': '11px' },
        );
        expect(maskCssComments(genericModelButton.body)).not.toMatch(
            /font-size:\s*inherit/,
        );
        const genericPresetBase = expectRuleDeclarations(
            baseRules,
            '.preset-btn',
            {
                'font-size': '11px',
            },
        );
        expect(maskCssComments(genericPresetBase.body)).not.toMatch(
            /font-size:\s*inherit/,
        );
    });

    it('loads Pi model choices and calls the active pane setter', async () => {
        const row = document.createElement('div');
        const dropup = document.createElement('div');
        dropup.id = 'pi-rpc-model-dropup';
        dropup.className = 'model-presets-dropup hidden';
        document.body.append(dropup);
        const tab = { paneId: 'pi-rpc:models', coder: 'pi-rpc' };
        getPiRpcControls.mockReturnValue({
            ready: true,
            exited: false,
            busy: false,
            queueDepth: 0,
            hasTranscript: false,
            model: 'current-model',
            thinking: 'medium',
        });
        rpcChatModels.mockResolvedValue([
            { provider: 'remote', id: 'model-id', name: 'Friendly model' },
            { provider: 'remote', id: 'fallback-id' },
        ]);
        let resolveSetter;
        rpcChatSetModel.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveSetter = resolve;
                }),
        );
        const tm = Object.create(TabManager.prototype);
        tm.presetsContainer = row;
        tm.getActiveTab = vi.fn(() => tab);
        tm.app = { showToast: vi.fn() };
        tm._piRpcResetPending = new Set();
        tm._piRpcMenuRequest = 0;
        tm.renderPresets('pi-rpc');
        row.querySelector('.pi-rpc-model-trigger').click();
        await Promise.resolve();

        expect(rpcChatModels).toHaveBeenCalledWith(tab.paneId);
        expect(dropup.textContent).toContain('Model · current-model');
        expect(dropup.textContent).toContain('Friendly model');
        expect(dropup.textContent).toContain('remote/model-id');
        expect(dropup.textContent).toContain('fallback-id');
        const choice = [...dropup.querySelectorAll('.dropup-model-btn')].find(
            (button) => button.textContent === 'Friendly model',
        );
        choice.click();
        expect(rpcChatSetModel).toHaveBeenCalledWith(
            tab.paneId,
            'remote',
            'model-id',
        );
        expect(choice.disabled).toBe(true);
        tm.renderPresets('pi-rpc');
        expect(row.querySelector('.pi-rpc-model-trigger').disabled).toBe(true);
        resolveSetter();
        await Promise.resolve();
        expect(dropup.classList.contains('hidden')).toBe(true);
        expect(row.querySelector('.pi-rpc-model-trigger').disabled).toBe(false);
    });

    it('uses Pi thinking levels, preserves generic model isolation, and reports setter errors', async () => {
        const row = document.createElement('div');
        const dropup = document.createElement('div');
        dropup.id = 'pi-rpc-thinking-dropup';
        dropup.className = 'model-presets-dropup hidden';
        document.body.append(dropup);
        const tab = { paneId: 'pi-rpc:thinking', coder: 'pi-rpc' };
        getPiRpcControls.mockReturnValue({
            ready: true,
            exited: false,
            busy: false,
            queueDepth: 0,
            hasTranscript: false,
            model: 'm',
            thinking: 'low',
        });
        rpcChatThinkingLevels.mockResolvedValue(['off', 'low', 'high']);
        rpcChatSetThinking.mockRejectedValue(new Error('Pi rejected level'));
        const tm = Object.create(TabManager.prototype);
        tm.presetsContainer = row;
        tm.getActiveTab = vi.fn(() => tab);
        tm.app = { showToast: vi.fn() };
        tm._piRpcResetPending = new Set();
        tm._piRpcMenuRequest = 0;
        tm.renderPresets('pi-rpc');
        row.querySelector('.pi-rpc-thinking-trigger').click();
        await Promise.resolve();
        expect(rpcChatThinkingLevels).toHaveBeenCalledWith(tab.paneId);
        expect(dropup.textContent).toContain('Thinking · low');
        expect(
            [...dropup.querySelectorAll('.dropup-model-btn')].map(
                (button) => button.textContent,
            ),
        ).toEqual(['off', 'low', 'high']);
        dropup.querySelectorAll('.dropup-model-btn')[2].click();
        await Promise.resolve();
        await Promise.resolve();
        expect(rpcChatSetThinking).toHaveBeenCalledWith(tab.paneId, 'high');
        expect(tm.app.showToast).toHaveBeenCalledWith('Pi rejected level', {
            type: 'error',
            title: 'Pi thinking',
        });
        expect(dropup.classList.contains('hidden')).toBe(false);
    });

    it('reenables the Thinking trigger after a fulfilled setter', async () => {
        const row = document.createElement('div');
        const dropup = document.createElement('div');
        dropup.id = 'pi-rpc-thinking-dropup';
        dropup.className = 'model-presets-dropup hidden';
        document.body.append(dropup);
        const tab = { paneId: 'pi-rpc:thinking-success', coder: 'pi-rpc' };
        getPiRpcControls.mockReturnValue({
            ready: true,
            exited: false,
            busy: false,
            queueDepth: 0,
            hasTranscript: false,
            model: 'm',
            thinking: 'low',
        });
        rpcChatThinkingLevels.mockResolvedValue(['low', 'high']);
        let resolveSetter;
        rpcChatSetThinking.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveSetter = resolve;
                }),
        );
        const tm = Object.create(TabManager.prototype);
        tm.presetsContainer = row;
        tm.getActiveTab = vi.fn(() => tab);
        tm._piRpcResetPending = new Set();
        tm._piRpcMenuRequest = 0;
        tm.renderPresets('pi-rpc');
        row.querySelector('.pi-rpc-thinking-trigger').click();
        await Promise.resolve();
        dropup.querySelector('.dropup-model-btn').click();
        tm.renderPresets('pi-rpc');
        expect(row.querySelector('.pi-rpc-thinking-trigger').disabled).toBe(
            true,
        );
        resolveSetter();
        await Promise.resolve();
        expect(dropup.classList.contains('hidden')).toBe(true);
        expect(row.querySelector('.pi-rpc-thinking-trigger').disabled).toBe(
            false,
        );
    });

    it('confirms Reset Chat, disables it while pending, and keeps the row until the controller succeeds', async () => {
        const row = document.createElement('div');
        const tab = { paneId: 'pi-rpc:reset', coder: 'pi-rpc' };
        getPiRpcControls.mockReturnValue({
            ready: true,
            exited: false,
            busy: false,
            queueDepth: 0,
            hasTranscript: true,
            model: 'm',
            thinking: 'low',
        });
        let resolveReset;
        rpcChatReset.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveReset = resolve;
                }),
        );
        vi.stubGlobal(
            'confirm',
            vi.fn(() => true),
        );
        const tm = Object.create(TabManager.prototype);
        tm.presetsContainer = row;
        tm.tabs = new Map([[tab.paneId, tab]]);
        tm.getActiveTab = vi.fn(() => tab);
        tm._piRpcResetPending = new Set();
        tm.renderPresets('pi-rpc');
        row.querySelector('.pi-rpc-reset-btn').click();
        expect(confirm).toHaveBeenCalledWith(
            'Reset Chat starts a fresh conversation and cannot be undone. Continue?',
        );
        expect(rpcChatReset).toHaveBeenCalledWith(tab.paneId);
        expect(row.querySelector('.pi-rpc-reset-btn').disabled).toBe(true);
        expect(row.textContent).toContain('Clear');
        resolveReset({ cancelled: false, reset: true });
        await Promise.resolve();
        await Promise.resolve();
        // The reset chain is then -> catch -> finally: one microtask hop
        // deeper than before the per-chat history clear was added.
        await Promise.resolve();
        expect(row.querySelector('.pi-rpc-reset-btn').disabled).toBe(false);
    });

    it('runs Compact without confirmation, disables it while pending, and surfaces errors', async () => {
        const row = document.createElement('div');
        const tab = { paneId: 'pi-rpc:compact', coder: 'pi-rpc' };
        getPiRpcControls.mockReturnValue({
            ready: true,
            exited: false,
            busy: false,
            queueDepth: 0,
            hasTranscript: true,
            model: 'm',
            thinking: 'low',
        });
        let rejectCompact;
        rpcChatCompact.mockImplementation(
            () =>
                new Promise((_resolve, reject) => {
                    rejectCompact = reject;
                }),
        );
        vi.stubGlobal(
            'confirm',
            vi.fn(() => true),
        );
        const tm = Object.create(TabManager.prototype);
        tm.presetsContainer = row;
        tm.tabs = new Map([[tab.paneId, tab]]);
        tm.getActiveTab = vi.fn(() => tab);
        tm._piRpcResetPending = new Set();
        tm._piRpcError = vi.fn();
        tm.renderPresets('pi-rpc');
        row.querySelector('.pi-rpc-compact-btn').click();
        // Compaction is non-destructive: no confirmation dialog.
        expect(confirm).not.toHaveBeenCalled();
        expect(rpcChatCompact).toHaveBeenCalledWith(tab.paneId);
        expect(row.querySelector('.pi-rpc-compact-btn').disabled).toBe(true);
        rejectCompact(new Error('compact rejected'));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(tm._piRpcError).toHaveBeenCalledWith(
            expect.any(Error),
            'Compact',
        );
        expect(row.querySelector('.pi-rpc-compact-btn').disabled).toBe(false);
    });

    it('handles Escape dropup-first, composing, active, and idle states', () => {
        const tab = { paneId: 'pi-rpc:escape', coder: 'pi-rpc' };
        const tm = Object.create(TabManager.prototype);
        tm.getActiveTab = vi.fn(() => tab);
        tm._piRpcError = vi.fn();

        const dropupEvent = {
            key: 'Escape',
            isComposing: false,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };
        tm._closePiSubagentViewerIfOpen = vi.fn(() => false);
        tm._closePiRpcDropups = vi.fn(() => true);
        tm._interruptActivePiRpc = vi.fn(() => true);
        expect(tm._handlePiRpcEscape(dropupEvent)).toBe(true);
        expect(tm._closePiRpcDropups).toHaveBeenCalledOnce();
        expect(tm._interruptActivePiRpc).not.toHaveBeenCalled();
        expect(dropupEvent.preventDefault).toHaveBeenCalledOnce();

        const composingEvent = {
            key: 'Escape',
            isComposing: true,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };
        expect(tm._handlePiRpcEscape(composingEvent)).toBe(true);
        expect(composingEvent.preventDefault).not.toHaveBeenCalled();

        const activeEvent = {
            key: 'Escape',
            isComposing: false,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };
        tm._closePiRpcDropups.mockReturnValue(false);
        tm._interruptActivePiRpc.mockReturnValue(true);
        expect(tm._handlePiRpcEscape(activeEvent)).toBe(true);
        expect(tm._interruptActivePiRpc).toHaveBeenCalledOnce();
        expect(activeEvent.preventDefault).toHaveBeenCalledOnce();

        const viewerEvent = {
            key: 'Escape',
            isComposing: false,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };
        tm._closePiSubagentViewerIfOpen.mockReturnValue(true);
        expect(tm._handlePiRpcEscape(viewerEvent)).toBe(true);
        expect(tm._closePiSubagentViewerIfOpen).toHaveBeenCalled();
        expect(tm._closePiRpcDropups).toHaveBeenCalledTimes(2);
        expect(tm._interruptActivePiRpc).toHaveBeenCalledTimes(1);
        expect(viewerEvent.preventDefault).toHaveBeenCalledOnce();
        expect(viewerEvent.stopPropagation).toHaveBeenCalledOnce();

        const idleEvent = {
            key: 'Escape',
            isComposing: false,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };
        tm._closePiSubagentViewerIfOpen.mockReturnValue(false);
        tm._interruptActivePiRpc.mockReturnValue(false);
        expect(tm._handlePiRpcEscape(idleEvent)).toBe(false);
        expect(idleEvent.preventDefault).not.toHaveBeenCalled();
    });

    it('restores inherited actions after leaving Pi RPC and closes Pi dropups', () => {
        const modelDropup = document.createElement('div');
        modelDropup.id = 'pi-rpc-model-dropup';
        modelDropup.className = 'model-presets-dropup';
        const thinkingDropup = document.createElement('div');
        thinkingDropup.id = 'pi-rpc-thinking-dropup';
        thinkingDropup.className = 'model-presets-dropup';
        document.body.append(modelDropup, thinkingDropup);
        const tm = Object.create(TabManager.prototype);
        tm.cancelInputBtn = document.createElement('button');
        tm.copyInputBtn = document.createElement('button');
        tm.directModeToggle = document.createElement('button');
        tm._setPiRpcActionVisibility({ coder: 'pi-rpc' });
        expect(tm.cancelInputBtn.classList.contains('hidden')).toBe(false);
        tm._closePiRpcDropups(true);
        expect(modelDropup.classList.contains('hidden')).toBe(true);
        expect(thinkingDropup.classList.contains('hidden')).toBe(true);
        tm._setPiRpcActionVisibility({ coder: 'bash' });
        expect(tm.cancelInputBtn.classList.contains('hidden')).toBe(false);
        expect(tm.copyInputBtn.classList.contains('hidden')).toBe(false);
        expect(tm.directModeToggle.classList.contains('hidden')).toBe(false);
    });

    it("hides and clears on switch-away, then restores each Pi pane's status", () => {
        const bar = document.createElement('div');
        const tabs = {
            one: { paneId: 'pi-rpc:one', coder: 'pi-rpc' },
            two: { paneId: 'pi-rpc:two', coder: 'pi-rpc' },
            bash: { paneId: 'bash:one', coder: 'bash' },
        };
        let active = tabs.one;
        getPiRpcStatus.mockImplementation((paneId) =>
            paneId === tabs.one.paneId
                ? { cwd: '/work/one' }
                : { cwd: '/work/two' },
        );
        const tm = Object.create(TabManager.prototype);
        tm.piRpcStatusBar = bar;
        tm.getActiveTab = vi.fn(() => active);

        tm.renderPiRpcStatusBar();
        expect(bar.textContent).toContain('/work/one');
        active = tabs.bash;
        tm.renderPiRpcStatusBar();
        expect(bar.classList.contains('hidden')).toBe(true);
        expect(bar.childElementCount).toBe(0);
        active = tabs.two;
        tm.renderPiRpcStatusBar();
        expect(bar.classList.contains('hidden')).toBe(false);
        expect(bar.textContent).toContain('/work/two');
    });

    it('refreshes only the active Pi pane from controller notifications', () => {
        const bar = document.createElement('div');
        const presets = document.createElement('div');
        const active = { paneId: 'pi-rpc:active', coder: 'pi-rpc' };
        const inactive = { paneId: 'pi-rpc:inactive', coder: 'pi-rpc' };
        let current = new Map([
            [
                active.paneId,
                {
                    cwd: '/work/active',
                    contextUsedTokens: 1000,
                    contextWindowTokens: 10000,
                },
            ],
            [inactive.paneId, { cwd: '/work/inactive' }],
        ]);
        let controls = {
            ready: true,
            exited: false,
            busy: false,
            queueDepth: 0,
            hasTranscript: false,
            model: 'old-model',
            thinking: 'low',
        };
        getPiRpcStatus.mockImplementation(
            (paneId) => current.get(paneId) ?? null,
        );
        getPiRpcControls.mockImplementation(() => controls);
        const tm = Object.create(TabManager.prototype);
        tm.piRpcStatusBar = bar;
        tm.presetsContainer = presets;
        tm.getActiveTab = vi.fn(() => active);
        tm.cancelInputBtn = document.createElement('button');
        tm.copyInputBtn = document.createElement('button');
        tm.directModeToggle = document.createElement('button');
        tm._piRpcResetPending = new Set();
        tm.renderPiRpcStatusBar();
        tm.renderPresets('pi-rpc');
        const meter = () => bar.querySelector('.pi-rpc-context-meter');
        const fill = () => meter()?.querySelector('.pi-rpc-context-meter-fill');
        expect(presets.querySelector('.pi-rpc-model-trigger').textContent).toBe(
            '🤖 Models ▾',
        );
        expect(presets.querySelector('.pi-rpc-model-trigger').title).toBe(
            'old-model',
        );
        expect(
            presets.querySelector('.pi-rpc-thinking-trigger').textContent,
        ).toBe('Thinking ▾');
        expect(
            presets.querySelector('.pi-rpc-thinking-trigger').title,
        ).toBe('low');
        expect(meter().getAttribute('aria-valuenow')).toBe('10');
        expect(
            fill().classList.contains('pi-rpc-context-meter-fill--green') ||
                fill().classList.contains('pi-rpc-context-meter-fill--low'),
        ).toBe(true);

        // The constructor owns subscription; invoke its captured listener on a
        // lightweight instance after installing the same callback contract.
        const setup = vi
            .spyOn(TabManager.prototype, 'setupEventListeners')
            .mockImplementation(() => {});
        vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 0);
        const constructed = new TabManager({});
        constructed.piRpcStatusBar = bar;
        constructed.presetsContainer = presets;
        constructed.getActiveTab = vi.fn(() => active);
        constructed.cancelInputBtn = document.createElement('button');
        constructed.copyInputBtn = document.createElement('button');
        constructed.directModeToggle = document.createElement('button');
        constructed.piThinkingBtn = document.createElement('button');
        constructed._piThinkingLevels = new Map();
        constructed._piRpcResetPending = new Set();
        const notify = subscribePiRpcStatus.mock.calls[0]?.[0];
        expect(notify).toEqual(expect.any(Function));
        current = new Map([
            [
                active.paneId,
                {
                    cwd: '/work/active-new',
                    contextUsedTokens: 1000,
                    contextWindowTokens: 10000,
                },
            ],
            [inactive.paneId, { cwd: '/work/inactive-new' }],
        ]);
        controls = {
            ...controls,
            model: 'new-model',
            thinking: 'high',
        };
        notify(inactive.paneId, current.get(inactive.paneId));
        expect(bar.textContent).toContain('/work/active-new');
        expect(bar.textContent).not.toContain('/work/inactive-new');
        expect(presets.querySelector('.pi-rpc-model-trigger').textContent).toBe(
            '🤖 Models ▾',
        );
        expect(
            presets.querySelector('.pi-rpc-thinking-trigger').textContent,
        ).toBe('Thinking ▾');
        expect(meter().getAttribute('aria-valuenow')).toBe('10');
        expect(
            fill().classList.contains('pi-rpc-context-meter-fill--green') ||
                fill().classList.contains('pi-rpc-context-meter-fill--low'),
        ).toBe(true);
        current.set(active.paneId, {
            cwd: '/work/active-new',
            contextUsedTokens: 5000,
            contextWindowTokens: 10000,
        });
        notify(active.paneId, current.get(active.paneId));
        expect(bar.textContent).toContain('/work/active-new');
        expect(presets.querySelector('.pi-rpc-model-trigger').title).toBe(
            'new-model',
        );
        expect(
            presets.querySelector('.pi-rpc-thinking-trigger').title,
        ).toBe('high');
        expect(meter().getAttribute('aria-valuenow')).toBe('50');
        expect(
            fill().classList.contains('pi-rpc-context-meter-fill--yellow') ||
                fill().classList.contains('pi-rpc-context-meter-fill--mid'),
        ).toBe(true);
        expect(fill().style.width).toBe('50%');
        setup.mockRestore();
    });

    it('routes staged Pi RPC prompts to rpcChatSend instead of sendInput', () => {
        mockFetch();
        const tab = {
            paneId: 'pi-rpc:/work/demo',
            coder: 'pi-rpc',
            isDead: true,
        };
        const tm = stagedContext(tab);

        tm.sendStagedInput();

        expect(rpcChatSend).toHaveBeenCalledWith(
            tab.paneId,
            'hello from Pi RPC',
        );
        expect(tm.sendInput).not.toHaveBeenCalled();
    });

    it('finalizes Pi RPC by destroying its controller without a PTY DELETE', () => {
        const fetchSpy = mockFetch();
        const paneId = 'pi-rpc:/work/demo';
        const tm = Object.create(TabManager.prototype);
        tm.tabs = new Map([
            [
                paneId,
                {
                    paneId,
                    coder: 'pi-rpc',
                    title: 'Pi RPC · demo',
                    tabEl: document.createElement('div'),
                    termContainer: document.createElement('div'),
                },
            ],
        ]);
        tm.app = {
            kanbanManager: { cleanup: vi.fn() },
            reviewManager: { cleanup: vi.fn() },
            markdownManager: { refreshFiles: vi.fn() },
        };
        tm._stopSoftCloseCountdown = vi.fn();
        tm._removeSoftCloseOverlay = vi.fn();
        tm.updateDocumentTitle = vi.fn();
        tm.updateDisconnectBanner = vi.fn();
        tm.saveTabsState = vi.fn();
        tm.updateTabOverflow = vi.fn();
        tm.inputBarContainer = document.createElement('div');
        tm.presetsContainer = document.createElement('div');
        tm.piRpcStatusBar = document.createElement('div');
        tm.piRpcStatusBar.append(document.createElement('span'));
        tm.piRpcStatusBar.classList.remove('hidden');
        tm.getActiveTab = vi.fn(() => tm.tabs.get(tm.activePaneId));
        tm.activePaneId = paneId;
        tm.showEmptyState = vi.fn();

        tm.finalizeCloseTab(paneId);

        expect(destroyRpcChat).toHaveBeenCalledWith(paneId);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(tm.tabs.has(paneId)).toBe(false);
        expect(tm.piRpcStatusBar.classList.contains('hidden')).toBe(true);
        expect(tm.piRpcStatusBar.childElementCount).toBe(0);
    });

    it('does not send generic raw presets to Pi RPC', () => {
        const tab = { coder: 'pi-rpc' };
        const tm = Object.create(TabManager.prototype);
        tm.getActiveTab = vi.fn(() => tab);
        tm.sendInput = vi.fn();

        tm.sendRawInput('\x03');

        expect(tm.sendInput).not.toHaveBeenCalled();
    });

    it('does not send a quick command after switching the open dropup to Pi RPC', () => {
        const dropup = document.createElement('div');
        dropup.id = 'quick-commands-dropup';
        document.body.appendChild(dropup);
        let activeTab = { coder: 'bash' };
        const tm = Object.create(TabManager.prototype);
        tm.app = { quickCommands: [{ name: 'Status', command: '/status' }] };
        tm.getActiveTab = vi.fn(() => activeTab);
        tm.sendInput = vi.fn();
        tm.inputTextArea = document.createElement('textarea');
        tm.adjustInputHeight = vi.fn();
        tm._spamScrollToBottom = vi.fn();
        tm._appendConfigFooter = vi.fn();

        tm.renderQuickCmdsDropup();
        activeTab = { coder: 'pi-rpc' };
        document.querySelector('.dropup-model-btn').click();

        expect(tm.sendInput).not.toHaveBeenCalled();
    });

    it('does not run the Ctrl+Shift+Enter PTY bypass for Pi RPC', () => {
        const tab = { coder: 'pi-rpc' };
        const tm = {
            getActiveTab: vi.fn(() => tab),
            sendInput: vi.fn(),
        };
        const event = {
            ctrlKey: true,
            shiftKey: true,
            altKey: false,
            metaKey: false,
            key: 'Enter',
            preventDefault: vi.fn(),
        };

        TabManager.prototype.handleGlobalTabShortcuts.call(tm, event);

        expect(tm.sendInput).not.toHaveBeenCalled();
        expect(event.preventDefault).not.toHaveBeenCalled();
    });
});

describe('Pi RPC TabManager real Escape listener (textarea + document)', () => {
    // End-to-end coverage for the Escape listeners installed by
    // TabManager.setupEventListeners (textarea at web/terminal.js:693,
    // document at web/terminal.js:910). setupEventListeners is the
    // production wiring; calling it directly is the only way to fire
    // the real listener code under test. Heavy init helpers are stubbed
    // so the run only exercises the Escape-relevant branches.
    function installRealEscapeListeners() {
        const textarea = document.createElement('textarea');
        textarea.id = 'input-textarea';
        const sendBtn = document.createElement('button');
        sendBtn.id = 'send-input-btn';
        document.body.append(textarea, sendBtn);

        const tab = { paneId: 'pi-rpc:escape-real', coder: 'pi-rpc' };
        const tm = Object.create(TabManager.prototype);
        tm.inputTextArea = textarea;
        tm.sendInputBtn = sendBtn;
        tm.cancelInputBtn = document.createElement('button');
        tm.copyInputBtn = document.createElement('button');
        tm.directModeToggle = document.createElement('button');
        tm.getActiveTab = vi.fn(() => tab);
        tm._piRpcControlsFor = vi.fn(() => ({
            ready: true,
            exited: false,
            busy: true,
            queueDepth: 0,
            hasTranscript: false,
            model: 'm',
            thinking: 'low',
        }));
        tm._closePiRpcDropups = vi.fn(() => false);
        tm._interruptActivePiRpc = vi.fn(() => false);
        tm.sendRawInput = vi.fn();
        tm.handleGlobalTabShortcuts = vi.fn();
        tm._initHieroPreview = vi.fn();
        tm._setupContainerDragHandlers = vi.fn();
        tm._initAttachmentDropZone = vi.fn();
        tm._initAttachmentPasteHandler = vi.fn();
        tm._initPromptHistoryKeydown = vi.fn();
        tm._initBrandHud = vi.fn();
        tm.focusActiveTerminal = vi.fn();
        tm.app = {};

        // setupEventListeners installs a non-trivial set of document
        // listeners. Capture every keydown registration so we can remove
        // them after the test runs and prevent cross-test leakage.
        const realAdd = document.addEventListener.bind(document);
        const realRemove = document.removeEventListener.bind(document);
        const capturedKeydown = [];
        const addSpy = vi
            .spyOn(document, 'addEventListener')
            .mockImplementation((type, listener, options) => {
                if (type === 'keydown') capturedKeydown.push(listener);
                return realAdd(type, listener, options);
            });
        try {
            TabManager.prototype.setupEventListeners.call(tm);
        } finally {
            addSpy.mockRestore();
        }
        return {
            tm,
            textarea,
            cancelInputBtn: tm.cancelInputBtn,
            cleanup: () => {
                for (const listener of capturedKeydown) {
                    realRemove('keydown', listener);
                }
            },
        };
    }

    it('the visible Pi RPC Cancel button calls rpcChatInterrupt instead of raw PTY input', () => {
        const ctx = installRealEscapeListeners();
        try {
            ctx.tm._interruptActivePiRpc =
                TabManager.prototype._interruptActivePiRpc.bind(ctx.tm);
            ctx.cancelInputBtn.click();
            expect(rpcChatInterrupt).toHaveBeenCalledWith('pi-rpc:escape-real');
            expect(ctx.tm.sendRawInput).not.toHaveBeenCalled();
        } finally {
            ctx.cleanup();
        }
    });

    it('Esc closes an open viewer without reaching the Pi interrupt path', () => {
        const ctx = installRealEscapeListeners();
        try {
            closePiSubagentViewer.mockReturnValue(true);
            const event = new KeyboardEvent('keydown', {
                key: 'Escape',
                isComposing: false,
                bubbles: true,
                cancelable: true,
            });
            ctx.textarea.dispatchEvent(event);
            expect(closePiSubagentViewer).toHaveBeenCalledWith(
                'pi-rpc:escape-real',
            );
            expect(event.defaultPrevented).toBe(true);
            expect(ctx.tm._interruptActivePiRpc).not.toHaveBeenCalled();
            expect(rpcChatInterrupt).not.toHaveBeenCalled();
        } finally {
            ctx.cleanup();
        }
    });

    it('composing Escape is a no-op on both textarea and document listeners', () => {
        const ctx = installRealEscapeListeners();
        try {
            // Tab is not busy in the test, so _interruptActivePiRpc is
            // off by default; composing must never reach it.
            const textareaEvent = new KeyboardEvent('keydown', {
                key: 'Escape',
                isComposing: true,
                bubbles: true,
                cancelable: true,
            });
            ctx.textarea.dispatchEvent(textareaEvent);
            const documentEvent = new KeyboardEvent('keydown', {
                key: 'Escape',
                isComposing: true,
                bubbles: true,
                cancelable: true,
            });
            document.dispatchEvent(documentEvent);

            // Composing must not consume the event in any way: no
            // preventDefault, no stopPropagation, no blur, no focus,
            // no interrupt.
            expect(textareaEvent.defaultPrevented).toBe(false);
            expect(documentEvent.defaultPrevented).toBe(false);
            expect(ctx.tm._interruptActivePiRpc).not.toHaveBeenCalled();
            expect(ctx.tm.focusActiveTerminal).not.toHaveBeenCalled();
        } finally {
            ctx.cleanup();
        }
    });

    it('non-composing Escape with active Pi interrupts on both listeners and prevents default + propagation', () => {
        const ctx = installRealEscapeListeners();
        try {
            ctx.tm._interruptActivePiRpc.mockReturnValue(true);
            const textareaEvent = new KeyboardEvent('keydown', {
                key: 'Escape',
                isComposing: false,
                bubbles: true,
                cancelable: true,
            });
            ctx.textarea.dispatchEvent(textareaEvent);
            const documentEvent = new KeyboardEvent('keydown', {
                key: 'Escape',
                isComposing: false,
                bubbles: true,
                cancelable: true,
            });
            document.dispatchEvent(documentEvent);

            // Active Pi: both listeners must call preventDefault and
            // stopPropagation, and fire the interrupt. The textarea
            // listener returns early before the blur/focus fallback
            // because _handlePiRpcEscape claimed the event.
            expect(textareaEvent.defaultPrevented).toBe(true);
            expect(documentEvent.defaultPrevented).toBe(true);
            expect(ctx.tm._interruptActivePiRpc).toHaveBeenCalled();
            expect(ctx.tm.focusActiveTerminal).not.toHaveBeenCalled();
        } finally {
            ctx.cleanup();
        }
    });

    it('non-composing Escape on the textarea without active Pi falls through to the existing blur/focus action', () => {
        const ctx = installRealEscapeListeners();
        try {
            // _interruptActivePiRpc and _closePiRpcDropups already
            // return false; ensure the textarea listener's Escape
            // branch reaches the blur/focus fallback.
            const ev = new KeyboardEvent('keydown', {
                key: 'Escape',
                isComposing: false,
                bubbles: true,
                cancelable: true,
            });
            ctx.textarea.dispatchEvent(ev);

            // The fallback path runs because _handlePiRpcEscape did not
            // claim the event: the listener's own preventDefault +
            // blur + focus call sequence runs. The Pi RPC interrupt
            // branch was reached (by both textarea + document
            // listeners) but returned false because there is no
            // active Pi.
            expect(ev.defaultPrevented).toBe(true);
            expect(ctx.tm.focusActiveTerminal).toHaveBeenCalled();
            // _interruptActivePiRpc was checked, but always returned
            // false. Verify it was checked at least once and never
            // returned true.
            expect(ctx.tm._interruptActivePiRpc).toHaveBeenCalled();
            expect(
                ctx.tm._interruptActivePiRpc.mock.results.every(
                    (r) => r.value === false,
                ),
            ).toBe(true);
        } finally {
            ctx.cleanup();
        }
    });
});

describe('Pi RPC per-chat prompt history', () => {
    function cycleContext(promptHistory) {
        const tab = { paneId: 'pi-rpc:cycle', coder: 'pi-rpc', promptHistory };
        const tm = Object.create(TabManager.prototype);
        tm.inputTextArea = document.createElement('textarea');
        tm.adjustInputHeight = vi.fn();
        return { tm, tab };
    }

    it('records composed payloads newest-first and skips consecutive duplicates', () => {
        mockFetch();
        const tab = { paneId: 'pi-rpc:hist', coder: 'pi-rpc' };
        const tm = stagedContext(tab);

        tm.sendStagedInput();
        tm.inputTextArea.value = 'second';
        tm.sendStagedInput();
        tm.inputTextArea.value = 'second';
        tm.sendStagedInput();

        expect(tab.promptHistory).toEqual(['second', 'hello from Pi RPC']);
        expect(tab.chatHistoryCursor).toBe(-1);
        expect(tab.chatHistoryPreCycleValue).toBeUndefined();
    });

    it('cycles older/newer, clamps at the oldest, and restores the pre-cycle draft', () => {
        const { tm, tab } = cycleContext(['newest', 'oldest']);
        tm.inputTextArea.value = 'draft';

        tm._cycleChatHistory('older', tab);
        expect(tm.inputTextArea.value).toBe('newest');
        tm._cycleChatHistory('older', tab);
        expect(tm.inputTextArea.value).toBe('oldest');
        tm._cycleChatHistory('older', tab);
        expect(tm.inputTextArea.value).toBe('oldest'); // clamped
        tm._cycleChatHistory('newer', tab);
        expect(tm.inputTextArea.value).toBe('newest');
        tm._cycleChatHistory('newer', tab);
        expect(tm.inputTextArea.value).toBe('draft'); // pre-cycle draft back
        tm._cycleChatHistory('newer', tab);
        expect(tm.inputTextArea.value).toBe('draft'); // no-op past newest
    });

    it('does nothing without history', () => {
        const { tm, tab } = cycleContext([]);
        tm.inputTextArea.value = 'draft';
        tm._cycleChatHistory('older', tab);
        expect(tm.inputTextArea.value).toBe('draft');
        expect(tab.chatHistoryCursor).toBeUndefined();
    });

    it('caret guards detect first/last line', () => {
        const { tm } = cycleContext([]);
        tm.inputTextArea.value = 'line1\nline2';
        tm.inputTextArea.setSelectionRange(3, 3); // caret on line1
        expect(tm._caretOnFirstLine()).toBe(true);
        expect(tm._caretOnLastLine()).toBe(false);
        tm.inputTextArea.setSelectionRange(8, 8); // caret on line2
        expect(tm._caretOnFirstLine()).toBe(false);
        expect(tm._caretOnLastLine()).toBe(true);
    });

    it('typed input starts a fresh per-chat history cycle', () => {
        const tab = {
            paneId: 'pi-rpc:type',
            coder: 'pi-rpc',
            promptHistory: ['newest'],
            chatHistoryCursor: 0,
            chatHistoryPreCycleValue: 'stale draft',
        };
        const tm = Object.create(TabManager.prototype);
        tm.inputTextArea = document.createElement('textarea');
        tm.inputTextArea.value = 'edited draft';
        tm.getActiveTab = vi.fn(() => tab);
        tm.adjustInputHeight = vi.fn();

        TabManager.prototype._initPromptHistoryKeydown.call(tm);
        tm.inputTextArea.dispatchEvent(new Event('input'));

        expect(tab.chatHistoryCursor).toBe(-1);
        expect(tab.chatHistoryPreCycleValue).toBeUndefined();
        tm._cycleChatHistory('older', tab);
        tm._cycleChatHistory('newer', tab);
        expect(tm.inputTextArea.value).toBe('edited draft');
    });

    it('Reset Chat success clears the per-chat history', async () => {
        const row = document.createElement('div');
        const tab = {
            paneId: 'pi-rpc:reset-hist',
            coder: 'pi-rpc',
            promptHistory: ['x'],
            chatHistoryCursor: 1,
        };
        getPiRpcControls.mockReturnValue({
            ready: true,
            exited: false,
            busy: false,
            queueDepth: 0,
            hasTranscript: true,
            model: 'm',
            thinking: 'low',
        });
        rpcChatReset.mockResolvedValue({ cancelled: false, reset: true });
        vi.stubGlobal(
            'confirm',
            vi.fn(() => true),
        );
        const tm = Object.create(TabManager.prototype);
        tm.presetsContainer = row;
        tm.tabs = new Map([[tab.paneId, tab]]);
        tm.getActiveTab = vi.fn(() => tab);
        tm._piRpcResetPending = new Set();
        tm._piRpcError = vi.fn();

        tm.renderPresets('pi-rpc');
        row.querySelector('.pi-rpc-reset-btn').click();
        await Promise.resolve();
        await Promise.resolve();

        expect(tab.promptHistory).toEqual([]);
        expect(tab.chatHistoryCursor).toBe(-1);
        expect(tab.chatHistoryPreCycleValue).toBeUndefined();
    });
});

describe('Pi RPC chat input plain-arrow keydown (real listener)', () => {
    // Mirrors installRealEscapeListeners: setupEventListeners is the
    // production wiring for the textarea keydown listener under test.
    function installRealChatKeydown() {
        const textarea = document.createElement('textarea');
        textarea.id = 'input-textarea';
        const sendBtn = document.createElement('button');
        sendBtn.id = 'send-input-btn';
        document.body.append(textarea, sendBtn);

        const tab = { paneId: 'pi-rpc:arrows', coder: 'pi-rpc' };
        const tm = Object.create(TabManager.prototype);
        tm.inputTextArea = textarea;
        tm.sendInputBtn = sendBtn;
        tm.cancelInputBtn = document.createElement('button');
        tm.copyInputBtn = document.createElement('button');
        tm.directModeToggle = document.createElement('button');
        tm.getActiveTab = vi.fn(() => tab);
        tm._closePiRpcDropups = vi.fn(() => false);
        tm._interruptActivePiRpc = vi.fn(() => false);
        tm.handleGlobalTabShortcuts = vi.fn();
        tm._initHieroPreview = vi.fn();
        tm._setupContainerDragHandlers = vi.fn();
        tm._initAttachmentDropZone = vi.fn();
        tm._initAttachmentPasteHandler = vi.fn();
        tm._initPromptHistoryKeydown = vi.fn();
        tm._initBrandHud = vi.fn();
        tm.focusActiveTerminal = vi.fn();
        tm.adjustInputHeight = vi.fn();
        tm.app = {};

        const realAdd = document.addEventListener.bind(document);
        const realRemove = document.removeEventListener.bind(document);
        const capturedKeydown = [];
        const addSpy = vi
            .spyOn(document, 'addEventListener')
            .mockImplementation((type, listener, options) => {
                if (type === 'keydown') capturedKeydown.push(listener);
                return realAdd(type, listener, options);
            });
        try {
            TabManager.prototype.setupEventListeners.call(tm);
        } finally {
            addSpy.mockRestore();
        }
        return {
            tm,
            tab,
            textarea,
            cleanup: () => {
                for (const listener of capturedKeydown) {
                    realRemove('keydown', listener);
                }
            },
        };
    }

    const arrowEvent = (key, extra = {}) =>
        new KeyboardEvent('keydown', {
            key,
            bubbles: true,
            cancelable: true,
            ...extra,
        });

    it('ArrowUp/ArrowDown cycle the per-chat history on a Pi RPC tab', () => {
        const ctx = installRealChatKeydown();
        try {
            ctx.tab.promptHistory = ['a', 'b'];
            const up = arrowEvent('ArrowUp');
            ctx.textarea.dispatchEvent(up);
            expect(ctx.textarea.value).toBe('a');
            expect(up.defaultPrevented).toBe(true);
            ctx.textarea.dispatchEvent(arrowEvent('ArrowDown'));
            expect(ctx.textarea.value).toBe('');
        } finally {
            ctx.cleanup();
        }
    });

    it('leaves no-op history arrows to native textarea behavior', () => {
        const ctx = installRealChatKeydown();
        try {
            const up = arrowEvent('ArrowUp');
            ctx.textarea.dispatchEvent(up);
            expect(up.defaultPrevented).toBe(false);

            ctx.tab.promptHistory = ['a'];
            const down = arrowEvent('ArrowDown');
            ctx.textarea.dispatchEvent(down);
            expect(down.defaultPrevented).toBe(false);
        } finally {
            ctx.cleanup();
        }
    });

    it('ArrowUp does not cycle when the caret is below the first line', () => {
        const ctx = installRealChatKeydown();
        try {
            ctx.tab.promptHistory = ['a'];
            ctx.textarea.value = 'line1\nline2';
            ctx.textarea.setSelectionRange(8, 8);
            ctx.textarea.dispatchEvent(arrowEvent('ArrowUp'));
            expect(ctx.textarea.value).toBe('line1\nline2');
            expect(ctx.tab.chatHistoryCursor).toBeUndefined();
        } finally {
            ctx.cleanup();
        }
    });

    it('modified arrows and non-Pi tabs do not cycle', () => {
        const ctx = installRealChatKeydown();
        try {
            ctx.tab.promptHistory = ['a'];
            ctx.textarea.dispatchEvent(arrowEvent('ArrowUp', { altKey: true }));
            expect(ctx.textarea.value).toBe('');
            expect(ctx.tab.chatHistoryCursor).toBeUndefined();

            const bashTab = { paneId: 'bash:1', coder: 'bash' };
            ctx.tm.getActiveTab.mockReturnValue(bashTab);
            ctx.tm.sendInput = vi.fn(() => true);
            ctx.tm._spamScrollToBottom = vi.fn();
            ctx.textarea.dispatchEvent(arrowEvent('ArrowUp'));
            expect(ctx.tm.sendInput).toHaveBeenCalledWith(bashTab, '\u001b[A');
            expect(ctx.textarea.value).toBe('');
        } finally {
            ctx.cleanup();
        }
    });
});

describe('Pi RPC interrupt restore', () => {
    function interruptContext(tab) {
        const tm = Object.create(TabManager.prototype);
        tm.getActiveTab = vi.fn(() => tab);
        tm.inputTextArea = document.createElement('textarea');
        tm.lastInputValue = '';
        tm.app = { showToast: vi.fn() };
        tm.adjustInputHeight = vi.fn();
        tm._piRpcControlsFor = vi.fn(() => ({
            ready: true,
            exited: false,
            busy: true,
            queueDepth: 0,
            hasTranscript: true,
            model: 'm',
            thinking: 'low',
        }));
        tm._piRpcError = vi.fn();
        return tm;
    }

    it('restores the active prompt into the input after a successful abort', async () => {
        const tab = { paneId: 'pi-rpc:one', coder: 'pi-rpc' };
        const tm = interruptContext(tab);
        rpcChatInterrupt.mockResolvedValueOnce({
            aborted: true,
            restored: ['fix the login bug'],
        });

        expect(tm._interruptActivePiRpc()).toBe(true);
        await Promise.resolve();

        expect(tm.inputTextArea.value).toBe('fix the login bug');
        expect(tm.lastInputValue).toBe('fix the login bug');
        expect(tm._historyCursor).toBe(-1);
        expect(tm._historyPreCycleValue).toBeUndefined();
        expect(tab.chatHistoryCursor).toBe(-1);
        expect(tm.app.showToast).not.toHaveBeenCalled();
    });

    it('joins queued steers above the current draft and hints about the retained queue', async () => {
        const tab = { paneId: 'pi-rpc:two', coder: 'pi-rpc' };
        const tm = interruptContext(tab);
        tm.inputTextArea.value = 'unsent draft';
        rpcChatInterrupt.mockResolvedValueOnce({
            aborted: true,
            restored: ['first', 'second'],
        });

        tm._interruptActivePiRpc();
        await Promise.resolve();

        expect(tm.inputTextArea.value).toBe('first\n\nsecond\n\nunsent draft');
        expect(tm.app.showToast).toHaveBeenCalledWith(
            'Pi kept 1 queued steering message; edit before resending to avoid duplicates',
            { type: 'info', title: 'Pi interrupt' },
        );
    });

    it('parks the restored text on tab.draft when another tab is active at restore time', async () => {
        const tab = { paneId: 'pi-rpc:away', coder: 'pi-rpc', draft: 'parked' };
        const other = { paneId: 'bash:1', coder: 'bash' };
        const tm = interruptContext(tab);
        rpcChatInterrupt.mockResolvedValueOnce({
            aborted: true,
            restored: ['lost prompt'],
        });

        // Escape fires while the Pi tab is active; the user switches tabs
        // while the abort is still in flight.
        tm._interruptActivePiRpc();
        tm.getActiveTab.mockReturnValue(other);
        await Promise.resolve();

        expect(tab.draft).toBe('lost prompt\n\nparked');
        expect(tm.inputTextArea.value).toBe('');
    });

    it('a rejected abort restores nothing', async () => {
        const tab = { paneId: 'pi-rpc:fail', coder: 'pi-rpc' };
        const tm = interruptContext(tab);
        rpcChatInterrupt.mockRejectedValueOnce(new Error('pi gone'));

        tm._interruptActivePiRpc();
        await Promise.resolve();
        await Promise.resolve();

        expect(tm.inputTextArea.value).toBe('');
        expect(tm._piRpcError).toHaveBeenCalled();
    });

    it('an empty restored array is a no-op', async () => {
        const tab = { paneId: 'pi-rpc:idle', coder: 'pi-rpc' };
        const tm = interruptContext(tab);
        rpcChatInterrupt.mockResolvedValueOnce({ aborted: true, restored: [] });

        tm._interruptActivePiRpc();
        await Promise.resolve();

        expect(tm.inputTextArea.value).toBe('');
        expect(tm.adjustInputHeight).not.toHaveBeenCalled();
    });
});
