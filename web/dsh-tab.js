import { getEmbeddedProfileId, serverKey } from './util.js';
export const DSH_CODER = 'dsh-preview';
export const DSH_PANE_ID = 'dsh-preview';
export const DSH_TITLE = 'DSH preview';
const STATUS_KEY = 'phi_dsh_preview';
const MOUNT_PATTERN = /^\/api\/dsh\/[A-Za-z0-9_-]{22}\/$/;
const STATUS_TIMEOUT = 5000;
const REFRESH_INTERVAL = 15000;
const views = new Map();
let cached = null;
let inFlight = null;
export function validDshMount(mount) {
    return typeof mount === 'string' && MOUNT_PATTERN.test(mount);
}
function readCachedStatus() {
    const key = serverKey(STATUS_KEY);
    if (cached?.key === key)
        return cached.status;
    try {
        const data = JSON.parse(localStorage.getItem(key) || 'null');
        if (typeof data?.enabled !== 'boolean' ||
            typeof data?.state !== 'string')
            return null;
        // Persist summaries, never mounts. A server restart invalidates routing.
        const status = { enabled: data.enabled, state: data.state };
        cached = { key, status };
        return status;
    }
    catch {
        return null;
    }
}
function writeCachedStatus(key, status) {
    const summary = { enabled: status.enabled, state: status.state };
    cached = { key, status: summary };
    try {
        localStorage.setItem(key, JSON.stringify(summary));
    }
    catch {
        /* memory works without storage */
    }
}
function fetchStatus(scope, disposal) {
    const key = serverKey(STATUS_KEY);
    if (inFlight?.key === key &&
        inFlight.scope === scope &&
        !inFlight.signal.aborted)
        return inFlight.promise;
    const controller = new AbortController();
    const abort = () => controller.abort();
    scope?.signal.addEventListener('abort', abort, { once: true });
    disposal?.addEventListener('abort', abort, { once: true });
    if (scope?.aborted || disposal?.aborted)
        abort();
    // Explicit timer works on older Chromium too, and remains armed through json().
    const timer = setTimeout(abort, STATUS_TIMEOUT);
    const promise = (async () => {
        try {
            const res = await fetch('/api/dsh/status', {
                headers: scope?.headers({ 'Cache-Control': 'no-store' }) ?? {
                    'Cache-Control': 'no-store',
                },
                signal: controller.signal,
            });
            if (!res.ok)
                return null;
            const data = await res.json();
            if (controller.signal.aborted ||
                scope?.aborted ||
                serverKey(STATUS_KEY) !== key ||
                typeof data?.enabled !== 'boolean' ||
                typeof data?.state !== 'string')
                return null;
            const status = {
                enabled: data.enabled,
                state: data.state,
            };
            if (validDshMount(data.mount))
                status.mount = data.mount;
            if (typeof data.reason === 'string')
                status.reason = data.reason;
            writeCachedStatus(key, status);
            return status;
        }
        catch {
            return null;
        }
        finally {
            clearTimeout(timer);
            scope?.signal.removeEventListener('abort', abort);
            disposal?.removeEventListener('abort', abort);
        }
    })();
    const request = { key, scope, signal: controller.signal, promise };
    inFlight = request;
    void promise.finally(() => {
        if (inFlight === request)
            inFlight = null;
    });
    return promise;
}
function isEmbeddedShell() {
    return getEmbeddedProfileId() !== '';
}
function ensureView(container) {
    const old = views.get(DSH_PANE_ID);
    if (old?.container === container)
        return old;
    destroyDshPreview(DSH_PANE_ID);
    const view = { container, frame: null, controller: new AbortController() };
    views.set(DSH_PANE_ID, view);
    const notice = document.createElement('div');
    notice.className = 'dsh-notice';
    notice.textContent =
        'Online preview · This UI shares your Phi access. Not isolated.';
    container.appendChild(notice);
    return view;
}
function renderState(view, text, retry) {
    if (view.frame)
        return;
    let shell = view.container.querySelector(':scope > .dsh-shell');
    if (!shell) {
        shell = document.createElement('div');
        shell.className = 'dsh-shell';
        shell.innerHTML =
            '<div class="dsh-shell-text"></div><button type="button" class="btn dsh-retry">Retry</button>';
        view.container.appendChild(shell);
    }
    const label = shell.querySelector('.dsh-shell-text');
    const button = shell.querySelector('.dsh-retry');
    if (label)
        label.textContent = text;
    if (button) {
        button.classList.toggle('hidden', !retry);
        button.onclick = retry ?? null;
    }
}
function stateText(status) {
    if (!status)
        return 'The preview is unreachable. Check the connection and retry.';
    if (!status.enabled)
        return 'The DSH preview is off on this server.';
    if (status.state === 'ready')
        return 'Connecting to the harness…';
    if (status.state === 'starting')
        return 'The harness is starting…';
    if (status.state === 'stopped')
        return 'The harness stopped. Restart phi to try again.';
    return 'The harness is unavailable.';
}
/** Same-origin scripts have Phi authority. See docs/dsh-preview.md.
 * Keep the native app intact; no sandbox isolation is claimed. */
