/* Φ phi — saved Pi Thinking fallback options */
import { getEmbeddedProfileId, serverKey } from './util.js';
export const THINKING_PRESET_LEVELS = [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
];
const STORAGE_PREFIX = 'phi:thinking-presets:v1';
const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_INTERVAL_MS = 10_000;
const STORAGE_WARNING = 'Browser storage is unavailable; Thinking changes are kept only in memory.';
export function normalizeThinkingPresetList(value) {
    if (!Array.isArray(value))
        return null;
    const out = [];
    for (const item of value) {
        if (typeof item !== 'string')
            return null;
        if (!THINKING_PRESET_LEVELS.includes(item))
            return null;
        if (out.includes(item))
            return null;
        out.push(item);
    }
    return out;
}
export function thinkingPresetTokens(exclude = []) {
    return THINKING_PRESET_LEVELS.filter((level) => !exclude.includes(level));
}
function sameList(a, b) {
    return a.length === b.length && a.every((item, index) => item === b[index]);
}
function emptyState() {
    return {
        confirmed: null,
        desired: [],
        dirty: false,
        saveRequired: false,
        attempt: null,
        writing: false,
        error: '',
        storageWarning: '',
    };
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export class ThinkingPresetStore {
    state = emptyState();
    listeners = new Set();
    memorySnapshots = new Map();
    storageKey = STORAGE_PREFIX;
    ownerIdValue = '';
    scope = null;
    profileId = '';
    ownerGeneration = 0;
    lane = Promise.resolve();
    disposed = false;
    timer = null;
    onlineHandler = null;
    loadRequested = false;
    activeCancels = new Set();
    get ownerId() {
        return this.ownerIdValue;
    }
    getState() {
        return this.state;
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    get hasUnsentWork() {
        const { confirmed, desired, dirty, attempt, saveRequired } = this.state;
        return (dirty &&
            !attempt &&
            !saveRequired &&
            confirmed !== null &&
            !sameList(confirmed, desired));
    }
    bind(scope) {
        if (this.disposed)
            return;
        const profileId = scope?.profileId ?? getEmbeddedProfileId();
        const origin = scope?.origin ?? '';
        const profileKey = profileId === getEmbeddedProfileId()
            ? serverKey(STORAGE_PREFIX)
            : profileId
                ? `${STORAGE_PREFIX}:${profileId}`
                : STORAGE_PREFIX;
        const storageKey = `${profileKey}:${encodeURIComponent(origin)}`;
        const ownerId = `${profileId}\u0000${origin}\u0000${storageKey}`;
        if (this.ownerIdValue === ownerId && this.scope === (scope ?? null))
            return;
        this.ownerGeneration++;
        this.activeCancels.forEach((cancel) => {
            cancel('BackendScope changed');
        });
        this.activeCancels.clear();
        this.clearRetry();
        this.removeOnlineHandler();
        this.scope = scope ?? null;
        this.profileId = profileId;
        this.storageKey = storageKey;
        this.ownerIdValue = ownerId;
        this.loadRequested = true;
        this.lane = Promise.resolve();
        this.state = this.restore();
        this.notify();
        this.addOnlineHandler();
        void this.wake();
    }
    dispose() {
        this.disposed = true;
        this.ownerGeneration++;
        this.activeCancels.forEach((cancel) => {
            cancel('Thinking store disposed');
        });
        this.activeCancels.clear();
        this.clearRetry();
        this.removeOnlineHandler();
        this.listeners.clear();
    }
    /** Read through the same lane as writes; callers may use it as a fresh probe. */
    async refresh() {
        if (this.disposed)
            return false;
        this.loadRequested = true;
        const result = await this.enqueue((generation) => this.readServerList(generation));
        this.schedulePendingWake();
        return result === true;
    }
    setLevels(next) {
        if (this.disposed)
            return;
        const levels = normalizeThinkingPresetList([...next]);
        if (!levels || sameList(levels, this.state.desired))
            return;
        const settledAttempt = this.state.attempt !== null && !this.state.writing;
        this.patch({ desired: levels, dirty: true, error: '' });
        this.persist();
        if (!settledAttempt)
            void this.wake();
    }
    /** Explicitly authorize reconciling the current draft after uncertainty. */
    async saveAgain() {
        if (this.disposed ||
            this.state.writing ||
            (!this.state.attempt && !this.state.saveRequired))
            return;
        const authorization = {
            attempt: this.state.attempt,
            saveRequired: this.state.saveRequired,
            desired: [...this.state.desired],
        };
        await this.enqueue(async (generation) => {
            if (this.state.attempt !== authorization.attempt ||
                this.state.saveRequired !== authorization.saveRequired ||
                this.state.writing ||
                !sameList(this.state.desired, authorization.desired))
                return;
            this.patch({
                attempt: null,
                saveRequired: false,
                dirty: true,
                error: '',
            });
            this.persist();
            await this.write([...authorization.desired], generation);
        });
        this.schedulePendingWake();
    }
    /** Discard local state in favour of the list most recently read from the server. */
    useServerList() {
        if (this.disposed || this.state.confirmed === null)
            return;
        const confirmed = [...this.state.confirmed];
        this.patch({
            desired: confirmed,
            dirty: false,
            saveRequired: false,
            attempt: null,
            error: '',
        });
        this.persist();
    }
    /** Called when the menu opens. Never-sent work is probed before a PUT. */
    start() {
        if (this.disposed || typeof window === 'undefined')
            return;
        this.addOnlineHandler();
        void this.wake();
    }
    /** Render subscribers must not turn one failed GET into an immediate retry loop. */
    ensureLoaded() {
        if (this.disposed ||
            this.state.confirmed !== null ||
            this.loadRequested)
            return;
        void this.refresh();
    }
    addOnlineHandler() {
        if (this.onlineHandler || typeof window === 'undefined')
            return;
        this.onlineHandler = () => {
            void this.wake();
        };
        window.addEventListener('online', this.onlineHandler);
    }
    removeOnlineHandler() {
        if (!this.onlineHandler || typeof window === 'undefined')
            return;
        window.removeEventListener('online', this.onlineHandler);
        this.onlineHandler = null;
    }
    async wake() {
        if (this.disposed)
            return;
        this.loadRequested = true;
        await this.enqueue(async (generation) => {
            const read = await this.readServerList(generation);
            if (!read || !this.isCurrent(generation))
                return;
            const { confirmed, desired, dirty, attempt, saveRequired } = this.state;
            if (attempt || saveRequired || !dirty || confirmed === null)
                return;
            if (sameList(confirmed, desired)) {
                this.patch({ dirty: false });
                this.persist();
                return;
            }
            await this.write([...desired], generation);
        });
        this.schedulePendingWake();
    }
    enqueue(task) {
        const generation = this.ownerGeneration;
        const result = this.lane.then(() => {
            if (!this.isCurrent(generation))
                return undefined;
            return task(generation);
        });
        this.lane = result.then(() => undefined, () => undefined);
        return result;
    }
    async readServerList(generation) {
        const previousConfirmed = this.state.confirmed;
        try {
            const result = await this.requestBody(generation, {}, async (response) => {
                if (!response.ok) {
                    return {
                        response,
                        detail: (await response.text()).trim(),
                        payload: null,
                    };
                }
                return {
                    response,
                    detail: '',
                    payload: await response.json(),
                };
            });
            if (!this.isCurrent(generation))
                return false;
            if (!result.response.ok) {
                this.patch({
                    error: result.detail ||
                        `Could not read saved Thinking options (HTTP ${result.response.status})`,
                });
                return false;
            }
            const levels = normalizeThinkingPresetList(result.payload
                ?.thinking_presets);
            if (!levels) {
                this.patch({ error: 'Saved Thinking options were unreadable' });
                return false;
            }
            this.acceptServerList(levels, previousConfirmed);
            return true;
        }
        catch (error) {
            if (this.isCurrent(generation))
                this.patch({ error: describeError(error) });
            return false;
        }
    }
    acceptServerList(levels, previousConfirmed) {
        const { desired, dirty, attempt, saveRequired } = this.state;
        const next = { confirmed: [...levels], error: '' };
        if (attempt) {
            if (sameList(attempt.levels, levels)) {
                next.attempt = null;
                next.dirty = !sameList(desired, levels);
                next.saveRequired = false;
            }
        }
        else if (previousConfirmed === null) {
            if (!dirty || sameList(desired, levels)) {
                next.desired = [...levels];
                next.dirty = false;
                next.saveRequired = false;
            }
            else {
                // A blind local edit (including intentional []) needs explicit confirmation.
                next.dirty = true;
                next.saveRequired = true;
            }
        }
        else if (!dirty || sameList(desired, levels)) {
            next.desired = [...levels];
            next.dirty = false;
            next.saveRequired = false;
        }
        else {
            next.dirty = true;
            next.saveRequired = saveRequired;
        }
        this.patch(next);
        this.persist();
    }
    async write(levels, generation) {
        const snapshot = [...levels];
        this.patch({
            attempt: { levels: snapshot, status: 'unknown' },
            dirty: true,
            writing: true,
            error: '',
        });
        this.persist();
        try {
            const result = await this.requestBody(generation, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ thinking_presets: snapshot }),
            }, async (response) => {
                if (!response.ok) {
                    return {
                        response,
                        detail: (await response.text()).trim(),
                        payload: null,
                    };
                }
                return {
                    response,
                    detail: '',
                    payload: await response.json(),
                };
            });
            if (!this.isCurrent(generation))
                return;
            if (!result.response.ok) {
                this.patch({
                    writing: false,
                    attempt: { levels: snapshot, status: 'rejected' },
                    error: result.detail ||
                        `Saved Thinking options rejected (HTTP ${result.response.status})`,
                });
                this.persist();
                return;
            }
            const saved = normalizeThinkingPresetList(result.payload
                ?.thinking_presets);
            if (!saved || !sameList(saved, snapshot)) {
                this.patch({
                    writing: false,
                    attempt: { levels: snapshot, status: 'unknown' },
                    error: 'Saved Thinking options were not acknowledged; Save again to retry',
                });
                this.persist();
                return;
            }
            const desired = this.state.desired;
            this.patch({
                confirmed: saved,
                dirty: !sameList(desired, snapshot),
                saveRequired: false,
                attempt: null,
                writing: false,
                error: '',
            });
            this.persist();
        }
        catch (error) {
            if (!this.isCurrent(generation))
                return;
            this.patch({
                writing: false,
                attempt: { levels: snapshot, status: 'unknown' },
                error: describeError(error),
            });
            this.persist();
        }
    }
    async requestBody(generation, init, consume) {
        if (!this.isCurrent(generation))
            throw new DOMException('Owner changed', 'AbortError');
        const scope = this.scope;
        const controller = new AbortController();
        let rejectAbort;
        const aborted = new Promise((_resolve, reject) => {
            rejectAbort = reject;
        });
        let settled = false;
        const cancel = (message) => {
            if (settled)
                return;
            controller.abort();
            rejectAbort(new DOMException(message, 'AbortError'));
        };
        const scopeAbort = () => cancel('BackendScope aborted');
        this.activeCancels.add(cancel);
        if (scope?.signal.aborted)
            scopeAbort();
        else
            scope?.signal.addEventListener('abort', scopeAbort, { once: true });
        const timeout = setTimeout(() => cancel('Saved Thinking options timed out'), REQUEST_TIMEOUT_MS);
        const extraHeaders = init.headers;
        const headers = scope
            ? scope.headers(extraHeaders)
            : {
                ...extraHeaders,
                ...(this.profileId
                    ? { 'X-Phi-Backend': this.profileId }
                    : {}),
            };
        const operation = (async () => {
            const response = await fetch('/api/config/thinking-presets', {
                ...init,
                headers,
                credentials: 'same-origin',
                signal: controller.signal,
            });
            if (!this.isCurrent(generation))
                throw new DOMException('Owner changed', 'AbortError');
            return await consume(response);
        })();
        try {
            return await Promise.race([operation, aborted]);
        }
        finally {
            settled = true;
            clearTimeout(timeout);
            scope?.signal.removeEventListener('abort', scopeAbort);
            this.activeCancels.delete(cancel);
        }
    }
    schedulePendingWake() {
        if (this.disposed)
            return;
        if (!this.hasPendingWork) {
            this.clearRetry();
            return;
        }
        if (this.timer || typeof window === 'undefined')
            return;
        const generation = this.ownerGeneration;
        this.timer = setTimeout(() => {
            this.timer = null;
            if (this.isCurrent(generation))
                void this.wake();
        }, RETRY_INTERVAL_MS);
    }
    get hasPendingWork() {
        return (this.state.dirty ||
            this.state.attempt !== null ||
            this.state.saveRequired);
    }
    clearRetry() {
        if (!this.timer)
            return;
        clearTimeout(this.timer);
        this.timer = null;
    }
    patch(next) {
        if (this.disposed)
            return;
        this.state = { ...this.state, ...next };
        this.notify();
    }
    notify() {
        for (const listener of this.listeners)
            listener(this.state);
    }
    restore() {
        const empty = emptyState();
        const memory = this.memorySnapshots.get(this.storageKey);
        if (memory) {
            return {
                ...memory,
                confirmed: memory.confirmed === null ? null : [...memory.confirmed],
                desired: [...memory.desired],
                attempt: memory.attempt
                    ? {
                        levels: [...memory.attempt.levels],
                        status: memory.attempt.status,
                    }
                    : null,
                writing: false,
                error: '',
            };
        }
        try {
            const raw = localStorage.getItem(this.storageKey);
            if (!raw)
                return empty;
            const parsed = JSON.parse(raw);
            if (!isRecord(parsed))
                return empty;
            const expected = [
                'attempt',
                'confirmed',
                'desired',
                'dirty',
                'saveRequired',
                'version',
            ];
            if (parsed.version !== 1 ||
                Object.keys(parsed).length !== expected.length ||
                !expected.every((key) => Object.hasOwn(parsed, key)))
                return empty;
            const confirmed = parsed.confirmed === null
                ? null
                : normalizeThinkingPresetList(parsed.confirmed);
            const desired = normalizeThinkingPresetList(parsed.desired);
            const dirty = parsed.dirty;
            const saveRequired = parsed.saveRequired;
            let attempt = null;
            if (parsed.attempt !== null) {
                if (!isRecord(parsed.attempt))
                    return empty;
                const levels = normalizeThinkingPresetList(parsed.attempt.levels);
                const status = parsed.attempt.status;
                if (!levels ||
                    (status !== 'unknown' && status !== 'rejected') ||
                    Object.keys(parsed.attempt).length !== 2 ||
                    !Object.hasOwn(parsed.attempt, 'levels') ||
                    !Object.hasOwn(parsed.attempt, 'status'))
                    return empty;
                attempt = { levels, status };
            }
            if ((parsed.confirmed !== null && !confirmed) ||
                !desired ||
                typeof dirty !== 'boolean' ||
                typeof saveRequired !== 'boolean' ||
                (attempt !== null && (!dirty || confirmed === null)) ||
                (saveRequired &&
                    (!dirty || attempt !== null || confirmed === null)) ||
                (!dirty &&
                    (attempt !== null ||
                        saveRequired ||
                        (confirmed === null
                            ? desired.length !== 0
                            : !sameList(confirmed, desired)))))
                return empty;
            return {
                ...empty,
                confirmed,
                desired,
                dirty,
                saveRequired,
                attempt,
            };
        }
        catch {
            return { ...empty, storageWarning: STORAGE_WARNING };
        }
    }
    persist() {
        const record = {
            version: 1,
            confirmed: this.state.confirmed,
            desired: this.state.desired,
            dirty: this.state.dirty,
            saveRequired: this.state.saveRequired,
            attempt: this.state.attempt,
        };
        this.rememberState();
        try {
            localStorage.setItem(this.storageKey, JSON.stringify(record));
        }
        catch {
            if (!this.state.storageWarning) {
                this.patch({ storageWarning: STORAGE_WARNING });
                this.rememberState();
            }
        }
    }
    rememberState() {
        this.memorySnapshots.set(this.storageKey, {
            ...this.state,
            confirmed: this.state.confirmed === null
                ? null
                : [...this.state.confirmed],
            desired: [...this.state.desired],
            attempt: this.state.attempt
                ? {
                    levels: [...this.state.attempt.levels],
                    status: this.state.attempt.status,
                }
                : null,
        });
    }
    isCurrent(generation) {
        return !this.disposed && generation === this.ownerGeneration;
    }
}
function describeError(error) {
    if (error instanceof DOMException && error.name === 'AbortError')
        return error.message.includes('timed out')
            ? 'Saved Thinking options timed out'
            : 'Saved Thinking options unavailable';
    if (error instanceof Error && error.message)
        return error.message;
    return 'Saved Thinking options unavailable';
}
