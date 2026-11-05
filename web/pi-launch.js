import { appearanceOwner, appearanceRequestContext, } from './mobile-appearance.js';
const SCHEMA = 1;
const CACHE_PREFIX = 'phi:pi-launch-cache:v1:';
const RECORD_PREFIX = 'phi:pi-launch-record:v1:';
const WRITER_PREFIX = 'phi:pi-launch-writer:v1:';
const PING_PREFIX = 'phi:pi-launch-ping:v1:';
// Largest revision a browser can round-trip without losing precision.
const MAX_REVISION = 9007199254740991;
const TIMEOUT_MS = 15000;
const DEBOUNCE_MS = 300;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
const FIELDS = [
    'pi_default_mode',
    'psi_command',
    'psi_args',
    'psi_env',
];
const EMPTY_DRAFT = () => ({
    fields: {},
    base: null,
    version: 0,
});
function randomId() {
    const bytes = new Uint8Array(9);
    if (globalThis.crypto)
        crypto.getRandomValues(bytes);
    else
        for (let i = 0; i < bytes.length; i++)
            bytes[i] = Math.random() * 256;
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function validArgs(value) {
    return Array.isArray(value) && value.every((v) => typeof v === 'string');
}
function validEnv(value) {
    return (!!value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.values(value).every((v) => typeof v === 'string'));
}
function validFields(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    for (const key of Object.keys(value)) {
        if (!FIELDS.includes(key))
            return false;
    }
    if ('pi_default_mode' in value &&
        value.pi_default_mode !== 'pi' &&
        value.pi_default_mode !== 'psi')
        return false;
    if ('psi_command' in value && typeof value.psi_command !== 'string')
        return false;
    if ('psi_args' in value && !validArgs(value.psi_args))
        return false;
    if ('psi_env' in value && !validEnv(value.psi_env))
        return false;
    return true;
}
// Normalise a server document. Older servers answer with the mode only, which
// is still a usable default; missing Psi fields are simply empty.
function normalizeState(value) {
    if (!value || typeof value !== 'object')
        return null;
    if (typeof value.revision !== 'number' ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 0 ||
        value.revision > MAX_REVISION)
        return null;
    if (value.pi_default_mode !== 'pi' && value.pi_default_mode !== 'psi')
        return null;
    return {
        revision: value.revision,
        pi_default_mode: value.pi_default_mode,
        psi_command: typeof value.psi_command === 'string' ? value.psi_command : '',
        psi_args: validArgs(value.psi_args) ? value.psi_args : [],
        psi_env: validEnv(value.psi_env) ? { ...value.psi_env } : {},
    };
}
function validDraft(value) {
    if (!value || typeof value !== 'object')
        return false;
    if (!validFields(value.fields))
        return false;
    const base = value.base;
    if (base !== null &&
        (typeof base !== 'number' || !Number.isSafeInteger(base)))
        return false;
    return (typeof value.version === 'number' && Number.isSafeInteger(value.version));
}
function validAttempt(value) {
    return (!!value &&
        typeof value.id === 'string' &&
        value.id.length > 0 &&
        validFields(value.fields) &&
        Object.keys(value.fields).length > 0 &&
        typeof value.base === 'number' &&
        Number.isSafeInteger(value.base) &&
        typeof value.version === 'number');
}
function sameValue(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
            return false;
        return a.every((item, index) => item === b[index]);
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        const left = a;
        const right = b;
        const keys = Object.keys(left);
        if (keys.length !== Object.keys(right).length)
            return false;
        return keys.every((key) => left[key] === right[key]);
    }
    return a === b;
}
// parsePsiArgs splits the textarea into argv entries. One entry per line, so
// spaces inside a line are part of that argument; blank lines add nothing.
export function parsePsiArgs(text) {
    const args = text.split(/\r?\n/).filter((line) => line !== '');
    for (const [index, arg] of args.entries()) {
        if (arg.includes('\u0000'))
            return {
                error: `Line ${index + 1}: an argument cannot contain NUL.`,
            };
    }
    return { value: args };
}
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
// parsePsiEnv reads KEY=VALUE lines. The value keeps every character after the
// first '=', and a duplicate name is an error instead of a silent override.
export function parsePsiEnv(text) {
    const env = Object.create(null);
    const seen = new Set();
    for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (line.trim() === '')
            continue;
        const separator = line.indexOf('=');
        if (separator <= 0)
            return { error: `Line ${index + 1}: expected KEY=VALUE.` };
        const key = line.slice(0, separator);
        const value = line.slice(separator + 1);
        if (!ENV_KEY.test(key))
            return {
                error: `Line ${index + 1}: ${key || 'the name'} must match [A-Za-z_][A-Za-z0-9_]*.`,
            };
        if (seen.has(key.toLowerCase()))
            return { error: `Line ${index + 1}: ${key} is already set above.` };
        seen.add(key.toLowerCase());
        env[key] = value;
    }
    return { value: { ...env } };
}
// PiLaunchStore owns the default agent and the Psi launch settings. Server
// state is revisioned, so two editors can never silently overwrite each other,
// and a write whose response was lost stays visibly unconfirmed instead of
// being resent.
export class PiLaunchStore {
    scope;
    owner;
    writer;
    confirmed = null;
    draft = EMPTY_DRAFT();
    attempt = null;
    phase = 'loading';
    error = '';
    storageWarning = '';
    disposed = false;
    timer = null;
    inflight = null;
    retries = 0;
    listeners = new Set();
    fetch;
    onWake = () => {
        if (this.disposed)
            return;
        void this.refresh();
    };
    onStorage = (event) => {
        if (this.disposed || !event.key)
            return;
        if (event.key.startsWith(CACHE_PREFIX) ||
            event.key.startsWith(PING_PREFIX))
            void this.refresh();
    };
    constructor(scope) {
        this.scope = scope;
        this.owner = appearanceOwner(scope);
        this.writer = randomId();
        this.fetch = appearanceRequestContext(scope).fetch;
        this.restore();
        if (typeof window !== 'undefined') {
            window.addEventListener('online', this.onWake);
            window.addEventListener('focus', this.onWake);
            window.addEventListener('storage', this.onStorage);
        }
    }
    // mode is what a launch in this browser should use right now: the local
    // choice when there is one, otherwise the last confirmed server default.
    get mode() {
        return (this.draft.fields.pi_default_mode ??
            this.confirmed?.pi_default_mode ??
            null);
    }
    get known() {
        return this.mode !== null;
    }
    // Confirmed Psi launch settings. A pending edit is not reflected here:
    // processes keep using the last value the server acknowledged.
    get psiCommand() {
        return this.confirmed?.psi_command ?? '';
    }
    get psiArgs() {
        return this.confirmed?.psi_args ?? [];
    }
    get psiEnv() {
        return this.confirmed?.psi_env ?? {};
    }
    // Draft value of a field, falling back to the confirmed one.
    value(key) {
        const draft = this.draft.fields[key];
        if (draft !== undefined)
            return draft;
        return this.confirmed?.[key];
    }
    // changedFields are the fields this browser would send right now.
    get changedFields() {
        const changed = {};
        for (const key of FIELDS) {
            const value = this.draft.fields[key];
            if (value === undefined)
                continue;
            if (sameValue(value, this.confirmed?.[key]))
                continue;
            changed[key] = value;
        }
        return changed;
    }
    get pending() {
        return Object.keys(this.changedFields).length > 0;
    }
    // canDiscard is false while a dispatched write may still land: a refresh
    // cannot cancel an outstanding request.
    get canDiscard() {
        return this.pending && !this.attempt;
    }
    get needsManualSave() {
        return (this.pending &&
            (this.phase === 'unknown' ||
                this.phase === 'conflict' ||
                this.phase === 'rejected'));
    }
    get status() {
        if (this.storageWarning)
            return this.storageWarning;
        switch (this.phase) {
            case 'saved':
                return 'Saved. Applies to new Pi tabs.';
            case 'pending': {
                const changed = Object.keys(this.changedFields);
                // A Psi launch field is not usable before the server confirms
                // it: every launch reads the saved settings.
                if (changed.some((key) => key !== 'pi_default_mode'))
                    return 'Pending. Launches keep using the saved Psi settings until this is confirmed.';
                return 'Pending. This browser uses it now; other clients keep the saved default until it is confirmed.';
            }
            case 'unknown':
                return 'Save outcome unknown. Refreshing to check; this will not be resent automatically.';
            case 'conflict':
                return (this.error || 'Changed elsewhere. Review and save again.');
            case 'rejected':
                return this.error || 'The server rejected this setting.';
            case 'unavailable':
                return this.error || 'Launch settings are unavailable.';
            default:
                return 'Loading the server default…';
        }
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    // choose applies the user's selection locally at once. The save is
    // debounced; rendering never waits for the network.
    choose(mode) {
        if (this.mode === mode)
            return;
        this.edit({ pi_default_mode: mode });
    }
    setCommand(command) {
        if ((this.value('psi_command') ?? '') === command)
            return;
        this.edit({ psi_command: command });
    }
    setArgs(args) {
        if (sameValue(this.value('psi_args') ?? [], args))
            return;
        this.edit({ psi_args: args });
    }
    setEnv(env) {
        if (sameValue(this.value('psi_env') ?? {}, env))
            return;
        this.edit({ psi_env: env });
    }
    // useServerValues discards local edits, but only when no dispatched write
    // can still land. Otherwise the caller must wait or resend explicitly.
    useServerValues() {
        if (this.attempt || this.disposed)
            return false;
        this.draft = EMPTY_DRAFT();
        this.error = '';
        this.phase = this.confirmed ? 'saved' : 'loading';
        this.persist();
        this.notify();
        return true;
    }
    // saveNow is the explicit "my changes" decision: read the current
    // revision, then replace it with the pending fields.
    async saveNow() {
        if (this.disposed)
            return;
        const fields = this.changedFields;
        const version = this.draft.version;
        if (!Object.keys(fields).length)
            return;
        await this.refresh();
        if (this.disposed || !this.confirmed)
            return;
        if (this.draft.version !== version)
            return;
        // An explicit save supersedes an unresolved attempt; the fresh
        // revision below decides whether it already landed.
        this.attempt = null;
        this.draft.base = this.confirmed.revision;
        await this.send(this.changedFields, this.confirmed.revision, version);
    }
    async refresh() {
        if (this.disposed)
            return false;
        if (this.inflight)
            return this.inflight;
        this.inflight = this.readState();
        try {
            return await this.inflight;
        }
        finally {
            this.inflight = null;
        }
    }
    dispose() {
        this.disposed = true;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = null;
        this.listeners.clear();
        if (typeof window !== 'undefined') {
            window.removeEventListener('online', this.onWake);
            window.removeEventListener('focus', this.onWake);
            window.removeEventListener('storage', this.onStorage);
        }
    }
    // edit records one field change. The draft base is pinned at the first
    // dirty edit and never silently rebased by a later refresh.
    edit(patch) {
        if (this.disposed)
            return;
        const fields = { ...this.draft.fields, ...patch };
        // A value that matches the server is no longer a draft, so restoring
        // the saved value clears the pending state without a request.
        for (const key of FIELDS) {
            if (key in fields && sameValue(fields[key], this.confirmed?.[key]))
                delete fields[key];
        }
        if (!Object.keys(fields).length) {
            this.draft = EMPTY_DRAFT();
            this.error = '';
            this.phase = this.confirmed ? 'saved' : 'loading';
            this.persist();
            this.notify();
            return;
        }
        if (this.draft.base === null)
            this.draft.base = this.confirmed?.revision ?? null;
        this.draft.fields = fields;
        this.draft.version++;
        this.error = '';
        this.phase = 'pending';
        this.persist();
        this.notify();
        this.schedule();
    }
    async readState() {
        let response;
        try {
            response = await this.request('/api/config/pi-launch', {
                cache: 'no-store',
            });
        }
        catch {
            this.markUnreachable();
            return false;
        }
        if (!response.ok) {
            this.markUnreachable(response.status);
            return false;
        }
        const state = await this.parseState(response);
        if (!state) {
            this.markUnreachable();
            return false;
        }
        this.retries = 0;
        this.reconcile(state);
        return true;
    }
    reconcile(state) {
        // A late, older response must not replace newer confirmed state.
        if (this.confirmed && state.revision < this.confirmed.revision)
            return;
        const attempt = this.attempt;
        if (attempt) {
            if (state.revision > attempt.base) {
                // The old attempt cannot apply any more. Matching values mean
                // it landed; anything else is someone else's write.
                const settled = this.attemptLanded(state, attempt);
                this.attempt = null;
                this.applyConfirmed(state);
                if (settled) {
                    this.clearDraftIfUnedited(attempt);
                    this.phase = this.pending ? 'pending' : 'saved';
                    this.error = '';
                }
                else {
                    this.phase = 'conflict';
                    this.error =
                        'The default changed elsewhere. Review and save again.';
                }
                this.persist();
                this.notify();
                if (this.phase === 'pending')
                    this.schedule();
                return;
            }
            // Same revision: the request may still be in flight or lost.
            this.applyConfirmed(state);
            this.phase = 'unknown';
            this.notify();
            return;
        }
        this.applyConfirmed(state);
        if (this.pending && this.draft.base === null)
            this.draft.base = state.revision;
        if (!this.pending) {
            this.phase = 'saved';
            this.error = '';
        }
        else if (this.draft.base !== state.revision) {
            // Never rebase a draft onto a revision it was not written for: the
            // explicit save is the user's decision to replace it.
            this.phase = 'conflict';
            this.error =
                'The default changed elsewhere. Review and save again.';
        }
        else {
            this.phase = 'pending';
            this.error = '';
        }
        this.persist();
        this.notify();
        if (this.phase === 'pending')
            this.schedule();
    }
    attemptLanded(state, attempt) {
        return Object.entries(attempt.fields).every(([key, value]) => sameValue(state[key], value));
    }
    // clearDraftIfUnedited drops the fields an acknowledged attempt carried,
    // but only while the user has not touched anything since.
    clearDraftIfUnedited(attempt) {
        if (this.draft.version !== attempt.version)
            return;
        this.draft = EMPTY_DRAFT();
    }
    applyConfirmed(state) {
        // A late, older reply must never replace newer confirmed state.
        if (this.confirmed && state.revision < this.confirmed.revision)
            return;
        this.confirmed = state;
        try {
            localStorage.setItem(CACHE_PREFIX + this.owner, JSON.stringify({ schema: SCHEMA, state }));
        }
        catch {
            /* the in-memory value stays authoritative */
        }
    }
    schedule() {
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.flush();
        }, DEBOUNCE_MS);
    }
    async flush() {
        if (this.disposed)
            return;
        // Never resend a write whose outcome is unknown.
        if (this.attempt)
            return;
        if (this.phase === 'conflict' ||
            this.phase === 'rejected' ||
            this.phase === 'unavailable')
            return;
        const fields = this.changedFields;
        if (!Object.keys(fields).length)
            return;
        if (!this.confirmed) {
            void this.refresh();
            return;
        }
        if (this.draft.base === null)
            this.draft.base = this.confirmed.revision;
        if (this.draft.base !== this.confirmed.revision) {
            this.phase = 'conflict';
            this.error =
                'The default changed elsewhere. Review and save again.';
            this.persist();
            this.notify();
            return;
        }
        await this.send(fields, this.draft.base, this.draft.version);
    }
    async send(fields, base, version) {
        if (this.disposed)
            return;
        const attempt = {
            id: randomId(),
            base,
            fields,
            version,
        };
        this.attempt = attempt;
        // The dispatch marker must be durable before the request leaves, so a
        // reload cannot mistake an applied write for unsent work.
        if (!this.persist()) {
            this.attempt = null;
            this.phase = 'pending';
            this.notify();
            return;
        }
        this.notify();
        let response;
        try {
            response = await this.request('/api/config/pi-launch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ revision: base, fields }),
            });
        }
        catch {
            this.phase = 'unknown';
            this.notify();
            return;
        }
        if (response.ok) {
            const state = await this.parseState(response);
            if (state && state.revision === base + 1) {
                // A newer confirmed state rules out trusting this older reply.
                const newer = !!this.confirmed &&
                    this.confirmed.revision > state.revision;
                this.attempt = null;
                if (!newer) {
                    this.applyConfirmed(state);
                    if (this.attemptLanded(state, attempt))
                        this.clearDraftIfUnedited(attempt);
                    this.phase = this.pending ? 'pending' : 'saved';
                    this.error = '';
                }
                else if (this.attemptLanded(this.confirmed, attempt)) {
                    this.clearDraftIfUnedited(attempt);
                    this.phase = this.pending ? 'pending' : 'saved';
                }
                else {
                    this.phase = 'conflict';
                    this.error =
                        'The default changed elsewhere. Review and save again.';
                }
                this.persist();
                this.notify();
                if (this.phase === 'saved')
                    this.ping();
                return;
            }
            this.phase = 'unknown';
            this.notify();
            return;
        }
        if (response.status === 409) {
            const state = await this.parseState(response);
            this.attempt = null;
            if (state)
                this.applyConfirmed(state);
            if (this.pending) {
                this.phase = 'conflict';
                this.error =
                    'The default changed elsewhere. Review and save again.';
            }
            else {
                this.phase = 'saved';
                this.error = '';
            }
            this.persist();
            this.notify();
            return;
        }
        if (response.status === 400) {
            this.attempt = null;
            // A rejection describes the input that was sent, not whatever the
            // user has typed since.
            if (this.draft.version === version) {
                this.phase = 'rejected';
                this.error =
                    (await response.text().catch(() => '')).trim() ||
                        'The server rejected this setting.';
            }
            else {
                this.phase = this.pending
                    ? 'pending'
                    : this.confirmed
                        ? 'saved'
                        : 'loading';
                this.error = '';
            }
            this.persist();
            this.notify();
            if (this.phase === 'pending')
                this.schedule();
            return;
        }
        if (response.status === 401 || response.status === 403) {
            this.phase = 'unavailable';
            this.error = 'Sign in again to change this setting.';
            this.notify();
            return;
        }
        if (response.status === 404 || response.status === 405) {
            this.attempt = null;
            this.phase = 'unavailable';
            this.error = 'This server does not support launch settings.';
            this.persist();
            this.notify();
            return;
        }
        this.phase = 'unknown';
        this.notify();
    }
    markUnreachable(status) {
        if (this.confirmed === null) {
            this.phase = 'unavailable';
            this.error = status
                ? `Launch settings are unavailable (HTTP ${status}).`
                : 'Launch settings are unavailable until the connection returns.';
            this.notify();
        }
        if (this.confirmed === null || this.attempt) {
            const delay = BACKOFF_MS[Math.min(this.retries, BACKOFF_MS.length - 1)];
            this.retries++;
            if (this.timer)
                clearTimeout(this.timer);
            this.timer = setTimeout(() => {
                this.timer = null;
                void this.refresh();
            }, delay);
        }
    }
    async parseState(response) {
        try {
            return normalizeState(await response.json());
        }
        catch {
            return null;
        }
    }
    request(url, init = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        return this.fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
    }
    ping() {
        try {
            localStorage.setItem(PING_PREFIX + this.owner, String(Date.now()));
        }
        catch {
            /* cross-tab refresh is best-effort */
        }
    }
    // restore loads this document's own record first, then the record of the
    // writer this document was opened from. A→B→A therefore finds A's own
    // pending state, while a reload copies its predecessor's draft into a
    // fresh writer identity.
    restore() {
        try {
            const cached = JSON.parse(localStorage.getItem(CACHE_PREFIX + this.owner) || 'null');
            if (cached?.schema === SCHEMA)
                this.confirmed = normalizeState(cached.state);
        }
        catch {
            /* keep the default empty state */
        }
        const own = this.readRecord(this.writer);
        const source = own ?? this.readRecord(this.predecessor());
        if (source) {
            this.draft = source.draft;
            // A copied dispatched attempt stays unknown and is never resent.
            this.attempt = source.attempt ? { ...source.attempt } : null;
            if (this.attempt)
                this.phase = 'unknown';
            else if (this.pending)
                this.phase = 'pending';
            else if (this.confirmed)
                this.phase = 'saved';
        }
        else if (this.confirmed) {
            this.phase = 'saved';
        }
        this.remember();
    }
    readRecord(writer) {
        if (!writer)
            return null;
        try {
            const value = JSON.parse(localStorage.getItem(RECORD_PREFIX + this.owner + ':' + writer) || 'null');
            if (value?.schema !== SCHEMA || value.owner !== this.owner)
                return null;
            if (!validDraft(value.draft))
                return null;
            if (value.attempt !== null && !validAttempt(value.attempt))
                return null;
            return {
                schema: SCHEMA,
                owner: this.owner,
                writer: String(value.writer || writer),
                draft: value.draft,
                attempt: value.attempt,
            };
        }
        catch {
            return null;
        }
    }
    predecessor() {
        try {
            return sessionStorage.getItem(WRITER_PREFIX + this.owner);
        }
        catch {
            return null;
        }
    }
    remember() {
        try {
            sessionStorage.setItem(WRITER_PREFIX + this.owner, this.writer);
        }
        catch {
            /* the recovery hint is optional */
        }
    }
    persist() {
        try {
            localStorage.setItem(RECORD_PREFIX + this.owner + ':' + this.writer, JSON.stringify({
                schema: SCHEMA,
                owner: this.owner,
                writer: this.writer,
                draft: this.draft,
                attempt: this.attempt,
            }));
            if (this.storageWarning) {
                this.storageWarning = '';
                this.notify();
            }
            return true;
        }
        catch {
            if (!this.storageWarning) {
                this.storageWarning =
                    'Browser storage is unavailable; a reload will lose these edits.';
                this.notify();
            }
            return false;
        }
    }
    notify() {
        for (const listener of this.listeners)
            listener();
    }
}
