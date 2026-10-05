// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import {
    encode,
    replayHarness,
    recordingEnvelope,
} from './_terminalReplayHarness.js';
import {
    Terminal,
    SerializeAddon,
    parse,
    terminalState,
    firstDifference,
} from './_terminalOracle.js';
import { TabManager } from '../web/terminal.js';
setupDomHarness();

const liveCheckpointHead = (head) => ({
    epoch: 7,
    oldest: 0,
    head,
    ckpt: { through: head, cols: 240, rows: 12, ansi: 'OLD LIVE\r\n' },
});
function coarse() {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
}
function rows(term) {
    const b = term.buffer.active;
    return Array.from({ length: b.length }, (_, i) =>
        b.getLine(i).translateToString(true),
    );
}
function serializer(h) {
    h.tab.serializeAddon = new SerializeAddon();
    h.term.loadAddon(h.tab.serializeAddon);
}

it('an alternate-screen checkpoint preserves already-painted TUI content', async () => {
    const baseline = new Terminal({
        cols: 40,
        rows: 12,
        allowProposedApi: true,
    });
    const restored = new Terminal({
        cols: 40,
        rows: 12,
        allowProposedApi: true,
    });
    const addon = new SerializeAddon();
    baseline.loadAddon(addon);
    const fetcher = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    try {
        const prefix = 'NORMAL\x1b[?1049hALT SCREEN CONTENT';
        await parse(baseline, prefix);
        Object.create(TabManager.prototype)._uploadCheckpoint({
            paneId: 'review',
            paneEpoch: 7,
            drainedSeq: encode(prefix).length,
            ws: { mode: 'hot' },
            term: baseline,
            serializeAddon: addon,
        });
        const ansi = JSON.parse(fetcher.mock.calls[0][1].body).ansi;
        await parse(restored, ansi);

        expect(
            firstDifference(terminalState(baseline), terminalState(restored)),
        ).toBeNull();
    } finally {
        baseline.dispose();
        restored.dispose();
    }
});

it('coarse raw attach retains the application screen mode and rendition', async () => {
    coarse();
    const text = `\x1b[?1049h\x1b[31m${`${'A'.repeat(239)}\r\n`.repeat(9000)}\x1b[HNEWEST`;
    const bytes = encode(text);
    const h = replayHarness(bytes);
    const reference = new Terminal({ cols: 240, rows: 12, scrollback: 10000 });
    try {
        await parse(reference, text);
        h.pty.ws.head({ epoch: 7, oldest: 0, head: bytes.length });
        await h.settle();
        expect(h.requests[0].from).toBe(0);
        expect(
            firstDifference(terminalState(reference), terminalState(h.term)),
        ).toBeNull();
    } finally {
        h.dispose();
        reference.dispose();
    }
});

it('older pages retain every short numbered line', async () => {
    const text = Array.from(
        { length: 300000 },
        (_, i) => `${String(i).padStart(8, '0')}\r\n`,
    ).join('');
    const bytes = encode(text);
    const h = replayHarness(bytes);
    try {
        serializer(h);
        h.pty.ws.head({
            epoch: 7,
            oldest: 0,
            head: bytes.length,
            ckpt: {
                through: bytes.length,
                cols: 240,
                rows: 12,
                ansi: 'LATEST\r\n',
            },
        });
        await h.settle();
        await h.manager._loadColdHistory(h.tab);
        await h.settle();
        const first = rows(h.term)
            .map((x) => (/^\d{8}$/.test(x) ? Number(x) : NaN))
            .filter(Number.isFinite);
        await h.manager._loadColdHistory(h.tab);
        await h.settle();
        const second = rows(h.term)
            .map((x) => (/^\d{8}$/.test(x) ? Number(x) : NaN))
            .filter(Number.isFinite);
        const gap = Math.min(...first) - Math.max(...second) - 1;
        expect(
            Math.max(...first),
            'the first page must include immediate older output',
        ).toBe(299999);
        expect(Math.min(...second)).toBeLessThan(Math.min(...first));
        expect(
            gap,
            'all rows between adjacent pages must be accessible',
        ).toBeLessThanOrEqual(0);
        expect(h.term.buffer.active.length).toBeLessThanOrEqual(
            10000 + h.term.rows,
        );
        expect(h.requests.every((r) => r.to - r.from <= 2 * 1024 * 1024)).toBe(
            true,
        );
    } finally {
        h.dispose();
    }
});