export function mountDshPreview(paneId, container, mount) {
    if (paneId !== DSH_PANE_ID || !validDshMount(mount))
        return;
    const view = ensureView(container);
    if (view.frame)
        return;
    const frame = document.createElement('iframe');
    frame.className = 'dsh-frame';
    frame.title = 'DeepSeek harness (online preview)';
    frame.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen');
    container.querySelector(':scope > .dsh-shell')?.remove();
    view.frame = frame;
    container.appendChild(frame);
    frame.src = mount;
}
export function destroyDshPreview(paneId) {
    const view = views.get(paneId);
    views.delete(paneId);
    if (!view)
        return;
    view.controller.abort();
    view.releaseScope?.();
    clearTimeout(view.timer);
    view.frame?.removeAttribute('src');
    view.frame?.remove();
    view.container.querySelector(':scope > .dsh-notice')?.remove();
    view.container.querySelector(':scope > .dsh-shell')?.remove();
}
async function resolveMount(tm, view) {
    const scope = tm.app?.scope;
    const key = serverKey(STATUS_KEY);
    const current = () => !view.controller.signal.aborted &&
        !scope?.aborted &&
        !isEmbeddedShell() &&
        key === serverKey(STATUS_KEY) &&
        tm.tabs.get(DSH_PANE_ID)?.termContainer === view.container &&
        views.get(DSH_PANE_ID) === view;
    clearTimeout(view.timer);
    if (isEmbeddedShell()) {
        renderState(view, 'The DSH preview is not available in the desktop shell.');
        return;
    }
    const dispose = () => {
        if (views.get(DSH_PANE_ID) === view)
            destroyDshPreview(DSH_PANE_ID);
    };
    if (scope && !view.releaseScope) {
        scope.signal.addEventListener('abort', dispose, { once: true });
        view.releaseScope = () => scope.signal.removeEventListener('abort', dispose);
        if (scope.aborted) {
            dispose();
            return;
        }
    }
    const fresh = await fetchStatus(scope, view.controller.signal);
    if (!current())
        return;
    if (view.frame) {
        if (fresh &&
            (!fresh.enabled ||
                fresh.state !== 'ready' ||
                fresh.mount !== view.frame.getAttribute('src')) &&
            !view.container.querySelector('.dsh-reload')) {
            const notice = view.container.querySelector('.dsh-notice');
            if (!notice)
                return;
            notice.textContent =
                'Online preview · Shares Phi access. Harness changed; reload required. ';
            const reload = document.createElement('button');
            reload.type = 'button';
            reload.className = 'btn dsh-reload';
            reload.textContent = 'Reload DSH';
            reload.onclick = () => {
                if (!current() ||
                    !confirm('Reload DSH? Unsent or in-memory work in the harness may be lost.'))
                    return;
                destroyDshPreview(DSH_PANE_ID);
                restoreDshPreviewContainer(tm, view.container);
            };
            notice.appendChild(reload);
        }
    }
    else if (fresh?.enabled &&
        fresh.state === 'ready' &&
        validDshMount(fresh.mount)) {
        mountDshPreview(DSH_PANE_ID, view.container, fresh.mount);
    }
    else {
        const summary = fresh ?? readCachedStatus();
        renderState(view, fresh
            ? fresh.state === 'ready'
                ? 'The harness returned an invalid route. Retry.'
                : stateText(fresh)
            : `${stateText(summary)} Last status is cached; connection unavailable.`, () => {
            void resolveMount(tm, view);
        });
    }
    // Concurrent retries can share a response, but must own only one timer.
    // Status refresh never navigates a live frame or replays DSH traffic.
    if (current()) {
        clearTimeout(view.timer);
        view.timer = setTimeout(() => {
            void resolveMount(tm, view);
        }, REFRESH_INTERVAL);
    }
}
/** Create/select synchronously, then reconcile routing in the background. */
export function openDshPreviewTab(tm) {
    const existing = tm.tabs.get(DSH_PANE_ID);
    if (existing) {
        tm.switchTab(DSH_PANE_ID);
        return Promise.resolve();
    }
    const sessions = tm.app?.sessionsManager;
    tm.createTab(DSH_PANE_ID, '', DSH_TITLE, DSH_CODER, sessions?.activeWorkspace ?? '', sessions?.activeCWD ?? '', true);
    const tab = tm.tabs.get(DSH_PANE_ID);
    if (!tab)
        return Promise.resolve();
    const view = ensureView(tab.termContainer);
    renderState(view, stateText(readCachedStatus()));
    return resolveMount(tm, view);
}
export function restoreDshPreviewContainer(tm, container) {
    const view = ensureView(container);
    renderState(view, stateText(readCachedStatus()));
    void resolveMount(tm, view);
}
export async function refreshDshLauncher(scope) {
    const btn = document.getElementById('dsh-preview-btn');
    if (!btn)
        return;
    if (isEmbeddedShell()) {
        btn.classList.add('hidden');
        return;
    }
    const key = serverKey(STATUS_KEY);
    const summary = readCachedStatus();
    btn.classList.toggle('hidden', !summary?.enabled);
    const fresh = await fetchStatus(scope);
    if (scope?.aborted || isEmbeddedShell() || key !== serverKey(STATUS_KEY))
        return;
    btn.classList.toggle('hidden', !(fresh ?? summary)?.enabled);
}
export function __resetDshTabForTest() {
    for (const id of views.keys())
        destroyDshPreview(id);
    cached = null;
    inFlight = null;
}
