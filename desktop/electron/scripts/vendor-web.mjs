// Vendors the browser Phi page's header into the desktop package.
//
// The desktop main view page (web/index.html) must render the same
// `.app-header` DOM the browser Phi page renders — a single source of
// truth. This script extracts that header from the repo-root web/ page,
// writes it as web/header.html, inlines it into the main view page
// (web/index.html, generated from web/index.template.html), and copies
// the styles the header needs (the full web/style.css plus the vendored
// font faces). It also vendors the browser page's behavior-driving JS
// modules (the same sources web/app.js imports) into web/vendor/, so the
// main view page runs the same header code the browser page runs.
// Every output is deterministic: running the script twice produces
// identical files.
//
// Run as part of the desktop build (pnpm run build), before tsc.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.join(here, '..');
const webRoot = path.join(electronRoot, '..', '..', 'web');
const outDir = path.join(electronRoot, 'web');

/** Browser Phi JS modules the main view page imports (app.js's module
 *  graph, copied byte-identical so the header runs the browser code).
 *  config.js is the standalone config page's entry; it is vendored for
 *  parity but never loaded by the main view page (it boots the settings
 *  surface). */
const WEB_JS_MODULES = [
  'app.js',
  'terminal.js',
  'ws.js',
  'sessions.js',
  'util.js',
  'attachments.js',
  'md-render.js',
  'diff.js',
  'markdown.js',
  'filetree.js',
  'kanban.js',
  'kanban-features.js',
  'sync.js',
  'auth.js',
  'settings.js',
  'desktop.js',
  'config.js',
  'header-state.js',
];

/** Browser vendor subdirectory the module graph imports (auth.js imports
 *  './vendor/noble-hashes/...', so the relative layout is preserved under
 *  web/vendor/). */
const WEB_JS_VENDOR_DIRS = ['noble-hashes'];

/** The main-view-page placeholder the vendored header is inlined into. */
const HEADER_PLACEHOLDER = '<!--VENDORED_HEADER-->';

/** Local window controls appended inside the vendored header (the main
 *  view page's own chrome; driven through the preload bridge). */
const CAPTION_CONTROLS = `
    <div class="caption-controls">
      <button id="caption-minimize" type="button" aria-label="Minimize" title="Minimize">─</button>
      <button id="caption-maximize" type="button" aria-label="Maximize" title="Maximize">□</button>
      <button id="caption-close" type="button" aria-label="Close" title="Close">✕</button>
    </div>`;

/**
 * Extracts the `<header class="app-header">...</header>` block from the
 * browser Phi page, tracking nested header tags so the closing tag is the
 * block's own. Throws when the block is missing or unterminated.
 */
function extractHeader(html) {
  const openTag = '<header class="app-header"';
  const start = html.indexOf(openTag);
  if (start < 0) throw new Error('vendor-web: <header class="app-header"> not found in web/index.html');
  const tagEnd = html.indexOf('>', start);
  if (tagEnd < 0) throw new Error('vendor-web: unterminated <header class="app-header"> tag');
  let depth = 1;
  let i = tagEnd + 1;
  while (i < html.length && depth > 0) {
    const open = html.indexOf('<header', i);
    const close = html.indexOf('</header>', i);
    if (close < 0) throw new Error('vendor-web: unterminated app-header block');
    if (open >= 0 && open < close) {
      depth += 1;
      i = open + '<header'.length;
    } else {
      depth -= 1;
      i = close + '</header>'.length;
    }
  }
  return html.slice(start, i);
}

/** Builds the main view page by inlining the vendored header fragment,
 *  decorated with the local caption controls at its right end. */
function buildIndexPage(headerFragment) {
  const template = readFileSync(path.join(outDir, 'index.template.html'), 'utf8');
  if (!template.includes(HEADER_PLACEHOLDER)) {
    throw new Error(`vendor-web: ${HEADER_PLACEHOLDER} placeholder missing from web/index.template.html`);
  }
  if (!headerFragment.endsWith('</header>')) {
    throw new Error('vendor-web: extracted header does not end with </header>');
  }
  // Decorate the vendored header with ONLY the desktop-local caption
  // controls (just before </header>). The header DOM and its styling
  // stay byte-identical to the browser Phi's source — single source
  // of truth via vendoring. Any visual change to the header
  // (centering the workspace, hiding the brand name, etc.) must land
  // in web/index.html first and get re-vendored through this script;
  // it does NOT belong here as a mutation.
  const decorated = `${headerFragment.slice(0, -'</header>'.length)}${CAPTION_CONTROLS}\n  </header>`;
  return template.replace(HEADER_PLACEHOLDER, decorated);
}

const header = extractHeader(readFileSync(path.join(webRoot, 'index.html'), 'utf8'));

mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'header.html'), header);
writeFileSync(path.join(outDir, 'index.html'), buildIndexPage(header));

// Vendor the browser Phi JS module graph byte-identical into web/vendor/.
// The main view page's mainview.js imports from these (ACCENT_COLORS,
// displayHostname, workspace-label helpers, theme application), so the
// TBAR runs the same header code the browser page runs. The copies are
// regenerated on every build, so they cannot drift.
const vendorJsDir = path.join(outDir, 'vendor');
mkdirSync(vendorJsDir, { recursive: true });
for (const name of WEB_JS_MODULES) {
  copyFileSync(path.join(webRoot, name), path.join(vendorJsDir, name));
}
for (const dir of WEB_JS_VENDOR_DIRS) {
  const src = path.join(webRoot, 'vendor', dir);
  const dest = path.join(vendorJsDir, 'vendor', dir);
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    copyFileSync(path.join(src, entry), path.join(dest, entry));
  }
}
console.log('vendored web header + style.css + fonts + JS modules -> desktop/electron/web/');

// The header renders with the same stylesheet and font faces as the
// browser page. Copying the whole stylesheet (rather than a hand-picked
// subset) keeps the vendored header visually identical to the browser and
// regenerates on every build, so the copy cannot drift.
copyFileSync(path.join(webRoot, 'style.css'), path.join(outDir, 'style.css'));
const fontsDir = path.join(outDir, 'vendor', 'fonts');
mkdirSync(fontsDir, { recursive: true });
copyFileSync(
  path.join(webRoot, 'vendor', 'fonts', 'fonts.css'),
  path.join(fontsDir, 'fonts.css'),
);
for (const entry of readdirSync(path.join(webRoot, 'vendor', 'fonts'))) {
  if (entry.endsWith('.woff2')) {
    copyFileSync(path.join(webRoot, 'vendor', 'fonts', entry), path.join(fontsDir, entry));
  }
}
