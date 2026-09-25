// Shared @xterm/headless loader for node-env vitest suites.
//
// The vendored bundle (web/vendor/xterm-headless.js) needs browser-shaped
// globals at eval; this builds the same Worker-like vm sandbox every suite
// needs (previously copy-pasted per file) and returns the Terminal class
// plus a runSource hook for suites that must eval more code (e.g. the
// archive parse core) in the same context.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const BUNDLE_PATH = join(process.cwd(), 'web', 'vendor', 'xterm-headless.js');

export function createHeadlessSandbox() {
    const bundle = readFileSync(BUNDLE_PATH, 'utf8');
    // Sandboxed global like a Worker would have:
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
    // The shims return empty/sensible defaults — the parser never queries
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
    sandbox.performance = { now: () => Date.now() };
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
    sandbox.structuredClone =
        globalThis.structuredClone ||
        ((val) => JSON.parse(JSON.stringify(val)));
    const ctx = vm.createContext(sandbox, { name: 'xterm-headless' });
    // The bundle is `(()=>{...})()`: pure side-effect IIFE, no return.
    vm.runInContext(bundle, ctx, { filename: 'xterm-headless.js' });
    if (!ctx.exports?.Terminal) {
        throw new Error(
            'xterm-headless did not expose Terminal in the sandbox',
        );
    }
    return {
        Terminal: ctx.exports.Terminal,
        runSource: (src, filename) => vm.runInContext(src, ctx, { filename }),
        ctx,
    };
}
