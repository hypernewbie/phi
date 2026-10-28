// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

// Frozen input: a retained view holds live delivery, so only text may leave
// the client. Mouse state, application-mode keys, and paste wrappers describe
// a screen the reader is no longer looking at.
describe('input while the view is retained', () => {
    const manager = () => Object.create(TabManager.prototype);
    // The served markup owns this line; jsdom starts without index.html.
    beforeEach(() => {
        document.body.innerHTML =
            '<div id="input-restriction" class="hidden" role="status"></div>';
    });

    it('drops mouse reports and application-mode keys', () => {
        const tm = manager();
        const tab = { _resyncNeeded: true, isDead: false };
        for (const data of [
            '\x1b[<64;20;5M',
            '\x1b[A',
            '\x03',
            '\x1b[200~half',
        ]) {
            tm._holdFrozenInput(tab, data);
        }
        expect(tab.ws).toBeUndefined();
        expect(tab.userFollowBottom).toBeUndefined();
    });

    it('holds a paste in the draft and says so', () => {
        const tm = manager();
        const area = document.createElement('textarea');
        area.value = 'kept ';
        tm.inputTextArea = area;
        tm.adjustInputHeight = vi.fn();
        tm.saveActiveDraft = vi.fn();
        const tab = { _resyncNeeded: true, isDead: false };

        const held = tm._holdFrozenInput(
            tab,
            '\x1b[200~first\r\nsecond\x1b[201~',
        );

        expect(held).toBe(true);
        expect(area.value).toBe('kept first\nsecond');
        expect(document.getElementById('input-restriction').textContent).toBe(
            'Paste held until live output is resynced.',
        );
    });

    it('lets printable text through to the normal send path', () => {
        const tm = manager();
        expect(tm._holdFrozenInput({ _resyncNeeded: true }, 'hello')).toBe(
            false,
        );
    });

    it('treats Enter as the resync gesture', () => {
        const tm = manager();
        const tab = { _resyncNeeded: true, isDead: false };
        tm._resyncRetainedView = vi.fn();
        expect(tm._holdFrozenInput(tab, '\r')).toBe(true);
        expect(tm._resyncRetainedView).toHaveBeenCalledWith(tab);
    });

    it('clears the restriction line once a frontier is certified', () => {
        const tm = manager();
        const line = document.getElementById('input-restriction');
        tm._setInputRestriction('Paste held until live output is resynced.');
        expect(line.classList.contains('hidden')).toBe(false);
        const tab = { _resyncNeeded: true };
        tm._updateResyncAffordance = vi.fn();
        tm._clearResyncNeeded(tab);
        expect(line.classList.contains('hidden')).toBe(true);
        expect(line.textContent).toBe('');
    });
});
