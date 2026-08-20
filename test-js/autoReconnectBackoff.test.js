import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The backoff was reset in the websocket's onopen handler. A socket that opens
// and then immediately dies therefore scored as a success, so the attempt
// counter could never climb past 1:
//
//   open -> reconnectAttempts = 0 -> close -> attempt 1 -> open -> 0 -> ...
//
// Two consequences, both of which look like "it disconnects constantly":
// the exponential backoff never engaged (every retry used the attempt-1
// delay), and AUTO_RECONNECT_MAX_ATTEMPTS was unreachable, so a flapping
// pane redialled forever instead of giving up.

const src = readFileSync(
    fileURLToPath(new URL('../web/terminal.js', import.meta.url)),
    'utf8',
);

describe('source guards', () => {
    // maybeAutoReconnect is entangled with app.config, document.visibilityState,
    // activePaneId, tabInfo.termContainer, and a live setTimeout -> reconnectTab;
    // AUTO_RECONNECT_* are also module-private consts, unreachable from outside.
    // These guards pin the shipped source text directly instead.
    it('resets the backoff only from the stability timer, never inline in onopen', () => {
        // The reset must be the body of the stable-timer callback.
        expect(src).toMatch(
            /reconnectStableTimer = setTimeout\(\(\) => \{\s*\n\s*tabInfo\.reconnectAttempts = 0;/,
        );
        expect(src).toContain('}, AUTO_RECONNECT_STABLE_MS);');
        // And there must be no bare synchronous reset next to the open flag.
        const openIdx = src.indexOf('opened = true;');
        expect(openIdx).toBeGreaterThan(-1);
        const afterOpen = src.slice(openIdx, openIdx + 400);
        const inlineReset =
            /opened = true;(?:(?!setTimeout)[\s\S])*?tabInfo\.reconnectAttempts = 0;/;
        expect(afterOpen).not.toMatch(inlineReset);
    });

    it('floors every redial with the grace constant', () => {
        expect(src).toContain(
            'AUTO_RECONNECT_GRACE_MS + Math.random() * backoff',
        );
        expect(src).toMatch(/const AUTO_RECONNECT_GRACE_MS = 1000;/);
    });

    it('revives dead active tab on window focus alongside online and pageshow', () => {
        expect(src).toContain(
            "window.addEventListener('focus', () => this._reviveActiveTabIfDead());",
        );
        expect(src).toContain(
            "window.addEventListener('online', () => this._reviveActiveTabIfDead());",
        );
        expect(src).toMatch(
            /window\.addEventListener\(\s*'pageshow',\s*\(\) =>\s*this\._reviveActiveTabIfDead\(\),?\s*\)/,
        );
    });
});
