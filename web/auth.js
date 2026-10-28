// Optional access-password bootstrap for Phi.
//
// PBKDF2-SHA256 runs natively via WebCrypto (crypto.subtle) whenever the
// runtime exposes it — secure contexts such as http://localhost, HTTPS,
// and the desktop body view — which is ~10-40x faster than JS on weak
// devices. On plain-HTTP LAN origins, where browsers do not expose
// SubtleCrypto at all, this falls back to the audited @noble/hashes
// implementation. Both paths produce identical bytes (RFC 8018); a
// 1-iteration cross-check against noble runs once per page load before
// the native path is trusted, so a broken or tampered SubtleCrypto can
// never produce a verifier the Go server would reject — or worse, a
// bootstrap verifier that locks the user out.
import { pbkdf2Async } from './vendor/noble-hashes/pbkdf2.js';
import { hmac } from './vendor/noble-hashes/hmac.js';
import { sha256 } from './vendor/noble-hashes/sha2.js';
import { serverKey } from './util.js';

const CREDENTIAL_KEY = 'phi_access_credential_v1';
// Legacy browser storage for the v2 bearer. Tokens now live only in memory;
// the refresh handle stays in its HttpOnly cookie.
const LEGACY_BEARER_KEY = 'phi_access_bearer_v1';

// The desktop's embedded page serves EVERY server from one page, so one
// localStorage holds every server's credential. A single shared key made
// each server overwrite the previous one's credential: the next server
// found a foreign salt, treated it as a rotation, cleared it, and asked
// for the password again. The key is namespaced per server instead. In a
// plain browser tab each server has its own origin (and its own
// localStorage), so the key stays unchanged there.
function credentialKey(context) {
    return context?.credentialKey || serverKey(CREDENTIAL_KEY);
}

function bearerKey(context) {
    if (!context?.credentialKey) return serverKey(LEGACY_BEARER_KEY);
    const key = context.credentialKey;
    return key.startsWith(CREDENTIAL_KEY)
        ? `${LEGACY_BEARER_KEY}${key.slice(CREDENTIAL_KEY.length)}`
        : `${LEGACY_BEARER_KEY}:${key}`;
}

function discardLegacyBearer(context) {
    try {
        localStorage.removeItem(bearerKey(context));
    } catch {
        // Storage is blocked, so there is no value to migrate.
    }
}

discardLegacyBearer();

function authFetch(context, url, init) {
    return (context?.fetch || fetch)(url, init);
}
const PASSWORD_MIN_LENGTH = 8;
// Module-owned auth requests must not hold bootstrap or a submit button open
// forever. The deadline covers headers and response-body consumption.
const AUTH_TIMEOUT_MS = 30000;

function bytesToBase64URL(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function base64URLToBytes(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new Error('Invalid saved access credential');
    }
    const padded =
        value.replace(/-/g, '+').replace(/_/g, '/') +
        '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function validStatus(status) {
    return (
        !!status &&
        status.enabled === true &&
        status.version === 'v1' &&
        status.algorithm === 'pbkdf2-sha256' &&
        Number.isInteger(status.iterations) &&
        status.iterations > 0 &&
        typeof status.salt === 'string' &&
        typeof status.challenge === 'string'
    );
}

function invalidStatusError() {
    return new Error('Phi returned invalid access protection settings');
}

// parseProtocols maps the capability field to the protocols this client can
// speak. An absent field is the legacy v1-only response. A present field must
// be a nonempty array of unique nonempty names, and unknown names are only
// tolerated beside a supported protocol.
function parseProtocols(value) {
    if (value === undefined) return ['v1'];
    if (!Array.isArray(value) || value.length === 0) throw invalidStatusError();
    const seen = new Set();
    for (const protocol of value) {
        if (typeof protocol !== 'string' || !protocol || seen.has(protocol))
            throw invalidStatusError();
        seen.add(protocol);
    }
    const supported = value.filter((p) => p === 'v1' || p === 'v2');
    if (supported.length === 0) throw invalidStatusError();
    return supported;
}

// parseAccessStatus validates the status contract shared by both protocols.
function parseAccessStatus(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        throw invalidStatusError();
    if (typeof payload.enabled !== 'boolean') throw invalidStatusError();
    const protocols = parseProtocols(payload.protocols);
    if (payload.enabled && typeof payload.authenticated !== 'boolean')
        throw invalidStatusError();
    return {
        enabled: payload.enabled,
        authenticated: payload.authenticated === true,
        protocols,
        raw: payload,
    };
}

function preferredProtocol(protocols) {
    return protocols.includes('v2') ? 'v2' : 'v1';
}

// v1 KDF metadata is only required before using the v1 path; a v2 status must
// not be rejected by v1-only bounds.
function hasV1Metadata(status) {
    return (
        status.raw.version === 'v1' &&
        status.raw.algorithm === 'pbkdf2-sha256' &&
        Number.isInteger(status.raw.iterations) &&
        status.raw.iterations > 0 &&
        typeof status.raw.salt === 'string' &&
        typeof status.raw.challenge === 'string'
    );
}

async function getStatus(context) {
    return withAuthDeadline(async (signal) => {
        const res = await authFetch(context, '/api/auth/status', {
            cache: 'no-store',
            redirect: 'error',
            signal,
        });
        if (res.status !== 200)
            throw new Error('Unable to check Phi access protection');
        let payload;
        try {
            payload = await res.json();
        } catch {
            throw invalidStatusError();
        }
        return parseAccessStatus(payload);
    });
}

async function deriveVerifierNative(subtle, password, salt, iterations) {
    const key = await subtle.importKey(
        'raw',
        password,
        { name: 'PBKDF2' },
        false,
        ['deriveBits'],
    );
    const bits = await subtle.deriveBits(
        {
            name: 'PBKDF2',
            hash: 'SHA-256',
            salt,
            iterations,
        },
        key,
        256,
    );
    return new Uint8Array(bits);
}

