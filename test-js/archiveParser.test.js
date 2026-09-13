// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// TERMPERF §5 parsing tier: the archive worker must actually parse
// terminal bytes and produce ordered row blocks. Loading the official
// @xterm/headless@5.5.0 bundle inside a Node vm sandbox with a
// `self.window = self` shim lets us assert parsing behavior without a
// real Worker runtime (jsdom has no `self`/`Window`, and the
// Cloudflare Workers constructor isn't available in Node).

const BUNDLE_PATH = join(process.cwd(), 'web', 'vendor', 'xterm-headless.js');

let runArchiveParseCore;
let SandboxTerminal;

beforeAll(async () => {
    const bundle = readFileSync(BUNDLE_PATH, 'utf8');
    // Set up a sandboxed global like a Worker would have:
    //   self.window = self so font-measurement checks don't throw
    //   self.exports = {} so the CJS tail's `r=exports; ...` works
    // After eval, the bundle populates self.exports.Terminal.
    const sandbox = {
        self: undefined,
        exports: undefined,
    };
    sandbox.self = sandbox;
    sandbox.exports = {};
    sandbox.window = sandbox;
    sandbox.document = sandbox;
    // xterm-headless probes a lot of browser-shaped globals at eval.
    // Provide a minimal-strict-mode shim so the bundle can load; the
    // shims return empty/sensible defaults — the parser never queries
    // them beyond what the worker shim also satisfies.
    sandbox.navigator = {
        userAgent: 'node-vm',
        language: 'en',
        languages: ['en'],
        platform: 'node',
        maxTouchPoints: 0,
        hardwareConcurrency: 1,
    };
    sandbox.location = {
        protocol: 'https:',
        host: 'localhost',
        hostname: 'localhost',
        port: '',
        pathname: '/',
        search: '',
        hash: '',
        href: 'https://localhost/',
    };
    sandbox.screen = {
        width: 1024,
        height: 768,
        availWidth: 1024,
        availHeight: 768,
        colorDepth: 24,
        pixelDepth: 24,
        orientation: { type: 'landscape', angle: 0 },
    };
    sandbox.matchMedia = () => ({
        matches: false,
        media: '',
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {
            return false;
        },
    });
    sandbox.devicePixelRatio = 1;
    sandbox.requestAnimationFrame = (cb) => {
        const id = Math.floor(Math.random() * 1e6);
        queueMicrotask(() => cb(performance.now()));
        return id;
    };
    sandbox.cancelAnimationFrame = () => {};
    sandbox.setTimeout = (cb, ms) => {
        const id = Math.floor(Math.random() * 1e6);
        queueMicrotask(() => cb());
        return id;
    };
    sandbox.clearTimeout = () => {};
    sandbox.setInterval = (cb, _ms) => {
        queueMicrotask(() => cb());
        return 1;
    };
    sandbox.clearInterval = () => {};
    sandbox.queueMicrotask = (cb) => {
        Promise.resolve().then(cb);
    };
    sandbox.getComputedStyle = () => ({ getPropertyValue: () => '' });
    sandbox.MutationObserver = class {
        observe() {}
        disconnect() {}
        takeRecords() {
            return [];
        }
    };
    sandbox.IntersectionObserver = class {
        observe() {}
        disconnect() {}
        unobserve() {}
    };
    sandbox.ResizeObserver = class {
        observe() {}
        disconnect() {}
        unobserve() {}
    };
    sandbox.CSS = { escape: (s) => String(s) };
    const ctx = vm.createContext(sandbox, {
        name: 'xterm-headless',
    });
    // The bundle is `(()=>{...})()`: pure side-effect IIFE, no return.
    vm.runInContext(bundle, ctx, { filename: 'xterm-headless.js' });
    if (!ctx.exports || !ctx.exports.Terminal) {
        throw new Error(
            'xterm-headless did not expose Terminal in the sandbox',
        );
    }
    // The runArchiveParseCore call sites need a Terminal class
    // reference; the core uses the one passed via xtermClasses.
    SandboxTerminal = ctx.exports.Terminal;
    // Now load the parse core the same way the worker would.
    const coreSrc = readFileSync(
        join(process.cwd(), 'web', 'history-parse-core.js'),
        'utf8',
    );
    vm.runInContext(coreSrc, ctx, { filename: 'history-parse-core.js' });
    if (typeof ctx.runArchiveParseCore !== 'function') {
        throw new Error('parse core did not expose runArchiveParseCore');
    }
    runArchiveParseCore = ctx.runArchiveParseCore;
});

