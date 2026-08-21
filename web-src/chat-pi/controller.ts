import { connectControl } from './client.js';
import { mountChatPi } from './index.js';
import type { ChatPiHandle, PiModel, PiRpcControls } from './index.js';
import type { PiRpcStatus } from './render.js';

const chats = new Map<string, ChatPiHandle>();
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
    );
    chats.set(paneId, chat);
}

export function rpcChatSend(paneId: string, payload: string): boolean {
    return chats.get(paneId)?.send(payload) ?? false;
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

export function destroyRpcChat(paneId: string): void {
    const chat = chats.get(paneId);
    if (!chat) {
        setPiRpcStatus(paneId, null);
        setPiRpcControls(paneId, null);
        return;
    }
    chats.delete(paneId);
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