// Resolves to a native derive function, or false when only noble is
// usable. Memoized as a promise so concurrent callers share one probe.
// The probe derives a 1-iteration verifier through BOTH implementations
// (microseconds) and only trusts the native path on a byte-for-byte match.
async function probeNativeDerive() {
    const subtle = globalThis.crypto?.subtle;
    if (
        !subtle ||
        typeof subtle.importKey !== 'function' ||
        typeof subtle.deriveBits !== 'function'
    ) {
        return false;
    }
    try {
        const katPassword = new TextEncoder().encode('phi-native-derive-kat');
        const katSalt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
        const expected = await pbkdf2Async(sha256, katPassword, katSalt, {
            c: 1,
            dkLen: 32,
        });
        const actual = await deriveVerifierNative(
            subtle,
            katPassword,
            katSalt,
            1,
        );
        if (
            actual.length !== expected.length ||
            !expected.every((byte, i) => byte === actual[i])
        ) {
            return false;
        }
        return (password, salt, iterations) =>
            deriveVerifierNative(subtle, password, salt, iterations);
    } catch {
        return false;
    }
}

let nativeDerivePromise;
function nativeDerive() {
    if (!nativeDerivePromise) nativeDerivePromise = probeNativeDerive();
    return nativeDerivePromise;
}

function resetNativeDerive() {
    nativeDerivePromise = undefined;
}

