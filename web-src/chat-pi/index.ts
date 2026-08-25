import { dispatchComposer } from './composer.js';
import type { QueueDelivery } from './composer.js';
import type { ControlClient, ControlConnectionState } from './client.js';
import {
    createPiDialogController,
    type DialogAnswer,
    type DialogRecord,
    type PiDialogController,
} from './dialogs.js';
import { MessageBuffer } from './message-buffer.js';
import type { Snapshot } from './message-buffer.js';
import { savePersisted } from './persist.js';
import { renderedUserText } from './render.js';
import type { PiRpcStatus } from './render.js';
import { createReviewTranscriptView } from '../review-transcript.js';
import type {
    ActiveTurnState,
    ReviewQueueActions,
    ReviewQueueItem,
} from '../review-transcript.js';
import { createSubagentStrip, createSubagentViewer } from './subagents.js';

export interface PiModel {
    provider: string;
    id: string;
    name?: string;
}

export interface PiRpcControls {
    ready: boolean;
    exited: boolean;
    busy: boolean;
    queueDepth: number;
    hasTranscript: boolean;
    model: string;
    thinking: string;
    connectionState: ControlConnectionState;
}

export interface PiQueueItem extends ReviewQueueItem {
    sid: string;
    sessionEpoch: string;
    attachments: Array<{
        ref: string;
        name: string;
        mimeType: string;
        sizeBytes: number;
    }>;
}

export interface PiQueueSnapshot {
    sessionEpoch: string;
    items: PiQueueItem[];
}

export type PiDialogRecord = DialogRecord;

export interface PiQueueSendResult {
    item?: PiQueueItem;
    uncertain: boolean;
    error?: string;
}

export interface PiQueueRecovery {
    copied?: boolean;
    restored?: boolean;
    reason?: string;
    message?: string;
    attachmentRefs?: string[];
    item?: {
        message: string;
        attachments?: Array<{
            ref: string;
            name?: string;
            mimeType?: string;
            sizeBytes?: number;
        }>;
    };
    attachments?: Array<{
        ref: string;
        name?: string;
        mimeType?: string;
        sizeBytes?: number;
    }>;
}

export interface ChatPiSendInput {
    message: string;
    attachments: string[];
    deliveryOverride?: QueueDelivery;
}

export interface ChatPiHandle {
    destroy(): void;
    send(input: ChatPiSendInput): Promise<PiQueueSendResult>;
    send(input: string): boolean;
    getModels(): Promise<PiModel[]>;
    getThinkingLevels(): Promise<string[]>;
    setModel(provider: string, modelId: string): Promise<unknown>;
    setThinking(level: string): Promise<unknown>;
    resetChat(): Promise<unknown>;
    interrupt(): Promise<unknown>;
    setName(name: string): Promise<unknown>;
    queueCopy(itemId: string): Promise<unknown>;
    queueDiscard(itemId: string): Promise<unknown>;
    queueRestore(itemId: string): Promise<unknown>;
    restoreLatestLocal(): Promise<unknown>;
    closeExtensionDialog(): boolean;
    focusExtensionDialog(): void;
    cancelDialogs(reason: 'tabClosed' | 'server'): Promise<unknown>;
    refreshFleet(): void;
    closeSubagentViewer(): boolean;
}

export type PiRpcStatusChange = (status: PiRpcStatus | null) => void;
export type PiRpcControlChange = (controls: PiRpcControls | null) => void;
export type PiFleetChange = (snapshot: unknown) => void;

function cloneStatus(status: PiRpcStatus): PiRpcStatus {
    return {
        ...status,
        skills: status.skills ? [...status.skills] : status.skills,
    };
}

function mergeState(status: PiRpcStatus, state: unknown): boolean {
    if (!state || typeof state !== 'object') return false;
    const source = state as Record<string, unknown>;
    let changed = false;
    const strings = ['cwd', 'model', 'thinking'] as const;
    for (const field of strings) {
        if (Object.hasOwn(source, field) && typeof source[field] === 'string') {
            status[field] = source[field] as never;
            changed = true;
        }
    }
    const numbers = [
        'inputTokens',
        'outputTokens',
        'contextUsedTokens',
        'contextWindowTokens',
        'cacheReadTokens',
        'cacheWriteTokens',
        'cost',
    ] as const;
    for (const field of numbers) {
        if (!Object.hasOwn(source, field)) continue;
        const value = source[field];
        if (
            value === null ||
            (typeof value === 'number' && Number.isFinite(value))
        ) {
            status[field] = value as never;
            changed = true;
        }
    }
    if (Object.hasOwn(source, 'skills')) {
        const value = source.skills;
        if (
            value === null ||
            (Array.isArray(value) &&
                value.every((item) => typeof item === 'string'))
        ) {
            status.skills = value === null ? null : [...(value as string[])];
            changed = true;
        }
    }
    return changed;
}

function isSnapshot(value: unknown): value is Snapshot {
    if (!value || typeof value !== 'object') return false;
    const snapshot = value as Record<string, unknown>;
    return (
        typeof snapshot.lastSeq === 'number' &&
        Number.isFinite(snapshot.lastSeq) &&
        Array.isArray(snapshot.messages)
    );
}

function rejected(message: string): Promise<never> {
    return Promise.reject(new Error(message));
}

function validQueueSnapshot(value: unknown): value is PiQueueSnapshot {
    if (!value || typeof value !== 'object') return false;
    const queue = value as Record<string, unknown>;
    return typeof queue.sessionEpoch === 'string' && Array.isArray(queue.items);
}

function cloneDialogRecords(value: unknown): PiDialogRecord[] {
    if (!Array.isArray(value)) return [];
    const methods = new Set(['select', 'confirm', 'input', 'editor']);
    return value.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const record = entry as Record<string, unknown>;
        if (
            typeof record.id !== 'string' ||
            !methods.has(String(record.method)) ||
            typeof record.title !== 'string'
        )
            return [];
        const method = record.method as PiDialogRecord['method'];
        return [
            {
                id: record.id,
                method,
                title: record.title,
                ...(Array.isArray(record.options)
                    ? {
                          options: record.options.filter(
                              (option): option is string =>
                                  typeof option === 'string',
                          ),
                      }
                    : {}),
                ...(typeof record.message === 'string'
                    ? { message: record.message }
                    : {}),
                ...(typeof record.placeholder === 'string'
                    ? { placeholder: record.placeholder }
                    : {}),
                ...(typeof record.prefill === 'string'
                    ? { prefill: record.prefill }
                    : {}),
                timeout:
                    typeof record.timeout === 'number' &&
                    Number.isFinite(record.timeout)
                        ? record.timeout
                        : 0,
                createdAt:
                    typeof record.createdAt === 'number' &&
                    Number.isFinite(record.createdAt)
                        ? record.createdAt
                        : 0,
            },
        ];
    });
}

