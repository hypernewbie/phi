// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TabManager } from '../web/terminal.js';

// Reconnect must leave the terminal showing the session, not a pile of
// artefacts from every previous drop.
//
// The server replays its whole ring buffer on each attach and always ends
// with a 0x06 replay-complete frame. The client used to write the replay on
// top of whatever was already on screen and bracket it with [Connection lost]
// / [Reconnected] markers, so each cycle left a duplicated scrollback and two
// permanent banners that no later reconnect could clear.

const terminalJsSrc = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'terminal.js'),
    'utf8'
);

function fakeTerm() {
    return {
        written: [],
        resets: 0,
        rows: 24,
        write(data) { this.written.push(data); },
        reset() { this.resets += 1; this.written.length = 0; },
        refresh: vi.fn(),
    };
}

function ctx() {
    const c = Object.create(TabManager.prototype);
    c.app = { config: { auto_reconnect: 'off' }, showToast: vi.fn() };
    c.updateDocumentTitle = vi.fn();
    c.updateDisconnectBanner = vi.fn();
    c._showReconnectOverlay = vi.fn();
    c.maybeAutoReconnect = vi.fn();
    c.writeToTerminal = vi.fn((tab, data) => tab.term.write(data));
    c.getActiveTab = vi.fn(() => null);
    return c;
}

function tab() {
    return {
        paneId: 'p1',
        title: 'shell',
        coder: 'bash',
        term: fakeTerm(),
        tabEl: Object.assign(document.createElement('div'), { classList: document.createElement('div').classList }),
        isDead: false,
        exitCode: null,
    };
}

beforeEach(() => vi.clearAllMocks());

describe('disconnect no longer writes into the scrollback', () => {
    it('reports a lost connection through the overlay, banner and toast only', () => {
        const c = ctx();
        const t = tab();

        TabManager.prototype._handleTerminalDisconnect.call(c, t);

        // The banners are transient UI; a buffer write would be permanent.
        expect(t.term.written.join('')).not.toMatch(/Connection lost/);
        expect(c._showReconnectOverlay).toHaveBeenCalledWith(t);
        expect(c.updateDisconnectBanner).toHaveBeenCalled();
        expect(c.app.showToast).toHaveBeenCalled();
        expect(t.isDead).toBe(true);
    });

    it('keeps no [Connection lost] or [Reconnected] writes in the source', () => {
        // Cheap guard against either marker being reintroduced elsewhere.
        expect(terminalJsSrc).not.toMatch(/term\.write\([^)]*Connection lost/);
        expect(terminalJsSrc).not.toMatch(/term\.write\([^)]*Reconnected/);
    });
});

describe('replay replaces the buffer instead of appending to it', () => {
    it('resets on the first replayed byte so history is not duplicated', () => {
        const c = ctx();
        const t = tab();
        t.term.write('old output\r\n');
        t.awaitingReplay = true;

        // Mirrors the data callback installed by reconnectTab.
        const onData = (data) => {
            if (t.awaitingReplay) {
                t.awaitingReplay = false;
                t.term.reset();
            }
            c.writeToTerminal(t, data);
        };
        onData('old output\r\nnew output\r\n');

        expect(t.term.resets).toBe(1);
        expect(t.term.written.join('')).toBe('old output\r\nnew output\r\n');
    });

    it('resets once per reconnect, not on every chunk', () => {
        const c = ctx();
        const t = tab();
        t.awaitingReplay = true;

        const onData = (data) => {
            if (t.awaitingReplay) {
                t.awaitingReplay = false;
                t.term.reset();
            }
            c.writeToTerminal(t, data);
        };
        onData('chunk one');
        onData('chunk two');
        onData('chunk three');

        expect(t.term.resets).toBe(1);
        expect(t.term.written.join('')).toBe('chunk onechunk twochunk three');
    });

    it('drops the pending reset when the replay was empty', () => {
        // Replay disabled server-side still sends replay-complete. Leaving the
        // flag armed would blank the terminal on the next live byte.
        const c = ctx();
        const t = tab();
        t.term.write('history worth keeping');
        t.awaitingReplay = true;

        TabManager.prototype.handleControlMessage.call(c, t, { type: 'replay-complete' });

        expect(t.awaitingReplay).toBe(false);
        expect(t.term.resets).toBe(0);
        expect(t.term.written.join('')).toContain('history worth keeping');
    });
});
