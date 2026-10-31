import { connectControl } from './client.js';
import { mountChatPi } from './index.js';
import { hideSubagentStrip } from './subagents.js';
import type { ChatPiHandle, PiModel, PiRpcControls } from './index.js';
import type { PiRpcStatus } from './render.js';
import type {
    TranscriptSearchResult,
    TranscriptSearchUpdate,
} from '../review-transcript.js';

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
    // The transport can refuse the stream while no call is pending; report
    // that to the mounted chat instead of leaving it looking ready.
    let reportStreamFailure: ((message: string) => void) | null = null;
    const chat = mountChatPi(
        container,
        cwd,
        connectControl((message) => reportStreamFailure?.(message)),
        sessionPath,
        (status) => setPiRpcStatus(paneId, status),
        (state) => setPiRpcControls(paneId, state),
        (snapshot) => lastFleetSnapshots.set(paneId, snapshot),
    );
    reportStreamFailure = (message) => chat.streamFailed(message);
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

export function rpcChatSend(paneId: string, payload: string): boolean {
    return chats.get(paneId)?.send(payload) ?? false;
}

export function rpcChatSearch(
    paneId: string,
    query: string,
    onUpdate: (update: TranscriptSearchUpdate) => void,
): (() => void) | null {
    return chats.get(paneId)?.searchTranscript(query, onUpdate) ?? null;
}

export function rpcChatReveal(
    paneId: string,
    result: TranscriptSearchResult,
): boolean {
    return chats.get(paneId)?.revealTranscriptSearchResult(result) ?? false;
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

export function rpcChatCompact(paneId: string): Promise<unknown> {
    return chats.get(paneId)?.compact() ?? missingPane(paneId);
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
