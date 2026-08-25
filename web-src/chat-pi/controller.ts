import { connectControl } from './client.js';
import { mountChatPi } from './index.js';
import { hideSubagentStrip } from './subagents.js';
import type {
    ChatPiHandle,
    ChatPiSendInput,
    PiModel,
    PiQueueRecovery,
    PiQueueSendResult,
    PiRpcControls,
} from './index.js';
import type { PiRpcStatus } from './render.js';

const chats = new Map<string, ChatPiHandle>();
const lastFleetSnapshots = new Map<string, unknown>();
const statuses = new Map<string, PiRpcStatus>();
const controls = new Map<string, PiRpcControls>();
const statusListeners = new Set<
    (paneId: string, status: PiRpcStatus | null) => void
>();

function cloneStatus(status: PiRpcStatus): PiRpcStatus {
    return {
        ...status,
        skills: status.skills ? [...status.skills] : status.skills,
    };
}

function cloneControls(state: PiRpcControls): PiRpcControls {
    return { ...state };
}

function notifyPiRpcStatus(paneId: string): void {
    const status = statuses.get(paneId);
    for (const listener of statusListeners)
        listener(paneId, status ? cloneStatus(status) : null);
}

function setPiRpcStatus(paneId: string, status: PiRpcStatus | null): void {
    if (status === null) statuses.delete(paneId);
    else statuses.set(paneId, cloneStatus(status));
    notifyPiRpcStatus(paneId);
}

function setPiRpcControls(paneId: string, state: PiRpcControls | null): void {
    if (state === null) controls.delete(paneId);
    else controls.set(paneId, cloneControls(state));
    // Readiness, busy/queue state, transcript changes, and teardown share the
    // existing status subscription so terminal controls repaint without a
    // second browser-wide listener contract.
    notifyPiRpcStatus(paneId);
}

function missingPane(paneId: string): Promise<never> {
    return Promise.reject(
        new Error(`unknown or destroyed Pi RPC pane: ${paneId}`),
    );
}

export function mountRpcChat(
    paneId: string,
    container: HTMLElement,
    cwd: string,
    sessionPath?: string,
): void {
    destroyRpcChat(paneId);
    const chat = mountChatPi(
        container,
        cwd,
        connectControl(),
        sessionPath,
        (status) => setPiRpcStatus(paneId, status),
        (state) => setPiRpcControls(paneId, state),
        (snapshot) => lastFleetSnapshots.set(paneId, snapshot),
        (recovery: PiQueueRecovery) => {
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
export function syncPiSubagentStrip(paneId: string): void {
    const chat = chats.get(paneId);
    if (chat) chat.refreshFleet();
    else hideSubagentStrip();
}

export function rpcChatSend(
    paneId: string,
    payload: string,
    attachmentRefs: string[] = [],
    deliveryOverride?: ChatPiSendInput['deliveryOverride'],
): Promise<PiQueueSendResult> {
    return (
        chats.get(paneId)?.send({
            message: payload,
            attachments: [...attachmentRefs],
            ...(deliveryOverride ? { deliveryOverride } : {}),
        }) ?? missingPane(paneId)
    );
}

export function rpcChatQueueCopy(
    paneId: string,
    itemId: string,
): Promise<unknown> {
    return chats.get(paneId)?.queueCopy(itemId) ?? missingPane(paneId);
}

export function rpcChatQueueDiscard(
    paneId: string,
    itemId: string,
): Promise<unknown> {
    return chats.get(paneId)?.queueDiscard(itemId) ?? missingPane(paneId);
}

export function rpcChatQueueRestore(
    paneId: string,
    itemId: string,
): Promise<unknown> {
    return chats.get(paneId)?.queueRestore(itemId) ?? missingPane(paneId);
}

export function rpcChatRestoreLatestLocal(paneId: string): Promise<unknown> {
    return chats.get(paneId)?.restoreLatestLocal() ?? missingPane(paneId);
}

export function rpcChatModels(paneId: string): Promise<PiModel[]> {
    return chats.get(paneId)?.getModels() ?? missingPane(paneId);
}

export function rpcChatThinkingLevels(paneId: string): Promise<string[]> {
    return chats.get(paneId)?.getThinkingLevels() ?? missingPane(paneId);
}

export function rpcChatSetModel(
    paneId: string,
    provider: string,
    modelId: string,
): Promise<unknown> {
    return (
        chats.get(paneId)?.setModel(provider, modelId) ?? missingPane(paneId)
    );
}

export function rpcChatSetThinking(
    paneId: string,
    level: string,
): Promise<unknown> {
    return chats.get(paneId)?.setThinking(level) ?? missingPane(paneId);
}

export function rpcChatReset(paneId: string): Promise<unknown> {
    return chats.get(paneId)?.resetChat() ?? missingPane(paneId);
}

export function rpcChatInterrupt(paneId: string): Promise<unknown> {
    return chats.get(paneId)?.interrupt() ?? missingPane(paneId);
}

export function closePiSubagentViewer(paneId: string): boolean {
    return chats.get(paneId)?.closeSubagentViewer() ?? false;
}

export function rpcChatSetName(paneId: string, name: string): Promise<unknown> {
    return chats.get(paneId)?.setName(name) ?? missingPane(paneId);
}

export function destroyRpcChat(paneId: string): void {
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

export function getPiRpcStatus(paneId: string): PiRpcStatus | null {
    const status = statuses.get(paneId);
    return status ? cloneStatus(status) : null;
}

export function getPiRpcControls(paneId: string): PiRpcControls | null {
    const state = controls.get(paneId);
    return state ? cloneControls(state) : null;
}

export function subscribePiRpcStatus(
    listener: (paneId: string, status: PiRpcStatus | null) => void,
): () => void {
    statusListeners.add(listener);
    return () => statusListeners.delete(listener);
}

export function rpcChatCancelDialogs(
    paneId: string,
    reason: 'tabClosed' | 'server' = 'tabClosed',
): Promise<unknown> {
    return chats.get(paneId)?.cancelDialogs(reason) ?? missingPane(paneId);
}

export function closePiExtensionDialog(paneId: string): boolean {
    return chats.get(paneId)?.closeExtensionDialog() ?? false;
}

export function focusPiExtensionDialog(paneId: string): void {
    chats.get(paneId)?.focusExtensionDialog();
}

export function rpcChatToggleSearch(paneId: string): boolean {
    return chats.get(paneId)?.toggleSearch() ?? false;
}

export function closePiSearch(paneId: string): boolean {
    return chats.get(paneId)?.closeSearch() ?? false;
}
