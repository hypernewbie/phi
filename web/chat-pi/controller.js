import { connectControl } from './client.js';
import { mountChatPi } from './index.js';
import { hideSubagentStrip } from './subagents.js';
const chats = new Map();
const lastFleetSnapshots = new Map();
const statuses = new Map();
const controls = new Map();
const statusListeners = new Set();
function cloneStatus(status) {
    return {
        ...status,
        skills: status.skills ? [...status.skills] : status.skills,
    };
}
function cloneControls(state) {
    return { ...state };
}
function notifyPiRpcStatus(paneId) {
    const status = statuses.get(paneId);
    for (const listener of statusListeners)
        listener(paneId, status ? cloneStatus(status) : null);
}
function setPiRpcStatus(paneId, status) {
    if (status === null) statuses.delete(paneId);
    else statuses.set(paneId, cloneStatus(status));
    notifyPiRpcStatus(paneId);
}
function setPiRpcControls(paneId, state) {
    if (state === null) controls.delete(paneId);
    else controls.set(paneId, cloneControls(state));
    // Readiness, busy/queue state, transcript changes, and teardown share the
    // existing status subscription so terminal controls repaint without a
    // second browser-wide listener contract.
    notifyPiRpcStatus(paneId);
}
function missingPane(paneId) {
    return Promise.reject(
        new Error(`unknown or destroyed Pi RPC pane: ${paneId}`),
    );
}
export function mountRpcChat(paneId, container, cwd, sessionPath) {
    destroyRpcChat(paneId);
    const chat = mountChatPi(
        container,
        cwd,
        connectControl(),
        sessionPath,
        (status) => setPiRpcStatus(paneId, status),
        (state) => setPiRpcControls(paneId, state),
        (snapshot) => lastFleetSnapshots.set(paneId, snapshot),
        (recovery) => {
            if (typeof document !== 'undefined') {
                document.dispatchEvent(
                    new CustomEvent('phi:pi-queue-recovery', {
                        detail: { paneId, recovery },
                    }),
                );
            }
        },
    );
    chats.set(paneId, chat);
}
/** Repaint the shared subagent strip for the active tab: replay the
 * pane's last fleet snapshot via its handle, or hide the strip when the
 * tab has no chat handle (plain terminal/review tabs). */
export function syncPiSubagentStrip(paneId) {
    const chat = chats.get(paneId);
    if (chat) chat.refreshFleet();
    else hideSubagentStrip();
}
export function rpcChatSend(
    paneId,
    payload,
    attachmentRefs = [],
    deliveryOverride,
) {
    return (
        chats.get(paneId)?.send({
            message: payload,
            attachments: [...attachmentRefs],
            ...(deliveryOverride ? { deliveryOverride } : {}),
        }) ?? missingPane(paneId)
    );
}
export function rpcChatQueueCopy(paneId, itemId) {
    return chats.get(paneId)?.queueCopy(itemId) ?? missingPane(paneId);
}
export function rpcChatQueueDiscard(paneId, itemId) {
    return chats.get(paneId)?.queueDiscard(itemId) ?? missingPane(paneId);
}
export function rpcChatQueueRestore(paneId, itemId) {
    return chats.get(paneId)?.queueRestore(itemId) ?? missingPane(paneId);
}
export function rpcChatRestoreLatestLocal(paneId) {
    return chats.get(paneId)?.restoreLatestLocal() ?? missingPane(paneId);
}
export function rpcChatModels(paneId) {
    return chats.get(paneId)?.getModels() ?? missingPane(paneId);
}
export function rpcChatThinkingLevels(paneId) {
    return chats.get(paneId)?.getThinkingLevels() ?? missingPane(paneId);
}
export function rpcChatSetModel(paneId, provider, modelId) {
    return (
        chats.get(paneId)?.setModel(provider, modelId) ?? missingPane(paneId)
    );
}
export function rpcChatSetThinking(paneId, level) {
    return chats.get(paneId)?.setThinking(level) ?? missingPane(paneId);
}
export function rpcChatReset(paneId) {
    return chats.get(paneId)?.resetChat() ?? missingPane(paneId);
}
export function rpcChatInterrupt(paneId) {
    return chats.get(paneId)?.interrupt() ?? missingPane(paneId);
}
export function closePiSubagentViewer(paneId) {
    return chats.get(paneId)?.closeSubagentViewer() ?? false;
}
export function rpcChatSetName(paneId, name) {
    return chats.get(paneId)?.setName(name) ?? missingPane(paneId);
}
export function destroyRpcChat(paneId) {
    const chat = chats.get(paneId);
    if (!chat) {
        lastFleetSnapshots.delete(paneId);
        setPiRpcStatus(paneId, null);
        setPiRpcControls(paneId, null);
        return;
    }
    chats.delete(paneId);
    lastFleetSnapshots.delete(paneId);
    statuses.delete(paneId);
    controls.delete(paneId);
    chat.destroy();
}
export function getPiRpcStatus(paneId) {
    const status = statuses.get(paneId);
    return status ? cloneStatus(status) : null;
}
export function getPiRpcControls(paneId) {
    const state = controls.get(paneId);
    return state ? cloneControls(state) : null;
}
export function subscribePiRpcStatus(listener) {
    statusListeners.add(listener);
    return () => statusListeners.delete(listener);
}
export function rpcChatCancelDialogs(paneId, reason = 'tabClosed') {
    return chats.get(paneId)?.cancelDialogs(reason) ?? missingPane(paneId);
}
export function closePiExtensionDialog(paneId) {
    return chats.get(paneId)?.closeExtensionDialog() ?? false;
}
export function focusPiExtensionDialog(paneId) {
    chats.get(paneId)?.focusExtensionDialog();
}
