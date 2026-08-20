// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { setupDomHarness, mockFetch } from './_dom.js';
import { App } from '../web/app.js';

// The cmd config export was split in v0.7.16: quick_commands (sent to
// active PTY) and terminal_commands (spawn new shell tabs) are now
// different endpoints. They were conflated - same name, different thing.
// These tests pin the new methods to the correct routes.

setupDomHarness();

// Minimal App instance. App is a large class; we exercise just the two new
// methods against Object.create so we don't need to run the constructor.
function makeApp() {
    const a = Object.create(App.prototype);
    a.showToast = vi.fn();
    return a;
}

beforeEach(() => vi.clearAllMocks());

describe('App.exportQuickCommandsConfig', () => {
    it('hits /api/config/export-quick-commands (not the old /export-cmds)', async () => {
        const a = makeApp();
        const btn = document.createElement('button');
        mockFetch(() => ({ ok: true, json: { config: 'PHIQUICKCMDS:abc' } }));
        await a.exportQuickCommandsConfig(btn);
        const [url] = fetch.mock.calls[0];
        expect(url).toContain('/api/config/export-quick-commands');
        expect(url).not.toContain('/export-cmds');
    });
});

describe('App.exportTerminalCommandsConfig', () => {
    it('hits /api/config/export-terminal-commands (not the old /export-cmds)', async () => {
        const a = makeApp();
        const btn = document.createElement('button');
        mockFetch(() => ({ ok: true, json: { config: 'PHITERMCMDS:abc' } }));
        await a.exportTerminalCommandsConfig(btn);
        const [url] = fetch.mock.calls[0];
        expect(url).toContain('/api/config/export-terminal-commands');
        expect(url).not.toContain('/export-cmds');
    });
});

// Static wiring checks: the two call sites must point at the right method,
// not the old combined one. Catches regressions where someone rewires the
// dropup to the terminal endpoint (or vice versa).
describe('call sites use the right method (static source check)', () => {
    it('the quick-commands dropup in web/terminal.js calls exportQuickCommandsConfig', () => {
        const src = readFileSync('web/terminal.js', 'utf8');
        // Match the if-block body: `mode === 'cmds')` followed by any
        // (non-greedy) chars then `this.app.<method>(copyBtn)`. Tolerates
        // nested braces by limiting the lookahead to the relevant line.
        const match = src.match(
            /mode === 'cmds'\)[\s\S]*?this\.app\.(\w+)\(copyBtn\)/,
        );
        expect(
            match,
            'expected to find quick-commands dropup copy handler',
        ).toBeTruthy();
        expect(match[1]).toBe('exportQuickCommandsConfig');
    });

    it('the cmd panel Copy Commands button in web/diff.js calls exportTerminalCommandsConfig', () => {
        const src = readFileSync('web/diff.js', 'utf8');
        const match = src.match(
            /copyAllCommands\(btnElement\) \{[\s\S]*?this\.app\.(\w+)\(btnElement\)/,
        );
        expect(match, 'expected to find copyAllCommands handler').toBeTruthy();
        expect(match[1]).toBe('exportTerminalCommandsConfig');
    });
});