async function deriveVerifier(password, status) {
    if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
        throw new Error(
            `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
        );
    }
    const salt = base64URLToBytes(status.salt);
    const native = await nativeDerive();
    if (native) {
        return native(
            new TextEncoder().encode(password),
            salt,
            status.iterations,
        );
    }
    return pbkdf2Async(sha256, password, salt, {
        c: status.iterations,
        dkLen: 32,
        asyncTick: 10,
    });
}

function storeCredential(status, verifier, context) {
    try {
        localStorage.setItem(
            credentialKey(context),
            JSON.stringify({
                version: status.version,
                algorithm: status.algorithm,
                iterations: status.iterations,
                salt: status.salt,
                verifier: bytesToBase64URL(verifier),
            }),
        );
    } catch {
        // A cookie session still works when localStorage is blocked. The user
        // will only need to type the password after that session expires.
    }
}

function clearCredential(context) {
    try {
        localStorage.removeItem(credentialKey(context));
    } catch {
        /* ignored */
    }
}

function savedVerifier(status, context) {
    try {
        const saved = JSON.parse(
            localStorage.getItem(credentialKey(context)) || 'null',
        );
        if (
            !saved ||
            saved.version !== status.version ||
            saved.algorithm !== status.algorithm ||
            saved.iterations !== status.iterations ||
            saved.salt !== status.salt
        ) {
            clearCredential(context);
            return null;
        }
        const verifier = base64URLToBytes(saved.verifier);
        return verifier.length === 32 ? verifier : null;
    } catch {
        clearCredential(context);
        return null;
    }
}

// The challenge is single-use and expires five minutes after it is issued
// (accessChallengeTTL in auth.go). Re-deriving on a slow device can outlast
// that window, so a status older than this threshold is refreshed.
const challengeRefreshAfterMs = 4 * 60 * 1000;
const challengeLifetimeMs = 5 * 60 * 1000;
const statusFetchTimeoutMs = 15000;

// login reports 'ok', 'rejected', 'rate-limited', or 'transient'. Only an
// explicit 401 rejects the credential; a 429, 5xx, or transport failure must
// not destroy it, change the selected protocol, or prompt for another password.
async function login(status, verifier, context) {
    const proof = bytesToBase64URL(
        hmac(sha256, verifier, new TextEncoder().encode(status.challenge)),
    );
    try {
        return await withAuthDeadline(async (signal) => {
            const res = await authFetch(context, '/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ challenge: status.challenge, proof }),
                redirect: 'error',
                signal,
            });
            if (res.ok) return 'ok';
            if (res.status === 401) return 'rejected';
            if (res.status === 429) return 'rate-limited';
            return 'transient';
        });
    } catch {
        // A timeout, redirect, or transport failure is transient: it must not
        // discard the credential or change the selected protocol.
        return 'transient';
    }
}

// Replaces a challenge that the derivation may have outlived. The fetch is
// bounded. On failure the original status is still usable unless it is old
// enough to have expired, in which case there is no challenge to post and
// the caller must not send the login at all. Age is measured at the moment of
// the decision, so time spent refreshing counts against the lifetime too.
async function freshStatus(fallback, startedAt, context) {
    if (performance.now() - startedAt < challengeRefreshAfterMs) return fallback;
    try {
        const status = await withAuthDeadline(async (signal) => {
            const res = await authFetch(context, '/api/auth/status', {
                cache: 'no-store',
                redirect: 'error',
                signal,
            });
            if (res.status !== 200)
                throw new Error('Unable to refresh access challenge');
            return await res.json();
        }, statusFetchTimeoutMs);
        if (validStatus(status)) return status;
    } catch {
        // Fall through to the expiry check below.
    }
    return performance.now() - startedAt < challengeLifetimeMs
        ? fallback
        : null;
}

// --- v2 bearer client ----------------------------------------------------

const authStates = new Map();
const HOST_INSTALL = Symbol('host install');
const REFRESH_LEAD_MS = 60 * 1000;
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const REFRESH_LOCK_PREFIX = 'phi-access-refresh:';
let activeAuthKey = null;
let activeAuthContext = null;

const AUTH_CHANNEL = 'phi-access-auth';
let invalidation = null;

function invalidationChannel() {
    if (invalidation) return invalidation;
    if (typeof BroadcastChannel !== 'function') return null;
    try {
        const channel = new BroadcastChannel(AUTH_CHANNEL);
        channel.addEventListener('message', (event) => {
            if (!event.data) return;
            if (event.data.kind === 'logout') {
                const ownerKey = event.data.ownerKey;
                if (typeof ownerKey !== 'string') return;
                const state = authStates.get(ownerKey);
                if (!state) return;
                dropCredential(state);
                if (pendingOverlay?.ownerKey === ownerKey)
                    pendingOverlay.finish({ enabled: false });
                return;
            }
            if (event.data.kind === 'bundle') receiveBundle(event.data);
        });
        invalidation = channel;
    } catch {
        // No channel support: this page still clears its own credential.
        invalidation = null;
    }
    return invalidation;
}

function broadcastInvalidation(ownerKey) {
    const channel = invalidationChannel();
    if (channel) channel.postMessage({ kind: 'logout', ownerKey });
}

function broadcastBundle(context, state) {
    const channel = invalidationChannel();
    if (!channel || !state.accessToken) return;
    channel.postMessage({
        kind: 'bundle',
        origin: location.origin,
        ownerKey: credentialKey(context),
        bundle: {
            token: state.accessToken,
            expiresAt: state.accessExpiresAt,
            refreshIdleExpiresAt: state.refreshIdleExpiresAt,
            refreshAbsoluteExpiresAt: state.refreshAbsoluteExpiresAt,
        },
    });
}

function receiveBundle(message) {
    const ownerKey =
        typeof message.ownerKey === 'string'
            ? message.ownerKey
            : (activeAuthKey ?? credentialKey());
    if (message.origin !== location.origin) return;
    const state = stateForKey(ownerKey);
    const bundle = message.bundle;
    if (!bundle || typeof bundle.token !== 'string' || !bundle.token) return;
    if (!Number.isInteger(bundle.expiresAt) || bundle.expiresAt <= 0) return;
    if (
        !Number.isInteger(bundle.refreshIdleExpiresAt) ||
        !Number.isInteger(bundle.refreshAbsoluteExpiresAt) ||
        bundle.refreshIdleExpiresAt <= 0 ||
        bundle.refreshAbsoluteExpiresAt < bundle.refreshIdleExpiresAt
    )
        return;
    if (state.memoryOnly) return;
    if (state.accessToken && bundle.expiresAt <= state.accessExpiresAt) return;
    adoptToken(bundle.token, bundle, contextForKey(ownerKey), { broadcast: false });
}

function contextForKey(ownerKey) {
    if (ownerKey === activeAuthKey) return activeAuthContext;
    return { credentialKey: ownerKey };
}

function newAuthState() {
    return {
        selectedProtocol: null,
        accessEnabled: false,
        accessToken: null,
        persistedToken: null,
        memoryOnly: false,
        accessExpiresAt: 0,
        refreshIdleExpiresAt: 0,
        refreshAbsoluteExpiresAt: 0,
        epoch: 0,
        reauthInFlight: null,
        refreshInFlight: null,
        renewalTimer: null,
        retryTimer: null,
        retryDelayMs: 0,
        pendingBootstrapRelease: null,
    };
}

function stateForKey(key) {
    let state = authStates.get(key);
    if (!state) {
        state = newAuthState();
        authStates.set(key, state);
    }
    return state;
}

function stateFor(context) {
    return stateForKey(credentialKey(context));
}

function activateAuthContext(context) {
    activeAuthContext = context || null;
    activeAuthKey = credentialKey(context);
    return stateForKey(activeAuthKey);
}

function activeAuthState() {
    if (activeAuthKey === null) activateAuthContext();
    return stateForKey(activeAuthKey);
}

function utf8Length(value) {
    return new TextEncoder().encode(value).length;
}

function authTimeoutError() {
    return new Error('Phi did not respond. Try again.');
}

// Race the deadline as well as aborting: some fetch implementations ignore
// AbortSignal and would otherwise keep auth UI pending forever.
async function withAuthDeadline(run, timeoutMs = AUTH_TIMEOUT_MS) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(authTimeoutError());
        }, timeoutMs);
    });
    try {
        return await Promise.race([run(controller.signal), deadline]);
    } finally {
        clearTimeout(timer);
    }
}

function parseCredentialBundle(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return null;
    const {
        token,
        expires_at: expiresAt,
        expires_in: expiresIn,
        refresh_idle_expires_at: refreshIdle,
        refresh_absolute_expires_at: refreshAbsolute,
    } = payload;
    if (typeof token !== 'string' || !token) return null;
    for (const value of [expiresAt, expiresIn, refreshIdle, refreshAbsolute]) {
        if (!Number.isInteger(value)) return null;
    }
    if (expiresAt <= 0 || refreshIdle <= 0 || refreshAbsolute <= 0) return null;
    if (refreshIdle > refreshAbsolute) return null;
    return {
        token,
        expiresAt,
        expiresIn,
        refreshIdleExpiresAt: refreshIdle,
        refreshAbsoluteExpiresAt: refreshAbsolute,
    };
}

const REFRESH_INSTALLED = 'installed';
const REFRESH_NONE = 'none';
const REFRESH_SUPERSEDED = 'superseded';

function refreshDue(context) {
    const state = stateFor(context);
    if (!state.accessToken || !state.accessExpiresAt) return true;
    return state.accessExpiresAt * 1000 - Date.now() <= REFRESH_LEAD_MS;
}

function withRefreshLock(origin, run) {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
    if (!locks || typeof locks.request !== 'function')
        return Promise.resolve().then(run);
    try {
        return Promise.resolve(
            locks.request(REFRESH_LOCK_PREFIX + origin, () => run()),
        );
    } catch {
        return Promise.resolve().then(run);
    }
}

function refreshSession({ ifDue = false } = {}, context) {
    const state = stateFor(context);
    if (state.refreshInFlight) return state.refreshInFlight;
    if (state.memoryOnly) return Promise.resolve(REFRESH_NONE);
    const origin = location.origin;
    const attempt = withRefreshLock(origin, () =>
        ifDue && !refreshDue(context)
            ? REFRESH_INSTALLED
            : runRefresh(context, state, origin),
    );
    state.refreshInFlight = attempt;
    void attempt
        .catch(() => {})
        .then(() => {
            if (state.refreshInFlight === attempt)
                state.refreshInFlight = null;
        });
    return attempt;
}

function retryAfterMs(res) {
    const raw =
        res.headers && typeof res.headers.get === 'function'
            ? res.headers.get('Retry-After')
            : null;
    const seconds = Number.parseInt(raw, 10);
    if (!Number.isInteger(seconds) || seconds <= 0) return 0;
    return Math.min(seconds, 300) * 1000;
}

function refreshFailure(message, waitMs) {
    const err = new Error(message);
    if (waitMs > 0) err.retryAfterMs = waitMs;
    return err;
}

async function runRefresh(context, state, origin) {
    const epoch = state.epoch;
    let result;
    try {
        result = await withAuthDeadline(async (signal) => {
            const res = await authFetch(context, '/api/auth/v2/refresh', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Phi-Auth': 'v2',
                },
                body: '{}',
                credentials: 'same-origin',
                redirect: 'error',
                signal,
            });
            if (res.status !== 200)
                return { status: res.status, retryAfterMs: retryAfterMs(res) };
            try {
                return { status: res.status, payload: await res.json() };
            } catch {
                return { status: res.status, invalid: true };
            }
        });
    } catch (err) {
        if (
            err instanceof Error &&
            err.message === 'Phi returned invalid access protection settings'
        )
            throw err;
        throw new Error('Unable to reach Phi. Try again.');
    }
    if (result.status === 401) return REFRESH_NONE;
    if (result.status !== 200)
        throw refreshFailure(
            'Unable to refresh access session',
            result.retryAfterMs,
        );
    if (result.invalid) throw invalidStatusError();
    const bundle = parseCredentialBundle(result.payload);
    if (!bundle) throw invalidStatusError();
    if (bundle.expiresIn <= 0)
        throw new Error('Unable to refresh access session');
    if (epoch !== state.epoch || location.origin !== origin)
        return REFRESH_SUPERSEDED;
    adoptToken(bundle.token, bundle, context);
    return REFRESH_INSTALLED;
}

// Tokens obtained from password login or the refresh cookie stay in memory.
// Browser storage holds neither an access token nor a refresh handle.
function adoptToken(token, bundle, context, { broadcast = true } = {}) {
    const state = stateFor(context);
    state.accessToken = token;
    state.accessEnabled = true;
    state.selectedProtocol = 'v2';
    state.persistedToken = null;
    state.memoryOnly = false;
    state.accessExpiresAt = bundle?.expiresAt || 0;
    state.refreshIdleExpiresAt = bundle?.refreshIdleExpiresAt || 0;
    state.refreshAbsoluteExpiresAt = bundle?.refreshAbsoluteExpiresAt || 0;
    state.retryDelayMs = 0;
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
    state.epoch++;
    scheduleRenewal(context, state);
    if (broadcast) broadcastBundle(context, state);
    if (pendingOverlay?.ownerKey === credentialKey(context))
        pendingOverlay.finish({ enabled: true });
}

function clearTokenState(state) {
    state.accessToken = null;
    state.persistedToken = null;
    state.accessExpiresAt = 0;
    state.refreshIdleExpiresAt = 0;
    state.refreshAbsoluteExpiresAt = 0;
    clearTimeout(state.renewalTimer);
    clearTimeout(state.retryTimer);
    state.renewalTimer = null;
    state.retryTimer = null;
    state.retryDelayMs = 0;
}

function dropCredential(state) {
    clearTokenState(state);
    state.selectedProtocol = 'v2';
    state.epoch++;
}

// A delayed rejection for token A must not clear token B installed after it.
function rejectToken(token, context) {
    const state = stateFor(context);
    if (!token || state.accessToken !== token) return;
    clearTokenState(state);
    state.selectedProtocol = 'v2';
}

function scheduleRenewal(context, state = stateFor(context)) {
    clearTimeout(state.renewalTimer);
    state.renewalTimer = null;
    if (!state.accessToken || state.memoryOnly || !state.accessExpiresAt) return;
    const epoch = state.epoch;
    const delay = Math.min(
        MAX_TIMEOUT_MS,
        Math.max(
            0,
            state.accessExpiresAt * 1000 - Date.now() - REFRESH_LEAD_MS,
        ),
    );
    state.renewalTimer = setTimeout(() => {
        state.renewalTimer = null;
        if (epoch !== state.epoch) return;
        void renewIfDue({}, context);
    }, delay);
}

function scheduleRetry(err, context, state = stateFor(context)) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
    if (!state.accessToken || state.memoryOnly) return;
    const epoch = state.epoch;
    state.retryDelayMs = state.retryDelayMs
        ? Math.min(RETRY_MAX_MS, state.retryDelayMs * 2)
        : RETRY_BASE_MS;
    const jitter = state.retryDelayMs * 0.2 * Math.random();
    const honored =
        err && Number.isFinite(err.retryAfterMs) ? err.retryAfterMs : 0;
    const delay = Math.max(honored, state.retryDelayMs + jitter);
    state.retryTimer = setTimeout(() => {
        state.retryTimer = null;
        if (epoch !== state.epoch) return;
        void renewIfDue({ ifDue: false }, context);
    }, delay);
}

async function renewIfDue({ ifDue = true } = {}, context) {
    const state = stateFor(context);
    if (!state.accessToken || state.memoryOnly) return;
    if (ifDue && !refreshDue(context)) {
        scheduleRenewal(context, state);
        return;
    }
    const epoch = state.epoch;
    let outcome;
    try {
        outcome = await refreshSession({ ifDue }, context);
    } catch (err) {
        if (epoch !== state.epoch) return;
        scheduleRetry(err, context, state);
        return;
    }
    if (epoch !== state.epoch) return;
    if (outcome === REFRESH_INSTALLED) return;
    if (outcome === REFRESH_NONE) {
        dropCredential(state);
        void requestReauth(context);
        return;
    }
    scheduleRenewal(context, state);
}

// refreshAccessIfDue lets a reconnecting socket bring the credential up to date
// without a request when the in-memory token is still fresh. It returns
// undefined synchronously when nothing is due, so a redial is not deferred by a
// microtask and v1/disabled deployments keep their exact dial behavior.
export function refreshAccessIfDue(context) {
    const ownerContext = context ?? activeAuthContext;
    const state = stateFor(ownerContext);
    if (!state.accessToken || state.memoryOnly) return undefined;
    if (!refreshDue(ownerContext)) {
        scheduleRenewal(ownerContext, state);
        return undefined;
    }
    return renewIfDue({}, ownerContext);
}

// checkV2Token reports whether the server still accepts token. A rejected
// token is 'invalid'; transport errors and 429/5xx throw, so a transient
// failure never destroys a saved credential or changes protocol.
async function checkV2Token(token, context) {
    return withAuthDeadline(async (signal) => {
        const res = await authFetch(context, '/api/auth/v2/status', {
            headers: { Authorization: `Bearer ${token}` },
            cache: 'no-store',
            redirect: 'error',
            signal,
        });
        if (res.status === 401 || res.status === 403) return 'invalid';
        if (res.status !== 200)
            throw new Error('Unable to check Phi access protection');
        let payload;
        try {
            payload = await res.json();
        } catch {
            throw invalidStatusError();
        }
        if (
            !payload ||
            typeof payload.enabled !== 'boolean' ||
            typeof payload.authenticated !== 'boolean'
        )
            throw invalidStatusError();
        if (!payload.enabled) return 'invalid';
        return payload.authenticated ? 'valid' : 'invalid';
    });
}

async function v2Login(password, context) {
    return withAuthDeadline(async (signal) => {
        const res = await authFetch(context, '/api/auth/v2/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Phi-Auth': 'v2',
            },
            body: JSON.stringify({ password }),
            credentials: 'same-origin',
            redirect: 'error',
            signal,
        });
        if (res.status === 401) throw new Error('Wrong password');
        if (res.status === 429)
            throw new Error('Too many attempts. Try again in a moment.');
        if (!res.ok) throw new Error('Unable to sign in');
        let payload;
        try {
            payload = await res.json();
        } catch {
            throw new Error('Unable to sign in');
        }
        const bundle = parseCredentialBundle(payload);
        if (!bundle || bundle.expiresIn <= 0)
            throw new Error('Unable to sign in');
        return bundle;
    });
}

function v2PasswordError(res) {
    if (res.status === 401) return new Error('Sign in to change Phi access');
    if (res.status === 429)
        return new Error('Too many attempts. Try again in a moment.');
    return new Error('Unable to save access password');
}

function validateV2Password(password) {
    if (typeof password !== 'string')
        throw new Error('Enter a password to continue');
    const bytes = utf8Length(password);
    if (bytes < PASSWORD_MIN_LENGTH)
        throw new Error(
            `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
        );
    if (bytes > 1024) throw new Error('Password must be at most 1024 bytes');
}

