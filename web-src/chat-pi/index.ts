import { dispatchComposer } from './composer.js';
import type { ControlClient } from './client.js';
import { MessageBuffer } from './message-buffer.js';
import type { Snapshot } from './message-buffer.js';
import { savePersisted } from './persist.js';
import { renderedUserText } from './render.js';
import type { PiRpcStatus } from './render.js';
import { createReviewTranscriptView } from '../review-transcript.js';
import type { ActiveTurnState } from '../review-transcript.js';

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
}

export interface ChatPiHandle {
    destroy(): void;
    send(text: string): boolean;
    getModels(): Promise<PiModel[]>;
    getThinkingLevels(): Promise<string[]>;
    setModel(provider: string, modelId: string): Promise<unknown>;
    setThinking(level: string): Promise<unknown>;
    resetChat(): Promise<unknown>;
    interrupt(): Promise<unknown>;
    setName(name: string): Promise<unknown>;
}

export type PiRpcStatusChange = (status: PiRpcStatus | null) => void;
export type PiRpcControlChange = (controls: PiRpcControls | null) => void;

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
): ChatPiHandle {
    const wire = client as LegacyClient;
    const buffer = new MessageBuffer();
    const localStatus: PiRpcStatus = { cwd };
    let sid = '';
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
    };
    let outgoingSeq = 0;
    const outgoing: OutgoingPrompt[] = [];
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
        });
    const applyState = (state: unknown): void => {
        const source = state as Record<string, unknown> | null;
        const statusChanged = mergeState(localStatus, state);
        let controlsChanged = statusChanged;
        if (source && typeof source === 'object') {
            if (typeof source.busy === 'boolean' && source.busy !== busy) {
                busy = source.busy;
                sessionActive = busy;
                controlsChanged = true;
                if (!busy) {
                    outgoing.length = 0;
                    activePrompt = null;
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
                hydrateInFlight = false;
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
                status.textContent = `Error: ${String(error)}`;
                if (!wasReset) {
                    ready = false;
                    notifyControls();
                }
            });
    };

    const send = (text: string): boolean => {
        if (!sid || !ready || exited) return false;
        const dispatch = dispatchComposer(text, busy);
        if (dispatch.kind === 'rejected') {
            status.textContent = dispatch.reason;
            return false;
        }
        const currentSid = sid;
        const local: OutgoingPrompt = {
            id: `out-${++outgoingSeq}`,
            text: dispatch.message,
            state: 'sending' as const,
        };
        outgoing.push(local);
        activePrompt = { ...local, origin: 'optimistic' };
        syncActiveTurn();
        void invokeControl(
            wire,
            'prompt',
            currentSid,
            {
                message: dispatch.message,
                ...(dispatch.streamingBehavior
                    ? { streamingBehavior: dispatch.streamingBehavior }
                    : {}),
            },
            `p${Date.now()}-${Math.random().toString(16).slice(2)}`,
            legacyResponses,
        )
            .then((data: any) => {
                const index = outgoing.indexOf(local);
                if (data?.accepted !== true) {
                    if (index >= 0) outgoing.splice(index, 1);
                    if (activePrompt?.id === local.id)
                        activePrompt = outgoing.at(-1)
                            ? { ...outgoing.at(-1)!, origin: 'optimistic' }
                            : null;
                    if (!destroyed && currentSid === sid)
                        status.textContent = 'Error: prompt was not accepted';
                } else if (index >= 0) {
                    local.state = 'sent';
                    if (activePrompt?.id === local.id)
                        activePrompt.state = 'sent';
                } else if (activePrompt?.id === local.id) {
                    // Pi may reconcile the outgoing record before the
                    // prompt response arrives. Keep the retained marker's
                    // state in sync with the accepted response.
                    activePrompt.state = 'sent';
                }
                syncActiveTurn();
            })
            .catch((error: unknown) => {
                const index = outgoing.indexOf(local);
                if (index >= 0) outgoing.splice(index, 1);
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
            flushPendingSave();
            notifyControls();
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
                (item) => renderedUserText(item.text) === text,
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
            switch (result.renderDisposition) {
                case 'full':
                    paint();
                    if (!hydrateInFlight) schedulePersist(250);
                    break;
                case 'partial':
                    view.setStructuredPartial(buffer.getPartial());
                    break;
                case 'partial-clear':
                    view.setStructuredPartial('');
                    break;
                case 'none':
                    // stateChanged, queue events, stale events, irrelevant
                    // delta kinds — nothing to paint, nothing to persist.
                    break;
            }
        }
    });

    const spawnArgs: { cwd: string; sessionPath?: string } = { cwd };
    if (sessionPath) spawnArgs.sessionPath = sessionPath;
    void invokeControl(
        wire,
        'spawn',
        undefined,
        spawnArgs,
        'sp',
        legacyResponses,
    )
        .then((data: any) => {
            if (destroyed) return;
            const nextSid = typeof data?.sid === 'string' ? data.sid : '';
            if (!nextSid || !isSnapshot(data?.snapshot)) {
                failBootstrap('Pi RPC bootstrap snapshot missing or malformed');
                return;
            }
            sid = nextSid;
            view.title.textContent =
                typeof data.title === 'string' ? data.title : 'Pi RPC';
            buffer.applySnapshot(data.snapshot);
            applyState(data.state);
            ready = true;
            exited = false;
            status.textContent = 'Ready';
            notifyControls();
            paint();
            requestHydrate(false);
        })
        .catch((error: unknown) => {
            if (!destroyed) failBootstrap(error);
        });

    return {
        destroy: (): void => {
            if (destroyed) return;
            flushPendingSave();
            destroyed = true;
            off();
            client.close();
            root.replaceChildren();
            onStatusChange(null);
            onControlChange(null);
        },
        send,
        getModels,
        getThinkingLevels,
        setModel,
        setThinking,
        resetChat,
        interrupt,
        setName,
    };
}
