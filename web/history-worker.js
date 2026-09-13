/* Φ phi — Terminal recording archive worker (see temp/TERMPERF.md) */

// xterm-headless references `window` (font measurement stack) at
// module-eval time. Workers have no `window`; declare a self-shim
// BEFORE the bundle evals so it loads cleanly without touching a DOM.
self.window = self;
self.document = self;

// The headless bundle is a CommonJS CJS bundle that ends with
// `var r = exports; ...`, expecting `exports` to be in scope. Workers
// don't provide it, so we shim `self.exports` before importScripts.
self.exports = self.exports || {};

importScripts('vendor/xterm-headless.js');
importScripts('history-parse-core.js');

const Terminal = self.exports && self.exports.Terminal;
const parseCore = self.runArchiveParseCore;

self.onmessage = async (event) => {
    const msg = event.data;
    if (!msg || msg.type !== 'parse') return;
    const { paneId, cols, rows, chunks = [], markers = [] } = msg;
    if (typeof parseCore !== 'function') {
        self.postMessage({
            type: 'error',
            paneId,
            message: 'parser core not loaded',
        });
        self.postMessage({ type: 'done', paneId, lines: 0 });
        return;
    }
    try {
        await parseCore(
            {
                paneId,
                cols,
                rows,
                chunks,
                markers,
                yieldEvery: msg.yieldEvery,
            },
            { Terminal },
            {
                onRows: (id, blocks) =>
                    self.postMessage({ type: 'rows', paneId: id, blocks }),
                onError: (id, message) =>
                    self.postMessage({ type: 'error', paneId: id, message }),
                onDone: (id, lines) =>
                    self.postMessage({ type: 'done', paneId: id, lines }),
            },
        );
    } catch (e) {
        self.postMessage({
            type: 'error',
            paneId,
            message: `worker fatal: ${e && e.message ? e.message : e}`,
        });
        self.postMessage({ type: 'done', paneId, lines: 0 });
    }
};