async function saveV2Password(password, context) {
    validateV2Password(password);
    const state = stateFor(context);
    const epoch = state.epoch;
    const headers = {
        'Content-Type': 'application/json',
        'X-Phi-Auth': 'v2',
    };
    if (state.accessToken) headers.Authorization = `Bearer ${state.accessToken}`;
    const payload = await withAuthDeadline(async (signal) => {
        const res = await authFetch(context, '/api/auth/v2/password', {
            method: 'POST',
            headers,
            body: JSON.stringify({ password }),
            credentials: 'same-origin',
            redirect: 'error',
            signal,
        });
        if (!res.ok) throw v2PasswordError(res);
        try {
            return await res.json();
        } catch {
            throw new Error('Unable to save access password');
        }
    });
    const bundle = parseCredentialBundle(payload);
    if (!payload || payload.enabled !== true || !bundle || bundle.expiresIn <= 0)
        throw new Error('Unable to save access password');
    if (epoch === state.epoch) adoptToken(bundle.token, bundle, context);
    return { enabled: true };
}

async function clearV2Password(context) {
    const state = stateFor(context);
    if (!state.accessEnabled && !state.accessToken) return { enabled: false };
    const token = state.accessToken;
    const epoch = state.epoch;
    const headers = {
        'Content-Type': 'application/json',
        'X-Phi-Auth': 'v2',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const payload = await withAuthDeadline(async (signal) => {
        const res = await authFetch(context, '/api/auth/v2/password', {
            method: 'POST',
            headers,
            body: JSON.stringify({ password: '' }),
            credentials: 'same-origin',
            redirect: 'error',
            signal,
        });
        if (!res.ok) throw v2PasswordError(res);
        try {
            return await res.json();
        } catch {
            throw new Error('Unable to clear access password');
        }
    });
    // Never discard a live credential after a successful-looking proxy page.
    if (!payload || payload.enabled !== false)
        throw new Error('Unable to clear access password');
    // A credential installed while the clear was in flight is newer than
    // this response; never clear it.
    if (state.epoch !== epoch) return { enabled: false };
    clearTokenState(state);
    state.accessEnabled = false;
    state.selectedProtocol = 'v2';
    state.epoch++;
    broadcastInvalidation(credentialKey(context));
    if (pendingOverlay?.ownerKey === credentialKey(context))
        pendingOverlay.finish({ enabled: false });
    return { enabled: false };
}

// --- protected fetch wrapper --------------------------------------------

const WRAPPED_FETCH = Symbol.for('phi.accessFetch');
let reloadPage = () => location.reload();

function isSyncMessagePath(path) {
    return path === '/api/sync/messages' || path.startsWith('/api/sync/messages/');
}

// isProtectedAPIPath is the wrapper and asset scope: same-origin API data that
// needs a credential, excluding the public auth routes and the sync exemption.
function isProtectedAPIPath(pathname) {
    return (
        pathname.startsWith('/api/') &&
        !pathname.startsWith('/api/auth/') &&
        !isSyncMessagePath(pathname)
    );
}

function requestURL(input) {
    try {
        if (typeof input === 'string' || input instanceof URL)
            return new URL(input, location.href);
        if (input && typeof input.url === 'string')
            return new URL(input.url, location.href);
    } catch {
        /* not a URL this wrapper can scope */
    }
    return null;
}

function requestHeaders(input, init) {
    if (init && init.headers) return new Headers(init.headers);
    if (typeof Request !== 'undefined' && input instanceof Request)
        return new Headers(input.headers);
    return new Headers();
}

// installAccessFetch wraps fetch once so same-origin protected API calls carry
// the in-memory bearer. A stale-token 401 refreshes once and retries only GET
// or HEAD; mutations are never replayed. Route-specific 403 responses pass on.
export function installAccessFetch() {
    const baseFetch = globalThis.fetch;
    if (!baseFetch || baseFetch[WRAPPED_FETCH]) return;
    const wrapped = async (input, init) => {
        const url = requestURL(input);
        const ownerKey = activeAuthKey ?? credentialKey();
        const context = activeAuthContext;
        const state = stateForKey(ownerKey);
        const token = state.accessToken;
        if (!url || !token || url.origin !== location.origin)
            return baseFetch(input, init);
        if (!isProtectedAPIPath(url.pathname)) return baseFetch(input, init);
        const headers = requestHeaders(input, init);
        // A caller-supplied Authorization is the caller's business: keep it,
        // and never treat its failure as this module's token being rejected.
        if (headers.has('Authorization')) return baseFetch(input, init);
        headers.set('Authorization', `Bearer ${token}`);
        const requestInit = init ? { ...init, headers } : { headers };
        const response = await baseFetch(input, requestInit);
        if (response.status !== 401 || state.accessToken !== token)
            return response;
        let outcome;
        try {
            outcome = await refreshSession({}, context);
        } catch (err) {
            scheduleRetry(err, context, state);
            return response;
        }
        if (outcome === REFRESH_NONE) {
            rejectToken(token, context);
            if (activeAuthKey === ownerKey) requestReauth(context);
            return response;
        }
        const method = (
            (init && init.method) ||
            (input && typeof input.method === 'string' ? input.method : 'GET')
        ).toUpperCase();
        const renewed = state.accessToken;
        if (
            outcome !== REFRESH_INSTALLED ||
            !renewed ||
            (method !== 'GET' && method !== 'HEAD')
        )
            return response;
        const retryHeaders = requestHeaders(input, init);
        retryHeaders.set('Authorization', `Bearer ${renewed}`);
        return baseFetch(
            input,
            init ? { ...init, headers: retryHeaders } : { headers: retryHeaders },
        );
    };
    wrapped[WRAPPED_FETCH] = true;
    globalThis.fetch = wrapped;
}

// requestReauth coalesces every rejected request into one overlay, then reloads
// once after a successful sign-in.
function requestReauth(context) {
    const key = credentialKey(context);
    const state = stateForKey(key);
    if (state.reauthInFlight) return state.reauthInFlight;
    state.reauthInFlight = (async () => {
        try {
            const result = await showUnlockPrompt(context, 'v2');
            if (result.enabled && activeAuthKey === key) reloadPage();
        } catch {
            /* the overlay reports its own failure */
        } finally {
            state.reauthInFlight = null;
        }
    })();
    return state.reauthInFlight;
}

async function discoverAccessStatus(context) {
    return withAuthDeadline(async (signal) => {
        const res = await authFetch(context, '/api/auth/status', {
            cache: 'no-store',
            redirect: 'error',
            signal,
        });
        if (res.status !== 200)
            throw new Error('Unable to check Phi access protection');
        let payload;
        try {
            payload = await res.json();
        } catch {
            throw invalidStatusError();
        }
        return parseAccessStatus(payload);
    });
}

let pendingOverlay = null;

function showUnlockPrompt(context, protocol) {
    const state = stateFor(context);
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            if (pendingOverlay && pendingOverlay.finish === finish)
                pendingOverlay = null;
            overlay.remove();
            resolve(value);
        };
        const overlay = document.createElement('div');
        overlay.className = 'access-auth-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'access-auth-title');

        const dialog = document.createElement('form');
        dialog.className = 'access-auth-dialog';
        dialog.noValidate = true;

        const title = document.createElement('h1');
        title.id = 'access-auth-title';
        title.textContent = 'Sign in to Phi';
        dialog.appendChild(title);

        const subtitle = document.createElement('p');
        subtitle.className = 'access-auth-subtitle';
        subtitle.textContent = 'Enter your password to continue.';
        dialog.appendChild(subtitle);

        const label = document.createElement('label');
        label.htmlFor = 'access-auth-password';
        label.textContent = 'Password';
        dialog.appendChild(label);

        const input = document.createElement('input');
        input.id = 'access-auth-password';
        input.type = 'password';
        input.autocomplete = 'current-password';
        input.required = true;
        dialog.appendChild(input);

        const error = document.createElement('div');
        error.className = 'access-auth-error';
        error.setAttribute('role', 'alert');
        dialog.appendChild(error);

        const submit = document.createElement('button');
        submit.className = 'btn btn-accent';
        submit.type = 'submit';
        submit.textContent = 'Sign in';
        dialog.appendChild(submit);

        dialog.addEventListener('submit', async (event) => {
            event.preventDefault();
            error.textContent = '';
            submit.disabled = true;
            // The pure-JS derivation runs for a minute or more on phones:
            // WebKit disables the JIT for plain-HTTP origins, so 600k PBKDF2
            // iterations run at interpreter speed. Tick the label so the
            // wait reads as slow instead of dead.
            // performance.now(): monotonic, so a clock correction during a
            // long derivation cannot make an old challenge look young.
            const started = performance.now();
            const epoch = state.epoch;
            submit.textContent = 'Signing in…';
            // requestAnimationFrame, not setInterval: Chromium's
            // scheduler.yield keeps rendering alive but starves timers.
            let shownSeconds = 0;
            let ticker = requestAnimationFrame(function tick() {
                const seconds = Math.round((performance.now() - started) / 1000);
                if (seconds !== shownSeconds) {
                    shownSeconds = seconds;
                    submit.textContent = `Signing in… ${seconds}s`;
                }
                ticker = requestAnimationFrame(tick);
            });
            try {
                if (protocol === 'v2') {
                    const bundle = await v2Login(input.value, context);
                    if (epoch !== state.epoch) return;
                    adoptToken(bundle.token, bundle, context);
                    input.value = '';
                    finish({ enabled: true });
                    return;
                }
                const status = await getStatus(context);
                if (epoch !== state.epoch) return;
                if (!status.enabled) {
                    finish({ enabled: false });
                    return;
                }
                const verifier = await deriveVerifier(input.value, status.raw);
                if (epoch !== state.epoch) return;
                const challenge = await freshStatus(status.raw, started, context);
                if (epoch !== state.epoch) return;
                if (!challenge) {
                    // The derivation outlived the challenge and the refresh
                    // failed. Posting it would count as a failed attempt and
                    // report a correct password as wrong.
                    error.textContent = 'Sign-in took too long. Try again.';
                    input.select();
                    return;
                }
                const verdict = await login(challenge, verifier, context);
                if (epoch !== state.epoch) return;
                if (verdict === 'rate-limited') {
                    // Rate limited, not a wrong password: the server refuses
                    // every attempt until its backoff ends, so saying "Wrong
                    // password" would send the user into a retry loop that
                    // cannot work.
                    error.textContent =
                        'Too many attempts. Wait about a minute, then try again.';
                    input.select();
                    return;
                }
                if (verdict === 'rejected') {
                    error.textContent = 'Wrong password';
                    input.select();
                    return;
                }
                if (verdict === 'transient') {
                    error.textContent = 'Unable to reach Phi. Try again.';
                    input.select();
                    return;
                }
                storeCredential(status.raw, verifier, context);
                input.value = '';
                finish({ enabled: true });
            } catch (err) {
                if (epoch !== state.epoch) return;
                error.textContent =
                    err instanceof Error ? err.message : 'Unable to unlock Phi';
                input.select();
            } finally {
                cancelAnimationFrame(ticker);
                submit.disabled = false;
                submit.textContent = 'Sign in';
            }
        });

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        pendingOverlay = { finish, ownerKey: credentialKey(context) };
        requestAnimationFrame(() => input.focus());
    });
}

