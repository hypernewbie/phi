/* Φ phi — Standalone Markdown Viewer (md.html entry module)

   Loaded ONLY by web/md.html (the pop-out window), never by index.html.
   Imports only pure helpers — no app singletons. Importing this module
   has no side effects; md.html calls initMdView() explicitly. */
import { renderMarkdownSafe, rewriteRelativeImages, highlightCodeIn, } from './md-render.js';
import { escapeHtml, getLastFolderName } from './util.js';
// --- pure helpers (exported for tests) ---
// decodeEventFrame splits a binary hub frame into its 1-byte type tag and
// UTF-8 payload (the wire format of BroadcastAll: [type, ...json]).
export function decodeEventFrame(bytes) {
    return {
        type: bytes[0] ?? 0,
        payload: new TextDecoder().decode(bytes.subarray(1)),
    };
}
// mdEventMatchesPath reports whether a 0x07 md-changed event for `dir`
// concerns the file at `path`.
export function mdEventMatchesPath(dir, path) {
    if (!dir)
        return true; // unknown dir: refresh anyway, it's one cheap fetch
    const normDir = dir.replace(/\\/g, '/');
    const d = normDir.endsWith('/') ? normDir : `${normDir}/`;
    return path.replace(/\\/g, '/').startsWith(d);
}
// Static pages are whitelisted; query values never select arbitrary URLs.
const STATIC_PAGES = {
    help: { file: 'help.md', title: 'Phi Documentation' },
    changelog: { file: 'changelog.md', title: 'Changelog' },
};
async function initStaticPage(container, page) {
    const spec = STATIC_PAGES[page];
    if (!spec) {
        container.innerHTML =
            '<div class="md-list-error">Unknown "page" query parameter.</div>';
        return;
    }
    document.title = spec.title;
    try {
        const res = await fetch(spec.file);
        if (!res.ok)
            throw new Error((await res.text()) || `Failed to load ${spec.file}`);
        const raw = await res.text();
        container.innerHTML = `<div class="md-rendered">${renderMarkdownSafe(raw)}</div>`;
        highlightCodeIn(container);
    }
    catch (e) {
        container.innerHTML = `<div class="md-list-error">Failed to load: ${escapeHtml(e.message)}</div>`;
    }
}
// initMdView renders a workspace file or whitelisted static page.
export function initMdView() {
    const container = document.getElementById('md-view-body');
    if (!container)
        return;
    const params = new URL(location.href).searchParams;
    const page = params.get('page') || '';
    if (page) {
        void initStaticPage(container, page);
        return;
    }
    const path = params.get('path') || '';
    const cwd = params.get('cwd') || '';
    if (!path) {
        container.innerHTML =
            '<div class="md-list-error">Missing "path" query parameter.</div>';
        return;
    }
    document.title = getLastFolderName(path);
    let lastRenderedRaw = null;
    let loadRequestId = 0;
    async function loadAndRender() {
        // Overlapping fetches (onopen + 0x07 event) can resolve out of
        // order; only the latest request may touch the DOM.
        const requestId = ++loadRequestId;
        try {
            const res = await fetch(`/api/markdown/file?path=${encodeURIComponent(path)}&cwd=${encodeURIComponent(cwd)}`);
            if (requestId !== loadRequestId)
                return;
            if (res.status === 401) {
                container.innerHTML =
                    '<div class="md-list-error">Session expired — log in in the main phi window, then reload this one.</div>';
                return;
            }
            if (!res.ok) {
                const text = await res.text();
                if (requestId !== loadRequestId)
                    return;
                container.innerHTML = `<div class="md-list-error">Failed to load: ${escapeHtml(text)}</div>`;
                return;
            }
            const raw = await res.text();
            if (requestId !== loadRequestId)
                return;
            if (raw === lastRenderedRaw)
                return; // unchanged: no re-render, no scroll jump
            lastRenderedRaw = raw;
            const prevScrollTop = document.scrollingElement?.scrollTop ?? 0;
            container.innerHTML = `<div class="md-rendered">${renderMarkdownSafe(raw)}</div>`;
            rewriteRelativeImages(container, path, cwd);
            highlightCodeIn(container);
            if (document.scrollingElement)
                document.scrollingElement.scrollTop = prevScrollTop;
        }
        catch (e) {
            if (requestId !== loadRequestId)
                return;
            container.innerHTML = `<div class="md-list-error">Failed to load: ${escapeHtml(e.message)}</div>`;
        }
    }
    function connect() {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(`${proto}://${location.host}/ws/md-events`);
        ws.binaryType = 'arraybuffer';
        // Refresh on open too: content may have changed while disconnected.
        ws.onopen = () => {
            void loadAndRender();
        };
        ws.onmessage = (e) => {
            if (!(e.data instanceof ArrayBuffer))
                return;
            const frame = decodeEventFrame(new Uint8Array(e.data));
            if (frame.type !== 0x07)
                return; // ignore other frame types
            let dir = null;
            try {
                dir = JSON.parse(frame.payload)?.dir ?? null;
            }
            catch (_) {
                /* refresh anyway */
            }
            if (mdEventMatchesPath(dir, path))
                void loadAndRender();
        };
        ws.onclose = () => {
            setTimeout(connect, 10000);
        };
    }
    void loadAndRender();
    connect();
}
