import { dispatchComposer } from './composer.js';
import { MessageBuffer } from './message-buffer.js';
import { savePersisted } from './persist.js';
import { renderedUserText } from './render.js';
import { createReviewTranscriptView } from '../review-transcript.js';
function cloneStatus(status) {
    return {
        ...status,
        skills: status.skills ? [...status.skills] : status.skills,
    };
}
function mergeState(status, state) {
    if (!state || typeof state !== 'object')
        return false;
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
        if (!Object.hasOwn(source, field))
            continue;
        const value = source[field];
        if (value === null ||
            (typeof value === 'number' && Number.isFinite(value))) {
            status[field] = value;
            changed = true;
        }
    }
    if (Object.hasOwn(source, 'skills')) {
        const value = source.skills;
        if (value === null ||
            (Array.isArray(value) &&
                value.every((item) => typeof item === 'string'))) {
            status.skills = value === null ? null : [...value];
            changed = true;
        }
    }
    return changed;
}
function isSnapshot(value) {
    if (!value || typeof value !== 'object')
        return false;
    const snapshot = value;
    return (typeof snapshot.lastSeq === 'number' &&
        Number.isFinite(snapshot.lastSeq) &&
        Array.isArray(snapshot.messages));
}
function rejected(message) {
    return Promise.reject(new Error(message));
}
function validModels(value) {
    const models = value?.models;
    if (!Array.isArray(models))
        throw new Error('Pi model list is malformed');
    return models.flatMap((item) => {
        if (!item || typeof item !== 'object')
            return [];
        const model = item;
        if (typeof model.provider !== 'string' || !model.provider)
            return [];
        if (typeof model.id !== 'string' || !model.id)
            return [];
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
    if (!Array.isArray(levels) ||
        !levels.every((level) => typeof level === 'string'))
        throw new Error('Pi thinking level list is malformed');
    return [...levels];
}
function invokeControl(client, op, sid, args, legacyId, legacyResponses) {
    if (typeof client.call === 'function')
        return client.call(op, sid, args);
    const frame = { t: 'call', id: legacyId, op };
    if (sid !== undefined)
        frame.sid = sid;
    if (args !== undefined)
        frame.args = args;
    return new Promise((resolve, reject) => {
        if (legacyResponses) {
            legacyResponses.set(legacyId, { resolve, reject });
            client.send(frame);
            return;
        }
        const off = client.onMessage((env) => {
            if (env?.t !== 'res' || env.id !== legacyId)
                return;
            off();
            if (env.ok)
                resolve(env.data);
            else
                reject(new Error(String(env.error ?? 'control call failed')));
        });
        client.send(frame);
    });
}
export function mountChatPi(root, cwd, client, sessionPath, onStatusChange = () => { }, onControlChange = () => { }) {
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
    let sessionActive = false;
    let outgoingSeq = 0;
    const outgoing = [];
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
    const notifyControls = () => onControlChange({
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
                    activePrompt = null;
                    syncActiveTurn();
                }
            }
            if (typeof source.queueDepth === 'number' &&
                Number.isFinite(source.queueDepth) &&
                source.queueDepth >= 0 &&
                source.queueDepth !== queueDepth) {
                queueDepth = Math.trunc(source.queueDepth);
                controlsChanged = true;
            }
        }
        if (statusChanged)
            notifyStatus();
        if (controlsChanged)
            notifyControls();
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
        view.setStructuredMessages(buffer.getStructuredTranscript(), buffer.getPartial(), buffer.getToolResultMap());
        notifyControls();
    };
    const paint = () => {
        if (paintQueued)
            return;
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
    const syncActiveTurn = () => {
        const active = activePrompt
            ? {
                active: true,
                promptText: activePrompt.text,
                promptOrigin: activePrompt.origin,
                stateLabel: activePrompt.state === 'sending'
                    ? 'Sending'
                    : 'Sent to Pi',
                outgoing: outgoing.map((item) => ({
                    text: item.text,
                    stateLabel: item.state === 'sending' ? 'Sending' : 'Sent to Pi',
                })),
            }
            : null;
        view.setActiveTurn(active);
    };
    const cancelPendingSave = () => {
        if (pendingSaveTimer !== null)
            clearTimeout(pendingSaveTimer);
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
        if (!currentSid)
            return;
        pendingSaveTimer = setTimeout(() => {
            pendingSaveTimer = null;
            persistIfCurrent(currentSid);
        }, delay);
    };
    const scheduleImmediatePersist = () => {
        cancelPendingSave();
        const currentSid = sid;
        if (!currentSid)
            return;
        pendingImmediateSave = true;
        queueMicrotask(() => {
            if (!pendingImmediateSave)
                return;
            pendingImmediateSave = false;
            persistIfCurrent(currentSid);
        });
    };
    const flushPendingSave = () => {
        if (pendingSaveTimer === null && !pendingImmediateSave)
            return;
        cancelPendingSave();
        persistIfCurrent(sid);
    };
    const requestHydrate = (forReset = false) => {
        if (destroyed || !sid)
            return;
        if (forReset && activeHydrate?.reset && activeHydrate.sid === sid)
            return;
        hydrateInFlight = true;
        cancelPendingSave();
        const currentSid = sid;
        const generation = ++hydrateGeneration;
        activeHydrate = { sid: currentSid, generation, reset: forReset };
        const hydrateNumber = legacyHydrateId++;
        const legacyId = hydrateNumber === 0 ? 'hyd' : `hyd-${hydrateNumber}`;
        void invokeControl(wire, 'hydrate', currentSid, {}, legacyId, legacyResponses)
            .then((data) => {
            if (destroyed ||
                activeHydrate?.generation !== generation ||
                currentSid !== sid)
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
            if (wasReset)
                scheduleImmediatePersist();
            else
                schedulePersist(0);
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
        if (!sid || !ready || exited)
            return false;
        const dispatch = dispatchComposer(text, busy);
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
        activePrompt = { ...local, origin: 'optimistic' };
        syncActiveTurn();
        void invokeControl(wire, 'prompt', currentSid, {
            message: dispatch.message,
            ...(dispatch.streamingBehavior
                ? { streamingBehavior: dispatch.streamingBehavior }
                : {}),
        }, `p${Date.now()}-${Math.random().toString(16).slice(2)}`, legacyResponses)
            .then((data) => {
            const index = outgoing.indexOf(local);
            if (data?.accepted !== true) {
                if (index >= 0)
                    outgoing.splice(index, 1);
                if (activePrompt?.id === local.id)
                    activePrompt = outgoing.at(-1)
                        ? { ...outgoing.at(-1), origin: 'optimistic' }
                        : null;
                if (!destroyed && currentSid === sid)
                    status.textContent = 'Error: prompt was not accepted';
            }
            else if (index >= 0) {
                local.state = 'sent';
                if (activePrompt?.id === local.id)
                    activePrompt.state = 'sent';
            }
            else if (activePrompt?.id === local.id) {
                // Pi may reconcile the outgoing record before the
                // prompt response arrives. Keep the retained marker's
                // state in sync with the accepted response.
                activePrompt.state = 'sent';
            }
            syncActiveTurn();
        })
            .catch((error) => {
            const index = outgoing.indexOf(local);
            if (index >= 0)
                outgoing.splice(index, 1);
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
        if (!sid || !ready || exited)
            return rejected('Pi RPC is not ready');
        const currentSid = sid;
        return invokeControl(wire, 'getAvailableModels', currentSid, {}, 'models', legacyResponses).then(validModels);
    };
    const getThinkingLevels = () => {
        if (!sid || !ready || exited)
            return rejected('Pi RPC is not ready');
        const currentSid = sid;
        return invokeControl(wire, 'getAvailableThinkingLevels', currentSid, {}, 'thinking', legacyResponses).then(validThinkingLevels);
    };
    const setModel = (provider, modelId) => {
        if (!sid || !ready || exited)
            return rejected('Pi RPC is not ready');
        const currentSid = sid;
        return invokeControl(wire, 'setModel', currentSid, { provider, modelId }, 'set-model', legacyResponses).then((data) => {
            if (currentSid === sid)
                applyState(data?.state);
            return data;
        });
    };
    const setThinking = (level) => {
        if (!sid || !ready || exited)
            return rejected('Pi RPC is not ready');
        const currentSid = sid;
        return invokeControl(wire, 'setThinking', currentSid, { level }, 'set-thinking', legacyResponses).then((data) => {
            if (currentSid === sid)
                applyState(data?.state);
            return data;
        });
    };
    const interrupt = () => {
        if (!sid || !ready || exited || !sessionActive)
            return rejected('Pi RPC is not active');
        if (abortInFlight)
            return rejected('Pi interrupt is already pending');
        abortInFlight = true;
        const currentSid = sid;
        return invokeControl(wire, 'abort', currentSid, {}, 'abort', legacyResponses)
            .catch((error) => {
            if (!destroyed && currentSid === sid)
                status.textContent = `Error: ${String(error)}`;
            throw error;
        })
            .finally(() => {
            abortInFlight = false;
        });
    };
    const resetChat = () => {
        if (!sid || !ready || exited)
            return rejected('Pi RPC is not ready');
        if (busy || queueDepth > 0)
            return rejected('Pi RPC is busy');
        if (resetInFlight)
            return rejected('Pi RPC reset is already pending');
        resetInFlight = true;
        notifyControls();
        const currentSid = sid;
        return invokeControl(wire, 'newSession', currentSid, {}, 'reset', legacyResponses)
            .then((data) => {
            if (currentSid !== sid)
                return data;
            if (data?.cancelled === true)
                return data;
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
    const off = client.onMessage((env) => {
        if (env?.t === 'res' && typeof env.id === 'string') {
            const response = legacyResponses.get(env.id);
            if (response) {
                legacyResponses.delete(env.id);
                if (env.ok)
                    response.resolve(env.data);
                else
                    response.reject(new Error(String(env.error ?? 'control call failed')));
                return;
            }
        }
        if (destroyed)
            return;
        if (env?.t !== 'evt' || env?.sid !== sid)
            return;
        const result = buffer.applyEvent({
            seq: env.seq,
            evt: env.evt,
            data: env.data,
        });
        if (!result.applied) {
            if (result.gap && sid)
                requestHydrate(false);
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
        if (env.evt === 'messageEnd' && env.data?.message?.role === 'user') {
            const text = renderedUserText(env.data.message.content);
            const match = outgoing.find((item) => renderedUserText(item.text) === text);
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
        }
        else {
            // Hot-path branching on the render disposition avoids full
            // structured repaints during streaming `text_delta` events and
            // avoids the expensive full-history serialize-and-write on
            // every partial. The microtask-coalesced paint() stays for
            // authoritative `full` events; the live partial path uses a
            // narrow DOM mutation.
            switch (result.renderDisposition) {
                case 'full':
                    paint();
                    if (!hydrateInFlight)
                        schedulePersist(250);
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
    if (sessionPath)
        spawnArgs.sessionPath = sessionPath;
    void invokeControl(wire, 'spawn', undefined, spawnArgs, 'sp', legacyResponses)
        .then((data) => {
        if (destroyed)
            return;
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
        if (!destroyed)
            failBootstrap(error);
    });
    return {
        destroy: () => {
            if (destroyed)
                return;
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
    };
}
