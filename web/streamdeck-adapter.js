const MAX_TABS = 128;
const MAX_ID_BYTES = 128;
const MAX_LABEL_BYTES = 128;
const MAX_WAIT_MS = 10_000;
function byteLength(value, encoder) {
    return encoder.encode(value).byteLength;
}
function boundedLabel(value, encoder) {
    if (typeof value !== 'string')
        return '';
    let label = '';
    let size = 0;
    for (const character of value) {
        const bytes = byteLength(character, encoder);
        if (size + bytes > MAX_LABEL_BYTES)
            break;
        label += character;
        size += bytes;
    }
    return label;
}
function tabType(coder) {
    if (typeof coder !== 'string')
        return 'other';
    switch (coder) {
        case 'pi':
        case 'pi-rpc':
        case 'review':
        case 'kanban':
        case 'claude':
        case 'codex':
            return coder;
        default:
            return 'other';
    }
}
function connectionState(tab) {
    if (tab.coder === 'review' ||
        tab.coder === 'kanban' ||
        tab.coder === 'pi-rpc') {
        return 'local';
    }
    if (tab.isDead === true)
        return 'disconnected';
    if (tab.ws?.readyState === 1)
        return 'connected';
    if (tab.ws?.readyState === 0)
        return 'connecting';
    return 'unknown';
}
function makePageNonce() {
    try {
        const bytes = new Uint8Array(16);
        globalThis.crypto.getRandomValues(bytes);
        return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    catch {
        return null;
    }
}
/** Install the bounded page API after App.init() has restored its tabs. */
export function installStreamDeckAdapter(manager) {
    const documentNonce = makePageNonce();
    if (!documentNonce)
        return null;
    const encoder = new TextEncoder();
    let revision = 0;
    let disposed = false;
    let waiter = null;
    const getState = () => {
        if (disposed ||
            !(manager.tabs instanceof Map) ||
            manager.tabs.size > MAX_TABS) {
            return null;
        }
        const tabs = [];
        for (const tab of manager.tabs.values()) {
            if (!tab ||
                typeof tab.paneId !== 'string' ||
                tab.softClosing === true)
                continue;
            if (byteLength(tab.paneId, encoder) === 0 ||
                byteLength(tab.paneId, encoder) > MAX_ID_BYTES) {
                return null;
            }
            tabs.push({
                paneId: tab.paneId,
                label: boundedLabel(tab.title, encoder),
                type: tabType(tab.coder),
                selected: manager.activePaneId === tab.paneId,
                connection: connectionState(tab),
            });
        }
        if (tabs.length > MAX_TABS)
            return null;
        const active = manager.getActiveTab();
        return {
            version: 1,
            documentNonce,
            revision,
            activePaneId: active &&
                active.softClosing !== true &&
                typeof active.paneId === 'string'
                ? active.paneId
                : null,
            tabs,
        };
    };
    const settleWaiter = (result) => {
        const current = waiter;
        if (!current)
            return;
        waiter = null;
        clearTimeout(current.timer);
        current.resolve(result);
    };
    const notify = () => {
        if (disposed)
            return;
        revision += 1;
        if (waiter && revision !== waiter.afterRevision) {
            const state = getState();
            if (state)
                settleWaiter({ kind: 'changed', state });
            else
                settleWaiter({ kind: 'unavailable' });
        }
    };
    const adapter = {
        getState,
        selectTab(paneId) {
            if (disposed ||
                typeof paneId !== 'string' ||
                byteLength(paneId, encoder) > MAX_ID_BYTES) {
                return { ok: false, reason: 'missing' };
            }
            const tab = manager.tabs.get(paneId);
            if (!tab || tab.softClosing === true)
                return { ok: false, reason: 'missing' };
            manager.switchTab(paneId);
            if (manager.activePaneId !== paneId ||
                manager.tabs.get(paneId) !== tab) {
                return { ok: false, reason: 'not-selected' };
            }
            const state = getState();
            return state
                ? { ok: true, state }
                : { ok: false, reason: 'not-selected' };
        },
        waitForRevision(afterRevision, timeoutMs) {
            if (disposed ||
                !Number.isSafeInteger(afterRevision) ||
                afterRevision < 0 ||
                !Number.isFinite(timeoutMs) ||
                timeoutMs < 1) {
                return Promise.resolve({
                    kind: disposed ? 'disposed' : 'unavailable',
                });
            }
            const state = getState();
            if (!state)
                return Promise.resolve({ kind: 'unavailable' });
            if (state.revision !== afterRevision) {
                return Promise.resolve({ kind: 'changed', state });
            }
            if (waiter)
                settleWaiter({ kind: 'cancelled' });
            return new Promise((resolve) => {
                const boundedTimeout = Math.min(timeoutMs, MAX_WAIT_MS);
                const timer = setTimeout(() => settleWaiter({ kind: 'timeout' }), boundedTimeout);
                waiter = { afterRevision, resolve, timer };
            });
        },
        cancelWait() {
            settleWaiter({ kind: 'cancelled' });
        },
        dispose() {
            if (disposed)
                return;
            disposed = true;
            settleWaiter({ kind: 'disposed' });
            if (manager._streamDeckAdapterChanged === notify) {
                manager._streamDeckAdapterChanged = null;
            }
            if (typeof window !== 'undefined') {
                window.removeEventListener('pagehide', onPageHide);
            }
        },
    };
    const onPageHide = () => adapter.dispose();
    manager._streamDeckAdapterChanged = notify;
    if (typeof window !== 'undefined') {
        window.addEventListener('pagehide', onPageHide, { once: true });
    }
    return adapter;
}
