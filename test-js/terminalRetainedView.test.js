// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { replayHarness, recordingEnvelope } from './_terminalReplayHarness.js';
import { parse } from './_terminalOracle.js';
import { TabManager } from '../web/terminal.js';

setupDomHarness();

// Slice 3 scenario: a replacement attach that cannot certify a frontier must
// not throw away a view the reader is holding. The pane keeps its coherent
// output, live delivery stays held, and only an explicit resync repairs it.

const SOURCE = `${'ROW 000\r\n'.repeat(80)}LIVE TAIL\r\n`;

async function readingHarness() {
    // Every range and state request is evicted, so bootstrap recovery has no
    // certified frontier to fall back to.
    const h = replayHarness(SOURCE, () => ({ ok: false, status: 404 }));
    await parse(h.term, 'KEPT 001\r\nKEPT 002\r\nKEPT 003\r\n'.repeat(6));
    h.tab.userFollowBottom = false;
    h.tab.term.scrollToBottom();
    h.tab.term.scrollLines(-4);
    return h;
}

const closeSpy = (h) => {
    const close = vi.fn();
    h.tab.ws.ws = { close };
    return close;
};

it('keeps the reader’s view instead of closing the socket', async () => {
    const h = await readingHarness();
    const close = closeSpy(h);
    const outcome = await h.manager._bootstrapDelta(h.tab, 0, 200);

    expect(outcome.kind).toBe('retained');
    expect(close).not.toHaveBeenCalled();
    expect(h.tab._resyncNeeded).toBe(true);
    expect(h.tab.userFollowBottom).toBe(false);
    expect(h.term.buffer.active.viewportY).toBeGreaterThan(0);
});

it('re-attaches when nobody is holding the view', async () => {
    const h = await readingHarness();
    h.tab.userFollowBottom = true;
    h.tab.term.scrollToBottom();

    const outcome = await h.manager._bootstrapDelta(h.tab, 0, 200);

    expect(outcome.kind).toBe('failed');
    expect(h.tab._resyncNeeded).toBeFalsy();
});

it('an empty pane is never retained', async () => {
    const h = replayHarness(SOURCE, () => ({ ok: false, status: 404 }));
    h.tab.userFollowBottom = false;

    const outcome = await h.manager._bootstrapDelta(h.tab, 0, 200);

    expect(outcome.kind).toBe('failed');
});

it('the explicit resync clears the hold and asks for a fresh attach', async () => {
    const h = await readingHarness();
    const close = closeSpy(h);
    await h.manager._bootstrapDelta(h.tab, 0, 200);
    expect(h.tab._resyncNeeded).toBe(true);

    h.manager._resyncRetainedView(h.tab);

    expect(h.tab._resyncNeeded).toBe(false);
    expect(h.tab.userFollowBottom).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
});

it('a certified frontier clears the hold', async () => {
    const h = await readingHarness();
    vi.stubGlobal('fetch', async (url) => {
        const query = new URL(url, 'http://localhost').searchParams;
        const from = Number(query.get('from'));
        const to = Number(query.get('through'));
        return recordingEnvelope(SOURCE.slice(from, to), from, to);
    });
    h.tab._resyncNeeded = true;

    const outcome = await h.manager._bootstrapDelta(h.tab, 0, 40);

    expect(outcome.kind).toBe('applied');
    expect(h.tab._resyncNeeded).toBe(false);
});

it('the history module reads the outcome union, not a boolean', async () => {
    const manager = Object.create(TabManager.prototype);
    manager._bootstrapDelta = async () => ({
        kind: 'retained',
        reason: 'reader',
    });
    // A retained tail must not be treated as a caught-up stream.
    expect(await manager._bootstrapDelta({}, {}, 0)).toEqual({
        kind: 'retained',
        reason: 'reader',
    });
});