describe('archive parser core', () => {
    it('parses ANSI bytes into text rows via @xterm/headless', async () => {
        const p1Blocks = [];
        const errors = [];
        let doneLines = -1;
        await runArchiveParseCore(
            {
                paneId: 'p1',
                cols: 80,
                rows: 24,
                chunks: [
                    {
                        start: 0,
                        end: 24,
                        bytes: 'alpha\r\nbeta\r\ngamma\r\ndelta\r\n',
                    },
                ],
                markers: [],
                yieldEvery: 4096,
            },
            { Terminal: SandboxTerminal },
            {
                onRows: (_p, b) => p1Blocks.push(...b),
                onError: (_p, m) => errors.push(m),
                onDone: (_p, l) => (doneLines = l),
            },
        );
        // Headless returns notifications that aren't fatal (font
        // measurement in a non-DOM env). Allow up to one warning but
        // never a real parse or transport error.
        const fatal = errors.filter((m) =>
            /(?:terminal construction|parse error|invalid)/.test(m),
        );
        expect(fatal).toEqual([]);
        expect(doneLines).toBeGreaterThanOrEqual(4);
        const all = p1Blocks.flatMap((b) => b.lines).join('\n');
        expect(all).toContain('alpha');
        expect(all).toContain('beta');
        expect(all).toContain('gamma');
        expect(all).toContain('delta');
    });

    it('emits rows per chunk in order across multiple chunks', async () => {
        const chunkBlocks = [];
        let doneLines = -1;
        await runArchiveParseCore(
            {
                paneId: 'p2',
                cols: 40,
                rows: 10,
                yieldEvery: 1024,
                chunks: [
                    // Two newlines per chunk — distinct per-chunk rows.
                    { start: 0, end: 8, bytes: 'one\r\ntwo\r\n' },
                    { start: 8, end: 14, bytes: 'three\r\n' },
                    { start: 14, end: 19, bytes: 'four\r\n' },
                ],
                markers: [],
            },
            { Terminal: SandboxTerminal },
            {
                onRows: (_p, b) => chunkBlocks.push(...b),
                onError: (_p, m) => {
                    throw new Error(`unexpected error: ${m}`);
                },
                onDone: (_p, l) => (doneLines = l),
            },
        );
        // Three chunks, three block starts, in order.
        expect(chunkBlocks.map((b) => b.start)).toEqual([0, 8, 14]);
        // block[0] holds the two rows that wrote under cursorY 0→2.
        expect(chunkBlocks[0].lines.join('|')).toContain('one');
        expect(chunkBlocks[0].lines.join('|')).toContain('two');
        expect(chunkBlocks[0].lines.join('|')).not.toMatch(/three|four/);
        // block[1] holds only 'three' (advance from cursorY 2→3).
        expect(chunkBlocks[1].lines.join('|')).toContain('three');
        expect(chunkBlocks[1].lines.join('|')).not.toMatch(/one|two|four/);
        // block[2] holds only 'four' (advance from cursorY 3→4).
        expect(chunkBlocks[2].lines.join('|')).toContain('four');
        expect(chunkBlocks[2].lines.join('|')).not.toMatch(/one|two|three/);
        // Cumulative line count from the parser.
        expect(doneLines).toBeGreaterThanOrEqual(4);
    });

    it('applies a resize marker before the chunk it precedes', async () => {
        const blocksWithMarker = await runWith([0, 120, 24]);
        const blocksNoMarker = await runWith(null);

        // With the marker, the 80-char first chunk fits on one row
        // (cols becomes 120 for chunk 0). Without the marker, the
        // 80-char chunk WRAPS at col 80, producing two visible rows.
        expect(blocksWithMarker[0].lines.length).toBe(1);
        expect(blocksNoMarker[0].lines.length).toBeGreaterThanOrEqual(2);

        // The 120-char marker must affect ALL chunks (it applies before
        // both writes per the approximation), so the second chunk
        // (40 chars) also stays a single line in both runs.
        expect(blocksWithMarker[1].lines.length).toBe(1);
        expect(blocksNoMarker[1].lines.length).toBe(1);

        async function runWith(marker) {
            const collected = [];
            await runArchiveParseCore(
                {
                    paneId: marker ? 'p3a' : 'p3b',
                    cols: 80,
                    rows: 24,
                    chunks: [
                        {
                            start: 0,
                            end: 82,
                            bytes: 'A'.repeat(81) + '\r\n',
                        },
                        {
                            start: 81,
                            end: 122,
                            bytes: 'B'.repeat(40) + '\r\n',
                        },
                    ],
                    markers: marker ? [marker] : [],
                },
                { Terminal: SandboxTerminal },
                {
                    onRows: (_p, b) => collected.push(...b),
                    onError: (_p, m) => {
                        throw new Error(`unexpected error: ${m}`);
                    },
                    onDone: () => {},
                },
            );
            return collected;
        }
    });

    it('attributes rows across scrollback in a 2-row terminal', async () => {
        const blocks = [];
        let doneLines = -1;
        // rows=2 forces the cursor to scroll after every two lines.
        // Each chunk has exactly one short line so the absolute-cursor
        // delta per chunk is exactly 1 and the line we want to attribute
        // is exactly at index `prevAbs` after the write.
        await runArchiveParseCore(
            {
                paneId: 'p5',
                cols: 8,
                rows: 2,
                chunks: [
                    { start: 0, end: 3, bytes: 'a\r\n' },
                    { start: 3, end: 6, bytes: 'b\r\n' },
                    { start: 6, end: 9, bytes: 'c\r\n' },
                    { start: 9, end: 12, bytes: 'd\r\n' },
                    { start: 12, end: 15, bytes: 'e\r\n' },
                    { start: 15, end: 18, bytes: 'f\r\n' },
                    { start: 18, end: 21, bytes: 'g\r\n' },
                ],
                markers: [],
            },
            { Terminal: SandboxTerminal },
            {
                onRows: (_p, b) => blocks.push(...b),
                onError: (_p, m) => {
                    throw new Error(`unexpected error: ${m}`);
                },
                onDone: (_p, l) => (doneLines = l),
            },
        );
        // Seven chunks, seven blocks, no empty ones. The first two
        // stay in the visible window; chunks 3+ force a scroll.
        expect(blocks.length).toBe(7);
        // Each block must contain its own row (a..g). The bug the
        // architect flagged is that the cursor-based contract drops
        // chunks once the cursor sits pinned at rows-1.
        const expectedLabels = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
        blocks.forEach((b, i) => {
            expect(b.lines.join('|')).toBe(expectedLabels[i]);
        });
        // Cumulative line count = sum of linesAdded across all chunks.
        expect(doneLines).toBe(7);
    });

    it('reports invalid jobs via onError and onDone(0)', async () => {
        const errors = [];
        let doneLines = -1;
        await runArchiveParseCore(
            {
                paneId: 'p4',
                cols: 0,
                rows: 24,
                chunks: [{ start: 0, end: 1, bytes: 'x' }],
            },
            { Terminal: SandboxTerminal },
            {
                onRows: () => {},
                onError: (_p, m) => errors.push(m),
                onDone: (_p, l) => (doneLines = l),
            },
        );
        expect(errors[0]).toMatch(/invalid/);
        expect(doneLines).toBe(0);
    });
});