// Called before App.init() so the normal UI never starts fetching protected
// data until either the bearer, the session cookie, or a remembered derived
// credential works. The selection is fixed for the rest of the page load: a
// v2 failure never falls back to v1.
export async function bootstrapAccessAuth(context) {
    const state = activateAuthContext(context);
    discardLegacyBearer(context);
    installAccessFetch();
    const ownerKey = activeAuthKey;
    let epoch = state.epoch;
    const superseded = () =>
        state.epoch !== epoch || activeAuthKey !== ownerKey;
    let releaseHost = () => {};
    const hostInstall = new Promise((resolve) => {
        releaseHost = () => resolve(HOST_INSTALL);
    });
    state.pendingBootstrapRelease = releaseHost;
    const wait = (promise) => Promise.race([promise, hostInstall]);

    try {
        let status;
        try {
            status = await wait(discoverAccessStatus(context));
        } catch (err) {
            // A host token installed during discovery supersedes its failure.
            if (superseded()) return { enabled: state.accessEnabled };
            throw err;
        }
        if (status === HOST_INSTALL || superseded())
            return { enabled: state.accessEnabled };

        // Keep v2 selected across re-bootstrap unless the server is now v1-only.
        const advertised = preferredProtocol(status.protocols);
        const hadV2Selection = state.selectedProtocol === 'v2';
        const protocol =
            hadV2Selection && advertised === 'v1'
                ? 'v1'
                : state.selectedProtocol || advertised;
        state.accessEnabled = status.enabled;
        // Fix the protocol before any login attempt; only an authenticated
        // session or a successful saved-v1 login may select v1.
        state.selectedProtocol = protocol;
        if (protocol === 'v1' && hadV2Selection) {
            // A v1-only server cannot use the previous bearer.
            clearTokenState(state);
            state.epoch++;
            epoch = state.epoch;
        }
        if (!status.enabled) {
            if (state.accessToken) {
                clearTokenState(state);
                state.epoch++;
                epoch = state.epoch;
            }
            return { enabled: false };
        }

        if (protocol === 'v2' && state.accessToken) {
            const token = state.accessToken;
            let verdict;
            try {
                verdict = await wait(checkV2Token(token, context));
            } catch (err) {
                if (superseded()) return { enabled: state.accessEnabled };
                throw err;
            }
            if (verdict === HOST_INSTALL || superseded())
                return { enabled: state.accessEnabled };
            if (verdict === 'valid') return { enabled: true };
            rejectToken(token, context);
            // No cookie fallback: an explicit v2 credential decides alone.
            return showUnlockPrompt(context, 'v2');
        }

        if (protocol === 'v1' || !hadV2Selection) {
            if (status.authenticated) {
                state.selectedProtocol = 'v1';
                return { enabled: true };
            }

            // A saved v1 verifier is only usable when the status still carries
            // v1 KDF metadata; a v2-only status must not be rejected by those bounds.
            if (hasV1Metadata(status)) {
                const verifier = savedVerifier(status.raw, context);
                if (verifier) {
                    const verdict = await wait(login(status.raw, verifier, context));
                    if (verdict === HOST_INSTALL || superseded())
                        return { enabled: state.accessEnabled };
                    if (verdict === 'ok') {
                        state.selectedProtocol = 'v1';
                        return { enabled: true };
                    }
                    if (verdict === 'transient' || verdict === 'rate-limited')
                        throw new Error('Unable to check Phi access protection');
                }
            }
        }

        if (protocol === 'v2') {
            let outcome;
            try {
                outcome = await wait(refreshSession({}, context));
            } catch (err) {
                if (superseded()) return { enabled: state.accessEnabled };
                throw err;
            }
            if (outcome === REFRESH_INSTALLED) return { enabled: true };
            if (outcome === HOST_INSTALL || superseded())
                return { enabled: state.accessEnabled };
            if (outcome === REFRESH_SUPERSEDED && state.accessToken)
                return { enabled: true };
            return showUnlockPrompt(context, 'v2');
        }
        return showUnlockPrompt(context, 'v1');
    } finally {
        if (state.pendingBootstrapRelease === releaseHost)
            state.pendingBootstrapRelease = null;
    }
}

