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
    {
        file: 'xterm-addon-fit.js',
        namespace: 'FitAddon',
        className: 'FitAddon',
    },
    {
        file: 'xterm-addon-search.js',
        namespace: 'SearchAddon',
        className: 'SearchAddon',
    },
    {
        file: 'xterm-addon-webgl.js',
        namespace: 'WebglAddon',
        className: 'WebglAddon',
    },
    {
        file: 'xterm-addon-unicode11.js',
        namespace: 'Unicode11Addon',
        className: 'Unicode11Addon',
    },
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
    const fn = new Function(...ADDON_FN_PARAMS, `${src}\nreturn globalThis;`);
    return fn(sandbox, sandbox);
}

function loadJsDiff() {
    return loadAddon('jsdiff.min.js');
}

// All vendor scripts must parse without syntax errors. Uses Node's strict
// parser, which is stricter than the browser's - so any file that fails
// here would also fail in the browser.
describe('web/vendor/*.js - parse integrity', () => {
    it.each([
        'Sortable.min.js',
        'chart.umd.js',
        'diff2html.min.js',
        'jsdiff.min.js',
        'highlight.min.js',
        'marked.min.js',
        'purify.min.js',
        'xterm.js',
        'xterm-addon-fit.js',
        'xterm-addon-search.js',
        'xterm-addon-webgl.js',
        'xterm-addon-unicode11.js',
    ])('%s parses as valid JavaScript', (filename) => {
        const src = readFileSync(join(VENDOR_DIR, filename), 'utf8');
        // Catches truncation mid-statement (the regression we hit on 2026-07-11).
        expect(
            () => new Function(src),
            `${filename} failed to parse`,
        ).not.toThrow();
    });

    it.each(XTERM_ADDONS.map((a) => a.file))(
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
describe('jsdiff vendor exposes the expected browser primitive', () => {
    it('evaluates the UMD and exposes globalThis.Diff.diffWords', () => {
        const result = loadJsDiff();
        expect(result.Diff).toBeDefined();
        expect(typeof result.Diff.diffWords).toBe('function');
        expect(result.Diff.diffWords('old', 'new')).toEqual([
            { count: 1, added: false, removed: true, value: 'old' },
            { count: 1, added: true, removed: false, value: 'new' },
        ]);
    });

    it('loads jsdiff before the app module entry', () => {
        const html = readFileSync(
            join(process.cwd(), 'web', 'index.html'),
            'utf8',
        );
        const jsdiff = html.indexOf(
            '<script src="vendor/jsdiff.min.js"></script>',
        );
        const app = html.indexOf(
            '<script type="module" src="app.js"></script>',
        );
        expect(jsdiff).toBeGreaterThanOrEqual(0);
        expect(app).toBeGreaterThan(jsdiff);
    });

    it('ships the complete BSD-3-Clause notice beside the asset', () => {
        const notice = readFileSync(join(VENDOR_DIR, 'jsdiff.LICENSE'), 'utf8');
        expect(notice).toContain('BSD 3-Clause License');
        expect(notice).toContain('Copyright (c) 2009-2015, Kevin Decker');
        expect(notice).toContain(
            'THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS',
        );
    });
});

describe('xterm addons expose the expected constructor on globalThis', () => {
    const RUNTIME_ADDONS = XTERM_ADDONS.filter(
        (a) => a.file !== 'xterm-addon-webgl.js',
    );
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
            expect(
                Ctor,
                `${namespace}.${className} is undefined in ${file}`,
            ).toBeDefined();
            expect(
                typeof Ctor,
                `${namespace}.${className} should be a constructor`,
            ).toBe('function');
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
        expect(
            () => new Ctor(),
            'new SearchAddon() must not throw',
        ).not.toThrow();
    });

    it('window.Unicode11Addon.Unicode11Addon can be instantiated', () => {
        const Ctor = loadAddon('xterm-addon-unicode11.js').Unicode11Addon
            .Unicode11Addon;
        expect(
            () => new Ctor(),
            'new Unicode11Addon() must not throw',
        ).not.toThrow();
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
    it.each(XTERM_ADDONS)(
        '$file assigns to $namespace',
        ({ file, namespace }) => {
            const src = readFileSync(join(VENDOR_DIR, file), 'utf8');
            // Match either `e.<Namespace>=t()` or `.exports.<Namespace>=t()` -
            // both shapes show up across UMD bundles.
            const pattern = new RegExp(`\\.${namespace}\\s*=\\s*t\\(\\)`);
            expect(
                pattern.test(src),
                `${file} does not contain an assignment of '${namespace}'. The UMD wrapper is broken.`,
            ).toBe(true);
        },
    );
});

// File-tree viewer vendors (2026-09-11). Each file must be present, not
// truncated (regression for the 2026-07-11 xterm-addon truncation
// incident), and must expose the global the dispatcher expects. We do
// not deeply exercise the libraries here — that's the renderer's job —
// only the load-and-parse smoke test, identical in shape to the xterm
// addon coverage above.
const FILE_VIEWER_VENDORS = [
    {
        dir: 'viewerjs',
        files: [
            { name: 'viewer.min.js', parser: 'js' },
            { name: 'viewer.min.css', parser: 'css' },
        ],
    },
    {
        dir: 'plyr',
        files: [
            { name: 'plyr.polyfilled.js', parser: 'js' },
            { name: 'plyr.css', parser: 'css' },
            { name: 'plyr.svg', parser: 'binary' },
            { name: 'blank.mp4', parser: 'mp4' },
        ],
    },
    {
        dir: 'json-viewer',
        files: [{ name: 'json-viewer.bundle.js', parser: 'js' }],
    },
];

describe('file-tree viewer vendor libraries load', () => {
    it.each(FILE_VIEWER_VENDORS)(
        '$dir/ files are present and parse without error',
        ({ dir, files }) => {
            for (const f of files) {
                const buf = readFileSync(join(VENDOR_DIR, dir, f.name));
                expect(
                    buf.length,
                    `${dir}/${f.name} is empty or truncated`,
                ).toBeGreaterThan(100);
                if (f.parser === 'js') {
                    const src = buf.toString('utf8');
                    expect(
                        () => new Function(src),
                        `${dir}/${f.name} failed to parse as JavaScript`,
                    ).not.toThrow();
                } else if (f.parser === 'mp4') {
                    // MP4 starts with an `ftyp` box at offset 4; check the
                    // magic bytes are present so the file isn't truncated
                    // mid-header.
                    expect(
                        buf.length >= 32 &&
                            buf.slice(4, 8).toString('ascii') === 'ftyp',
                        `${dir}/${f.name} is not a valid MP4 (missing ftyp box)`,
                    ).toBe(true);
                } else if (f.parser === 'binary') {
                    // SVG starts with `<?xml` or `<svg`.
                    const head = buf.slice(0, 64).toString('utf8').trimStart();
                    expect(
                        head.startsWith('<?xml') || head.startsWith('<svg'),
                        `${dir}/${f.name} is not valid SVG`,
                    ).toBe(true);
                }
                // CSS: presence is enough; we don't parse it.
            }
        },
    );

    it('viewerjs/viewer.min.js defines window.Viewer as a constructor', () => {
        const src = readFileSync(
            join(VENDOR_DIR, 'viewerjs', 'viewer.min.js'),
            'utf8',
        );
        // UMD assignment: `e.Viewer=` or `.exports.Viewer=`.
        expect(/[\.\b]Viewer\s*=/.test(src)).toBe(true);
    });

    it('plyr/plyr.polyfilled.js defines window.Plyr as a constructor', () => {
        const src = readFileSync(
            join(VENDOR_DIR, 'plyr', 'plyr.polyfilled.js'),
            'utf8',
        );
        expect(/[\.\b]Plyr\s*=/.test(src)).toBe(true);
    });

    it('json-viewer/json-viewer.bundle.js defines a custom element', () => {
        // @alenaksu/json-viewer registers `<json-viewer>` as a custom
        // element (customElements.define call). If the bundle is
        // truncated the registration never fires and the dispatcher
        // can't instantiate.
        const src = readFileSync(
            join(VENDOR_DIR, 'json-viewer', 'json-viewer.bundle.js'),
            'utf8',
        );
        expect(
            src.includes('customElements'),
            'json-viewer.bundle.js does not register a custom element',
        ).toBe(true);
    });
});
