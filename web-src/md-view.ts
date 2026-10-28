/* Φ phi — Standalone Markdown Viewer (md.html entry module)

   Loaded ONLY by web/md.html (the pop-out window), never by index.html.
   Imports only pure helpers — no app singletons. Importing this module
   has no side effects; md.html calls initMdView() explicitly. */

import {
    renderMarkdownSafe,
    rewriteRelativeImages,
    highlightCodeIn,
} from './md-render.js';
import { escapeHtml, getLastFolderName, wsUrl } from './util.js';
import { eventsSubprotocol } from './ws-protocols.js';
import { Notification } from './proto/events.js';

// --- pure helpers (exported for tests) ---

// decodeNotificationDir decodes one events message and returns the
// markdown directory when it carries a markdown change, null otherwise
// (other notification kinds, empty payloads, undecodable bytes).
export function decodeNotificationDir(bytes: Uint8Array): string | null {
    let notif: Notification;
    try {
        notif = Notification.decode(bytes);
    } catch {
        return null;
    }
    if (notif.kind?.$case !== 'markdownChanged') return null;
    return notif.kind.value.dir ?? '';
}

// Markdown events retry: full-jitter exponential backoff with a floor, capped.
// The fixed 10 s retry this replaced hammered a down server at a constant rate
// and gave a recovered link no fast path back.
const MD_EVENT_RETRY_BASE_MS = 1000;
const MD_EVENT_RETRY_MAX_MS = 20000;
const MD_EVENT_RETRY_FLOOR_MS = 500;

// mdEventRetryDelay returns the wait before retry `attempt` (1-based). Full
// jitter: random(0, min(cap, base * 2^(attempt-1))) plus a floor, because full
// jitter alone can return ~0 ms and turn a flapping server into a hot loop.
// `random` is injected so tests are deterministic.
export function mdEventRetryDelay(
    attempt: number,
    random: () => number = Math.random,
): number {
    const cap = Math.min(
        MD_EVENT_RETRY_MAX_MS,
        MD_EVENT_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1),
    );
    return Math.round(MD_EVENT_RETRY_FLOOR_MS + random() * cap);
}

// mdEventMatchesPath reports whether a 0x07 md-changed event for `dir`
// concerns the file at `path`.
export function mdEventMatchesPath(
    dir: string | null | undefined,
    path: string,
): boolean {
    if (!dir) return true; // unknown dir: refresh anyway, it's one cheap fetch
    const normDir = dir.replace(/\\/g, '/');
    const d = normDir.endsWith('/') ? normDir : `${normDir}/`;
    return path.replace(/\\/g, '/').startsWith(d);
}

// Static pages are whitelisted; query values never select arbitrary URLs.
const STATIC_PAGES: Record<string, { file: string; title: string }> = {
    help: { file: 'help.md', title: 'Phi Documentation' },
    changelog: { file: 'changelog.md', title: 'Changelog' },
};

async function initStaticPage(
    container: HTMLElement,
    page: string,
): Promise<void> {
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
            throw new Error(
                (await res.text()) || `Failed to load ${spec.file}`,
            );
        const raw = await res.text();
        container.innerHTML = `<div class="md-rendered">${renderMarkdownSafe(raw)}</div>`;
        highlightCodeIn(container);
    } catch (e) {
        container.innerHTML = `<div class="md-list-error">Failed to load: ${escapeHtml((e as Error).message)}</div>`;
    }
}

// initMdView renders a workspace file or whitelisted static page.
export function initMdView(): void {
    const container = document.getElementById('md-view-body');
    if (!container) return;

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

    let lastRenderedRaw: string | null = null;
    let loadRequestId = 0;

    async function loadAndRender(): Promise<void> {
        // Overlapping fetches (onopen + 0x07 event) can resolve out of
        // order; only the latest request may touch the DOM.
        const requestId = ++loadRequestId;
        const showError = (html: string) => {
            container!.innerHTML = html;
        };
        try {
            const res = await fetch(
                `/api/markdown/file?path=${encodeURIComponent(path)}&cwd=${encodeURIComponent(cwd)}`,
            );
            if (requestId !== loadRequestId) return;
            if (res.status === 401) {
                showError(
                    '<div class="md-list-error">Session expired — log in in the main phi window, then reload this one.</div>',
                );
                return;
            }
            if (!res.ok) {
                const text = await res.text();
                if (requestId !== loadRequestId) return;
                showError(
                    `<div class="md-list-error">Failed to load: ${escapeHtml(text)}</div>`,
                );
                return;
            }
            const raw = await res.text();
            if (requestId !== loadRequestId) return;
            if (raw === lastRenderedRaw) return; // unchanged: no re-render, no scroll jump
            lastRenderedRaw = raw;

            const prevScrollTop = document.scrollingElement?.scrollTop ?? 0;
            container!.innerHTML = `<div class="md-rendered">${renderMarkdownSafe(raw)}</div>`;
            rewriteRelativeImages(container!, path, cwd);
            highlightCodeIn(container!);
            if (document.scrollingElement)
                document.scrollingElement.scrollTop = prevScrollTop;
        } catch (e) {
            if (requestId !== loadRequestId) return;
            showError(
                `<div class="md-list-error">Failed to load: ${escapeHtml((e as Error).message)}</div>`,
            );
        }
    }

    // Event-socket retry state lives here, not at module scope: this function
    // owns one events socket per md.html window.
    let eventAttempt = 0;
    let eventTimer: ReturnType<typeof setTimeout> | null = null;

    // connect refreshes a stale bearer before dialing: the server closes an
    // events socket at the admitted token exp, so a redial with that same
    // token would only be refused again. The wait is bounded by the module's
    // own auth deadline and a refresh failure still redials — the retry owner
    // below decides what happens next, not the refresh.
    function connect(): void {
        let refresh: Promise<unknown> | undefined;
        try {
            refresh = window.phiAccessAuth?.refreshAccessIfDue?.();
        } catch (_e) {}
        // No auth module (or a v1 session) dials synchronously: bridge-free
        // behavior must stay byte-identical.
        if (refresh && typeof refresh.then === 'function') {
            void refresh.catch(() => {}).then(dial);
        } else {
            dial();
        }
    }

    function dial(): void {
        const socketURL = new URL(wsUrl('/ws/md-events'));
        const ws = new WebSocket(
            (window.phiAccessAuth?.webSocketURL?.(socketURL) ?? socketURL).href,
            eventsSubprotocol,
        );
        ws.binaryType = 'arraybuffer';
        // Refresh on open too: content may have changed while disconnected.
        ws.onopen = () => {
            eventAttempt = 0;
            const negotiated = ws.protocol;
            // Test fakes omit the attribute; real servers must select it.
            if (negotiated !== undefined && negotiated !== eventsSubprotocol) {
                console.error(
                    `[md-view] Server did not select ${eventsSubprotocol}`,
                );
                try {
                    ws.close();
                } catch (_e) {}
                return;
            }
            void loadAndRender();
        };
        ws.onmessage = (e: MessageEvent) => {
            if (!(e.data instanceof ArrayBuffer)) return;
            const dir = decodeNotificationDir(new Uint8Array(e.data));
            if (dir === null) return; // ignore other notification kinds
            if (mdEventMatchesPath(dir || null, path)) void loadAndRender();
        };
        ws.onclose = () => {
            eventAttempt += 1;
            if (eventTimer !== null) clearTimeout(eventTimer);
            eventTimer = setTimeout(() => {
                eventTimer = null;
                connect();
            }, mdEventRetryDelay(eventAttempt));
        };
    }

    void loadAndRender();
    connect();
}