async function createPasswordRecord(
    password,
    { iterations = 600000, salt } = {},
) {
    if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
        throw new Error(
            `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
        );
    }
    if (!salt) {
        if (!globalThis.crypto?.getRandomValues) {
            throw new Error(
                'This browser cannot securely generate a password salt',
            );
        }
        salt = new Uint8Array(16);
        globalThis.crypto.getRandomValues(salt);
    }
    const status = {
        enabled: true,
        version: 'v1',
        algorithm: 'pbkdf2-sha256',
        iterations,
        salt: bytesToBase64URL(salt),
    };
    const verifier = await deriveVerifier(password, status);
    return {
        status,
        verifier,
        passwordHash: [
            status.version,
            status.algorithm,
            String(status.iterations),
            status.salt,
            bytesToBase64URL(verifier),
        ].join('.'),
    };
}

// Called from the existing Config modal. The returned password record is the
// only thing written to config.toml; the raw password is discarded immediately.
export async function setAccessPassword(password, context) {
    const state = stateFor(context);
    if (state.selectedProtocol === 'v2')
        return saveV2Password(password, context);
    const epoch = state.epoch;
    const { passwordHash, status, verifier } =
        await createPasswordRecord(password);
    if (epoch !== state.epoch)
        throw new Error('Phi access changed; try again');
    await withAuthDeadline(async (signal) => {
        const res = await authFetch(context, '/api/auth/password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password_hash: passwordHash }),
            redirect: 'error',
            signal,
        });
        if (!res.ok)
            throw new Error(
                (await res.text()) || 'Unable to save access password',
            );
    });
    if (epoch === state.epoch) {
        storeCredential(status, verifier, context);
        state.epoch++;
    }
    return { enabled: true };
}

export async function clearAccessPassword(context) {
    const state = stateFor(context);
    if (state.selectedProtocol === 'v2')
        return clearV2Password(context);
    const epoch = state.epoch;
    await withAuthDeadline(async (signal) => {
        const res = await authFetch(context, '/api/auth/password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password_hash: '' }),
            redirect: 'error',
            signal,
        });
        if (!res.ok)
            throw new Error(
                (await res.text()) || 'Unable to clear access password',
            );
    });
    if (epoch === state.epoch) {
        clearCredential(context);
        state.epoch++;
    }
    return { enabled: false };
}

// getAccessToken returns the selected v2 bearer, or null in v1 mode.
export function getAccessToken() {
    return activeAuthState().accessToken;
}

// installToken is the host bridge: it installs a memory-only v2 credential
// (never localStorage), releases a pending unlock overlay, and lets a loaded
// body continue bootstrap. The host renews its token, so this page does not.
export function installToken(token) {
    if (typeof token !== 'string' || !token) return false;
    const state = activeAuthState();
    clearTimeout(state.renewalTimer);
    clearTimeout(state.retryTimer);
    state.renewalTimer = null;
    state.retryTimer = null;
    state.accessToken = token;
    state.accessEnabled = true;
    state.selectedProtocol = 'v2';
    state.epoch++;
    state.persistedToken = null;
    state.memoryOnly = true;
    state.accessExpiresAt = 0;
    state.refreshIdleExpiresAt = 0;
    state.refreshAbsoluteExpiresAt = 0;
    const releaseBootstrap = state.pendingBootstrapRelease;
    state.pendingBootstrapRelease = null;
    if (releaseBootstrap) releaseBootstrap();
    if (pendingOverlay?.ownerKey === activeAuthKey)
        pendingOverlay.finish({ enabled: true });
    return true;
}

export async function logoutAccess(all = false, context) {
    const state = stateFor(context);
    const token = state.accessToken;
    if (!token) throw new Error('Sign in to continue');
    const epoch = state.epoch;
    const result = await withAuthDeadline(async (signal) => {
        const res = await authFetch(context, '/api/auth/v2/logout', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Phi-Auth': 'v2',
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ all: all === true }),
            credentials: 'same-origin',
            redirect: 'error',
            signal,
        });
        if (!res.ok) return { ok: false };
        try {
            return { ok: true, payload: await res.json() };
        } catch {
            return { ok: false };
        }
    });
    if (!result.ok || !result.payload || result.payload.ok !== true)
        throw new Error('Unable to logout');
    if (epoch === state.epoch && state.accessToken === token) {
        clearTokenState(state);
        state.epoch++;
    }
    broadcastInvalidation(credentialKey(context));
    if (pendingOverlay?.ownerKey === credentialKey(context))
        pendingOverlay.finish({ enabled: false });
    return { ok: true };
}

// webSocketURL clones a socket URL and, in v2 mode, appends the bearer as one
// encoded query parameter. The token only travels to the page's own origin.
export function webSocketURL(url) {
    const target = new URL(url instanceof URL ? url.href : String(url));
    const state = activeAuthState();
    if (state.selectedProtocol !== 'v2' || !state.accessToken) return target;
    const httpOrigin = target.origin
        .replace(/^ws:/, 'http:')
        .replace(/^wss:/, 'https:');
    if (httpOrigin !== location.origin) return target;
    target.searchParams.set('token', state.accessToken);
    return target;
}

// authAssetURL makes a protected same-origin asset loadable by the DOM. A v2
// bearer session has no cookie, so <img>, media, download, and iframe loads
// cannot authenticate themselves: fetch the bytes with the module credential
// and return an object URL plus its release. Every other address comes back
// unchanged, so v1 sessions and public assets behave exactly as before.
export async function authAssetURL(url) {
    const target = new URL(
        url instanceof URL ? url.href : String(url),
        location.href,
    );
    const state = activeAuthState();
    if (
        state.selectedProtocol !== 'v2' ||
        !state.accessToken ||
        target.origin !== location.origin ||
        !isProtectedAPIPath(target.pathname)
    )
        return { url: target.href, revoke() {} };
    // The installed wrapper supplies the bearer and reports a rejected token.
    const res = await fetch(target.href, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Unable to load asset (${res.status})`);
    const objectURL = URL.createObjectURL(await res.blob());
    return { url: objectURL, revoke: () => URL.revokeObjectURL(objectURL) };
}

