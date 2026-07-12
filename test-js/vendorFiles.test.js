// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// REGRESSION: On 2026-07-11, two vendor addons in web/vendor/ were
// truncated mid-statement (xterm-addon-search.js ended with `dispose()
// {this.is` and xterm-addon-unicode11.js ended with `e.great`). When the
// browser parsed them, it threw a SyntaxError, the UMD wrapper never ran,
// and `window.SearchAddon` / `window.Unicode11Addon` were undefined. That
// made `new window.SearchAddon.SearchAddon()` blow up with "Cannot read
// properties of undefined (reading 'SearchAddon')" the first time any tab
// opened - making the whole app useless.
//
// These tests pin the invariant that must hold for the app to boot:
// every script in web/vendor/ must be a complete JS module that, when
// evaluated in a browser-like global, exposes the constructor the rest
// of the codebase expects.

const VENDOR_DIR = join(process.cwd(), 'web', 'vendor');

// Each xterm addon the codebase uses + the expected namespace it exposes.
// `window.<Namespace>.<ClassName>` is what createTab calls into.
const XTERM_ADDONS = [
    { file: 'xterm-addon-fit.js',       namespace: 'FitAddon',       className: 'FitAddon'       },
    { file: 'xterm-addon-search.js',    namespace: 'SearchAddon',    className: 'SearchAddon'    },
    { file: 'xterm-addon-webgl.js',     namespace: 'WebglAddon',     className: 'WebglAddon'     },
    { file: 'xterm-addon-unicode11.js', namespace: 'Unicode11Addon', className: 'Unicode11Addon' },
];

// UMD wrappers reference either `self` or `globalThis` as free variables.
// When we evaluate via `new Function`, both must be in the parameter list
// so the IIFE can resolve them.
const ADDON_FN_PARAMS = ['self', 'globalThis'];

function makeAddonSandbox() {
    const sandbox = {
        // The UMD wrappers in xterm addons attach to `self` or
        // `globalThis` (different builds use different ones). Both must
        // resolve to the same object so we can inspect the result.
        self: undefined, // wired below
        globalThis: undefined,
        // Stub the bare-minimum browser globals addons may call.
        queueMicrotask: (fn) => Promise.resolve().then(fn),
        Promise,
        Set,
        Map,
        WeakMap,
        WeakSet,
        Symbol,
        Uint8Array,
        Int32Array,
        ArrayBuffer,
        Object,
        Array,
        JSON,
        Math,
        Date,
        Error,
        TypeError,
        RangeError,
        console: { log() {}, warn() {}, error() {} },
    };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    return sandbox;
}

// Evaluate an addon in the sandbox and return the resulting globalThis.
// Different addons expose their constructor on different keys; the caller
// picks.
function loadAddon(file) {
    const src = readFileSync(join(VENDOR_DIR, file), 'utf8');
    const sandbox = makeAddonSandbox();
    const fn = new Function(...ADDON_FN_PARAMS, src + '\nreturn globalThis;');
    return fn(sandbox, sandbox);
}

// All vendor scripts must parse without syntax errors. Uses Node's strict
// parser, which is stricter than the browser's - so any file that fails
// here would also fail in the browser.
describe('web/vendor/*.js - parse integrity', () => {
    it.each([
        'Sortable.min.js',
        'diff2html.min.js',
        'highlight.min.js',
        'marked.min.js',
        'xterm.js',
        'xterm-addon-fit.js',
        'xterm-addon-search.js',
        'xterm-addon-webgl.js',
        'xterm-addon-unicode11.js',
    ])('%s parses as valid JavaScript', (filename) => {
        const src = readFileSync(join(VENDOR_DIR, filename), 'utf8');
        // Catches truncation mid-statement (the regression we hit on 2026-07-11).
        expect(() => new Function(src), `${filename} failed to parse`).not.toThrow();
    });

    it.each(XTERM_ADDONS.map(a => a.file))(
        '%s ends with the UMD-closure sequence (regression: addon was truncated before closing)',
        (filename) => {
            const src = readFileSync(join(VENDOR_DIR, filename), 'utf8');
            // Trim trailing whitespace + sourceMappingURL comment + the
            // semicolon the UMD wrapper emits. The actual closure shape
            // varies slightly between addons: `})());`, `}));`, `,i})()));`,
            // etc. They all end with one or more `)` then `;` after a `}`.
            // What we care about: the file isn't truncated MID-statement,
            // i.e. the UMD's IIFE invocation actually completed.
            const trimmed = src
                .replace(/\/\/[#@]\s*sourceMappingURL=[^\n]*\s*$/, '')
                .replace(/\s+$/, '');
            // Last 30 chars must contain a `});` or `}));` close-paren
            // sequence (the IIFE invocation). Anything else and the file
            // was truncated before the wrapper finished.
            expect(
                /[})]\)+;\s*$/.test(trimmed),
                `${filename} does not end with the UMD-closure sequence - file is likely truncated. ` +
                `Last 80 chars: ${JSON.stringify(trimmed.slice(-80))}`,
            ).toBe(true);
        },
    );
});