function cloneQueueItems(items: unknown): PiQueueItem[] {
    if (!Array.isArray(items)) return [];
    return items.flatMap((value) => {
        if (!value || typeof value !== 'object') return [];
        const item = value as Record<string, unknown>;
        const deliveries = new Set(['prompt', 'steer', 'followUp']);
        const states = new Set([
            'local',
            'sending',
            'accepted',
            'uncertain',
            'consumed',
            'cancelled',
            'promoted',
        ]);
        if (
            typeof item.id !== 'string' ||
            typeof item.sid !== 'string' ||
            typeof item.sessionEpoch !== 'string' ||
            typeof item.message !== 'string' ||
            typeof item.delivery !== 'string' ||
            !deliveries.has(item.delivery) ||
            typeof item.state !== 'string' ||
            !states.has(item.state)
        )
            return [];
        return [
            {
                id: item.id,
                sid: item.sid,
                sessionEpoch: item.sessionEpoch,
                message: item.message,
                delivery: item.delivery as PiQueueItem['delivery'],
                state: item.state as PiQueueItem['state'],
                error: typeof item.error === 'string' ? item.error : undefined,
                createdAt:
                    typeof item.createdAt === 'number'
                        ? item.createdAt
                        : undefined,
                attachments: Array.isArray(item.attachments)
                    ? item.attachments.flatMap((attachment) => {
                          if (!attachment || typeof attachment !== 'object')
                              return [];
                          const record = attachment as Record<string, unknown>;
                          if (typeof record.ref !== 'string') return [];
                          return [
                              {
                                  ref: record.ref,
                                  name:
                                      typeof record.name === 'string'
                                          ? record.name
                                          : 'attachment',
                                  mimeType:
                                      typeof record.mimeType === 'string'
                                          ? record.mimeType
                                          : 'application/octet-stream',
                                  sizeBytes:
                                      typeof record.sizeBytes === 'number'
                                          ? record.sizeBytes
                                          : 0,
                              },
                          ];
                      })
                    : [],
            },
        ];
    });
}

function validModels(value: unknown): PiModel[] {
    const models = (value as Record<string, unknown> | null)?.models;
    if (!Array.isArray(models)) throw new Error('Pi model list is malformed');
    return models.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const model = item as Record<string, unknown>;
        if (typeof model.provider !== 'string' || !model.provider) return [];
        if (typeof model.id !== 'string' || !model.id) return [];
        return [
            {
                provider: model.provider,
                id: model.id,
                ...(typeof model.name === 'string' && model.name
                    ? { name: model.name }
                    : {}),
            },
        ];
    });
}

function validThinkingLevels(value: unknown): string[] {
    const levels = (value as Record<string, unknown> | null)?.levels;
    if (
        !Array.isArray(levels) ||
        !levels.every((level) => typeof level === 'string')
    )
        throw new Error('Pi thinking level list is malformed');
    return [...(levels as string[])];
}

type LegacyClient = ControlClient & {
    call?: <T = any>(op: string, sid?: string, args?: unknown) => Promise<T>;
};

type LegacyResponseMap = Map<
    string,
    { resolve: (value: any) => void; reject: (reason?: unknown) => void }
>;

function invokeControl(
    client: LegacyClient,
    op: string,
    sid: string | undefined,
    args: unknown,
    legacyId: string,
    legacyResponses?: LegacyResponseMap,
): Promise<any> {
    if (typeof client.call === 'function') return client.call(op, sid, args);
    const frame: Record<string, unknown> = { t: 'call', id: legacyId, op };
    if (sid !== undefined) frame.sid = sid;
    if (args !== undefined) frame.args = args;
    return new Promise((resolve, reject) => {
        if (legacyResponses) {
            legacyResponses.set(legacyId, { resolve, reject });
            client.send(frame);
            return;
        }
        const off = client.onMessage((env: any) => {
            if (env?.t !== 'res' || env.id !== legacyId) return;
            off();
            if (env.ok) resolve(env.data);
            else reject(new Error(String(env.error ?? 'control call failed')));
        });
        client.send(frame);
    });
}

