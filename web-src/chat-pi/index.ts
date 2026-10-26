import { dispatchComposer } from './composer.js';
import type { ControlClient } from './client.js';
import { CompactCallTimeout } from './client.js';
import { MessageBuffer } from './message-buffer.js';
import type { Snapshot } from './message-buffer.js';
import { savePersisted } from './persist.js';
import { renderedUserText } from './render.js';
import type { PiRpcStatus } from './render.js';
import { createReviewTranscriptView } from '../review-transcript.js';
import type { ActiveTurnState } from '../review-transcript.js';
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
}

export interface ChatPiHandle {
    destroy(): void;
    /** Reports a refused control stream without discarding the transcript. */
    streamFailed(message: string): void;
    send(text: string): boolean;
    getModels(): Promise<PiModel[]>;
    getThinkingLevels(): Promise<string[]>;
    setModel(provider: string, modelId: string): Promise<unknown>;
    setThinking(level: string): Promise<unknown>;
    compact(): Promise<unknown>;
    resetChat(): Promise<unknown>;
    interrupt(): Promise<unknown>;
    setName(name: string): Promise<unknown>;
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

const stateMetricFields = [
    'inputTokens',
    'outputTokens',
    'contextUsedTokens',
    'contextWindowTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
] as const;

const stateOptionalFields = ['model', 'thinking', 'sessionPath'] as const;

/**
 * Canonical full State: the shape the backend publishes for a commit event or
 * a hydrate pair, scoped to one instance SID. Only this shape can clear an
 * omitted optional field; partial or legacy payloads merge without clearing.
 */
function isCanonicalState(
    state: unknown,
    sid: string,
): state is Record<string, unknown> {
    if (!state || typeof state !== 'object' || sid === '') return false;
    const source = state as Record<string, unknown>;
    if (source.sid !== sid) return false;
    for (const field of ['title', 'cwd'] as const) {
        if (typeof source[field] !== 'string') return false;
    }
    if (source.status !== 'live' && source.status !== 'exited') return false;
    if (typeof source.busy !== 'boolean') return false;
    const depth = source.queueDepth;
    if (typeof depth !== 'number' || !Number.isFinite(depth) || depth < 0)
        return false;
    for (const field of stateMetricFields) {
        if (!Object.hasOwn(source, field)) return false;
        const value = source[field];
        if (
            value !== null &&
            !(typeof value === 'number' && Number.isFinite(value))
        )
            return false;
    }
    if (!Object.hasOwn(source, 'skills')) return false;
    const skills = source.skills;
    if (
        skills !== null &&
        !(
            Array.isArray(skills) &&
            skills.every((item) => typeof item === 'string')
        )
    )
        return false;
    for (const field of stateOptionalFields) {
        if (Object.hasOwn(source, field) && typeof source[field] !== 'string')
            return false;
    }
    return true;
}

function mergeState(
    status: PiRpcStatus,
    state: unknown,
    canonical = false,
): boolean {
    if (!state || typeof state !== 'object') return false;
    const source = state as Record<string, unknown>;
    let changed = false;
    // Canonical absence, or an empty optional string, means the backend no
    // longer retains that value. The resume path is the only optional field
    // a reset must clear, and a stale render must not re-promote it.
    if (canonical) {
        for (const field of stateOptionalFields) {
            if (!status[field]) continue;
            const value = source[field];
            if (typeof value === 'string' && value) continue;
            delete status[field];
            changed = true;
        }
    }
    if (typeof source.title === 'string' && source.title.trim()) {
        status.title = source.title;
        changed = true;
    }
    const strings = ['cwd', 'model', 'thinking'] as const;
    // model and thinking are `omitempty` on the Go side, so a canonical
    // snapshot never carries them as empty strings and cannot re-add a value
    // the clear above removed.
    for (const field of strings) {
        if (Object.hasOwn(source, field) && typeof source[field] === 'string') {
            status[field] = source[field] as never;
            changed = true;
        }
    }
    // The backend publishes sessionPath only after the session file
    // exists, and never clears it through state; an empty value must
    // not wipe a previously promoted path. Same set-and-mark shape as
    // every other merged field.
    if (typeof source.sessionPath === 'string' && source.sessionPath) {
        status.sessionPath = source.sessionPath;
        changed = true;
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
        Number.isSafeInteger(snapshot.lastSeq) &&
        snapshot.lastSeq >= 0 &&
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

function invokeControl(
    client: ControlClient,
    op: string,
    sid: string | undefined,
    args: unknown,
    timeoutMs?: number,
): Promise<any> {
    return client.call(op, sid, args, timeoutMs ? { timeoutMs } : undefined);
}

export function mountChatPi(
    root: HTMLElement,
    cwd: string,
    client: ControlClient,
    sessionPath?: string,
    onStatusChange: PiRpcStatusChange = () => {},
    onControlChange: PiRpcControlChange = () => {},
    onFleetChange: PiFleetChange = () => {},
): ChatPiHandle {
    const wire = client;
    const buffer = new MessageBuffer();
    const localStatus: PiRpcStatus = { cwd };
    let sid = '';
    let destroyed = false;
    let ready = false;
    let busy = false;
    let queueDepth = 0;
    let exited = false;
    // Bootstrap ended without a session. No sid will ever arrive, so input
    // must stay in the composer instead of queueing into a dead pane.
    let bootstrapFailed = false;
    // The control stream failed a protocol check. Redialing cannot fix it, so
    // the pane stays read-only instead of accepting prompts it can never send.
    let streamBroken = false;
    let resetInFlight = false;
    let compactInFlight = false;
    let compactSnapshot: {
        messages: unknown[];
        ids: Set<string>;
        at: number;
        summary?: string | null;
        kept?: number | null;
    } | null = null;
    let _lastCompaction: {
        summary: string | null;
        id: string | null;
        timestamp: number;
        kept: number | null;
    } | null = null;
    let sessionActive = false;
    type PromptState = 'queued' | 'sending' | 'sent' | 'unconfirmed';
    type OutgoingPrompt = {
        id: string;
        text: string;
        state: PromptState;
    };
    let outgoingSeq = 0;
    const outgoing: OutgoingPrompt[] = [];
    // Outgoing records disappear when their user message is rendered; retain
    // the full current-turn order separately for interrupt restoration.
    const turnPrompts: OutgoingPrompt[] = [];
    let activePrompt: {
        id: string;
        text: string;
        state: PromptState;
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
        const canonical = isCanonicalState(state, sid);
        const statusChanged = mergeState(localStatus, state, canonical);
        if (
            statusChanged &&
            typeof localStatus.title === 'string' &&
            localStatus.title &&
            view.title.textContent !== localStatus.title
        ) {
            view.title.textContent = localStatus.title;
        }
        let controlsChanged = statusChanged;
        if (source && typeof source === 'object') {
            if (typeof source.busy === 'boolean' && source.busy !== busy) {
                busy = source.busy;
                sessionActive = busy;
                controlsChanged = true;
                if (!busy) {
                    // A turn boundary retires in-flight and accepted records.
                    // Queued and unconfirmed ones are input Pi may never have
                    // seen: they stay until the transcript reconciles them.
                    const kept = outgoing.filter(
                        (item) =>
                            item.state === 'queued' ||
                            item.state === 'unconfirmed',
                    );
                    outgoing.splice(0, outgoing.length, ...kept);
                    turnPrompts.splice(0, turnPrompts.length, ...kept);
                    activePrompt = kept.at(-1)
                        ? { ...kept.at(-1)!, origin: 'optimistic' }
                        : null;
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
        if (canonical && source?.status === 'exited') enterExited();
        if (statusChanged) notifyStatus();
        if (controlsChanged) notifyControls();
    };
    const failBootstrap = (message: unknown): void => {
        sid = '';
        ready = false;
        exited = false;
        bootstrapFailed = true;
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
        // A queued paint must not republish status or controls after teardown.
        if (destroyed) return;
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
    // One terminal transition shared by the rpcExited event and a canonical
    // exited snapshot, which can arrive at a cursor that makes the event stale.
    // Idempotent, so a duplicate or late signal cannot repeat teardown.
    const enterExited = (): void => {
        if (exited) return;
        exited = true;
        ready = false;
        // A hydrate or control response still in flight must not restore
        // readiness after the pane is terminal.
        activeHydrate = null;
        hydrateInFlight = false;
        status.textContent = 'Pi exited';
        lastFleet = undefined;
        onFleetChange(undefined);
        subagentViewer.destroy();
        strip.destroy();
        flushPendingSave();
        notifyControls();
    };
    const _origPrepend = view.prependOlder.bind(view);
    let _compactFileTried = false;
    (view as unknown as Record<string, unknown>).prependOlder = (
        count: number,
    ) => {
        const ok = (_origPrepend as (c: number) => boolean)(count);
        if (ok) return true;
        if (_compactFileTried) return false;
        const hasSnapshot =
            (
                view as unknown as { hasCompactSnapshot?: () => boolean }
            ).hasCompactSnapshot?.() ?? false;
        const total =
            (
                view as unknown as { getStructuredMessages?: () => unknown[] }
            ).getStructuredMessages?.().length ?? 0;
        if (!hasSnapshot && total < 30) {
            _compactFileTried = true;
            const sp = sessionPath ?? null;
            (
                view as unknown as {
                    loadCompactSnapshotFromFile?: (
                        o: unknown,
                    ) => Promise<boolean>;
                }
            )
                .loadCompactSnapshotFromFile?.({ sessionPath: sp, cwd })
                .then((loaded) => {
                    if (loaded)
                        (
                            view as unknown as {
                                prependOlder: (c: number) => boolean;
                            }
                        ).prependOlder(count);
                    else _compactFileTried = false;
                })
                .catch(() => {
                    _compactFileTried = false;
                });
        }
        return false;
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
    const promptLabel = (state: PromptState): string =>
        state === 'queued'
            ? 'Queued'
            : state === 'unconfirmed'
              ? 'Not confirmed'
              : state === 'sending'
                ? 'Sending'
                : 'Sent to Pi';
    // A row claims the working state only when Pi is actually working on it: a
    // prompt still queued here, or an unconfirmed one the idle session never
    // took, must not show "Pi is working" or the interrupt hint.
    const promptIsWorking = (state: PromptState): boolean =>
        state === 'sending' || (state !== 'queued' && sessionActive);
    const syncActiveTurn = (): void => {
        const base: ActiveTurnState | null = activePrompt
            ? {
                  active: promptIsWorking(activePrompt.state),
                  promptText: activePrompt.text,
                  promptOrigin: activePrompt.origin,
                  stateLabel: promptLabel(activePrompt.state),
                  outgoing: outgoing.map((item) => ({
                      text: item.text,
                      stateLabel: promptLabel(item.state),
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
        void invokeControl(wire, 'hydrate', currentSid, {})
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
                // An equal cursor is valid reset/gap recovery. An older one
                // cannot replace transcript or metadata that a newer event
                // has already advanced past.
                const older = data.lastSeq < buffer.getLastSeq();
                hydrateInFlight = false;
                if (older) {
                    if (!wasReset) notifyControls();
                    return;
                }
                buffer.applySnapshot(data);
                applyState((data as Snapshot & { state?: unknown }).state);
                reconcileOutgoing();
                // A hydrate that lands proves the stream is alive again, so a
                // stale error line from the drop must not stay in the header.
                if (ready && !exited) status.textContent = 'Ready';
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

    // Hydrate is authoritative: a record that was written and is already a
    // user message in the snapshot landed, so its local row must go. Matching
    // runs from the newest message backwards, so a repeated text reconciles
    // the prompt just sent instead of an identical one from history, and each
    // index is claimed once. Only a queued record is exempt: it never left
    // the browser, so no snapshot can contain it.
    const reconcileOutgoing = (): void => {
        if (outgoing.length === 0) return;
        const messages = buffer.getMessages();
        const claimed = new Set<number>();
        const kept: OutgoingPrompt[] = [];
        let changed = false;
        for (const item of outgoing) {
            if (item.state === 'queued') {
                kept.push(item);
                continue;
            }
            const text = renderedUserText(item.text);
            let index = -1;
            for (let position = messages.length - 1; position >= 0; position--) {
                const message: any = messages[position];
                if (
                    !claimed.has(position) &&
                    message?.role === 'user' &&
                    renderedUserText(message.content) === text
                ) {
                    index = position;
                    break;
                }
            }
            if (index < 0) {
                kept.push(item);
                continue;
            }
            claimed.add(index);
            changed = true;
            // Keep the turn marker on the transcript row it now belongs to.
            if (activePrompt?.id === item.id)
                activePrompt = { ...item, state: 'sent', origin: index };
        }
        if (!changed) return;
        outgoing.splice(0, outgoing.length, ...kept);
        // turnPrompts keeps its own copy for interrupt restoration: a prompt
        // that left this list may still be the text the user wants back.
        syncActiveTurn();
    };

    // Delivers one outgoing record. A prompt that never reached a socket stays
    // queued and replays on reconnect; one written before a drop may still
    // have landed, so it stays on screen as unconfirmed and is never resent
    // silently.
    const deliverPrompt = (local: OutgoingPrompt): void => {
        const currentSid = sid;
        if (destroyed || exited || streamBroken || !currentSid || !ready) {
            local.state = 'queued';
            return;
        }
        const dispatch = dispatchComposer(local.text);
        if (dispatch.kind === 'rejected') {
            local.state = 'unconfirmed';
            status.textContent = dispatch.reason;
            syncActiveTurn();
            return;
        }
        local.state = 'sending';
        syncActiveTurn();
        // A row retired at the turn boundary may still be unacknowledged. If
        // Pi did not clearly take it, put it back so the text is never lost.
        const retain = (state: PromptState): void => {
            local.state = state;
            if (!outgoing.includes(local) && state !== 'sent') {
                outgoing.push(local);
                turnPrompts.push(local);
            }
            if (activePrompt?.id === local.id) {
                activePrompt = { ...activePrompt, state };
            } else if (!activePrompt && outgoing.includes(local)) {
                // The turn boundary retired this record before the failure
                // landed, so nothing would render the text we just retained.
                activePrompt = { ...local, origin: 'optimistic' };
            }
        };
        void invokeControl(wire, 'prompt', currentSid, {
            message: dispatch.message,
            ...(dispatch.streamingBehavior
                ? { streamingBehavior: dispatch.streamingBehavior }
                : {}),
        })
            .then((data: any) => {
                if (destroyed) return;
                if (data?.accepted === true) {
                    retain('sent');
                } else {
                    retain('unconfirmed');
                    if (currentSid === sid)
                        status.textContent = 'Error: prompt was not accepted';
                }
                syncActiveTurn();
                flushQueue();
            })
            .catch((error: unknown) => {
                if (destroyed) return;
                // Keep the text visible in both cases. A transport drop may
                // have delivered it; hydrate reconciles the transcript.
                retain('unconfirmed');
                if (currentSid === sid)
                    status.textContent = `Not confirmed: ${String(error)}`;
                syncActiveTurn();
                flushQueue();
            });
    };

    const flushQueue = (): void => {
        if (destroyed || exited || streamBroken || !sid || !ready) return;
        // One at a time: the server runs each call in its own goroutine, so a
        // batch would not keep the user's order.
        if (outgoing.some((item) => item.state === 'sending')) return;
        const next = outgoing.find((item) => item.state === 'queued');
        if (next) deliverPrompt(next);
    };

    const send = (text: string): boolean => {
        // No sid will ever arrive for a failed bootstrap, and a stream that
        // failed a protocol check cannot send at all: keep the draft in the
        // composer instead of queueing it into a dead pane.
        if (
            exited ||
            bootstrapFailed ||
            streamBroken ||
            subagentViewer.isOpen()
        )
            return false;
        const dispatch = dispatchComposer(text);
        if (dispatch.kind === 'rejected') {
            status.textContent = dispatch.reason;
            return false;
        }
        const local: OutgoingPrompt = {
            id: `out-${++outgoingSeq}`,
            text: dispatch.message,
            state: 'queued',
        };
        outgoing.push(local);
        turnPrompts.push(local);
        activePrompt = { ...local, origin: 'optimistic' };
        syncActiveTurn();
        // Every prompt goes through one ordered queue, so two quick sends
        // reach Pi in the order they were typed.
        flushQueue();
        return true;
    };

    const getModels = (): Promise<PiModel[]> => {
        if (!sid || !ready || exited) return rejected('Pi RPC is not ready');
        const currentSid = sid;
        return invokeControl(wire, 'getAvailableModels', currentSid, {}).then(
            validModels,
        );
    };
    const getThinkingLevels = (): Promise<string[]> => {
        if (!sid || !ready || exited) return rejected('Pi RPC is not ready');
        const currentSid = sid;
        return invokeControl(
            wire,
            'getAvailableThinkingLevels',
            currentSid,
            {},
        ).then(validThinkingLevels);
    };
    const setModel = (provider: string, modelId: string): Promise<unknown> => {
        if (!sid || !ready || exited) return rejected('Pi RPC is not ready');
        const currentSid = sid;
        // Live metadata comes from sequenced stateChanged events. The
        // operation response carries no version, so it must not overwrite
        // state an event has already advanced past.
        return invokeControl(wire, 'setModel', currentSid, {
            provider,
            modelId,
        });
    };
    const setThinking = (level: string): Promise<unknown> => {
        if (!sid || !ready || exited) return rejected('Pi RPC is not ready');
        const currentSid = sid;
        return invokeControl(wire, 'setThinking', currentSid, { level });
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
        return invokeControl(wire, 'abort', currentSid, {})
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

    const compact = (): Promise<unknown> => {
        if (!sid || !ready || exited) return rejected('Pi RPC is not ready');
        if (busy || queueDepth > 0) return rejected('Pi RPC is busy');
        if (compactInFlight)
            return rejected('Pi compaction is already pending');
        try {
            const snapMessages =
                (
                    view as unknown as {
                        getStructuredMessages?: () => unknown[];
                    }
                ).getStructuredMessages?.() ??
                (
                    buffer as unknown as { getMessages?: () => unknown[] }
                ).getMessages?.() ??
                [];
            const snapForView = (() => {
                if (!compactSnapshot) return snapMessages as unknown[];
                const existingIds = compactSnapshot.ids;
                return (snapMessages as Array<{ id?: string }>).filter(
                    (m) => !m?.id || !existingIds.has(m.id),
                );
            })();
            compactSnapshot = {
                messages: JSON.parse(JSON.stringify(snapMessages)),
                at: Date.now(),
                ids: new Set(
                    (snapMessages as Array<{ id?: string }>)
                        .map((m) => m.id)
                        .filter(Boolean) as string[],
                ),
            };
            const v2 = view as unknown as {
                setCompactSnapshot?: (s: unknown) => void;
            };
            if (v2.setCompactSnapshot) {
                const from = (snapForView as unknown[]).length;
                v2.setCompactSnapshot({
                    messages: JSON.parse(JSON.stringify(snapForView)),
                    ids: new Set(
                        (snapForView as Array<{ id?: string }>)
                            .map((m) => m.id)
                            .filter(Boolean) as string[],
                    ),
                    from,
                    kept: null,
                    summary: null,
                    at: Date.now(),
                });
            }
        } catch {}
        compactInFlight = true;
        notifyControls();
        const currentSid = sid;
        return invokeControl(
            wire,
            'compact',
            currentSid,
            {},
            CompactCallTimeout,
        )
            .then((data) => {
                if (currentSid === sid) {
                    if (
                        typeof data?.stateWarning === 'string' &&
                        data.stateWarning
                    )
                        status.textContent = `Warning: ${data.stateWarning}`;
                }
                return data;
            })
            .catch((error: unknown) => {
                if (!destroyed && currentSid === sid)
                    status.textContent = `Error: ${String(error)}`;
                throw error;
            })
            .finally(() => {
                compactInFlight = false;
                // A pane destroyed mid-compaction must not repopulate the
                // controller's control cache after teardown published null.
                if (!destroyed) notifyControls();
            });
    };

    const resetChat = (): Promise<unknown> => {
        if (!sid || !ready || exited) return rejected('Pi RPC is not ready');
        if (busy || queueDepth > 0) return rejected('Pi RPC is busy');
        if (resetInFlight) return rejected('Pi RPC reset is already pending');
        resetInFlight = true;
        notifyControls();
        const currentSid = sid;
        // Fallback inputs for the case where the server's canonical clear is
        // lost or delayed. A newer accepted event advances the cursor and
        // disables the response-only rule, even when it repeats the same path.
        const previousPath = localStatus.sessionPath;
        const previousCursor = buffer.getLastSeq();
        return invokeControl(wire, 'newSession', currentSid, {})
            .then((data: any) => {
                if (destroyed || currentSid !== sid) return data;
                if (data?.cancelled === true) return data;
                if (data?.reset !== true)
                    throw new Error('Pi reset was not accepted');
                if (
                    previousPath !== undefined &&
                    localStatus.sessionPath === previousPath &&
                    buffer.getLastSeq() === previousCursor
                ) {
                    delete localStatus.sessionPath;
                    notifyStatus();
                }
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
                if (!destroyed) notifyControls();
            });
    };

    const setName = (name: string): Promise<unknown> => {
        const trimmed = name.trim();
        if (!trimmed) return rejected('name is required');
        if (!sid) return rejected('Pi RPC is not ready');
        return invokeControl(wire, 'setSessionName', sid, { name: trimmed });
    };

    const off = client.onMessage((env: any) => {
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
            enterExited();
        }
        if (env.evt === 'subagentFleet') {
            lastFleet = env.data;
            strip.update(env.data);
            onFleetChange(env.data);
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
                (
                    view as unknown as { clearCompactSnapshot?: () => void }
                ).clearCompactSnapshot?.();
                compactSnapshot = null;
            } else if (reason === 'manual' && errorMessage) {
                // Plan row: compaction_end errorMessage + reason manual
                // → status bar error. Gated on a non-empty errorMessage
                // so successful manual /compact (no errorMessage per
                // rpc.md) does not render a spurious "pi: compaction
                // error" line.
                status.textContent = `pi: ${errorMessage}`;
                (
                    view as unknown as { clearCompactSnapshot?: () => void }
                ).clearCompactSnapshot?.();
                compactSnapshot = null;
            } else if (!aborted && !errorMessage) {
                const summary =
                    (typeof (
                        data as unknown as { result?: { summary?: unknown } }
                    )?.result?.summary === 'string' &&
                        (data as unknown as { result: { summary: string } })
                            .result.summary) ||
                    (typeof (data as unknown as { summary?: unknown })
                        ?.summary === 'string' &&
                        (data as unknown as { summary: string }).summary) ||
                    (typeof (
                        data as unknown as {
                            result?: { compactionSummary?: unknown };
                        }
                    )?.result?.compactionSummary === 'string' &&
                        (
                            data as unknown as {
                                result: { compactionSummary: string };
                            }
                        ).result.compactionSummary) ||
                    null;
                const kept = Array.isArray(
                    (data as unknown as { result?: { messages?: unknown } })
                        ?.result?.messages,
                )
                    ? ((data as unknown as { result: { messages: unknown[] } })
                          .result.messages.length as number)
                    : null;
                _lastCompaction = {
                    summary,
                    id:
                        typeof (
                            data as unknown as { result?: { id?: unknown } }
                        )?.result?.id === 'string'
                            ? (data as unknown as { result: { id: string } })
                                  .result.id
                            : null,
                    timestamp: Date.now(),
                    kept,
                };
                const v3 = view as unknown as {
                    setCompactSnapshot?: (s: unknown) => void;
                };
                if (v3.setCompactSnapshot && compactSnapshot) {
                    try {
                        const existing = compactSnapshot.messages;
                        v3.setCompactSnapshot({
                            messages: existing,
                            ids: compactSnapshot.ids,
                            summary,
                            from: (existing as unknown[]).length + (kept ?? 0),
                            kept,
                            at: Date.now(),
                        });
                        compactSnapshot.summary = summary;
                        compactSnapshot.kept = kept;
                    } catch {}
                }
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
            (
                view as unknown as { clearCompactSnapshot?: () => void }
            ).clearCompactSnapshot?.();
            compactSnapshot = null;
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
    void invokeControl(wire, 'spawn', undefined, spawnArgs)
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
            // A snapshot taken at the exit cursor is terminal: bootstrap must
            // not mark the pane ready because the queued exit event is stale.
            if (!exited) {
                ready = true;
                status.textContent = 'Ready';
            }
            notifyControls();
            // Render the retained snapshot even when it is terminal; only the
            // readiness and hydrate work below belongs to a live pane.
            paint();
            if (exited) return;
            flushQueue();
            requestHydrate(false);
        })
        .catch((error: unknown) => {
            if (destroyed) return;
            // The spawn frame was written before the drop, so Pi may already
            // be running for this pane. Re-spawning would start a second
            // process, so this pane stays closed instead.
            const transport = (error as { transport?: unknown })?.transport;
            failBootstrap(
                transport
                    ? 'Pi connection lost before the session opened — reopen the tab'
                    : error,
            );
        });

    // Reconnect: adopt whatever the dropped stream missed, then release any
    // prompt queued while the session was unavailable.
    const offState =
        typeof client.onState === 'function'
            ? client.onState((connected) => {
                  if (destroyed || exited) return;
                  if (!connected) {
                      status.textContent = 'Reconnecting…';
                      return;
                  }
                  if (!sid || bootstrapFailed) return;
                  // A failed hydrate during the outage cleared readiness; the
                  // retained snapshot is still valid authority to accept input.
                  if (!ready) {
                      ready = true;
                      notifyControls();
                  }
                  status.textContent = 'Ready';
                  requestHydrate(false);
                  flushQueue();
              })
            : () => {};

    return {
        destroy: (): void => {
            if (destroyed) return;
            flushPendingSave();
            destroyed = true;
            off();
            offState();
            client.close();
            subagentViewer.destroy();
            strip.destroy();
            root.replaceChildren();
            onStatusChange(null);
            onControlChange(null);
        },
        streamFailed: (message: string): void => {
            if (destroyed) return;
            // Keep the transcript that already rendered; only the ability to
            // send is withdrawn, and the status says why.
            streamBroken = true;
            ready = false;
            status.textContent = `Error: ${message}`;
            notifyControls();
        },
        send,
        getModels,
        getThinkingLevels,
        setModel,
        setThinking,
        resetChat,
        compact,
        interrupt,
        setName,
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
