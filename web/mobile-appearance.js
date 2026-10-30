import { BackendScope } from './backend-scope.js';
export const EMPTY_MOBILE = {
    revision: 0,
    ui_font_size: null,
    terminal_font_size: null,
    ui_font_family: null,
    terminal_font_family: null,
};
const KEYS = [
    'ui_font_size',
    'terminal_font_size',
    'ui_font_family',
    'terminal_font_family',
];
const PROFILE_KEY = 'phi_appearance_profile';
const TIMEOUT = 15_000;
export const MOBILE_ROUTE = '/api/config/mobile-appearance';
export function selectAppearanceProfile(identity) {
    if (identity.native)
        return 'desktop';
    if (identity.override === 'desktop' || identity.override === 'mobile')
        return identity.override;
    return /Android|iPhone|iPad|iPod/i.test(identity.userAgent) ||
        (identity.platform === 'MacIntel' && identity.touchPoints > 1)
        ? 'mobile'
        : 'desktop';
}
let memoryOverride = null;
export function readProfileOverride() {
    if (memoryOverride)
        return memoryOverride;
    try {
        const value = localStorage.getItem(PROFILE_KEY);
        return value === 'desktop' || value === 'mobile' ? value : 'auto';
    }
    catch {
        return 'auto';
    }
}
export function writeProfileOverride(value) {
    memoryOverride = value;
    try {
        localStorage.setItem(PROFILE_KEY, value);
        return true;
    }
    catch {
        return false;
    }
}
export function currentAppearanceProfile() {
    const params = new URLSearchParams(location.search);
    return selectAppearanceProfile({
        native: params.get('desktop') === '1' ||
            params.get('desktop-popout') === '1' ||
            !!window.__phiDesktop ||
            location.protocol === 'phi-app:',
        override: readProfileOverride(),
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        touchPoints: navigator.maxTouchPoints || 0,
    });
}
export function captureAppearanceScope() {
    const params = new URLSearchParams(location.search);
    const embedded = params.get('embedded') === '1' || location.protocol === 'phi-app:';
    const profile = params.get('profile') || '';
    const origin = params.get('origin') || '';
    if (embedded && (!profile || !origin))
        throw new Error('Settings backend ownership is unavailable. Open Settings from the selected server.');
    if (embedded && !/^https?:$/.test(new URL(origin).protocol))
        throw new Error('Invalid Settings backend origin');
    return new BackendScope(embedded ? profile : '', embedded ? new URL(origin).origin : location.origin);
}
export function appearanceOwner(scope) {
    return JSON.stringify([
        location.origin,
        scope.profileId,
        scope.origin || location.origin,
    ]);
}
export function appearanceCacheKey(scope) {
    return `phi:mobile-appearance:v1:${appearanceOwner(scope)}`;
}
export function legacyAppearanceKey(scope) {
    return scope.profileId
        ? `phi:desktop-appearance:v1:${appearanceOwner(scope)}`
        : 'phi_appearance';
}
export function readAppearanceCache(scope) {
    try {
        const cache = JSON.parse(localStorage.getItem(appearanceCacheKey(scope)) || 'null');
        return cache?.schema === 1 && validMobileAppearance(cache.mobile)
            ? cache.mobile
            : null;
    }
    catch {
        return null;
    }
}
export function readInheritanceCache(scope) {
    try {
        const cache = JSON.parse(localStorage.getItem(appearanceCacheKey(scope)) || 'null');
        return cache?.schema === 1 && validInheritedFamilies(cache.inheritance)
            ? cache.inheritance
            : null;
    }
    catch {
        return null;
    }
}
function validInheritedFamilies(value) {
    if (!value || typeof value !== 'object')
        return false;
    const fields = value;
    return ['ui_font_family', 'terminal_font_family'].every((key) => typeof fields[key] === 'string' &&
        new TextEncoder().encode(fields[key]).length <= 512 &&
        !/\p{Cc}/u.test(fields[key]));
}
export function validMobileAppearance(value) {
    return (value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length === 5 &&
        Number.isSafeInteger(value.revision) &&
        value.revision >= 0 &&
        KEYS.every((key) => {
            const v = value[key];
            if (v === null)
                return true;
            if (key.endsWith('_size'))
                return (Number.isInteger(v) &&
                    v >= (key === 'ui_font_size' ? 10 : 8) &&
                    v <= (key === 'ui_font_size' ? 24 : 32));
            return (typeof v === 'string' &&
                new TextEncoder().encode(v).length <= 512 &&
                !/\p{Cc}/u.test(v));
        }));
}
export function effectiveAppearance(profile, desktop, mobile, inheritance = desktop) {
    const uiFamily = mobile.ui_font_family ?? inheritance.ui_font_family ?? '';
    const terminalFamily = mobile.terminal_font_family ?? inheritance.terminal_font_family ?? '';
    return {
        ui_font_size: profile === 'mobile'
            ? (mobile.ui_font_size ?? 17)
            : Number(desktop.ui_font_size) || 0,
        ui_font_family: profile === 'mobile'
            ? uiFamily === 'Phi Custom Font'
                ? '"Phi Custom Font", system-ui, sans-serif'
                : uiFamily
            : desktop.ui_font_family || '',
        terminal_font_size: profile === 'mobile'
            ? (mobile.terminal_font_size ?? 14)
            : Number(desktop.terminal_font_size) || 0,
        terminal_font_family: profile === 'mobile'
            ? terminalFamily === 'Phi Custom Font'
                ? '"Phi Custom Font", monospace'
                : terminalFamily
            : desktop.terminal_font_family || '',
    };
}
export function appearanceRequestContext(scope) {
    return {
        fetch: (url, init) => ownerFetch(scope, url, init),
        credentialKey: scope.profileId
            ? `phi_access_credential_v1:${scope.profileId}`
            : 'phi_access_credential_v1',
    };
}
export function readDesktopAppearance(scope) {
    try {
        return (JSON.parse(localStorage.getItem(legacyAppearanceKey(scope)) || 'null') || {});
    }
    catch {
        return {};
    }
}
export function mobileSystemTextRatio(size) {
    return Number.isFinite(size) && size > 0 ? Math.max(1, size / 17) : 1;
}
let systemTextProbe = null;
let systemTextObserver = null;
let systemTextRatio = 1;
let currentFonts = null;
function observeSystemText() {
    document.removeEventListener('DOMContentLoaded', observeSystemText);
    if (currentFonts?.profile !== 'mobile' || !document.body || systemTextProbe)
        return;
    const probe = document.createElement('span');
    probe.id = 'phi-system-text-probe';
    probe.setAttribute('aria-hidden', 'true');
    probe.textContent = 'M';
    // Keep the system style independent of the selected UI family and size.
    probe.style.cssText =
        'position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none;font:17px system-ui;';
    probe.style.font = '-apple-system-body';
    document.body.appendChild(probe);
    systemTextProbe = probe;
    const measure = () => {
        const ratio = mobileSystemTextRatio(parseFloat(getComputedStyle(probe).fontSize));
        if (ratio === systemTextRatio || currentFonts?.profile !== 'mobile')
            return;
        systemTextRatio = ratio;
        applyAppearanceFonts(currentFonts.profile, currentFonts.appearance);
    };
    if (typeof ResizeObserver !== 'undefined') {
        systemTextObserver = new ResizeObserver(measure);
        systemTextObserver.observe(probe);
    }
    measure();
}
export function applyAppearanceFonts(profile, appearance) {
    currentFonts = { profile, appearance };
    if (profile === 'mobile') {
        if (document.body)
            observeSystemText();
        else
            document.addEventListener('DOMContentLoaded', observeSystemText, {
                once: true,
            });
    }
    else {
        document.removeEventListener('DOMContentLoaded', observeSystemText);
        systemTextObserver?.disconnect();
        systemTextObserver = null;
        systemTextProbe?.remove();
        systemTextProbe = null;
        systemTextRatio = 1;
    }
    const size = appearance.ui_font_size * (profile === 'mobile' ? systemTextRatio : 1);
    document.documentElement.dataset.appearanceProfile = profile;
    document.documentElement.style.setProperty('--mobile-ui-size', `${size || 17}px`);
    // A CSSOM property assignment keeps saved font stacks out of stylesheet source.
    let sheet = document.getElementById('phi-prepaint-appearance');
    if (!sheet) {
        sheet = document.createElement('style');
        sheet.id = 'phi-prepaint-appearance';
        document.head.appendChild(sheet);
    }
    if (sheet.sheet && !sheet.sheet.cssRules.length)
        sheet.sheet.insertRule('body {}');
    const style = sheet.sheet?.cssRules[0]?.style;
    if (style) {
        style.fontFamily = appearance.ui_font_family;
        style.fontSize = appearance.ui_font_size >= 10 ? `${size}px` : '';
    }
    if (document.body) {
        document.body.style.fontFamily = appearance.ui_font_family;
        document.body.style.fontSize =
            appearance.ui_font_size >= 10 ? `${size}px` : '';
    }
}
// Consume the body inside the timeout; scope.fetch would replace the caller signal.
export async function ownerFetch(scope, url, init = {}) {
    const controller = new AbortController();
    let rejectAbort;
    const cancelled = new Promise((_, reject) => {
        rejectAbort = reject;
    });
    const cancel = () => {
        controller.abort();
        rejectAbort(new DOMException('Settings request cancelled or timed out', 'AbortError'));
    };
    const signals = [scope.signal, init.signal].filter(Boolean);
    const timer = setTimeout(cancel, TIMEOUT);
    for (const signal of signals)
        signal.addEventListener('abort', cancel, { once: true });
    try {
        if (signals.some((signal) => signal.aborted))
            throw new DOMException('Owner changed', 'AbortError');
        return await Promise.race([
            (async () => {
                const response = await fetch(url, {
                    ...init,
                    headers: scope.headers(init.headers),
                    credentials: 'same-origin',
                    signal: controller.signal,
                });
                const body = await response.arrayBuffer();
                if (controller.signal.aborted || scope.aborted)
                    throw new DOMException('Owner changed', 'AbortError');
                return new Response(response.status === 204 ||
                    response.status === 205 ||
                    response.status === 304
                    ? null
                    : body, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers,
                });
            })(),
            cancelled,
        ]);
    }
    finally {
        clearTimeout(timer);
        for (const signal of signals)
            signal.removeEventListener('abort', cancel);
    }
}
let database = null;
function openMobileDB() {
    if (!database)
        database = new Promise((resolve, reject) => {
            const request = indexedDB.open('phi-mobile-appearance-v1', 1);
            request.onupgradeneeded = () => {
                request.result.createObjectStore('owners', {
                    keyPath: 'owner',
                });
                request.result.createObjectStore('drafts', {
                    keyPath: 'id',
                    autoIncrement: true,
                });
            };
            request.onerror = () => {
                database = null;
                reject(request.error);
            };
            request.onblocked = () => {
                database = null;
                reject(new Error('Browser storage is blocked'));
            };
            request.onsuccess = () => {
                request.result.onversionchange = () => {
                    request.result.close();
                    database = null;
                };
                resolve(request.result);
            };
        });
    return database;
}
export const mobileStorage = {
    async change(owner, update) {
        const db = await openMobileDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(['owners', 'drafts'], 'readwrite');
            const owners = tx.objectStore('owners'), drafts = tx.objectStore('drafts');
            const ownerRequest = owners.get(owner), draftRequest = drafts.getAll();
            let result;
            tx.onerror = () => reject(tx.error || new Error('Browser storage failed'));
            tx.onabort = () => reject(tx.error || new Error('Browser storage aborted'));
            tx.oncomplete = () => resolve(result);
            draftRequest.onsuccess = () => {
                try {
                    const record = ownerRequest.result || {
                        owner,
                        confirmed: null,
                        counter: 0,
                        attempt: null,
                    };
                    result = update(record, draftRequest.result, {
                        put(draft) {
                            const value = { ...draft };
                            if (value.id === undefined)
                                delete value.id;
                            const request = drafts.put(value);
                            request.onsuccess = () => {
                                draft.id = Number(request.result);
                            };
                        },
                        delete(id) {
                            drafts.delete(id);
                        },
                    });
                    owners.put(record);
                }
                catch (error) {
                    tx.abort();
                    reject(error);
                }
            };
        });
    },
};
function copy(value) {
    return JSON.parse(JSON.stringify(value));
}
const hasFields = (draft) => Object.keys(draft.fields).length > 0;
export class MobileAppearanceStore {
    scope;
    storage;
    owner;
    confirmed;
    inheritance;
    inheritanceWarning = '';
    inheritanceRead = null;
    inheritanceGeneration = 0;
    draft;
    records;
    error = '';
    storageWarning = '';
    invalid = false;
    resetDetected = false;
    unavailable = false;
    disposed = false;
    timer = null;
    refreshTimer = null;
    backoff = 5000;
    read = null;
    lane = Promise.resolve();
    choiceGeneration = 0;
    listeners = new Set();
    channel = null;
    stop = new AbortController();
    constructor(scope, storage = mobileStorage) {
        this.scope = scope;
        this.storage = storage;
        this.owner = appearanceOwner(scope);
        this.confirmed = readAppearanceCache(scope);
        this.inheritance = readInheritanceCache(scope);
        this.draft = {
            owner: this.owner,
            fields: {},
            versions: {},
            base: this.confirmed?.revision ?? null,
            seq: 0,
            explicit: false,
        };
        this.records = {
            record: {
                owner: this.owner,
                confirmed: this.confirmed,
                counter: 0,
                attempt: null,
            },
            drafts: [],
        };
    }
    get values() {
        return { ...(this.confirmed || EMPTY_MOBILE), ...this.draft.fields };
    }
    get pending() {
        return hasFields(this.draft);
    }
    get attempt() {
        return this.records.record.attempt;
    }
    get conflict() {
        return (this.pending &&
            this.draft.base !== null &&
            this.confirmed !== null &&
            this.draft.base !== this.confirmed.revision);
    }
    get status() {
        if (this.storageWarning)
            return this.storageWarning;
        if (this.attempt)
            return this.attempt.fences.at(-1)?.status === 'rejected'
                ? 'Resolve failed; save outcome still unknown'
                : 'Save outcome unknown';
        if (this.error)
            return this.error;
        if (this.invalid)
            return 'Enter a whole number in the allowed range.';
        if (this.conflict)
            return 'Server settings changed. Choose which values to save.';
        if (this.pending)
            return 'Pending changes';
        return this.confirmed
            ? 'Saved'
            : 'Using mobile defaults; refreshing in background';
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    notify() {
        if (!this.disposed)
            for (const listener of this.listeners)
                listener();
    }
    broadcast() {
        if (this.disposed)
            return;
        try {
            this.channel?.postMessage({ owner: this.owner });
        }
        catch {
            // Notifications are hints; persisted drafts and polling remain usable.
        }
    }
    async start() {
        try {
            this.channel = new BroadcastChannel('phi_mobile_appearance');
            this.channel.onmessage = (event) => {
                if (event.data?.owner === this.owner)
                    void this.sync().then(() => this.refresh());
            };
        }
        catch {
            /* polling also covers browsers without BroadcastChannel */
        }
        window.addEventListener('online', this.wake);
        window.addEventListener('focus', this.wake);
        window.addEventListener('beforeunload', this.beforeUnload);
        this.scope.signal.addEventListener('abort', () => this.dispose(), {
            once: true,
        });
        await this.sync();
        if (!this.disposed)
            void this.refresh();
    }
    beforeUnload = (event) => {
        if (this.storageWarning && this.pending) {
            event.preventDefault();
            event.returnValue = '';
        }
    };
    wake = () => {
        void this.refresh();
    };
    dispose() {
        this.disposed = true;
        this.stop.abort();
        this.channel?.close();
        if (this.timer)
            clearTimeout(this.timer);
        if (this.refreshTimer)
            clearTimeout(this.refreshTimer);
        window.removeEventListener('online', this.wake);
        window.removeEventListener('focus', this.wake);
        window.removeEventListener('beforeunload', this.beforeUnload);
        this.listeners.clear();
    }
    storageError() {
        this.storageWarning =
            'Browser storage is unavailable. Changes remain in memory and cannot survive reload; saves are paused.';
        this.notify();
    }
    cache() {
        try {
            localStorage.setItem(appearanceCacheKey(this.scope), JSON.stringify({
                schema: 1,
                mobile: this.confirmed,
                inheritance: this.inheritance,
            }));
        }
        catch {
            /* IndexedDB remains authoritative for mobile saves. */
        }
    }
    adopt(state) {
        if (this.confirmed && state.revision < this.confirmed.revision)
            return;
        this.confirmed = copy(state);
        this.cache();
    }
    ingestInheritance(data) {
        if (this.disposed || !validInheritedFamilies(data))
            return;
        this.inheritanceGeneration++;
        this.inheritance = {
            ui_font_family: data.ui_font_family,
            terminal_font_family: data.terminal_font_family,
        };
        this.inheritanceWarning = '';
        this.cache();
        this.notify();
    }
    refreshInheritance() {
        if (this.inheritanceRead)
            return this.inheritanceRead;
        if (this.disposed)
            return Promise.resolve(false);
        const generation = this.inheritanceGeneration;
        this.inheritanceRead = (async () => {
            try {
                const response = await ownerFetch(this.scope, '/api/config', {
                    cache: 'no-store',
                    signal: this.stop.signal,
                });
                if (!response.ok)
                    throw new Error('Unable to refresh inherited fonts.');
                const data = await response.json();
                if (!validInheritedFamilies(data))
                    throw new Error('Invalid inherited fonts response.');
                if (this.disposed || generation !== this.inheritanceGeneration)
                    return false;
                this.ingestInheritance(data);
                return true;
            }
            catch {
                if (!this.disposed) {
                    this.inheritanceWarning =
                        'Inherited fonts could not refresh; using the last saved families or built-in defaults.';
                    this.notify();
                }
                return false;
            }
            finally {
                this.inheritanceRead = null;
            }
        })();
        return this.inheritanceRead;
    }
    async sync() {
        try {
            this.records = await this.storage.change(this.owner, (record, drafts) => ({ record, drafts }));
            if (this.records.record.confirmed &&
                validMobileAppearance(this.records.record.confirmed))
                this.adopt(this.records.record.confirmed);
            this.storageWarning = '';
        }
        catch {
            this.storageError();
        }
        this.notify();
    }
    edit(fields) {
        if (this.timer)
            clearTimeout(this.timer);
        this.invalid = false;
        this.error = '';
        if (!this.pending) {
            this.draft.explicit = false;
            this.draft.base = this.confirmed?.revision ?? null;
        }
        for (const key of KEYS)
            if (key in fields) {
                this.draft.fields[key] = fields[key];
                this.draft.versions[key] = ++this.draft.seq;
            }
        if (!this.pending)
            return;
        this.notify();
        const active = this.draft;
        const seq = active.seq;
        void this.persistDraft().then((saved) => {
            if (saved &&
                active === this.draft &&
                seq === active.seq &&
                !this.disposed &&
                !this.invalid) {
                if (this.timer)
                    clearTimeout(this.timer);
                this.timer = setTimeout(() => {
                    void this.flush();
                }, 300);
            }
        });
    }
    invalidateInput() {
        this.invalid = true;
        if (this.timer)
            clearTimeout(this.timer);
        this.notify();
    }
    persistDraft() {
        const active = this.draft;
        const snapshot = copy(active);
        const operation = this.lane.then(async () => {
            snapshot.id = active.id;
            try {
                await this.storage.change(this.owner, (_record, drafts, writer) => {
                    snapshot.cleared = drafts.find((draft) => draft.id === snapshot.id)?.cleared;
                    for (const key of KEYS)
                        if ((snapshot.versions[key] || 0) <=
                            (snapshot.cleared?.[key] || 0)) {
                            delete snapshot.fields[key];
                            delete snapshot.versions[key];
                        }
                    writer.put(snapshot);
                });
                active.id = snapshot.id;
                this.storageWarning = '';
                this.broadcast();
                return true;
            }
            catch {
                this.storageError();
                return false;
            }
        });
        this.lane = operation;
        return operation;
    }
    refresh(force = false) {
        if (this.read)
            return this.read;
        if (this.disposed || (this.unavailable && !force))
            return Promise.resolve(false);
        void this.refreshInheritance();
        const startRevision = this.confirmed?.revision ?? null;
        let nextDelay = 5000;
        this.read = (async () => {
            try {
                const response = await ownerFetch(this.scope, MOBILE_ROUTE, {
                    cache: 'no-store',
                    signal: this.stop.signal,
                });
                if (response.status === 404 || response.status === 405) {
                    this.unavailable = true;
                    throw new Error('Mobile persistence is unavailable on this server.');
                }
                if (!response.ok)
                    throw new Error(response.status === 401
                        ? 'Sign in again to save mobile settings.'
                        : 'Unable to refresh mobile settings.');
                const state = await response.json();
                if (!validMobileAppearance(state))
                    throw new Error('Invalid mobile settings response.');
                if (this.disposed)
                    return false;
                if (startRevision !== null && state.revision < startRevision) {
                    this.resetDetected = true;
                    this.error =
                        'Server state was reset. Saves are paused; pending changes are retained.';
                    return false;
                }
                this.adopt(state);
                await this.storage.change(this.owner, (record) => {
                    if (!record.confirmed ||
                        state.revision >= record.confirmed.revision)
                        record.confirmed = state;
                });
                if (!this.pending)
                    this.draft.base = this.confirmed?.revision ?? null;
                this.error = '';
                this.unavailable = false;
                this.backoff = 5000;
                await this.sync();
                void this.flush();
                return true;
            }
            catch (error) {
                if (!this.disposed)
                    this.error =
                        error instanceof Error
                            ? error.message
                            : 'Unable to refresh mobile settings.';
                nextDelay = this.backoff;
                this.backoff = Math.min(30000, this.backoff * 2);
                return false;
            }
            finally {
                this.read = null;
                this.notify();
                if (!this.disposed && !this.unavailable) {
                    if (this.refreshTimer)
                        clearTimeout(this.refreshTimer);
                    this.refreshTimer = setTimeout(() => {
                        void this.refresh();
                    }, nextDelay);
                }
            }
        })();
        return this.read;
    }
    async restore(id) {
        const active = this.draft, seq = active.seq;
        await this.sync();
        const source = this.records.drafts.find((draft) => draft.id === id && draft.owner === this.owner);
        if (!source ||
            active !== this.draft ||
            active.seq !== seq ||
            this.disposed)
            return;
        if (this.pending && !(await this.persistDraft()))
            return;
        if (active !== this.draft || active.seq !== seq || this.disposed)
            return;
        this.draft = {
            owner: this.owner,
            fields: copy(source.fields),
            versions: {},
            base: source.base,
            seq: 0,
            explicit: true,
        };
        for (const key of KEYS)
            if (key in source.fields)
                this.draft.versions[key] = ++this.draft.seq;
        this.draft.base = source.base;
        this.draft.explicit = true;
        this.draft.source = { id, seq: source.seq };
        this.notify();
        await this.persistDraft();
        await this.sync();
    }
    async discard(id) {
        await this.storage
            .change(this.owner, (record, drafts, writer) => {
            if (record.attempt?.draftId === id)
                return;
            const source = drafts.find((draft) => draft.id === id && draft.owner === this.owner);
            if (source)
                writer.delete(id);
        })
            .catch(() => this.storageError());
        await this.sync();
    }
    async useServerValues() {
        if (this.attempt)
            return;
        const choice = ++this.choiceGeneration;
        const active = this.draft;
        const selected = copy(active);
        this.draft.explicit = true;
        if (this.timer)
            clearTimeout(this.timer);
        if (!(await this.refresh()) ||
            this.attempt ||
            active !== this.draft ||
            choice !== this.choiceGeneration)
            return;
        for (const key of KEYS)
            if (this.draft.versions[key] === selected.versions[key]) {
                delete this.draft.fields[key];
                delete this.draft.versions[key];
            }
        this.draft.base = this.confirmed.revision;
        this.draft.explicit = this.pending;
        await this.persistDraft();
        this.notify();
    }
    async saveMyChanges() {
        if (this.attempt || this.invalid)
            return;
        const choice = ++this.choiceGeneration;
        const active = this.draft;
        const selected = copy(active);
        this.draft.explicit = true;
        if (this.timer)
            clearTimeout(this.timer);
        if (!hasFields(selected) ||
            !(await this.refresh()) ||
            this.attempt ||
            active !== this.draft ||
            choice !== this.choiceGeneration)
            return;
        selected.base = this.confirmed.revision;
        selected.explicit = false;
        // Persist the explicit rebase, but do not send any edits made during the read.
        this.draft.base = selected.base;
        await this.persistDraft();
        if (active === this.draft && choice === this.choiceGeneration)
            await this.flush(true, selected);
    }
    async flush(explicit = false, selected = copy(this.draft)) {
        if (this.disposed ||
            this.invalid ||
            this.unavailable ||
            this.resetDetected ||
            this.storageWarning ||
            navigator.onLine === false ||
            !hasFields(selected) ||
            selected.base === null ||
            (!explicit && selected.explicit))
            return;
        const active = this.draft;
        const choice = this.choiceGeneration;
        await this.lane;
        if (active !== this.draft)
            return;
        selected.id = active.id;
        if (selected.id === undefined)
            return;
        let attempt = null;
        try {
            attempt = await this.storage.change(this.owner, (record, drafts) => {
                // Storage may have waited behind another transaction since flush began.
                // Recheck local intent before claiming a durable, possibly unconfirmed write.
                if (this.disposed ||
                    this.scope.aborted ||
                    this.invalid ||
                    this.unavailable ||
                    this.resetDetected ||
                    this.storageWarning ||
                    navigator.onLine === false ||
                    active !== this.draft ||
                    choice !== this.choiceGeneration ||
                    (!explicit && active.explicit) ||
                    record.attempt ||
                    !record.confirmed ||
                    record.confirmed.revision !== selected.base)
                    return null;
                if (!explicit &&
                    drafts.some((draft) => draft.owner === this.owner &&
                        draft.id !== selected.id &&
                        hasFields(draft)))
                    return null;
                const saved = drafts.find((draft) => draft.id === selected.id);
                if (!saved || saved.seq < selected.seq)
                    return null;
                const claimed = {
                    id: ++record.counter,
                    revision: selected.base,
                    fields: selected.fields,
                    versions: selected.versions,
                    draftId: selected.id,
                    fences: [],
                };
                record.attempt = copy(claimed);
                return claimed;
            });
        }
        catch {
            this.storageError();
            return;
        }
        if (!attempt) {
            await this.sync();
            return;
        }
        await this.sync();
        this.broadcast();
        await this.send(attempt, null);
    }
    async resolve() {
        if (this.disposed || this.storageWarning || navigator.onLine === false)
            return;
        let claim = null;
        try {
            claim = await this.storage.change(this.owner, (record) => {
                const attempt = record.attempt;
                if (!attempt ||
                    (attempt.fences.at(-1)?.deadline || 0) > Date.now())
                    return null;
                const generation = (attempt.fences.at(-1)?.generation || 0) + 1;
                attempt.fences.push({
                    generation,
                    deadline: Date.now() + TIMEOUT,
                    status: 'unknown',
                });
                return { attempt: copy(attempt), generation };
            });
        }
        catch {
            this.storageError();
            return;
        }
        if (!claim)
            return;
        await this.sync();
        this.broadcast();
        await this.send(claim.attempt, claim.generation);
    }
    async send(attempt, generation) {
        try {
            const response = await ownerFetch(this.scope, MOBILE_ROUTE + (generation === null ? '' : '/fence'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: this.stop.signal,
                body: JSON.stringify(generation === null
                    ? {
                        revision: attempt.revision,
                        fields: attempt.fields,
                    }
                    : {}),
            });
            let state = null;
            if (response.status === 200 ||
                (response.status === 409 && generation === null)) {
                const parsed = await response.json();
                if (!validMobileAppearance(parsed))
                    throw new Error('Invalid save response');
                state = parsed;
                if (response.status === 200 &&
                    (generation === null
                        ? state.revision !== attempt.revision + 1 ||
                            KEYS.some((key) => key in attempt.fields &&
                                state[key] !== attempt.fields[key])
                        : state.revision <= attempt.revision))
                    throw new Error('Unexpected save acknowledgment');
            }
            else if (![400, 401, 403, 404, 405, 413, 415].includes(response.status))
                throw new Error('Save outcome unknown');
            let released = false;
            await this.storage.change(this.owner, (record, drafts, writer) => {
                const slot = record.attempt;
                if (!slot ||
                    slot.id !== attempt.id ||
                    (generation === null
                        ? slot.fences.length !== 0
                        : slot.fences.at(-1)?.generation !== generation))
                    return;
                if (generation !== null && response.status !== 200) {
                    const fence = slot.fences.at(-1);
                    fence.status = 'rejected';
                    fence.deadline = 0;
                    return;
                }
                if (state &&
                    (!record.confirmed ||
                        state.revision >= record.confirmed.revision))
                    record.confirmed = state;
                const draft = drafts.find((draft) => draft.id === attempt.draftId &&
                    draft.owner === this.owner);
                if (draft) {
                    if (generation === null && response.status === 200) {
                        for (const key of KEYS)
                            if (draft.versions[key] === attempt.versions[key]) {
                                draft.cleared ||= {};
                                draft.cleared[key] = attempt.versions[key];
                                delete draft.fields[key];
                                delete draft.versions[key];
                            }
                        if (!record.confirmed ||
                            record.confirmed.revision <= state.revision)
                            draft.base = state.revision;
                        if (draft.source) {
                            const source = drafts.find((other) => other.id === draft.source.id &&
                                other.seq === draft.source.seq);
                            if (source)
                                writer.delete(source.id);
                        }
                    }
                    else
                        draft.explicit = true;
                    writer.put(draft);
                }
                record.attempt = null;
                released = true;
            });
            if (generation === null &&
                response.status === 200 &&
                released &&
                this.draft.id === attempt.draftId) {
                for (const key of KEYS)
                    if (this.draft.versions[key] === attempt.versions[key]) {
                        delete this.draft.fields[key];
                        delete this.draft.versions[key];
                    }
                if (!this.confirmed ||
                    this.confirmed.revision <= state.revision)
                    this.draft.base = state.revision;
            }
            else if (released)
                this.draft.explicit = true;
            if (response.status === 404 || response.status === 405)
                this.unavailable = true;
            else if (response.status === 200)
                this.unavailable = false;
            this.error =
                response.status === 200
                    ? ''
                    : response.status === 401
                        ? 'Sign in again, then explicitly resolve or save.'
                        : 'Save rejected. Pending changes are retained.';
        }
        catch (error) {
            this.error = 'Save outcome unknown. Resolve before saving again.';
            if (error instanceof Error && !this.disposed)
                console.warn('[mobile appearance]', error.message);
        }
        finally {
            await this.sync();
            this.broadcast();
            this.notify();
        }
    }
}