if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        void renewIfDue();
    });
}

if (typeof window !== 'undefined') {
    const bridge = window.phiAccessAuth || {};
    bridge.installToken = installToken;
    bridge.getAccessToken = getAccessToken;
    bridge.webSocketURL = webSocketURL;
    bridge.refreshAccessIfDue = refreshAccessIfDue;
    bridge.assetURL = authAssetURL;
    window.phiAccessAuth = bridge;
}

export const __test__ = {
    bytesToBase64URL,
    base64URLToBytes,
    validStatus,
    savedVerifier,
    clearCredential,
    createPasswordRecord,
    storeCredential,
    deriveVerifier,
    freshStatus,
    nativeDerive,
    resetNativeDerive,
    parseAccessStatus,
    parseProtocols,
    parseCredentialBundle,
    refreshSession,
    renewIfDue,
    refreshDue,
    receiveBundle,
    resetAccessState,
    setReload,
    getAccessState,
};

// resetAccessState restores the module to its pre-bootstrap state. Tests call
// it between cases; nothing in the app calls it.
function resetAccessState() {
    for (const state of authStates.values()) {
        state.epoch++;
        clearTokenState(state);
        state.refreshInFlight = null;
        const releaseBootstrap = state.pendingBootstrapRelease;
        state.pendingBootstrapRelease = null;
        if (releaseBootstrap) releaseBootstrap();
    }
    authStates.clear();
    activeAuthContext = null;
    activeAuthKey = credentialKey();
    authStates.set(activeAuthKey, newAuthState());
    pendingOverlay = null;
    if (invalidation) {
        if (typeof invalidation.close === 'function') invalidation.close();
        invalidation = null;
    }
    reloadPage = () => location.reload();
}

function setReload(fn) {
    reloadPage = fn;
}

function getAccessState() {
    const {
        selectedProtocol,
        accessEnabled,
        accessToken,
        persistedToken,
        memoryOnly,
        accessExpiresAt,
    } = activeAuthState();
    return {
        selectedProtocol,
        accessEnabled,
        accessToken,
        persistedToken,
        memoryOnly,
        accessExpiresAt,
    };
}
