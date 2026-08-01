import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

const src = readFileSync(fileURLToPath(new URL('../web/terminal.js', import.meta.url)), 'utf8');

const GRACE = 1000;
const STABLE = 5000;
const MAX_ATTEMPTS = 10;
const MAX_DELAY = 20000;

// Mirrors maybeAutoReconnect's scheduling arithmetic and the open/close
// lifecycle around reconnectAttempts.
function makeTab() {
    return { reconnectAttempts: 0, reconnectStableTimer: null };
}

function onOpen(tab) {
    clearTimeout(tab.reconnectStableTimer);
    tab.reconnectStableTimer = setTimeout(() => {
        tab.reconnectAttempts = 0;
        tab.reconnectStableTimer = null;
    }, STABLE);
}

function onClose(tab) {
    clearTimeout(tab.reconnectStableTimer);
    tab.reconnectStableTimer = null;
}

function schedule(tab) {
    if (tab.reconnectAttempts >= MAX_ATTEMPTS) {
        tab.reconnectAttempts = 0;
        return null;
    }
    tab.reconnectAttempts++;
    const backoff = Math.min(MAX_DELAY, Math.pow(2, tab.reconnectAttempts - 1) * 1000);
    return GRACE + Math.random() * backoff;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('auto-reconnect backoff', () => {
    it('counts an open-then-immediately-closed socket as a failed attempt', () => {
        const tab = makeTab();

        // Three flap cycles: each reaches onopen, then dies well before the
        // stability window. This is the exact shape that pinned the old
        // counter at 1 forever.
        for (let i = 0; i < 3; i++) {
            schedule(tab);
            onOpen(tab);
            vi.advanceTimersByTime(100);
            onClose(tab);
        }

        expect(tab.reconnectAttempts).toBe(3);
    });

    it('escalates the delay across a flap instead of staying at attempt 1', () => {
        const tab = makeTab();
        vi.spyOn(Math, 'random').mockReturnValue(1);

        const delays = [];
        for (let i = 0; i < 4; i++) {
            delays.push(schedule(tab));
            onOpen(tab);
            vi.advanceTimersByTime(100);
            onClose(tab);
        }
        Math.random.mockRestore();

        expect(delays).toEqual([2000, 3000, 5000, 9000]);
        // Strictly increasing -- the old code produced [2000, 2000, 2000, 2000].
        for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    });

    it('gives up once the attempt cap is reached', () => {
        const tab = makeTab();
        for (let i = 0; i < MAX_ATTEMPTS; i++) {
            expect(schedule(tab)).not.toBeNull();
            onOpen(tab);
            vi.advanceTimersByTime(100);
            onClose(tab);
        }
        expect(schedule(tab)).toBeNull();
    });

    it('clears the backoff once a connection actually survives', () => {
        const tab = makeTab();
        schedule(tab);
        schedule(tab);
        expect(tab.reconnectAttempts).toBe(2);

        onOpen(tab);
        vi.advanceTimersByTime(STABLE + 1);

        expect(tab.reconnectAttempts).toBe(0);
    });

    it('never redials sooner than the grace period', () => {
        const tab = makeTab();
        vi.spyOn(Math, 'random').mockReturnValue(0); // worst case: no jitter
        for (let i = 0; i < 5; i++) {
            expect(schedule(tab)).toBeGreaterThanOrEqual(GRACE);
        }
        Math.random.mockRestore();
    });
});

describe('source guards', () => {
    // The behavioural tests above mirror the scheduling algorithm rather than
    // importing it -- terminal.js is a large hand-written module with no export
    // surface for this. So they pin the algorithm, and these guards pin that
    // the shipped file still implements it. Both halves are needed.
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
        const inlineReset = /opened = true;(?:(?!setTimeout)[\s\S])*?tabInfo\.reconnectAttempts = 0;/;
        expect(afterOpen).not.toMatch(inlineReset);
    });

    it('floors every redial with the grace constant', () => {
        expect(src).toContain('AUTO_RECONNECT_GRACE_MS + Math.random() * backoff');
        expect(src).toMatch(/const AUTO_RECONNECT_GRACE_MS = 1000;/);
    });
});