// The actual bug was that window.SearchAddon was undefined. Verify the
// UMD wrapper assigns the right namespace by evaluating each addon in a
// mock browser sandbox and checking the resulting global. Only addons
// that don't need a DOM at module-load time are exercised here; the
// webgl addon touches `document` on load and is verified by the static
// namespace-assignment check below.
describe('xterm addons expose the expected constructor on globalThis', () => {
    const RUNTIME_ADDONS = XTERM_ADDONS.filter(a => a.file !== 'xterm-addon-webgl.js');
    for (const { file, namespace, className } of RUNTIME_ADDONS) {
        it(`${file} sets globalThis.${namespace}.${className}`, () => {
            const result = loadAddon(file);

            // Assert the namespace object exists.
            const ns = result[namespace];
            expect(
                ns,
                `globalThis.${namespace} is undefined after evaluating ${file} - ` +
                `the UMD wrapper likely never completed`,
            ).toBeDefined();

            // Assert the class constructor exists.
            const Ctor = ns[className];
            expect(Ctor, `${namespace}.${className} is undefined in ${file}`).toBeDefined();
            expect(typeof Ctor, `${namespace}.${className} should be a constructor`).toBe('function');
        });
    }
});

// This is the exact failure mode the user hit: opening any tab crashed
// because `new window.SearchAddon.SearchAddon()` threw. If these tests
// pass, the runtime path through createTab won't blow up on load.
//
// Only the addons that don't need a DOM at module-load time are exercised
// here (search, fit, unicode11). The webgl addon needs `document` at
// load time, so it's verified by the parse + UMD-closure checks above
// rather than a full evaluate-in-sandbox test.
describe('createTab addons can be constructed without throwing', () => {
    it('window.SearchAddon.SearchAddon can be instantiated', () => {
        const Ctor = loadAddon('xterm-addon-search.js').SearchAddon.SearchAddon;
        expect(() => new Ctor(), 'new SearchAddon() must not throw').not.toThrow();
    });

    it('window.Unicode11Addon.Unicode11Addon can be instantiated', () => {
        const Ctor = loadAddon('xterm-addon-unicode11.js').Unicode11Addon.Unicode11Addon;
        expect(() => new Ctor(), 'new Unicode11Addon() must not throw').not.toThrow();
    });

    it('window.FitAddon.FitAddon can be instantiated', () => {
        const Ctor = loadAddon('xterm-addon-fit.js').FitAddon.FitAddon;
        expect(() => new Ctor(), 'new FitAddon() must not throw').not.toThrow();
    });
});

// Static check: each addon must contain the assignment that wires its
// namespace onto the host global. This catches the case where someone
// might hand-edit the addon and accidentally remove or rename the export
// (e.g. webgl addon wraps everything in an IIFE and the wrapper has to
// finish for WebglAddon to be reachable).
describe('xterm addons contain the expected namespace assignment', () => {
    it.each(XTERM_ADDONS)('$file assigns to $namespace', ({ file, namespace }) => {
        const src = readFileSync(join(VENDOR_DIR, file), 'utf8');
        // Match either `e.<Namespace>=t()` or `.exports.<Namespace>=t()` -
        // both shapes show up across UMD bundles.
        const pattern = new RegExp(`\\.${namespace}\\s*=\\s*t\\(\\)`);
        expect(
            pattern.test(src),
            `${file} does not contain an assignment of '${namespace}'. The UMD wrapper is broken.`,
        ).toBe(true);
    });
});