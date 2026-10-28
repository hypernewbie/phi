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
// The candidate persisted the v2 bearer under this key. That directive is
// superseded: no access token or refresh handle is ever written to browser
// storage, and the refresh handle exists only in its HttpOnly cookie. The old
// value is removed without being read or sent anywhere.
const LEGACY_BEARER_KEY = 'phi_access_bearer_v1';

function discardLegacyBearer() {
    try {
        localStorage.removeItem(LEGACY_BEARER_KEY);
    } catch {
        // Storage is blocked, so nothing was persisted and nothing migrates.
    }
}

discardLegacyBearer();

// The desktop's embedded page serves EVERY server from one page, so one
// localStorage holds every server's credential. A single shared key made
// each server overwrite the previous one's credential: the next server
// found a foreign salt, treated it as a rotation, cleared it, and asked
// for the password again. The key is namespaced per server instead. In a
// plain browser tab each server has its own origin (and its own
// localStorage), so the key stays unchanged there.
function credentialKey() {
    return serverKey(CREDENTIAL_KEY);
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

async function getStatus() {
    return withAuthDeadline(async (signal) => {
        const res = await fetch('/api/auth/status', {
            cache: 'no-store',
            redirect: 'error',
            signal,
        });
        if (res.status !== 200)
            throw new Error('Unable to check Phi access protection');
        const status = await res.json();
        if (status.enabled && !validStatus(status))
            throw new Error('Phi returned invalid access protection settings');
        return status;
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

function storeCredential(status, verifier) {
    try {
        localStorage.setItem(
            credentialKey(),
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

function clearCredential() {
    try {
        localStorage.removeItem(credentialKey());
    } catch {
        /* ignored */
    }
}

function savedVerifier(status) {
    try {
        const saved = JSON.parse(
            localStorage.getItem(credentialKey()) || 'null',
        );
        if (
            !saved ||
            saved.version !== status.version ||
            saved.algorithm !== status.algorithm ||
            saved.iterations !== status.iterations ||
            saved.salt !== status.salt
        ) {
            clearCredential();
            return null;
        }
        const verifier = base64URLToBytes(saved.verifier);
        return verifier.length === 32 ? verifier : null;
    } catch {
        clearCredential();
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
async function login(status, verifier) {
    const proof = bytesToBase64URL(
        hmac(sha256, verifier, new TextEncoder().encode(status.challenge)),
    );
    try {
        return await withAuthDeadline(async (signal) => {
            const res = await fetch('/api/auth/login', {
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
async function freshStatus(fallback, startedAt) {
    if (performance.now() - startedAt < challengeRefreshAfterMs) return fallback;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), statusFetchTimeoutMs);
    try {
        const res = await fetch('/api/auth/status', {
            cache: 'no-store',
            signal: controller.signal,
        });
        const status = await res.json();
        if (validStatus(status)) return status;
    } catch {
        // Fall through to the expiry check below.
    } finally {
        clearTimeout(timer);
    }
    return performance.now() - startedAt < challengeLifetimeMs
        ? fallback
        : null;
}

// --- v2 bearer client ----------------------------------------------------

let selectedProtocol = null; // 'v1' | 'v2' | null before discovery
let accessEnabled = false; // last discovered enforcement state
let accessToken = null; // in-memory bearer; null in v1 mode
let memoryOnly = false; // host-installed token: renewed by the host, not here
let stateEpoch = 0; // bumped whenever the selected credential changes
// Server-reported deadlines for the installed token, in Unix seconds. Like the
// token they are memory-only: the server is the only durable owner.
let accessExpiresAt = 0;
let refreshIdleExpiresAt = 0;
let refreshAbsoluteExpiresAt = 0;
// Renewal lead: a token is renewed this long before it expires. The stale-token
// path in the fetch wrapper covers a tab whose timers were throttled anyway.
const REFRESH_LEAD_MS = 60 * 1000;
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60000;
let renewalTimer = null;
let retryTimer = null;
let retryDelayMs = 0;
// Resolves a bootstrap that is waiting on the network when a host token
// arrives. The late response is fenced by stateEpoch.
let pendingBootstrapRelease = null;
const HOST_INSTALL = Symbol('host install');

// A logout in one tab invalidates the credential in every other tab. The
// message carries no secret: it only reports that the family is gone.
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
                dropCredential();
                if (pendingOverlay) pendingOverlay.finish({ enabled: false });
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

function broadcastInvalidation() {
    const channel = invalidationChannel();
    if (channel) channel.postMessage({ kind: 'logout' });
}

// broadcastBundle shares a renewed bundle with the other tabs of this
// origin/profile. The token already lives in this page's memory, so the
// message crosses no boundary a same-origin script could not cross itself. It
// carries no refresh handle - that stays in its HttpOnly cookie.
function broadcastBundle() {
    const channel = invalidationChannel();
    if (!channel || !accessToken) return;
    channel.postMessage({
        kind: 'bundle',
        origin: location.origin,
        bundle: {
            token: accessToken,
            expiresAt: accessExpiresAt,
            refreshIdleExpiresAt,
            refreshAbsoluteExpiresAt,
        },
    });
}

// receiveBundle adopts another tab's memory-only bundle. Deadlines only move
// forward, so a late message from an older refresh cannot replace a newer
// token, and a host install always outranks a page bundle.
function receiveBundle(message) {
    const bundle = message.bundle;
    if (!bundle || typeof bundle.token !== 'string' || !bundle.token) return;
    if (message.origin !== location.origin) return;
    if (!Number.isInteger(bundle.expiresAt) || bundle.expiresAt <= 0) return;
    if (memoryOnly) return;
    if (accessToken && bundle.expiresAt <= accessExpiresAt) return;
    adoptToken(bundle.token, bundle, { broadcast: false });
}

function utf8Length(value) {
    return new TextEncoder().encode(value).length;
}

function authTimeoutError() {
    return new Error('Phi did not respond. Try again.');
}

// The race settles the deadline even when a fetch implementation ignores the
// abort signal, so a stalled connection cannot hold bootstrap or a submit
// button open forever.
async function withAuthDeadline(run) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(authTimeoutError());
        }, AUTH_TIMEOUT_MS);
    });
    try {
        return await Promise.race([run(controller.signal), deadline]);
    } finally {
        clearTimeout(timer);
    }
}

// --- credential bundles and the refresh owner ---------------------------

// parseCredentialBundle accepts exactly the frozen credential bundle: an
// access token plus integer Unix-second deadlines. expires_in is a duration
// for this response only, so it is never treated as durable freshness.
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

// One refresh owner per server origin. Simultaneous callers share the in-flight
// request instead of rotating the same handle twice, and tabs of the same origin
// serialize through one named lock so a page reload cannot consume the handle a
// sibling just rotated. Without Locks, per-page single-flight still applies and
// the server's grace window covers the overlap.
const REFRESH_LOCK_PREFIX = 'phi-access-refresh:';
const refreshOwners = new Map();

// refreshDue reports whether the installed token is close enough to expiry to
// justify a request. A session with no token is always due.
function refreshDue() {
    if (!accessToken || !accessExpiresAt) return true;
    return accessExpiresAt * 1000 - Date.now() <= REFRESH_LEAD_MS;
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

function refreshSession({ ifDue = false } = {}) {
    const origin = location.origin;
    const pending = refreshOwners.get(origin);
    if (pending) return pending;
    // A host-installed token is renewed by the host; rotating it here would
    // race the host's own owner and consume its handle.
    if (memoryOnly) return Promise.resolve(REFRESH_NONE);
    const attempt = withRefreshLock(origin, () =>
        // Re-evaluated inside the lock: a bundle broadcast while this caller
        // waited makes the network request unnecessary.
        ifDue && !refreshDue() ? REFRESH_INSTALLED : runRefresh(origin),
    );
    refreshOwners.set(origin, attempt);
    void attempt
        .catch(() => {})
        .then(() => {
            if (refreshOwners.get(origin) === attempt)
                refreshOwners.delete(origin);
        });
    return attempt;
}

// retryAfterMs honors the server's own backoff instruction, bounded so a
// nonsense header cannot park the retry loop for hours.
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

// Only 401 ends the session. Every other failure keeps the credential, logs
// nobody out, and stays retryable; a malformed bundle is a server fault, not a
// reason to prompt for a password.
async function runRefresh(origin) {
    const epoch = stateEpoch;
    const res = await withAuthDeadline((signal) =>
        fetch('/api/auth/v2/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Phi-Auth': 'v2' },
            body: '{}',
            credentials: 'same-origin',
            redirect: 'error',
            signal,
        }),
    ).catch(() => {
        throw new Error('Unable to reach Phi. Try again.');
    });
    if (res.status === 401) return REFRESH_NONE;
    if (!res.ok)
        throw refreshFailure(
            'Unable to refresh access session',
            retryAfterMs(res),
        );
    let payload;
    try {
        payload = await res.json();
    } catch {
        throw invalidStatusError();
    }
    const bundle = parseCredentialBundle(payload);
    if (!bundle) throw invalidStatusError();
    // A non-positive duration cannot be used for this page load and is not a
    // credential failure, so it stays retryable instead of prompting.
    if (bundle.expiresIn <= 0)
        throw new Error('Unable to refresh access session');
    // A host install, logout, or origin change during the request is newer
    // than this answer.
    if (epoch !== stateEpoch || location.origin !== origin)
        return REFRESH_SUPERSEDED;
    adoptToken(bundle.token, bundle);
    return REFRESH_INSTALLED;
}

// adoptToken installs a v2 credential this module obtained. It lives in memory
// for the rest of the page load and is never persisted.
function adoptToken(token, bundle = null, { broadcast = true } = {}) {
    accessToken = token;
    accessEnabled = true;
    selectedProtocol = 'v2';
    accessExpiresAt = bundle ? bundle.expiresAt : 0;
    refreshIdleExpiresAt = bundle ? bundle.refreshIdleExpiresAt : 0;
    refreshAbsoluteExpiresAt = bundle ? bundle.refreshAbsoluteExpiresAt : 0;
    retryDelayMs = 0;
    stateEpoch++;
    scheduleRenewal();
    if (broadcast) broadcastBundle();
    // A replacement credential makes an open reauthentication prompt moot.
    if (pendingOverlay) pendingOverlay.finish({ enabled: true });
}

// clearTokenState forgets the in-memory token and everything scheduled for it
// without changing the selected protocol. It never touches the HttpOnly refresh
// cookie, which only the server can clear.
function clearTokenState() {
    accessToken = null;
    accessExpiresAt = 0;
    refreshIdleExpiresAt = 0;
    refreshAbsoluteExpiresAt = 0;
    clearTimeout(renewalTimer);
    renewalTimer = null;
}

// dropCredential forgets the credential and supersedes every operation that
// depended on it.
function dropCredential() {
    clearTokenState();
    selectedProtocol = 'v2';
    stateEpoch++;
}

// rejectToken clears only the token that failed. A delayed 401 for token A
// must not clear a token B installed after it, and a rejection never changes
// the selected protocol.
function rejectToken(token) {
    if (!token || accessToken !== token) return;
    clearTokenState();
    // Token absence alone must not select v1: keep the v2 choice.
    selectedProtocol = 'v2';
}

// scheduleRenewal renews near expiry for the current generation only. A timer
// armed for a credential that has since been replaced or dropped cannot renew
// anything.
function scheduleRenewal() {
    clearTimeout(renewalTimer);
    renewalTimer = null;
    if (!accessToken || memoryOnly || !accessExpiresAt) return;
    const epoch = stateEpoch;
    const delay = Math.max(
        0,
        accessExpiresAt * 1000 - Date.now() - REFRESH_LEAD_MS,
    );
    renewalTimer = setTimeout(() => {
        renewalTimer = null;
        if (epoch !== stateEpoch) return;
        void renewIfDue();
    }, delay);
}

// scheduleRetry retries a failed renewal with bounded jitter/backoff, honoring
// Retry-After. Nothing is cleared: a failed refresh must not log anybody out,
// open a prompt, or drop rendered data.
function scheduleRetry(err) {
    clearTimeout(retryTimer);
    retryTimer = null;
    if (!accessToken || memoryOnly) return;
    const epoch = stateEpoch;
    retryDelayMs = retryDelayMs
        ? Math.min(RETRY_MAX_MS, retryDelayMs * 2)
        : RETRY_BASE_MS;
    const jitter = retryDelayMs * 0.2 * Math.random();
    const honored =
        err && Number.isFinite(err.retryAfterMs) ? err.retryAfterMs : 0;
    const delay = Math.max(honored, retryDelayMs + jitter);
    retryTimer = setTimeout(() => {
        retryTimer = null;
        if (epoch !== stateEpoch) return;
        void renewIfDue({ ifDue: false });
    }, delay);
}

// renewIfDue is the background renewal owner: the scheduled timer, a return to
// a visible tab, and a socket reconnect all call it. A 401 is the only outcome
// that ends the session.
async function renewIfDue({ ifDue = true } = {}) {
    if (!accessToken || memoryOnly) return;
    if (ifDue && !refreshDue()) {
        scheduleRenewal();
        return;
    }
    const epoch = stateEpoch;
    let outcome;
    try {
        outcome = await refreshSession({ ifDue });
    } catch (err) {
        if (epoch !== stateEpoch) return;
        scheduleRetry(err);
        return;
    }
    if (epoch !== stateEpoch) return;
    if (outcome === REFRESH_INSTALLED) return;
    if (outcome === REFRESH_NONE) {
        // The refresh cookie is gone: the server has ended this session.
        dropCredential();
        void requestReauth();
        return;
    }
    scheduleRenewal();
}

// refreshAccessIfDue lets a reconnecting socket bring the credential up to date
// without a request when the in-memory token is still fresh. It returns
// undefined synchronously when nothing is due, so a redial is not deferred by a
// microtask and v1/disabled deployments keep their exact dial behavior.
export function refreshAccessIfDue() {
    if (!accessToken || memoryOnly) return undefined;
    if (!refreshDue()) {
        scheduleRenewal();
        return undefined;
    }
    return renewIfDue();
}

// checkV2Token reports whether the server still accepts token. A rejected
// token is 'invalid'; transport errors and 429/5xx throw, so a transient
// failure never destroys a saved credential or changes protocol.
async function checkV2Token(token) {
    return withAuthDeadline(async (signal) => {
        const res = await fetch('/api/auth/v2/status', {
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

async function v2Login(password) {
    return withAuthDeadline(async (signal) => {
        const res = await fetch('/api/auth/v2/login', {
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
        return bundle.token;
    });
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

function v2PasswordError(res) {
    if (res.status === 401) return new Error('Sign in to change Phi access');
    if (res.status === 429)
        return new Error('Too many attempts. Try again in a moment.');
    return new Error('Unable to save access password');
}

async function saveV2Password(password) {
    validateV2Password(password);
    const epoch = stateEpoch;
    const headers = {
        'Content-Type': 'application/json',
        'X-Phi-Auth': 'v2',
    };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    const payload = await withAuthDeadline(async (signal) => {
        const res = await fetch('/api/auth/v2/password', {
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
    if (
        !payload ||
        payload.enabled !== true ||
        !bundle ||
        bundle.expiresIn <= 0
    )
        throw new Error('Unable to save access password');
    if (epoch === stateEpoch) adoptToken(bundle.token);
    return { enabled: true };
}

async function clearV2Password() {
    if (!accessEnabled && !accessToken) return { enabled: false };
    const epoch = stateEpoch;
    const headers = {
        'Content-Type': 'application/json',
        'X-Phi-Auth': 'v2',
    };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    const payload = await withAuthDeadline(async (signal) => {
        const res = await fetch('/api/auth/v2/password', {
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
    // Never discard a live credential because a proxy or error page returned
    // a successful-looking response with the wrong body.
    if (!payload || payload.enabled !== false)
        throw new Error('Unable to clear access password');
    // A credential installed while the clear was in flight is newer than
    // this response; never clear it.
    if (epoch !== stateEpoch) return { enabled: false };
    accessToken = null;
    accessEnabled = false;
    selectedProtocol = 'v2';
    stateEpoch++;
    broadcastInvalidation();
    if (pendingOverlay) pendingOverlay.finish({ enabled: false });
    return { enabled: false };
}

// --- protected fetch wrapper --------------------------------------------

const WRAPPED_FETCH = Symbol.for('phi.accessFetch');
let reloadPage = () => location.reload();
let reauthInFlight = null;

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
// the in-memory bearer. Only a 401 means the access credential expired or was
// revoked; a 403 is a route-specific refusal and reaches the caller unchanged.
// A stale-token 401 starts the one refresh owner and then retries this request
// once, and only when it is idempotent (GET/HEAD). A mutation is never replayed
// here: the caller resubmits after the refreshed state renders.
export function installAccessFetch() {
    const baseFetch = globalThis.fetch;
    if (!baseFetch || baseFetch[WRAPPED_FETCH]) return;
    const wrapped = async (input, init) => {
        const url = requestURL(input);
        const token = accessToken;
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
        if (response.status !== 401) return response;
        // A delayed rejection of token A must not touch token B.
        if (accessToken !== token) return response;
        let outcome;
        try {
            outcome = await refreshSession();
        } catch {
            // Transient failure: keep the credential, surface this response,
            // and let the background owner retry with backoff.
            scheduleRetry();
            return response;
        }
        if (outcome === REFRESH_NONE) {
            rejectToken(token);
            requestReauth();
            return response;
        }
        const method = (
            (init && init.method) ||
            (input && typeof input.method === 'string' ? input.method : 'GET')
        ).toUpperCase();
        const renewed = accessToken;
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
function requestReauth() {
    if (reauthInFlight) return reauthInFlight;
    reauthInFlight = (async () => {
        try {
            const result = await showUnlockPrompt('v2');
            if (result.enabled) reloadPage();
        } catch {
            /* the overlay reports its own failure */
        } finally {
            reauthInFlight = null;
        }
    })();
    return reauthInFlight;
}

async function discoverAccessStatus() {
    return withAuthDeadline(async (signal) => {
        const res = await fetch('/api/auth/status', {
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

function showUnlockPrompt(protocol) {
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
            // A host token installed while this request was in flight is
            // newer than the response: it must win and the overlay is gone.
            const epoch = stateEpoch;
            try {
                if (protocol === 'v2') {
                    const token = await v2Login(input.value);
                    if (epoch !== stateEpoch) return;
                    adoptToken(token);
                    input.value = '';
                    finish({ enabled: true });
                    return;
                }
                const status = await getStatus();
                if (epoch !== stateEpoch) return;
                if (!status.enabled) {
                    finish({ enabled: false });
                    return;
                }
                const verifier = await deriveVerifier(input.value, status);
                const challenge = await freshStatus(status, started);
                if (!challenge) {
                    // The derivation outlived the challenge and the refresh
                    // failed. Posting it would count as a failed attempt and
                    // report a correct password as wrong.
                    error.textContent = 'Sign-in took too long. Try again.';
                    input.select();
                    return;
                }
                if (epoch !== stateEpoch) return;
                const verdict = await login(challenge, verifier);
                if (epoch !== stateEpoch) return;
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
                storeCredential(status, verifier);
                input.value = '';
                finish({ enabled: true });
            } catch (err) {
                if (epoch !== stateEpoch) return;
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
        pendingOverlay = { finish };
        requestAnimationFrame(() => input.focus());
    });
}

// recoverV1 returns a bootstrap result when an unselected session still holds
// a working v1 cookie or saved verifier, or null when it holds neither. A
// selected v2 session never reaches here: its credential decides alone.
async function recoverV1(status, wait, installed) {
    if (status.authenticated) {
        selectedProtocol = 'v1';
        return { enabled: true };
    }
    // A saved v1 verifier is only usable when the status still carries v1 KDF
    // metadata; a v2-only status must not be rejected by those bounds.
    if (!hasV1Metadata(status)) return null;
    const verifier = savedVerifier(status.raw);
    if (!verifier) return null;
    const verdict = await wait(login(status.raw, verifier));
    if (verdict === HOST_INSTALL || installed()) return HOST_INSTALL;
    if (verdict === 'ok') {
        selectedProtocol = 'v1';
        return { enabled: true };
    }
    // A rate limit cannot verify the saved credential either, so it is as
    // unavailable as a transport failure: never prompt for a password the
    // server is refusing to check.
    if (verdict === 'transient' || verdict === 'rate-limited')
        throw new Error('Unable to check Phi access protection');
    return null;
}

// Called before App.init() so the normal UI never starts fetching protected
// data until a credential works. The selection is fixed for the rest of the
// page load: a v2 failure never falls back to v1.
export async function bootstrapAccessAuth() {
    installAccessFetch();
    discardLegacyBearer();
    const epoch = stateEpoch;
    const installed = () => epoch !== stateEpoch;
    // A host token can land while discovery or a status check is in flight.
    // Wake bootstrap at once instead of waiting for the network deadline.
    let releaseHost = () => {};
    const hostInstall = new Promise((resolve) => {
        releaseHost = () => resolve(HOST_INSTALL);
    });
    pendingBootstrapRelease = releaseHost;
    const wait = (promise) => Promise.race([promise, hostInstall]);

    let status;
    try {
        status = await wait(discoverAccessStatus());
    } catch (err) {
        // A host token installed during discovery supersedes its failure.
        if (installed()) return { enabled: accessEnabled };
        throw err;
    }
    if (status === HOST_INSTALL || installed())
        return { enabled: accessEnabled };

    // An existing v2 selection survives a re-bootstrap. Only a successful
    // v1-only discovery may change it; a missing token never selects v1.
    const advertised = preferredProtocol(status.protocols);
    const hadV2Selection = selectedProtocol === 'v2';
    const protocol =
        hadV2Selection && advertised === 'v1'
            ? 'v1'
            : selectedProtocol || advertised;
    accessEnabled = status.enabled;
    // Fix the protocol before any login attempt; the refresh and saved
    // verifier branches below are the only v2-to-v1 change.
    selectedProtocol = protocol;
    if (protocol === 'v1' && hadV2Selection) {
        // A v1-only server cannot use the bearer. This holds even when the
        // server reports authentication disabled.
        clearTokenState();
    }
    if (!status.enabled) {
        // Enforcement is off: a credential from before is stale, and a
        // refresh would rotate a session the server no longer honours.
        clearTokenState();
        return { enabled: false };
    }

    // An in-memory token decides alone; it never deduces back to v1.
    if (accessToken) {
        const token = accessToken;
        let verdict;
        try {
            verdict = await wait(checkV2Token(token));
        } catch (err) {
            if (installed()) return { enabled: accessEnabled };
            throw err;
        }
        if (verdict === HOST_INSTALL || installed())
            return { enabled: accessEnabled };
        if (verdict === 'valid') {
            adoptToken(token);
            return { enabled: true };
        }
        rejectToken(token);
        // No cookie fallback: an explicit v2 credential decides alone.
        return showUnlockPrompt('v2');
    }

    // An unselected session may still hold a working v1 cookie or verifier.
    // Trying those first avoids a pointless refresh and a needless prompt.
    if (protocol === 'v1' || !hadV2Selection) {
        let recovered;
        try {
            recovered = await recoverV1(status, wait, installed);
        } catch (err) {
            if (installed()) return { enabled: accessEnabled };
            throw err;
        }
        if (recovered === HOST_INSTALL || installed())
            return { enabled: accessEnabled };
        if (recovered) return recovered;
    }

    if (protocol === 'v2') {
        // The HttpOnly refresh cookie is the only bootstrap credential. A 401
        // keeps the v2 selection and prompts here, never on v1.
        let outcome;
        try {
            outcome = await wait(refreshSession());
        } catch (err) {
            if (installed()) return { enabled: accessEnabled };
            throw err;
        }
        if (outcome === REFRESH_INSTALLED) return { enabled: true };
        if (outcome === HOST_INSTALL || installed())
            return { enabled: accessEnabled };
        return showUnlockPrompt('v2');
    }
    return showUnlockPrompt('v1');
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
export async function setAccessPassword(password) {
    if (selectedProtocol === 'v2') return saveV2Password(password);
    const epoch = stateEpoch;
    const { passwordHash, status, verifier } =
        await createPasswordRecord(password);
    if (epoch !== stateEpoch)
        throw new Error('Phi access changed; try again');
    const res = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password_hash: passwordHash }),
    });
    if (!res.ok)
        throw new Error((await res.text()) || 'Unable to save access password');
    storeCredential(status, verifier);
    // The new credential supersedes any operation that started before it.
    stateEpoch++;
    return { enabled: true };
}

export async function clearAccessPassword() {
    if (selectedProtocol === 'v2') return clearV2Password();
    const epoch = stateEpoch;
    const res = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password_hash: '' }),
    });
    if (!res.ok)
        throw new Error(
            (await res.text()) || 'Unable to clear access password',
        );
    clearCredential();
    stateEpoch++;
    return { enabled: false };
}

// getAccessToken returns the selected v2 bearer, or null in v1 mode.
export function getAccessToken() {
    return accessToken;
}

// installToken is the host bridge: it installs a memory-only v2 credential
// (never localStorage), releases a pending unlock overlay, and lets a loaded
// body continue bootstrap. The host renews its own token, so no renewal timer
// or standalone refresh is armed for it.
export function installToken(token) {
    if (typeof token !== 'string' || !token) return false;
    clearTimeout(renewalTimer);
    renewalTimer = null;
    clearTimeout(retryTimer);
    retryTimer = null;
    accessToken = token;
    accessEnabled = true;
    selectedProtocol = 'v2';
    memoryOnly = true;
    accessExpiresAt = 0;
    refreshIdleExpiresAt = 0;
    refreshAbsoluteExpiresAt = 0;
    stateEpoch++;
    // Release a bootstrap still waiting on discovery or a status check.
    const releaseBootstrap = pendingBootstrapRelease;
    pendingBootstrapRelease = null;
    if (releaseBootstrap) releaseBootstrap();
    if (pendingOverlay) pendingOverlay.finish({ enabled: true });
    return true;
}

// logoutAccess revokes the current family (all=false) or every v2 family
// (all=true) on the server, then drops the in-memory credential. It claims
// nothing the server has not confirmed.
export async function logoutAccess(all = false) {
    const token = accessToken;
    if (!token) throw new Error('Sign in to continue');
    const epoch = stateEpoch;
    const res = await withAuthDeadline((signal) =>
        fetch('/api/auth/v2/logout', {
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
        }),
    );
    if (!res.ok) throw new Error('Unable to logout');
    let payload;
    try {
        payload = await res.json();
    } catch {
        throw new Error('Unable to logout');
    }
    if (!payload || payload.ok !== true) throw new Error('Unable to logout');
    // A credential installed while the logout was in flight is newer than it.
    if (epoch === stateEpoch && accessToken === token) {
        clearTokenState();
        stateEpoch++;
    }
    broadcastInvalidation();
    if (pendingOverlay) pendingOverlay.finish({ enabled: false });
    return { ok: true };
}

// webSocketURL clones a socket URL and, in v2 mode, appends the bearer as one
// encoded query parameter. The token only travels to the page's own origin.
export function webSocketURL(url) {
    const target = new URL(url instanceof URL ? url.href : String(url));
    if (selectedProtocol !== 'v2' || !accessToken) return target;
    const httpOrigin = target.origin
        .replace(/^ws:/, 'http:')
        .replace(/^wss:/, 'https:');
    if (httpOrigin !== location.origin) return target;
    target.searchParams.set('token', accessToken);
    return target;
}

if (typeof window !== 'undefined') {
    const bridge = window.phiAccessAuth || {};
    bridge.installToken = installToken;
    bridge.getAccessToken = getAccessToken;
    bridge.webSocketURL = webSocketURL;
    bridge.refreshAccessIfDue = refreshAccessIfDue;
    window.phiAccessAuth = bridge;
}

// A hidden tab has throttled timers, and a resumed machine may have slept
// through the whole token lifetime, so returning to the foreground re-checks
// the deadline instead of trusting the schedule.
if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        void renewIfDue();
    });
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
    selectedProtocol = null;
    accessEnabled = false;
    accessToken = null;
    memoryOnly = false;
    accessExpiresAt = 0;
    refreshIdleExpiresAt = 0;
    refreshAbsoluteExpiresAt = 0;
    clearTimeout(renewalTimer);
    renewalTimer = null;
    clearTimeout(retryTimer);
    retryTimer = null;
    retryDelayMs = 0;
    stateEpoch++;
    reauthInFlight = null;
    pendingOverlay = null;
    refreshOwners.clear();
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
    return {
        selectedProtocol,
        accessEnabled,
        accessToken,
        memoryOnly,
        accessExpiresAt,
    };
}
