import { appearanceOwner, appearanceRequestContext, } from './mobile-appearance.js';
const SCHEMA = 2;
const CACHE_PREFIX = 'phi:pi-launch-cache:v1:';
const RECORD_PREFIX = 'phi:pi-launch-record:v1:';
const WRITER_PREFIX = 'phi:pi-launch-writer:v1:';
const PING_PREFIX = 'phi:pi-launch-ping:v1:';
const MAX_REVISION = Number.MAX_SAFE_INTEGER;
const DEBOUNCE_MS = 300;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
const FIELDS = [
    'pi_default_mode',
    'psi_command',
    'psi_args',
    'psi_env',
];
const TEXT_FIELDS = ['psi_command', 'psi_args', 'psi_env'];
const emptyDraft = () => ({
    fields: {},
    raw: {},
    versions: {},
    rejected: {},
    base: null,
    version: 0,
});
const validRevision = (value) => typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_REVISION;
const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const validArgs = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
const validEnv = (value) => object(value) &&
    Object.values(value).every((item) => typeof item === 'string');
function randomId() {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function validFields(value) {
    if (!object(value) ||
        Object.keys(value).some((key) => !FIELDS.includes(key)))
        return false;
    return ((!('pi_default_mode' in value) ||
        value.pi_default_mode === 'pi' ||
        value.pi_default_mode === 'psi') &&
        (!('psi_command' in value) || typeof value.psi_command === 'string') &&
        (!('psi_args' in value) || validArgs(value.psi_args)) &&
        (!('psi_env' in value) || validEnv(value.psi_env)));
}
// Shape checks are deliberately separate from editor validation: malformed
// stored Psi syntax must not hide the revision needed for Pi-only recovery.
function normalizeState(value) {
    if (!object(value) || !validRevision(value.revision))
        return null;
    const { revision, ...fields } = value;
    const selected = Object.fromEntries(FIELDS.filter((key) => key in fields).map((key) => [key, fields[key]]));
    if (!validFields(selected) || !selected.pi_default_mode)
        return null;
    return {
        revision,
        pi_default_mode: selected.pi_default_mode,
        psi_command: selected.psi_command ?? '',
        psi_args: selected.psi_args ?? [],
        psi_env: selected.psi_env ?? {},
    };
}
function sameValue(a, b) {
    if (Array.isArray(a) || Array.isArray(b))
        return (Array.isArray(a) &&
            Array.isArray(b) &&
            a.length === b.length &&
            a.every((item, i) => item === b[i]));
    if (object(a) && object(b))
        return (Object.keys(a).length === Object.keys(b).length &&
            Object.keys(a).every((key) => Object.hasOwn(b, key) && a[key] === b[key]));
    return a === b;
}
export function parsePsiArgs(text) {
    const args = [];
    for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (line.includes('\0') || line.includes('\r'))
            return {
                error: `Line ${index + 1}: an argument cannot contain NUL or a carriage return.`,
            };
        if (line !== '')
            args.push(line);
    }
    return { value: args };
}
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ENV = /^(?:PATH|COLORTERM|PHI_CLIPBOARD_FILE|PHI_PI_ATTACHMENT_ROOT|PHI_PI_BRIDGE_.*)$/i;
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
                error: `Line ${index + 1}: ${key} must match [A-Za-z_][A-Za-z0-9_]*.`,
            };
        if (seen.has(key.toLowerCase()))
            return { error: `Line ${index + 1}: ${key} is already set above.` };
        if (RESERVED_ENV.test(key))
            return {
                error: `Line ${index + 1}: ${key} is set by Phi and cannot be overridden.`,
            };
        if (value.includes('\0') || value.includes('\r'))
            return {
                error: `Line ${index + 1}: the value cannot contain NUL or a carriage return.`,
            };
        seen.add(key.toLowerCase());
        env[key] = value;
    }
    return { value: { ...env } };
}
function parseText(key, text) {
    if (key === 'psi_args')
        return parsePsiArgs(text);
    if (key === 'psi_env')
        return parsePsiEnv(text);
    return text.includes('\0') || /[\r\n]/.test(text)
        ? { error: 'The executable cannot contain NUL or line breaks.' }
        : { value: text };
}
function validVersions(value) {
    return (object(value) &&
        Object.entries(value).every(([key, version]) => FIELDS.includes(key) && validRevision(version)));
}
function validAttempt(value) {
    return (object(value) &&
        typeof value.id === 'string' &&
        value.id !== '' &&
        validRevision(value.base) &&
        validFields(value.fields) &&
        Object.keys(value.fields).length > 0 &&
        validVersions(value.versions) &&
        Object.keys(value.fields).every((key) => Object.hasOwn(value.versions, key)));
}
function validDraft(value) {
    return (object(value) &&
        validFields(value.fields) &&
        validVersions(value.versions) &&
        validRevision(value.version) &&
        (value.conflict === undefined || typeof value.conflict === 'boolean') &&
        (value.base === null || validRevision(value.base)) &&
        object(value.raw) &&
        Object.entries(value.raw).every(([key, text]) => TEXT_FIELDS.includes(key) &&
            typeof text === 'string') &&
        object(value.rejected) &&
        Object.entries(value.rejected).every(([key, error]) => FIELDS.includes(key) &&
            object(error) &&
            validRevision(error.version) &&
            typeof error.message === 'string'));
}
// One writer record contains raw edits, field versions, their base revision and
// the dispatched snapshot. Only an own POST acknowledgement can rebase edits.
export class PiLaunchStore {
    scope;
    writer;
    owner;
    confirmed = null;
    draft = emptyDraft();
    attempt = null;
    phase = 'loading';
    error = '';
    storageWarning = '';
    disposed = false;
    saveTimer = null;
    readTimer = null;
    inflight = null;
    explicit = false;
    unavailable = false;
    rolledBack = false;
    retries = 0;
    listeners = new Set();
    fetch;
    onWake = () => {
        void this.refresh();
    };
    onAbort = () => this.dispose();
    onStorage = (event) => {
        // GET cache writes are not hints: listening to them creates a refresh
        // loop between two tabs. Broadcast only an owner's successful writes.
        if (event.key === PING_PREFIX + this.owner)
            void this.refresh();
    };
    constructor(scope, writer = randomId()) {
        this.scope = scope;
        this.writer = writer;
        this.owner = appearanceOwner(scope);
        this.fetch = appearanceRequestContext(scope).fetch;
        this.restore();
        scope.signal.addEventListener('abort', this.onAbort, { once: true });
        if (typeof window !== 'undefined') {
            window.addEventListener('online', this.onWake);
            window.addEventListener('focus', this.onWake);
            window.addEventListener('storage', this.onStorage);
        }
        if (scope.aborted)
            this.dispose();
    }
    get mode() {
        return (this.draft.fields.pi_default_mode ??
            this.confirmed?.pi_default_mode ??
            null);
    }
    get known() {
        return this.mode !== null;
    }
    get psiCommand() {
        return this.confirmed?.psi_command ?? '';
    }
    get psiArgs() {
        return this.confirmed?.psi_args ?? [];
    }
    get psiEnv() {
        return this.confirmed?.psi_env ?? {};
    }
    value(key) {
        return (this.draft.fields[key] ?? this.confirmed?.[key]);
    }
    text(key) {
        if (Object.hasOwn(this.draft.raw, key))
            return this.draft.raw[key];
        const value = this.value(key);
        if (key === 'psi_args')
            return value?.join('\n') ?? '';
        if (key === 'psi_env')
            return Object.entries(value ?? {})
                .map(([name, entry]) => `${name}=${entry}`)
                .join('\n');
        return value ?? '';
    }
    fieldError(key) {
        if (key !== 'pi_default_mode' && Object.hasOwn(this.draft.raw, key)) {
            const parsed = parseText(key, this.draft.raw[key]);
            if ('error' in parsed)
                return parsed.error;
        }
        const rejection = this.draft.rejected[key];
        return rejection?.version === this.draft.versions[key]
            ? (rejection?.message ?? '')
            : '';
    }
    get changedFields() {
        return { ...this.draft.fields };
    }
    get pending() {
        return Object.keys(this.draft.versions).length > 0;
    }
    get canDiscard() {
        return this.pending && !this.attempt && !this.explicit;
    }
    get needsManualSave() {
        return (!!this.attempt ||
            (this.pending &&
                ['unknown', 'conflict', 'rejected'].includes(this.phase) &&
                Object.keys(this.eligibleFields(true)).length > 0));
    }
    get status() {
        if (this.storageWarning)
            return this.storageWarning;
        if (this.phase === 'saved')
            return 'Saved. Applies to new Pi tabs.';
        if (this.phase === 'pending')
            return 'Pending. The default applies in this browser now; launches use saved Psi settings until confirmed.';
        if (this.phase === 'unknown')
            return 'Save outcome unknown. Checking the server; this will not be resent automatically.';
        if (this.phase === 'conflict')
            return (this.error ||
                'Changed elsewhere. Review your draft, then save or use server values.');
        if (this.phase === 'rejected')
            return 'Not saved. Correct the marked fields or use server values.';
        if (this.phase === 'unavailable')
            return (this.error ||
                'Launch settings are unavailable. Your edits are kept.');
        return 'Loading the server default…';
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    choose(mode) {
        if (this.mode !== mode)
            this.edit('pi_default_mode', mode);
    }
    setCommand(command) {
        this.editText('psi_command', command);
    }
    setArgs(args) {
        this.editText('psi_args', args.join('\n'));
    }
    setEnv(env) {
        this.editText('psi_env', Object.entries(env)
            .map(([key, value]) => `${key}=${value}`)
            .join('\n'));
    }
    editText(key, text) {
        if (this.text(key) === text)
            return;
        const parsed = parseText(key, text);
        this.edit(key, 'value' in parsed ? parsed.value : undefined, text);
    }
    edit(key, value, raw) {
        if (this.disposed)
            return;
        if (!this.pending) {
            this.draft.base = this.confirmed?.revision ?? null;
            this.draft.conflict = false;
        }
        this.draft.version++;
        this.draft.versions[key] = this.draft.version;
        delete this.draft.rejected[key];
        if (raw !== undefined && key !== 'pi_default_mode')
            this.draft.raw[key] = raw;
        if (value === undefined)
            delete this.draft.fields[key];
        else
            this.draft.fields[key] = value;
        // Do not drop a return-to-saved edit while an older request can change
        // that saved value. It must be sent after the older acknowledgement.
        if (!this.attempt &&
            !this.explicit &&
            value !== undefined &&
            sameValue(value, this.confirmed?.[key]))
            this.clearField(key);
        this.error = '';
        this.setPhase();
        this.persist();
        this.notify();
        this.scheduleSave();
    }
    useServerValues() {
        if (this.attempt || this.explicit || this.disposed)
            return false;
        const version = this.draft.version;
        this.draft = emptyDraft();
        this.draft.version = version;
        this.error = '';
        this.setPhase();
        this.persist();
        this.notify();
        return true;
    }
    async saveNow() {
        if (this.disposed || this.explicit)
            return;
        const fields = this.eligibleFields(true);
        if (!Object.keys(fields).length)
            return;
        const versions = { ...this.draft.versions };
        this.explicit = true;
        this.notify();
        try {
            // Do not send from a cached revision if the fresh read failed.
            if (!(await this.refresh()) ||
                this.disposed ||
                !this.confirmed ||
                this.unavailable ||
                this.rolledBack)
                return;
            await this.send(fields, this.confirmed.revision, versions);
        }
        finally {
            this.explicit = false;
            this.notify();
        }
    }
    async refresh() {
        if (this.disposed)
            return false;
        if (this.inflight)
            return this.inflight;
        if (this.readTimer)
            clearTimeout(this.readTimer);
        this.readTimer = null;
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
        if (this.saveTimer)
            clearTimeout(this.saveTimer);
        if (this.readTimer)
            clearTimeout(this.readTimer);
        this.saveTimer = this.readTimer = null;
        this.listeners.clear();
        this.scope.signal.removeEventListener('abort', this.onAbort);
        if (typeof window !== 'undefined') {
            window.removeEventListener('online', this.onWake);
            window.removeEventListener('focus', this.onWake);
            window.removeEventListener('storage', this.onStorage);
        }
    }
    clearField(key) {
        delete this.draft.fields[key];
        delete this.draft.versions[key];
        delete this.draft.rejected[key];
    }
    setPhase() {
        if (this.unavailable)
            this.phase = 'unavailable';
        else if (this.attempt)
            this.phase = 'unknown';
        else if (this.rolledBack ||
            (this.pending && this.draft.conflict) ||
            (this.pending &&
                this.draft.base !== null &&
                this.confirmed &&
                this.draft.base !== this.confirmed.revision))
            this.phase = 'conflict';
        else if (FIELDS.some((key) => !!this.fieldError(key)))
            this.phase = 'rejected';
        else
            this.phase = this.pending
                ? 'pending'
                : this.confirmed
                    ? 'saved'
                    : 'loading';
    }
    eligibleFields(explicit = false) {
        // Recovery to Pi must never be bundled with invalid Psi settings.
        if (this.draft.fields.pi_default_mode === 'pi' &&
            (explicit || !this.fieldError('pi_default_mode')))
            return { pi_default_mode: 'pi' };
        const fields = { ...this.draft.fields };
        const invalidPsi = TEXT_FIELDS.some((key) => {
            const raw = this.draft.raw[key];
            return raw !== undefined && 'error' in parseText(key, raw);
        });
        if (invalidPsi)
            return {};
        for (const key of FIELDS)
            if (!explicit && this.fieldError(key))
                delete fields[key];
        return fields;
    }
    scheduleSave() {
        if (this.saveTimer)
            clearTimeout(this.saveTimer);
        if (this.disposed)
            return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            void this.flush();
        }, DEBOUNCE_MS);
    }
    scheduleRead() {
        if (this.disposed || this.readTimer || this.unavailable)
            return;
        const delay = BACKOFF_MS[Math.min(this.retries++, BACKOFF_MS.length - 1)];
        this.readTimer = setTimeout(() => {
            this.readTimer = null;
            void this.refresh();
        }, delay);
    }
    async flush() {
        if (this.disposed ||
            this.explicit ||
            this.attempt ||
            this.unavailable ||
            this.rolledBack ||
            this.draft.conflict)
            return;
        if (!this.confirmed) {
            void this.refresh();
            return;
        }
        if (this.draft.base !== this.confirmed.revision)
            return;
        const fields = this.eligibleFields();
        if (Object.keys(fields).length)
            await this.send(fields, this.confirmed.revision, {
                ...this.draft.versions,
            });
    }
    async readState() {
        const revisionAtStart = this.confirmed?.revision ?? 0;
        try {
            const response = await this.fetch('/api/config/pi-launch', {
                cache: 'no-store',
            });
            if (this.disposed)
                return false;
            if (!response.ok) {
                if ([401, 403, 404, 405].includes(response.status)) {
                    this.unavailable = true;
                    this.error =
                        response.status === 401 || response.status === 403
                            ? 'Sign in again to save launch settings. Your edits are kept.'
                            : 'This server does not support launch settings. Per-launch Pi/Psi actions still work.';
                }
                throw new Error('read failed');
            }
            const state = normalizeState(await response.json());
            if (this.disposed)
                return false;
            if (!state)
                throw new Error('invalid state');
            this.unavailable = false;
            this.error = '';
            this.reconcile(state, revisionAtStart);
            return true;
        }
        catch {
            if (this.disposed)
                return false;
            this.setPhase();
            if (!this.confirmed && !this.attempt) {
                this.phase = 'unavailable';
                this.error ||=
                    'Launch settings are offline. Your edits are kept.';
            }
            this.notify();
            this.scheduleRead();
            return false;
        }
    }
    reconcile(state, revisionAtStart) {
        if (this.confirmed && state.revision < this.confirmed.revision) {
            // An old GET overtaken by our own POST is not a server rollback.
            if (state.revision >= revisionAtStart)
                return;
            this.rolledBack = true;
            this.error =
                'The server returned an older revision. Automatic saves are paused; reload after checking the server.';
            this.setPhase();
            this.notify();
            return;
        }
        this.applyConfirmed(state);
        const attempt = this.attempt;
        if (attempt && state.revision > attempt.base) {
            this.attempt = null;
            if (this.matches(state, attempt.fields))
                this.clearAcknowledged(attempt, state);
            // Matching GET values do not identify our writer. Keep the original
            // base for newer edits, which might otherwise overwrite an editor.
        }
        if (this.pending && this.draft.base === null)
            this.draft.base = state.revision;
        this.setPhase();
        this.persist();
        this.notify();
        if (this.attempt)
            this.scheduleRead();
        else {
            this.retries = 0;
            this.scheduleSave();
        }
    }
    matches(state, fields) {
        return Object.entries(fields).every(([key, value]) => sameValue(state[key], value));
    }
    clearAcknowledged(attempt, state) {
        for (const key of FIELDS) {
            if (key in attempt.fields &&
                this.draft.versions[key] === attempt.versions[key] &&
                sameValue(state[key], attempt.fields[key]))
                this.clearField(key);
        }
    }
    applyConfirmed(state) {
        this.confirmed = state;
        for (const key of TEXT_FIELDS) {
            const raw = this.draft.raw[key];
            if (this.draft.versions[key] !== undefined || raw === undefined)
                continue;
            const parsed = parseText(key, raw);
            if ('error' in parsed || !sameValue(parsed.value, state[key]))
                delete this.draft.raw[key];
        }
        try {
            localStorage.setItem(CACHE_PREFIX + this.owner, JSON.stringify({ schema: SCHEMA, state }));
        }
        catch {
            /* memory still works */
        }
    }
    async send(fields, base, versions) {
        if (this.disposed || !Object.keys(fields).length)
            return;
        const previous = this.attempt;
        const attempt = { id: randomId(), base, fields, versions };
        this.attempt = attempt;
        // One durable replacement before dispatch. On storage failure preserve
        // an older unresolved attempt, not a false never-sent state.
        if (!this.persist()) {
            this.attempt = previous;
            this.setPhase();
            this.notify();
            return;
        }
        this.phase = 'pending';
        this.notify();
        let response;
        try {
            response = await this.fetch('/api/config/pi-launch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ revision: base, fields }),
            });
        }
        catch {
            if (this.disposed || this.attempt?.id !== attempt.id)
                return;
            this.setPhase();
            this.notify();
            this.scheduleRead();
            return;
        }
        if (this.disposed || this.attempt?.id !== attempt.id)
            return;
        if (response.ok || response.status === 409) {
            let state = null;
            try {
                state = normalizeState(await response.json());
            }
            catch {
                /* unknown */
            }
            if (this.disposed || this.attempt?.id !== attempt.id)
                return;
            if (state &&
                (response.status === 409 ||
                    (state.revision === base + 1 &&
                        this.matches(state, fields)))) {
                const newer = this.confirmed && this.confirmed.revision > state.revision;
                if (!newer)
                    this.applyConfirmed(state);
                this.attempt = null;
                if (response.ok) {
                    this.clearAcknowledged(attempt, this.confirmed);
                    if (!newer) {
                        this.draft.base = state.revision;
                        this.draft.conflict = false;
                    }
                    try {
                        localStorage.setItem(PING_PREFIX + this.owner, attempt.id);
                    }
                    catch {
                        /* best-effort hint */
                    }
                }
                else {
                    // Hand edits can race without incrementing the revision.
                    // A 409 still requires an explicit save in that case.
                    this.draft.conflict = true;
                }
                this.setPhase();
                this.persist();
                this.notify();
                this.scheduleSave();
                return;
            }
        }
        else if ([400, 401, 403, 404, 405, 413, 415, 422].includes(response.status)) {
            const message = (await response.text().catch(() => '')).trim() ||
                'The server rejected these launch settings.';
            if (this.disposed || this.attempt?.id !== attempt.id)
                return;
            this.attempt = null;
            if ([401, 403, 404, 405].includes(response.status)) {
                this.unavailable = true;
                this.error = [401, 403].includes(response.status)
                    ? 'Sign in again to save launch settings. Your edits are kept.'
                    : 'This server does not support launch settings. Per-launch Pi/Psi actions still work.';
            }
            else {
                for (const key of FIELDS)
                    if (key in fields &&
                        this.draft.versions[key] === versions[key])
                        this.draft.rejected[key] = {
                            version: versions[key],
                            message,
                        };
                // An edit made while this request was in flight can return to
                // the saved value, but only now is it safe to drop that edit.
                for (const key of FIELDS)
                    if (this.draft.versions[key] !== versions[key] &&
                        sameValue(this.draft.fields[key], this.confirmed?.[key]))
                        this.clearField(key);
            }
            this.setPhase();
            this.persist();
            this.notify();
            this.scheduleSave();
            return;
        }
        this.setPhase();
        this.notify();
        this.scheduleRead();
    }
    restore() {
        try {
            const cached = JSON.parse(localStorage.getItem(CACHE_PREFIX + this.owner) || 'null');
            if (cached?.schema === SCHEMA || cached?.schema === 1)
                this.confirmed = normalizeState(cached.state);
            const predecessor = sessionStorage.getItem(WRITER_PREFIX + this.owner);
            for (const writer of [this.writer, predecessor]) {
                if (!writer)
                    continue;
                const record = JSON.parse(localStorage.getItem(RECORD_PREFIX + this.owner + ':' + writer) || 'null');
                if (record?.schema !== SCHEMA ||
                    record.owner !== this.owner ||
                    !validDraft(record.draft) ||
                    (record.attempt !== null && !validAttempt(record.attempt)))
                    continue;
                this.draft = record.draft;
                this.attempt = record.attempt;
                break;
            }
        }
        catch {
            /* keep the valid in-memory values */
        }
        this.setPhase();
        this.persist();
        try {
            sessionStorage.setItem(WRITER_PREFIX + this.owner, this.writer);
        }
        catch {
            /* recovery hint only */
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
            this.storageWarning = '';
            return true;
        }
        catch {
            this.storageWarning =
                'Browser storage is unavailable. Edits stay in memory; saves are paused and a reload will lose them.';
            return false;
        }
    }
    notify() {
        if (!this.disposed)
            for (const listener of this.listeners)
                listener();
    }
}
