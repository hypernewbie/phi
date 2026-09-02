import { dispatchComposer } from './composer.js';
import { CompactCallTimeout } from './client.js';
import { MessageBuffer } from './message-buffer.js';
import { savePersisted } from './persist.js';
import { renderedUserText } from './render.js';
import { createReviewTranscriptView } from '../review-transcript.js';
import { createSubagentStrip, createSubagentViewer } from './subagents.js';
function cloneStatus(status) {
    return {
        ...status,
        skills: status.skills ? [...status.skills] : status.skills,
    };
}
function mergeState(status, state) {
    if (!state || typeof state !== 'object') return false;
    const source = state;
    let changed = false;
    const strings = ['cwd', 'model', 'thinking'];
    for (const field of strings) {
        if (Object.hasOwn(source, field) && typeof source[field] === 'string') {
            status[field] = source[field];
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
    ];
    for (const field of numbers) {
        if (!Object.hasOwn(source, field)) continue;
        const value = source[field];
        if (
            value === null ||
            (typeof value === 'number' && Number.isFinite(value))
        ) {
            status[field] = value;
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
            status.skills = value === null ? null : [...value];
            changed = true;
        }
    }
    return changed;
}
function isSnapshot(value) {
    if (!value || typeof value !== 'object') return false;
    const snapshot = value;
    return (
        typeof snapshot.lastSeq === 'number' &&
        Number.isFinite(snapshot.lastSeq) &&
        Array.isArray(snapshot.messages)
    );
}
function rejected(message) {
    return Promise.reject(new Error(message));
}
function validModels(value) {
    const models = value?.models;
    if (!Array.isArray(models)) throw new Error('Pi model list is malformed');
    return models.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const model = item;
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
function validThinkingLevels(value) {
    const levels = value?.levels;
    if (
        !Array.isArray(levels) ||
        !levels.every((level) => typeof level === 'string')
    )
        throw new Error('Pi thinking level list is malformed');
    return [...levels];
}
function invokeControl(
    client,
    op,
    sid,
    args,
    legacyId,
    legacyResponses,
    timeoutMs,
) {
    if (typeof client.call === 'function')
        return client.call(
            op,
            sid,
            args,
            timeoutMs ? { timeoutMs } : undefined,
        );
    const frame = { t: 'call', id: legacyId, op };
    if (sid !== undefined) frame.sid = sid;
    if (args !== undefined) frame.args = args;
    return new Promise((resolve, reject) => {
        if (legacyResponses) {
            legacyResponses.set(legacyId, { resolve, reject });
            client.send(frame);
            return;
        }
        const off = client.onMessage((env) => {
            if (env?.t !== 'res' || env.id !== legacyId) return;
            off();
            if (env.ok) resolve(env.data);
            else reject(new Error(String(env.error ?? 'control call failed')));
        });
        client.send(frame);
    });
}
export function mountChatPi(
    root,
    cwd,
    client,
    sessionPath,
    onStatusChange = () => {},
    onControlChange = () => {},
    onFleetChange = () => {},
) {
    const wire = client;
    const buffer = new MessageBuffer();
    const localStatus = { cwd };
    let sid = '';
    let destroyed = false;
    let ready = false;
    let busy = false;
    let queueDepth = 0;
    let exited = false;
    let resetInFlight = false;
    let compactInFlight = false;
    let compactSnapshot = null;
    let _lastCompaction = null;
    let sessionActive = false;
    let outgoingSeq = 0;
    const outgoing = [];
    // Outgoing records disappear when their user message is rendered; retain
    // the full current-turn order separately for interrupt restoration.
    const turnPrompts = [];
    let activePrompt = null;
    let abortInFlight = false;
    let hydrateInFlight = false;
    let pendingSaveTimer = null;
    let pendingImmediateSave = false;
    let hydrateGeneration = 0;
    let activeHydrate = null;
    let legacyHydrateId = 0;
    const legacyResponses = new Map();
    const notifyStatus = () => onStatusChange(cloneStatus(localStatus));
    const notifyControls = () =>
        onControlChange({
            ready,
            exited,
            busy,
            queueDepth,
            hasTranscript: buffer.getMessageCount() > 0,
            model: localStatus.model ?? '',
            thinking: localStatus.thinking ?? '',
        });
    const applyState = (state) => {
        const source = state;
        const statusChanged = mergeState(localStatus, state);
        let controlsChanged = statusChanged;
        if (source && typeof source === 'object') {
            if (typeof source.busy === 'boolean' && source.busy !== busy) {
                busy = source.busy;
                sessionActive = busy;
                controlsChanged = true;
                if (!busy) {
                    outgoing.length = 0;
                    turnPrompts.length = 0;
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
    const failBootstrap = (message) => {
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
    const flushPaint = () => {
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
    const paint = () => {
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
    const status = view.status;
    const _origPrepend = view.prependOlder.bind(view);
    let _compactFileTried = false;
    view.prependOlder = (count) => {
        const ok = _origPrepend(count);
        if (ok) return true;
        if (_compactFileTried) return false;
        const hasSnapshot = view.hasCompactSnapshot?.() ?? false;
        const total = view.getStructuredMessages?.().length ?? 0;
        if (!hasSnapshot && total < 30) {
            _compactFileTried = true;
            const sp = sessionPath ?? null;
            view.loadCompactSnapshotFromFile?.({ sessionPath: sp, cwd })
                .then((loaded) => {
                    if (loaded) view.prependOlder(count);
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
    let lastFleet;
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
    let retryState = null;
    const syncActiveTurn = () => {
        const base = activePrompt
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
    const removeTurnPrompt = (prompt) => {
        const index = turnPrompts.indexOf(prompt);
        if (index >= 0) turnPrompts.splice(index, 1);
    };
    const cancelPendingSave = () => {
        if (pendingSaveTimer !== null) clearTimeout(pendingSaveTimer);
        pendingSaveTimer = null;
        pendingImmediateSave = false;
    };
    const persistIfCurrent = (currentSid) => {
        if (!destroyed && sid === currentSid && !hydrateInFlight)
            savePersisted(currentSid, buffer.getMessages());
    };
    const schedulePersist = (delay) => {
        cancelPendingSave();
        const currentSid = sid;
        if (!currentSid) return;
        pendingSaveTimer = setTimeout(() => {
            pendingSaveTimer = null;
            persistIfCurrent(currentSid);
        }, delay);
    };
    const scheduleImmediatePersist = () => {
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
    const flushPendingSave = () => {
        if (pendingSaveTimer === null && !pendingImmediateSave) return;
        cancelPendingSave();
        persistIfCurrent(sid);
    };
    const requestHydrate = (forReset = false) => {
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
            .then((data) => {
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
                applyState(data.state);
                hydrateInFlight = false;
                paint();
                // A hydrate replaces the authoritative settled transcript.
                // Reset completion flushes in the next microtask; initial and
                // gap hydrates retain the existing 0 ms timer behavior.
                if (wasReset) scheduleImmediatePersist();
                else schedulePersist(0);
            })
            .catch((error) => {
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
    const send = (text) => {
        if (!sid || !ready || exited || subagentViewer.isOpen()) return false;
        const dispatch = dispatchComposer(text);
        if (dispatch.kind === 'rejected') {
            status.textContent = dispatch.reason;
            return false;
        }
        const currentSid = sid;
        const local = {
            id: `out-${++outgoingSeq}`,
            text: dispatch.message,
            state: 'sending',
        };
        outgoing.push(local);
        turnPrompts.push(local);
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
            .then((data) => {
                const index = outgoing.indexOf(local);
                if (data?.accepted !== true) {
                    if (index >= 0) outgoing.splice(index, 1);
                    removeTurnPrompt(local);
                    if (activePrompt?.id === local.id)
                        activePrompt = outgoing.at(-1)
                            ? { ...outgoing.at(-1), origin: 'optimistic' }
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
            .catch((error) => {
                const index = outgoing.indexOf(local);
                if (index >= 0) outgoing.splice(index, 1);
                removeTurnPrompt(local);
                if (activePrompt?.id === local.id)
                    activePrompt = outgoing.at(-1)
                        ? { ...outgoing.at(-1), origin: 'optimistic' }
                        : null;
                if (!destroyed && currentSid === sid)
                    status.textContent = `Error: ${String(error)}`;
                syncActiveTurn();
            });
        return true;
    };
    const getModels = () => {
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
    const getThinkingLevels = () => {
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
    const setModel = (provider, modelId) => {
        if (!sid || !ready || exited) return rejected('Pi RPC is not ready');
        const currentSid = sid;
        return invokeControl(
            wire,
            'setModel',
            currentSid,
            { provider, modelId },
            'set-model',
            legacyResponses,
        ).then((data) => {
            if (currentSid === sid) applyState(data?.state);
            return data;
        });
    };
    const setThinking = (level) => {
        if (!sid || !ready || exited) return rejected('Pi RPC is not ready');
        const currentSid = sid;
        return invokeControl(
            wire,
            'setThinking',
            currentSid,
            { level },
            'set-thinking',
            legacyResponses,
        ).then((data) => {
            if (currentSid === sid) applyState(data?.state);
            return data;
        });
    };
    const interrupt = () => {
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
            .then((data) => ({ ...(data ?? {}), restored }))
            .catch((error) => {
                if (!destroyed && currentSid === sid)
                    status.textContent = `Error: ${String(error)}`;
                throw error;
            })
            .finally(() => {
                abortInFlight = false;
            });
    };
    const compact = () => {
        if (!sid || !ready || exited) return rejected('Pi RPC is not ready');
        if (busy || queueDepth > 0) return rejected('Pi RPC is busy');
        if (compactInFlight)
            return rejected('Pi compaction is already pending');
        try {
            const snapMessages =
                view.getStructuredMessages?.() ?? buffer.getMessages?.() ?? [];
            const snapForView = (() => {
                if (!compactSnapshot) return snapMessages;
                const existingIds = compactSnapshot.ids;
                return snapMessages.filter(
                    (m) => !m?.id || !existingIds.has(m.id),
                );
            })();
            compactSnapshot = {
                messages: JSON.parse(JSON.stringify(snapMessages)),
                at: Date.now(),
                ids: new Set(snapMessages.map((m) => m.id).filter(Boolean)),
            };
            const v2 = view;
            if (v2.setCompactSnapshot) {
                const from = snapForView.length;
                v2.setCompactSnapshot({
                    messages: JSON.parse(JSON.stringify(snapForView)),
                    ids: new Set(snapForView.map((m) => m.id).filter(Boolean)),
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
            'compact',
            legacyResponses,
            CompactCallTimeout,
        )
            .then((data) => {
                if (currentSid === sid) {
                    applyState(data?.state);
                    if (
                        typeof data?.stateWarning === 'string' &&
                        data.stateWarning
                    )
                        status.textContent = `Warning: ${data.stateWarning}`;
                }
                return data;
            })
            .catch((error) => {
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
    const resetChat = () => {
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
            .then((data) => {
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
            .catch((error) => {
                if (!destroyed && currentSid === sid)
                    status.textContent = `Error: ${String(error)}`;
                throw error;
            })
            .finally(() => {
                resetInFlight = false;
                notifyControls();
            });
    };
    const setName = (name) => {
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
    const off = client.onMessage((env) => {
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
        // Milestone 4: provider-level retry indicator.
        // auto_retry_start/summarization_retry_scheduled stash
        // {attempt, maxAttempts} into retryState; the matching end/finished
        // events clear it. Numbers are coerced (invalid → ignore) so a
        // malformed event cannot strand the working row.
        if (
            env.evt === 'autoRetryStart' ||
            env.evt === 'summarizationRetryScheduled'
        ) {
            const data = env.data;
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
                const data = env.data;
                if (data?.success === false) {
                    status.textContent = `Retry failed after ${String(data.attempt ?? '?')} attempt${
                        (data.attempt ?? 0) === 1 ? '' : 's'
                    }: ${String(data.finalError ?? 'Unknown error')}`;
                }
            }
        }
        if (env.evt === 'extensionError') {
            const data = env.data;
            status.textContent = `pi extension error: ${String(data?.error ?? 'unknown')}`;
        }
        if (env.evt === 'compactionEnd') {
            const data = env.data;
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
                view.clearCompactSnapshot?.();
                compactSnapshot = null;
            } else if (reason === 'manual' && errorMessage) {
                // Plan row: compaction_end errorMessage + reason manual
                // → status bar error. Gated on a non-empty errorMessage
                // so successful manual /compact (no errorMessage per
                // rpc.md) does not render a spurious "pi: compaction
                // error" line.
                status.textContent = `pi: ${errorMessage}`;
                view.clearCompactSnapshot?.();
                compactSnapshot = null;
            } else if (!aborted && !errorMessage) {
                const summary =
                    (typeof data?.result?.summary === 'string' &&
                        data.result.summary) ||
                    (typeof data?.summary === 'string' && data.summary) ||
                    (typeof data?.result?.compactionSummary === 'string' &&
                        data.result.compactionSummary) ||
                    null;
                const kept = Array.isArray(data?.result?.messages)
                    ? data.result.messages.length
                    : null;
                _lastCompaction = {
                    summary,
                    id:
                        typeof data?.result?.id === 'string'
                            ? data.result.id
                            : null,
                    timestamp: Date.now(),
                    kept,
                };
                const v3 = view;
                if (v3.setCompactSnapshot && compactSnapshot) {
                    try {
                        const existing = compactSnapshot.messages;
                        v3.setCompactSnapshot({
                            messages: existing,
                            ids: compactSnapshot.ids,
                            summary,
                            from: existing.length + (kept ?? 0),
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
            view.clearCompactSnapshot?.();
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
    const spawnArgs = { cwd };
    if (sessionPath) spawnArgs.sessionPath = sessionPath;
    void invokeControl(
        wire,
        'spawn',
        undefined,
        spawnArgs,
        'sp',
        legacyResponses,
    )
        .then((data) => {
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
        .catch((error) => {
            if (!destroyed) failBootstrap(error);
        });
    return {
        destroy: () => {
            if (destroyed) return;
            flushPendingSave();
            destroyed = true;
            off();
            client.close();
            subagentViewer.destroy();
            strip.destroy();
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
        compact,
        interrupt,
        setName,
        refreshFleet: () => {
            // Tab re-activation: repaint this pane's last fleet snapshot
            // (or hide the shared strip when this pane has none).
            if (lastFleet === undefined) strip.hide();
            else strip.update(lastFleet);
        },
        closeSubagentViewer: () => {
            if (!subagentViewer.isOpen()) return false;
            subagentViewer.close();
            return true;
        },
    };
}