it('a new pane epoch clears older-history ownership', async () => {
    const text = 'OLD\r\n'.repeat(400000);
    const bytes = encode(text);
    const h = replayHarness(bytes);
    try {
        serializer(h);
        h.pty.ws.head({
            epoch: 7,
            oldest: 0,
            head: bytes.length,
            ckpt: {
                through: bytes.length,
                cols: 240,
                rows: 12,
                ansi: 'OLD LIVE\r\n',
            },
        });
        await h.settle();
        await h.manager._loadColdHistory(h.tab);
        await h.settle();
        const next = h.socket();
        next.ws.head({ epoch: 8, oldest: 0, head: 0 });
        await h.settle();
        next.ws.output(0, encode('NEW EPOCH OUTPUT\r\n'));
        await h.settle();
        expect(h.tab._historyBrowsing).toBe(false);
        expect(h.tab._historyLiveState).toBeNull();
        expect(rows(h.term)).toContain('NEW EPOCH OUTPUT');
        expect(h.tab.drainedSeq).toBe(encode('NEW EPOCH OUTPUT\r\n').length);
    } finally {
        h.dispose();
    }
});

it('same-epoch reconnect does not parse current output into older view', async () => {
    const text = 'ARCHIVE\r\n'.repeat(300000);
    const bytes = encode(`${text}NEW LIVE AFTER RECONNECT\r\n`);
    const head = encode(text).length;
    const h = replayHarness(bytes);
    try {
        serializer(h);
        h.pty.ws.head({
            epoch: 7,
            oldest: 0,
            head,
            ckpt: { through: head, cols: 240, rows: 12, ansi: 'OLD LIVE\r\n' },
        });
        await h.settle();
        await h.manager._loadColdHistory(h.tab);
        await h.settle();
        const oldRows = rows(h.term);
        const next = h.socket();
        next.ws.head({ epoch: 7, oldest: 0, head: bytes.length });
        await h.settle();
        expect(rows(h.term)).toEqual(oldRows);
        expect(h.tab.drainedSeq).toBe(head);
        await h.manager._restoreLatestHistory(h.tab);
        await h.settle();
        expect(
            rows(h.term).filter((r) => r === 'NEW LIVE AFTER RECONNECT'),
        ).toHaveLength(1);
        expect(h.tab.drainedSeq).toBe(bytes.length);
        expect(h.tab._historyBrowsing).toBe(false);
    } finally {
        h.dispose();
    }
});

it('a live gap during history browsing does not paint or resize that view', async () => {
    const prefix = 'ARCHIVE\r\n'.repeat(300000);
    const gap = 'RECOVERED GAP\r\n';
    const future = 'LIVE TAIL\r\n';
    const head = encode(prefix).length;
    const h = replayHarness(encode(prefix + gap + future));
    try {
        serializer(h);
        h.pty.ws.head(liveCheckpointHead(head));
        await h.settle();
        await h.manager._loadColdHistory(h.tab);
        const oldRows = rows(h.term);
        h.pty.ws.output(head + encode(gap).length, encode(future));
        await h.settle();
        expect(rows(h.term)).toEqual(oldRows);
        expect(h.tab.drainedSeq).toBe(head);
        await h.manager._restoreLatestHistory(h.tab);
        await h.settle();
        expect(rows(h.term)).toContain('RECOVERED GAP');
        expect(rows(h.term)).toContain('LIVE TAIL');
        expect(h.tab.drainedSeq).toBe(encode(prefix + gap + future).length);
    } finally {
        h.dispose();
    }
});

it.each(['same epoch', 'new epoch'])(
    'an in-flight older-page fetch preserves its owner across %s attachment',
    async (epochChange) => {
        const prefix = 'ARCHIVE\r\n'.repeat(300000);
        const source = encode(prefix);
        const h = replayHarness(source);
        try {
            serializer(h);
            h.pty.ws.head(liveCheckpointHead(source.length));
            await h.settle();
            let finish;
            const ready = new Promise((resolve) => {
                finish = resolve;
            });
            vi.stubGlobal('fetch', async (url) => {
                const query = new URL(url, 'http://localhost').searchParams;
                const from = Number(query.get('from'));
                const through = Number(query.get('through'));
                await ready;
                return recordingEnvelope(
                    source.slice(from, through),
                    from,
                    through,
                );
            });
            const loading = h.manager._loadColdHistory(h.tab);
            await new Promise((resolve) => setTimeout(resolve, 0));
            const next = h.socket();
            const changed = epochChange === 'new epoch';
            next.ws.head({
                epoch: changed ? 8 : 7,
                oldest: 0,
                head: changed ? 0 : source.length,
            });
            finish();
            await loading;
            await h.settle();
            expect(h.tab._historyLoading).toBe(false);
            expect(h.tab._historyParsing).toBe(false);
            expect(h.tab._historyBrowsing).toBe(!changed);
            if (changed) {
                next.ws.output(0, encode('NEW EPOCH\r\n'));
                await h.settle();
                expect(rows(h.term)).toContain('NEW EPOCH');
            } else {
                expect(rows(h.term).some((r) => r === 'ARCHIVE')).toBe(true);
                await h.manager._restoreLatestHistory(h.tab);
                await h.settle();
                expect(rows(h.term)).toContain('OLD LIVE');
            }
        } finally {
            h.dispose();
        }
    },
);
