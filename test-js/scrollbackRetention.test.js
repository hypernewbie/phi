// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// UX-law regression test (2026-09-13): the 512-row cap shipped without a
// single test proving scroll-up still worked — users saw 512 lines and
// history hid behind a button. This test writes 2000 numbered lines into
// a REAL headless xterm using the scrollback value parsed from
// web/terminal.js and asserts every line is retained and reachable.
// Re-capping the live buffer below the test volume fails this test.
const BUNDLE_PATH = join(process.cwd(), 'web', 'vendor', 'xterm-headless.js');
const TERMINAL_JS = join(process.cwd(), 'web', 'terminal.js');
const LINES = 2000;

let Terminal;
let liveScrollback;

function loadHeadlessTerminal() {
    const bundle = readFileSync(BUNDLE_PATH, 'utf8');
    const sandbox = { self: undefined, exports: undefined };
    sandbox.self = sandbox;
    sandbox.exports = {};
    sandbox.window = sandbox;
    sandbox.document = sandbox;
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
        queueMicrotask(() => cb(performance.now()));
        return 1;
    };
    sandbox.cancelAnimationFrame = () => {};
    sandbox.setTimeout = (cb) => {
        queueMicrotask(() => cb());
        return 1;
    };
    sandbox.clearTimeout = () => {};
    sandbox.setInterval = (cb) => {
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
    const ctx = vm.createContext(sandbox, { name: 'xterm-headless' });
    vm.runInContext(bundle, ctx, { filename: 'xterm-headless.js' });
    if (!ctx.exports?.Terminal) {
        throw new Error(
            'xterm-headless did not expose Terminal in the sandbox',
        );
    }
    return ctx.exports.Terminal;
}

function readLiveScrollback() {
    const src = readFileSync(TERMINAL_JS, 'utf8');
    const ctorStart = src.indexOf('new window.Terminal({');
    if (ctorStart < 0) throw new Error('live Terminal ctor not found');
    const ctorBody = src.slice(ctorStart, src.indexOf('});', ctorStart));
    const match = ctorBody.match(/scrollback:\s*(\d+)/);
    if (!match) throw new Error('scrollback option not found in live ctor');
    return Number(match[1]);
}

function writeAll(term, data) {
    return new Promise((resolve) => term.write(data, resolve));
}

function numberedLines(n) {
    let data = '';
    for (let i = 0; i < n; i++) {
        data += `line ${String(i).padStart(4, '0')}\r\n`;
    }
    return data;
}

beforeAll(() => {
    liveScrollback = readLiveScrollback();
    Terminal = loadHeadlessTerminal();
});

describe('live scrollback retains history (real xterm)', () => {
    it('the source scrollback covers the test volume', () => {
        // Self-calibrating: fails first if someone re-caps below LINES.
        expect(liveScrollback).toBeGreaterThanOrEqual(LINES);
    });

    it('2000 lines written are all retained and scroll-reachable', async () => {
        const term = new Terminal({
            cols: 80,
            rows: 24,
            scrollback: liveScrollback,
            allowProposedApi: true,
        });
        await writeAll(term, numberedLines(LINES));
        const buf = term.buffer.active;
        expect(buf.length).toBeGreaterThanOrEqual(LINES);
        expect(buf.getLine(0)?.translateToString().trim()).toBe('line 0000');
        expect(
            buf
                .getLine(LINES - 1)
                ?.translateToString()
                .trim(),
        ).toBe(`line ${String(LINES - 1).padStart(4, '0')}`);
        // Scroll-up can reach the oldest row: baseY covers the volume.
        expect(buf.baseY).toBeGreaterThanOrEqual(LINES - 24);
    });

    it('a 512 cap would fail this test (distinguishing check)', async () => {
        // Proves the test above is not vacuous: the exact cap that
        // shipped in the regression truncates this same volume.
        const term = new Terminal({
            cols: 80,
            rows: 24,
            scrollback: 512,
            allowProposedApi: true,
        });
        await writeAll(term, numberedLines(LINES));
        const buf = term.buffer.active;
        expect(buf.length).toBeLessThan(LINES);
        expect(buf.getLine(0)?.translateToString().trim()).not.toBe(
            'line 0000',
        );
    });
});