export function mountChatPi(
    root: HTMLElement,
    cwd: string,
    client: ControlClient,
    sessionPath?: string,
    onStatusChange: PiRpcStatusChange = () => {},
    onControlChange: PiRpcControlChange = () => {},
    onFleetChange: PiFleetChange = () => {},
    onQueueRecovery:
        | ((result: PiQueueRecovery) => void)
        | undefined = undefined,
): ChatPiHandle {
    const wire = client as LegacyClient;
    const buffer = new MessageBuffer();
    const localStatus: PiRpcStatus = { cwd };
    let sid = '';
    let queueSessionEpoch = '';
    let queueItems: PiQueueItem[] = [];
    let dialogs: PiDialogRecord[] = [];
    let piAuthoritativeQueue = {
        steering: [] as string[],
        followUp: [] as string[],
    };
    const spawnId = `spawn-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let spawnInFlight = false;
    let connectionState: ControlConnectionState = 'connecting';
    let destroyed = false;
    let ready = false;
    let busy = false;
    let queueDepth = 0;
    let exited = false;
    let resetInFlight = false;
    let sessionActive = false;
    type OutgoingPrompt = {
        id: string;
        text: string;
        state: 'sending' | 'sent';
        legacy?: boolean;
    };
    const outgoing: OutgoingPrompt[] = [];
    // Outgoing records disappear when their user message is rendered; retain
    // the full current-turn order separately for interrupt restoration.
    const turnPrompts: OutgoingPrompt[] = [];
    let activePrompt: {
        id: string;
        text: string;
        state: 'sending' | 'sent';
        origin: 'optimistic' | number;
    } | null = null;
    let abortInFlight = false;
    let hydrateInFlight = false;
    let pendingSaveTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingImmediateSave = false;
    let hydrateGeneration = 0;
    let activeHydrate: {
        sid: string;
        generation: number;
        reset: boolean;
    } | null = null;
    let legacyHydrateId = 0;
    let dialogCallSeq = 0;
    const legacyResponses: LegacyResponseMap = new Map();

    const notifyStatus = (): void => onStatusChange(cloneStatus(localStatus));
    const notifyControls = (): void =>
        onControlChange({
            ready,
            exited,
            busy,
            queueDepth,
            hasTranscript: buffer.getMessageCount() > 0,
            model: localStatus.model ?? '',
            thinking: localStatus.thinking ?? '',
            connectionState,
        });
    const applyState = (state: unknown): void => {
        const source = state as Record<string, unknown> | null;
        const statusChanged = mergeState(localStatus, state);
        let controlsChanged = statusChanged;
        if (source && typeof source === 'object') {
            if (typeof source.busy === 'boolean') {
                const busyChanged = source.busy !== busy;
                busy = source.busy;
                sessionActive = busy;
                controlsChanged = controlsChanged || busyChanged;
                // The Pi-authoritative arrays are display-only. Retire them at
                // the idle/settlement boundary without changing ledger
                // ownership; queueChanged remains the identity-bearing path
                // for local item transitions.
                if (
                    !busy &&
                    (piAuthoritativeQueue.steering.length > 0 ||
                        piAuthoritativeQueue.followUp.length > 0)
                ) {
                    piAuthoritativeQueue = { steering: [], followUp: [] };
                    syncQueueView();
                }
                // agent_settled is authoritative even when Pi never exposed a
                // busy=true edge (a settled child may report busy=false from
                // the start). Clear any optimistic turn on every idle state,
                // not only on a false transition.
                if (
                    !busy &&
                    (busyChanged ||
                        outgoing.length > 0 ||
                        activePrompt !== null ||
                        retryState !== null)
                ) {
                    // Queue-backed records have identity-bearing terminal
                    // transitions from queueChanged. A busy=false state
                    // (including a get_state response) cannot prove that Pi
                    // consumed an accepted item, so only clear legacy
                    // OpPrompt records at this compatibility boundary.
                    const queueOutgoing = outgoing.filter(
                        (item) => !item.legacy,
                    );
                    const queueIds = new Set(
                        queueOutgoing.map((item) => item.id),
                    );
                    outgoing.splice(0, outgoing.length, ...queueOutgoing);
                    for (
                        let index = turnPrompts.length - 1;
                        index >= 0;
                        index--
                    ) {
                        if (turnPrompts[index].legacy)
                            turnPrompts.splice(index, 1);
                    }
                    if (activePrompt && !queueIds.has(activePrompt.id)) {
                        activePrompt = queueOutgoing.at(-1)
                            ? { ...queueOutgoing.at(-1)!, origin: 'optimistic' }
                            : null;
                    }
                    // Milestone 4: guard against a stranded retry state
                    // when the busy→false transition lands in a hydrate
                    // window that dropped the auto_retry_end event (the
                    // event loop's `!result.applied` early return discards
                    // any event that arrives after a gap). Clearing the
                    // retry state before syncActiveTurn ensures the
                    // working row hides and the "Retrying · attempt N of
                    // M" label cannot persist past the turn boundary.
                    retryState = null;
                    syncActiveTurn();
                }
            }
            if (
                typeof source.queueDepth === 'number' &&
                Number.isFinite(source.queueDepth) &&
                source.queueDepth >= 0 &&
                source.queueDepth !== queueDepth
            ) {
                queueDepth = Math.trunc(source.queueDepth);
                controlsChanged = true;
            }
        }
        if (statusChanged) notifyStatus();
        if (controlsChanged) notifyControls();
    };
    const failBootstrap = (message: unknown): void => {
        sid = '';
        ready = false;
        exited = false;
        status.textContent = `Error: ${String(message ?? 'unknown')}`;
        notifyControls();
    };
    // Paint is microtask-coalesced: multiple text_delta events in the same
    // tick collapse into one DOM repaint, so streaming stays cheap even with
    // ~100 messages in the DOM window. The closure reads the latest buffer
    // and partial at flush time.
    let paintQueued = false;
    const flushPaint = (): void => {
        paintQueued = false;
        // The structured renderer reads active-turn state while it builds
        // the current window. State-only updates use this same narrow setter
        // without re-rendering the transcript.
        syncActiveTurn();
        view.setStructuredMessages(
            buffer.getStructuredTranscript(),
            buffer.getPartial(),
            buffer.getToolResultMap(),
        );
        notifyControls();
    };
    const paint = (): void => {
        if (paintQueued) return;
        paintQueued = true;
        void Promise.resolve().then(flushPaint);
    };

    onStatusChange(cloneStatus(localStatus));
    onControlChange({
        ready,
        exited,
        busy,
        queueDepth,
        hasTranscript: false,
        model: '',
        thinking: '',
        connectionState,
    });

    const view = createReviewTranscriptView(root, {
        title: 'Pi RPC',
        coder: cwd,
        status: 'Spawning…',
        mode: 'structured',
        windowSize: 100,
        pageSize: 50,
    });
    const status = view.status!;
    const respondDialog = (
        record: DialogRecord,
        answer: DialogAnswer,
    ): Promise<{ resolved?: boolean } | undefined> => {
        if (!sid) return rejected('Pi RPC is not ready');
        return invokeControl(
            wire,
            'extensionUiResponse',
            sid,
            { requestId: record.id, ...answer },
            `dialog-response-${++dialogCallSeq}`,
            legacyResponses,
        );
    };
    const cancelDialogRecords = (
        reason: 'tabClosed' | 'server',
    ): Promise<unknown> => {
        if (!sid) return Promise.resolve({ cancelled: 0 });
        return invokeControl(
            wire,
            'extensionUiCancel',
            sid,
            { reason },
            `dialog-cancel-${++dialogCallSeq}`,
            legacyResponses,
        );
    };
    const dialogController: PiDialogController = createPiDialogController({
        host: view.dialogHost,
        isActive: () => root.classList.contains('active'),
        fallbackFocus: () =>
            document.getElementById('input-textarea') as HTMLElement | null,
        respond: respondDialog,
        cancelAll: cancelDialogRecords,
        announce: (message) => view.announceDialog(message),
    });
    dialogController.setDialogs(dialogs);
    const reportQueueActionError = (error: unknown): void => {
        if (!destroyed) {
            status.textContent = `Queue action failed: ${String(
                error instanceof Error ? error.message : error,
            )}`;
        }
    };
    const syncQueueView = (): void => {
        view.setQueueState(queueItems, piAuthoritativeQueue, {
            copy: (item) => {
                void queueCopy(item.id)
                    .then((result) => {
                        if (result && typeof result === 'object') {
                            onQueueRecovery?.(result as PiQueueRecovery);
                        }
                        return result;
                    })
                    .catch(reportQueueActionError);
            },
            discard: (item) => {
                void queueDiscard(item.id).catch(reportQueueActionError);
            },
            restore: (item) => {
                void queueRestore(item.id)
                    .then((result) => {
                        if (
                            result &&
                            typeof result === 'object' &&
                            (result as { restored?: unknown }).restored === true
                        ) {
                            onQueueRecovery?.(result as PiQueueRecovery);
                        }
                        return result;
                    })
                    .catch(reportQueueActionError);
            },
        });
    };
    const applyQueueSnapshot = (value: unknown): void => {
        if (!validQueueSnapshot(value)) return;
        queueSessionEpoch = value.sessionEpoch;
        queueItems = cloneQueueItems(value.items);
        for (const outgoingItem of [...outgoing]) {
            if (outgoingItem.legacy) continue;
            const queueItem = queueItems.find(
                (candidate) => candidate.id === outgoingItem.id,
            );
            if (!queueItem) continue;
            if (
                queueItem.state === 'accepted' ||
                queueItem.state === 'promoted'
            ) {
                outgoingItem.state = 'sent';
                if (activePrompt?.id === outgoingItem.id)
                    activePrompt.state = 'sent';
            } else if (
                queueItem.state === 'cancelled' ||
                queueItem.state === 'consumed' ||
                queueItem.state === 'uncertain'
            ) {
                const outgoingIndex = outgoing.indexOf(outgoingItem);
                if (outgoingIndex >= 0) outgoing.splice(outgoingIndex, 1);
                removeTurnPrompt(outgoingItem);
                if (activePrompt?.id === outgoingItem.id) {
                    activePrompt = outgoing.at(-1)
                        ? { ...outgoing.at(-1)!, origin: 'optimistic' }
                        : null;
                }
            }
        }
        syncQueueView();
        syncActiveTurn();
    };
    // pi-subagents fleet strip: shared #subagent-strip below the input
    // bar. Only this pane may write it while it is the active tab, so
    // background panes' fleet events gate inside update(). The last
    // snapshot is kept for refreshFleet (tab re-activation repaint).
    let lastFleet: unknown;
    const subagentViewer = createSubagentViewer(root, client, cwd);
    const strip = createSubagentStrip(
        () => root.classList.contains('active'),
        (runId, label) => subagentViewer.open(runId, label),
    );
    // Milestone 4: provider-level retry indicator (pi's
    // auto_retry_start / auto_retry_end / summarization_retry_*).
    // Folded into the ActiveTurnState so the view's working row can
    // swap its label. Cleared by auto_retry_end (success or failure)
    // and by the applyState busy→false transition (gap-loss guard).
    let retryState: { attempt: number; maxAttempts: number } | null = null;
    const syncActiveTurn = (): void => {
        const base: ActiveTurnState | null = activePrompt
            ? {
                  active: true,
                  promptText: activePrompt.text,
                  promptOrigin: activePrompt.origin,
                  stateLabel:
                      activePrompt.state === 'sending'
                          ? 'Sending'
                          : 'Sent to Pi',
                  outgoing: outgoing.map((item) => ({
                      text: item.text,
                      stateLabel:
                          item.state === 'sending' ? 'Sending' : 'Sent to Pi',
                  })),
              }
            : null;
        // Retry alone (no activePrompt) keeps the working row visible
        // with the retry label. promptText is required by the type so
        // retry-only states pass '' — a UI-only value, never rendered
        // when active is false.
        if (!base && retryState) {
            view.setActiveTurn({
                active: false,
                promptText: '',
                promptOrigin: 'optimistic',
                stateLabel: 'Sending',
                retry: retryState,
            });
            return;
        }
        view.setActiveTurn(
            base
                ? { ...base, ...(retryState ? { retry: retryState } : {}) }
                : null,
        );
    };

    const removeTurnPrompt = (prompt: OutgoingPrompt): void => {
        const index = turnPrompts.indexOf(prompt);
        if (index >= 0) turnPrompts.splice(index, 1);
    };

    const cancelPendingSave = (): void => {
        if (pendingSaveTimer !== null) clearTimeout(pendingSaveTimer);
        pendingSaveTimer = null;
        pendingImmediateSave = false;
    };
    const persistIfCurrent = (currentSid: string): void => {
        if (!destroyed && sid === currentSid && !hydrateInFlight)
            savePersisted(currentSid, buffer.getMessages());
    };
    const schedulePersist = (delay: number): void => {
        cancelPendingSave();
        const currentSid = sid;
        if (!currentSid) return;
        pendingSaveTimer = setTimeout(() => {
            pendingSaveTimer = null;
            persistIfCurrent(currentSid);
        }, delay);
    };
    const scheduleImmediatePersist = (): void => {
        cancelPendingSave();
        const currentSid = sid;
        if (!currentSid) return;
        pendingImmediateSave = true;
        queueMicrotask(() => {
            if (!pendingImmediateSave) return;
            pendingImmediateSave = false;
            persistIfCurrent(currentSid);
        });
    };
    const flushPendingSave = (): void => {
        if (pendingSaveTimer === null && !pendingImmediateSave) return;
        cancelPendingSave();
        persistIfCurrent(sid);
    };

    const requestHydrate = (forReset = false): void => {
        if (destroyed || !sid) return;
        if (forReset && activeHydrate?.reset && activeHydrate.sid === sid)
            return;
        hydrateInFlight = true;
        cancelPendingSave();
        const currentSid = sid;
        const generation = ++hydrateGeneration;
        activeHydrate = { sid: currentSid, generation, reset: forReset };
        const hydrateNumber = legacyHydrateId++;
        const legacyId = hydrateNumber === 0 ? 'hyd' : `hyd-${hydrateNumber}`;
        void invokeControl(
            wire,
            'hydrate',
            currentSid,
            {},
            legacyId,
            legacyResponses,
        )
            .then((data: any) => {
                if (
                    destroyed ||
                    activeHydrate?.generation !== generation ||
                    currentSid !== sid
                )
                    return;
                const wasReset = activeHydrate.reset;
                activeHydrate = null;
                if (!isSnapshot(data)) {
                    hydrateInFlight = false;
                    status.textContent =
                        'Error: Pi RPC hydrate snapshot missing or malformed';
                    if (!wasReset) {
                        ready = false;
                        notifyControls();
                    }
                    return;
                }
                buffer.applySnapshot(data);
                applyState((data as Snapshot & { state?: unknown }).state);
                applyQueueSnapshot(
                    (data as Snapshot & { queue?: unknown }).queue,
                );
                dialogs = cloneDialogRecords(
                    (data as Snapshot & { dialogs?: unknown }).dialogs,
                );
                dialogController.setDialogs(dialogs);
                hydrateInFlight = false;
                ready =
                    connectionState === 'connected' ||
                    connectionState === 'connecting';
                status.textContent = 'Ready';
                view.setConnectionState(connectionState);
                notifyControls();
                paint();
                // A hydrate replaces the authoritative settled transcript.
                // Reset completion flushes in the next microtask; initial and
                // gap hydrates retain the existing 0 ms timer behavior.
                if (wasReset) scheduleImmediatePersist();
                else schedulePersist(0);
            })
            .catch((error: unknown) => {
                if (destroyed || activeHydrate?.generation !== generation)
                    return;
                const wasReset = activeHydrate.reset;
                activeHydrate = null;
                hydrateInFlight = false;
                const message = String(error);
                const normalized = message.toLowerCase();
                const unavailable =
                    normalized.includes('not found') ||
                    normalized.includes('unknown or destroyed') ||
                    normalized.includes('session unavailable');
                status.textContent =
                    connectionState === 'reconnecting'
                        ? 'Reconnecting…'
                        : unavailable
                          ? 'Session unavailable — draft preserved'
                          : `Error: ${message}`;
                if (!wasReset) {
                    ready = false;
                    if (unavailable) view.setConnectionState('unavailable');
                    notifyControls();
                }
            });
    };

    const sendLegacy = (text: string): boolean => {
        // OpPrompt predates the hydrate barrier and remains a compatibility
        // path for existing non-browser callers. Queue-backed sends below
        // still require `ready` and a hydrated session epoch.
        if (!sid || exited || subagentViewer.isOpen()) return false;
        const dispatch = dispatchComposer(text, { busy });
        if (dispatch.kind === 'rejected') {
            status.textContent = dispatch.reason;
            return false;
        }
        const currentSid = sid;
        const local: OutgoingPrompt = {
            id: `out-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            text: dispatch.message,
            state: 'sending',
            legacy: true,
        };
        outgoing.push(local);
        turnPrompts.push(local);
        activePrompt = { ...local, origin: 'optimistic' };
        syncActiveTurn();
        void invokeControl(
            wire,
            'prompt',
            currentSid,
            { message: dispatch.message, streamingBehavior: 'steer' },
            `p${Date.now()}-${Math.random().toString(16).slice(2)}`,
            legacyResponses,
        )
            .then((data: any) => {
                const index = outgoing.indexOf(local);
                if (data?.accepted !== true) {
                    if (index >= 0) outgoing.splice(index, 1);
                    removeTurnPrompt(local);
                    if (activePrompt?.id === local.id)
                        activePrompt = outgoing.at(-1)
                            ? { ...outgoing.at(-1)!, origin: 'optimistic' }
                            : null;
                    if (!destroyed && currentSid === sid)
                        status.textContent = 'Error: prompt was not accepted';
                } else {
                    local.state = 'sent';
                    if (activePrompt?.id === local.id)
                        activePrompt.state = 'sent';
                }
                syncActiveTurn();
            })
            .catch((error: unknown) => {
                const index = outgoing.indexOf(local);
                if (index >= 0) outgoing.splice(index, 1);
                removeTurnPrompt(local);
                if (activePrompt?.id === local.id)
                    activePrompt = outgoing.at(-1)
                        ? { ...outgoing.at(-1)!, origin: 'optimistic' }
                        : null;
                if (!destroyed && currentSid === sid)
                    status.textContent = `Error: ${String(error)}`;
                syncActiveTurn();
            });
        return true;
    };

    const send = (
        input: ChatPiSendInput | string,
    ): Promise<PiQueueSendResult> | boolean => {
        // OpPrompt remains a compatibility path for non-browser callers. The
        // shared composer always passes the structured object form below.
        if (typeof input === 'string') return sendLegacy(input);
        if (!sid || !ready || exited || subagentViewer.isOpen()) {
            return rejected('Pi RPC is not ready');
        }
        const dispatch = dispatchComposer(input.message, {
            busy,
            followUp: input.deliveryOverride === 'followUp',
        });
        if (dispatch.kind === 'rejected') {
            status.textContent = dispatch.reason;
            return rejected(dispatch.reason);
        }
        if (!queueSessionEpoch) {
            return rejected('Pi queue is not hydrated yet');
        }
        const delivery = input.deliveryOverride ?? dispatch.delivery;
        const attachments = Array.isArray(input.attachments)
            ? input.attachments
            : [];
        const currentSid = sid;
        const itemId =
            typeof crypto !== 'undefined' &&
            typeof crypto.randomUUID === 'function'
                ? crypto.randomUUID()
                : `queue-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const local: OutgoingPrompt = {
            id: itemId,
            text: dispatch.message,
            state: 'sending',
        };
        outgoing.push(local);
        turnPrompts.push(local);
        activePrompt = { ...local, origin: 'optimistic' };
        syncActiveTurn();
        return invokeControl(
            wire,
            'queueSubmit',
            currentSid,
            {
                itemId,
                sessionEpoch: queueSessionEpoch,
                message: dispatch.message,
                delivery,
                attachmentRefs: [...attachments],
            },
            `q${Date.now()}-${Math.random().toString(16).slice(2)}`,
            legacyResponses,
        )
            .then((data: unknown) => {
                const item = cloneQueueItems([data])[0];
                if (!item) throw new Error('queue response was malformed');
                queueItems = [
                    ...queueItems.filter(
                        (candidate) => candidate.id !== item.id,
                    ),
                    item,
                ];
                if (item.state === 'accepted' || item.state === 'promoted') {
                    local.state = 'sent';
                }
                syncQueueView();
                if (activePrompt?.id === local.id && local.state === 'sending')
                    activePrompt.state = 'sending';
                else if (activePrompt?.id === local.id)
                    activePrompt.state = 'sent';
                syncActiveTurn();
                return { item, uncertain: false };
            })
            .catch((error: unknown) => {
                const uncertain =
                    (error as { uncertain?: unknown })?.uncertain === true;
                const index = outgoing.indexOf(local);
                if (index >= 0) outgoing.splice(index, 1);
                removeTurnPrompt(local);
                if (activePrompt?.id === local.id)
                    activePrompt = outgoing.at(-1)
                        ? { ...outgoing.at(-1)!, origin: 'optimistic' }
                        : null;
                if (!destroyed && currentSid === sid) {
                    status.textContent = uncertain
                        ? 'Delivery uncertain — draft preserved'
                        : `Error: ${String(error)}`;
                }
                syncActiveTurn();
                throw error;
            });
    };

    const getModels = (): Promise<PiModel[]> => {
        if (!sid || !ready || exited) return rejected('Pi RPC is not ready');
        const currentSid = sid;
        return invokeControl(
            wire,
            'getAvailableModels',
            currentSid,
            {},
            'models',
            legacyResponses,
        ).then(validModels);
    };
    const getThinkingLevels = (): Promise<string[]> => {
        if (!sid || !ready || exited) return rejected('Pi RPC is not ready');
        const currentSid = sid;
        return invokeControl(
            wire,
            'getAvailableThinkingLevels',
            currentSid,
            {},
            'thinking',
            legacyResponses,
        ).then(validThinkingLevels);
    };
    const setModel = (provider: string, modelId: string): Promise<unknown> => {
        if (!sid || !ready || exited) return rejected('Pi RPC is not ready');
        const currentSid = sid;
        return invokeControl(
            wire,
            'setModel',
            currentSid,
            { provider, modelId },
            'set-model',
            legacyResponses,
        ).then((data: any) => {
            if (currentSid === sid) applyState(data?.state);
            return data;
        });
    };
    const setThinking = (level: string): Promise<unknown> => {
        if (!sid || !ready || exited) return rejected('Pi RPC is not ready');
        const currentSid = sid;
        return invokeControl(
            wire,
            'setThinking',
            currentSid,
            { level },
            'set-thinking',
            legacyResponses,
        ).then((data: any) => {
            if (currentSid === sid) applyState(data?.state);
            return data;
        });
    };
    const interrupt = (): Promise<unknown> => {
        if (!sid || !ready || exited || !sessionActive)
            return rejected('Pi RPC is not active');
        if (abortInFlight) return rejected('Pi interrupt is already pending');
        // Capture the in-flight prompt texts BEFORE the abort request:
        // applyState() clears activePrompt/outgoing on the busy=false state
        // change, which lands before the abort response resolves.
        const restored = turnPrompts
            .map((item) => item.text)
            .filter((text) => text !== '');
        abortInFlight = true;
        const currentSid = sid;
        return invokeControl(
            wire,
            'abort',
            currentSid,
            {},
            'abort',
            legacyResponses,
        )
            .then((data: any) => ({ ...(data ?? {}), restored }))
            .catch((error: unknown) => {
                if (!destroyed && currentSid === sid)
                    status.textContent = `Error: ${String(error)}`;
                throw error;
            })
            .finally(() => {
                abortInFlight = false;
            });
    };

    const resetChat = (): Promise<unknown> => {
        if (!sid || !ready || exited) return rejected('Pi RPC is not ready');
        if (busy || queueDepth > 0) return rejected('Pi RPC is busy');
        if (resetInFlight) return rejected('Pi RPC reset is already pending');
        resetInFlight = true;
        notifyControls();
        const currentSid = sid;
        return invokeControl(
            wire,
            'newSession',
            currentSid,
            {},
            'reset',
            legacyResponses,
        )
            .then((data: any) => {
                if (currentSid !== sid) return data;
                if (data?.cancelled === true) return data;
                if (data?.reset !== true)
                    throw new Error('Pi reset was not accepted');
                if (typeof data.stateWarning === 'string' && data.stateWarning)
                    status.textContent = `Warning: ${data.stateWarning}`;
                // The sequenced transcriptReset event is the only successful clear
                // trigger. Its handler starts the hydrate barrier below.
                return data;
            })
            .catch((error: unknown) => {
                if (!destroyed && currentSid === sid)
                    status.textContent = `Error: ${String(error)}`;
                throw error;
            })
            .finally(() => {
                resetInFlight = false;
                notifyControls();
            });
    };

    const setName = (name: string): Promise<unknown> => {
        const trimmed = name.trim();
        if (!trimmed) return rejected('name is required');
        if (!sid) return rejected('Pi RPC is not ready');
        return invokeControl(
            wire,
            'setSessionName',
            sid,
            { name: trimmed },
            'snm',
            legacyResponses,
        );
    };

    const queueOperation = (op: string, itemId: string): Promise<any> => {
        if (!sid || !queueSessionEpoch)
            return rejected('Pi queue is not hydrated yet');
        return invokeControl(
            wire,
            op,
            sid,
            { itemId, sessionEpoch: queueSessionEpoch },
            `${op}-${Date.now()}`,
            legacyResponses,
        ).then((data: any) => {
            if (data?.item) {
                const item = cloneQueueItems([data.item])[0];
                if (item) {
                    queueItems = [
                        ...queueItems.filter(
                            (candidate) => candidate.id !== item.id,
                        ),
                        item,
                    ];
                    syncQueueView();
                }
            }
            return data;
        });
    };

    const queueCopy = (itemId: string): Promise<unknown> =>
        queueOperation('queueCopy', itemId);
    const queueDiscard = (itemId: string): Promise<unknown> =>
        queueOperation('queueDiscard', itemId);
    const queueRestore = (itemId: string): Promise<unknown> =>
        queueOperation('queueRestore', itemId);
    const restoreLatestLocal = (): Promise<unknown> => {
        const latest = [...queueItems]
            .filter((item) => item.state === 'local')
            .sort(
                (left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0),
            )[0];
        return latest
            ? queueRestore(latest.id)
            : Promise.resolve({ restored: false, reason: 'missing' });
    };

    const off = client.onMessage((env: any) => {
        if (env?.t === 'res' && typeof env.id === 'string') {
            const response = legacyResponses.get(env.id);
            if (response) {
                legacyResponses.delete(env.id);
                if (env.ok) response.resolve(env.data);
                else
                    response.reject(
                        new Error(String(env.error ?? 'control call failed')),
                    );
                return;
            }
        }
        if (destroyed) return;
        if (env?.t !== 'evt' || env?.sid !== sid) return;

        const result = buffer.applyEvent({
            seq: env.seq,
            evt: env.evt,
            data: env.data,
        });
        if (!result.applied) {
            if (result.gap && sid) requestHydrate(false);
            return;
        }
        if (env.evt === 'stateChanged') {
            if (env.data?.error)
                status.textContent = `pi: ${String(env.data.error)}`;
            applyState(env.data);
        }
        if (env.evt === 'rpcExited') {
            exited = true;
            ready = false;
            status.textContent = 'Pi exited';
            lastFleet = undefined;
            onFleetChange(undefined);
            subagentViewer.destroy();
            strip.destroy();
            flushPendingSave();
            notifyControls();
        }
        if (env.evt === 'subagentFleet') {
            lastFleet = env.data;
            strip.update(env.data);
            onFleetChange(env.data);
        }
        if (env.evt === 'queueChanged') {
            applyQueueSnapshot(env.data);
        }
        if (env.evt === 'extensionUiRequest') {
            const next = cloneDialogRecords([env.data])[0];
            if (next && !dialogs.some((dialog) => dialog.id === next.id)) {
                dialogs = [...dialogs, next];
                dialogController.upsertDialog(next);
            }
        }
        if (env.evt === 'extensionUiClosed') {
            const data = env.data as { id?: unknown; reason?: unknown } | null;
            const id = typeof data?.id === 'string' ? data.id : '';
            if (id) {
                dialogs = dialogs.filter((dialog) => dialog.id !== id);
                const reason =
                    data?.reason === 'timeout' ||
                    data?.reason === 'childExit' ||
                    data?.reason === 'tabClosed' ||
                    data?.reason === 'unsupported'
                        ? data.reason
                        : 'server';
                dialogController.closeDialog(id, reason);
            }
        }
        if (
            env.evt === 'queueUpdate' &&
            env.data &&
            typeof env.data === 'object'
        ) {
            const queue = env.data as {
                steering?: unknown;
                followUp?: unknown;
            };
            piAuthoritativeQueue = {
                steering: Array.isArray(queue.steering)
                    ? queue.steering.filter(
                          (value): value is string => typeof value === 'string',
                      )
                    : [],
                followUp: Array.isArray(queue.followUp)
                    ? queue.followUp.filter(
                          (value): value is string => typeof value === 'string',
                      )
                    : [],
            };
            syncQueueView();
        }
        // Milestone 4: provider-level retry indicator.
        // auto_retry_start/summarization_retry_scheduled stash
        // {attempt, maxAttempts} into retryState; the matching end/finished
        // events clear it. Numbers are coerced (invalid → ignore) so a
        // malformed event cannot strand the working row.
        if (
            env.evt === 'autoRetryStart' ||
            env.evt === 'summarizationRetryScheduled'
        ) {
            const data = env.data as
                | {
                      attempt?: unknown;
                      maxAttempts?: unknown;
                      errorMessage?: unknown;
                  }
                | null
                | undefined;
            const attempt =
                data &&
                typeof data.attempt === 'number' &&
                Number.isFinite(data.attempt)
                    ? data.attempt
                    : null;
            const maxAttempts =
                data &&
                typeof data.maxAttempts === 'number' &&
                Number.isFinite(data.maxAttempts)
                    ? data.maxAttempts
                    : null;
            if (attempt !== null && maxAttempts !== null) {
                retryState = { attempt, maxAttempts };
                syncActiveTurn();
            }
            if (env.evt === 'summarizationRetryScheduled') {
                // rpc.md: summarization_retry_scheduled carries
                // {attempt, maxAttempts, delayMs, errorMessage}. Pi's TUI
                // renders showError(event.errorMessage) at
                // interactive-mode.js:2770. The provider errorMessage
                // is the actionable text; fall back to the generic
                // label only when no message is present.
                const errMsg =
                    typeof data?.errorMessage === 'string' && data.errorMessage
                        ? data.errorMessage
                        : 'summarization retry scheduled';
                status.textContent = `pi: ${errMsg}`;
            }
        }
        if (
            env.evt === 'autoRetryEnd' ||
            env.evt === 'summarizationRetryFinished'
        ) {
            const wasRetrying = retryState !== null;
            retryState = null;
            syncActiveTurn();
            if (env.evt === 'autoRetryEnd' && wasRetrying) {
                const data = env.data as
                    | { success?: unknown; finalError?: unknown }
                    | null
                    | undefined;
                if (data?.success === false) {
                    status.textContent = `Retry failed after ${String(
                        (data as { attempt?: unknown }).attempt ?? '?',
                    )} attempt${
                        ((data as { attempt?: unknown }).attempt ?? 0) === 1
                            ? ''
                            : 's'
                    }: ${String(data.finalError ?? 'Unknown error')}`;
                }
            }
        }
        if (env.evt === 'extensionError') {
            const data = env.data as { error?: unknown } | null | undefined;
            status.textContent = `pi extension error: ${String(
                data?.error ?? 'unknown',
            )}`;
        }
        if (env.evt === 'compactionEnd') {
            const data = env.data as
                | {
                      aborted?: unknown;
                      reason?: unknown;
                      errorMessage?: unknown;
                  }
                | null
                | undefined;
            const aborted = data?.aborted === true;
            const reason = typeof data?.reason === 'string' ? data.reason : '';
            const errorMessage =
                typeof data?.errorMessage === 'string' && data.errorMessage
                    ? data.errorMessage
                    : null;
            // Plan contract (rpc.md reference): compaction_end is
            // emitted "whether manual or automatic" and on success
            // carries `result` with NO errorMessage. The ephemeral
            // red row must be cleared on every compactionEnd that
            // carries no errorMessage (handler:
            // setEphemeralError(nonManual && errorMessage ? text : null)
            // unconditionally). This clears stale rows from any
            // previous failed auto-compaction, including aborted
            // compactionEnds that arrive with neither errorMessage
            // nor non-manual reason.
            const nonManual = reason !== 'manual';
            view.setEphemeralError(
                nonManual && errorMessage ? errorMessage : null,
            );
            if (aborted) {
                status.textContent =
                    reason === 'manual'
                        ? 'Compaction cancelled'
                        : 'Auto-compaction cancelled';
            } else if (reason === 'manual' && errorMessage) {
                // Plan row: compaction_end errorMessage + reason manual
                // → status bar error. Gated on a non-empty errorMessage
                // so successful manual /compact (no errorMessage per
                // rpc.md) does not render a spurious "pi: compaction
                // error" line.
                status.textContent = `pi: ${errorMessage}`;
            }
        }
        if (env.evt === 'messageEnd' && env.data?.message?.role === 'user') {
            const text = renderedUserText(env.data.message.content);
            const match = outgoing.find(
                (item) => item.legacy && renderedUserText(item.text) === text,
            );
            if (match) {
                outgoing.splice(outgoing.indexOf(match), 1);
                if (activePrompt?.id === match.id) {
                    activePrompt = {
                        ...match,
                        origin: result.messages.length - 1,
                    };
                }
            }
        }
        if (env.evt === 'transcriptReset') {
            requestHydrate(true);
        } else {
            // Hot-path branching on the render disposition avoids full
            // structured repaints during streaming `text_delta` events and
            // avoids the expensive full-history serialize-and-write on
            // every partial. The microtask-coalesced paint() stays for
            // authoritative `full` events; the live partial path uses a
            // narrow DOM mutation.
            if (result.liveToolCleared) {
                view.setLiveToolOutput(result.liveToolCleared, '');
            }
            switch (result.renderDisposition) {
                case 'full':
                    paint();
                    if (!hydrateInFlight) schedulePersist(250);
                    break;
                case 'partial':
                    if (result.partialKind === 'thinking') {
                        view.setStructuredThinking(buffer.getPartialThinking());
                    } else {
                        view.setStructuredPartial(buffer.getPartial());
                    }
                    break;
                case 'partial-clear':
                    view.setStructuredPartial('');
                    view.setStructuredThinking('');
                    break;
                case 'live-tool':
                    if (result.toolCallId && result.output !== undefined) {
                        view.setLiveToolOutput(
                            result.toolCallId,
                            result.output,
                        );
                    }
                    break;
                case 'none':
                    // stateChanged, queue events, stale events, irrelevant
                    // delta kinds — nothing to paint, nothing to persist.
                    break;
            }
        }
    });

    const spawnArgs: { cwd: string; sessionPath?: string; spawnId: string } = {
        cwd,
        spawnId,
    };
    if (sessionPath) spawnArgs.sessionPath = sessionPath;
    const startSpawn = (): void => {
        if (destroyed || sid || spawnInFlight) return;
        spawnInFlight = true;
        void invokeControl(
            wire,
            'spawn',
            undefined,
            spawnArgs,
            'sp',
            legacyResponses,
        )
            .then((data: any) => {
                spawnInFlight = false;
                if (destroyed) return;
                const nextSid = typeof data?.sid === 'string' ? data.sid : '';
                if (!nextSid || !isSnapshot(data?.snapshot)) {
                    throw new Error(
                        'Pi RPC bootstrap snapshot missing or malformed',
                    );
                }
                sid = nextSid;
                view.title.textContent =
                    typeof data.title === 'string' ? data.title : 'Pi RPC';
                buffer.applySnapshot(data.snapshot);
                applyState(data.state);
                applyQueueSnapshot(data.queue);
                ready = false;
                exited = false;
                hydrateInFlight = false;
                status.textContent = 'Hydrating…';
                notifyControls();
                paint();
                requestHydrate(false);
            })
            .catch((error: unknown) => {
                spawnInFlight = false;
                if (destroyed) return;
                ready = false;
                if (connectionState === 'reconnecting') {
                    status.textContent = 'Reconnecting…';
                } else {
                    failBootstrap(error);
                }
                notifyControls();
            });
    };
    const offConnectionState =
        typeof (client as ControlClient & { onConnectionState?: unknown })
            .onConnectionState === 'function'
            ? (client as ControlClient).onConnectionState((next) => {
                  connectionState = next;
                  view.setConnectionState(next);
                  if (next === 'reconnecting') {
                      ready = false;
                      status.textContent = 'Reconnecting…';
                  } else if (next === 'unavailable') {
                      ready = false;
                      status.textContent =
                          'Session unavailable — draft preserved';
                  } else if (next === 'connected') {
                      if (sid) {
                          status.textContent = 'Hydrating…';
                          requestHydrate(false);
                      } else startSpawn();
                  }
                  notifyControls();
              })
            : () => {};
    startSpawn();

    return {
        destroy: (): void => {
            if (destroyed) return;
            flushPendingSave();
            destroyed = true;
            off();
            offConnectionState();
            dialogController.destroy();
            client.close();
            subagentViewer.destroy();
            strip.destroy();
            root.replaceChildren();
            onStatusChange(null);
            onControlChange(null);
        },
        send: send as ChatPiHandle['send'],
        getModels,
        getThinkingLevels,
        setModel,
        setThinking,
        resetChat,
        interrupt,
        setName,
        queueCopy,
        queueDiscard,
        queueRestore,
        restoreLatestLocal,
        closeExtensionDialog: (): boolean => dialogController.closeActive(),
        focusExtensionDialog: (): void => dialogController.focusActive(),
        cancelDialogs: (reason): Promise<unknown> =>
            dialogController.cancelAll(reason),
        refreshFleet: (): void => {
            // Tab re-activation: repaint this pane's last fleet snapshot
            // (or hide the shared strip when this pane has none).
            if (lastFleet === undefined) strip.hide();
            else strip.update(lastFleet);
        },
        closeSubagentViewer: (): boolean => {
            if (!subagentViewer.isOpen()) return false;
            subagentViewer.close();
            return true;
        },
    };
}
