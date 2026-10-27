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
// Standalone-browser storage for the v2 bearer. The desktop body serves every
// server from one page, so it installs its token in memory instead of writing
// here (installToken).
const BEARER_KEY = 'phi_access_bearer_v1';

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
let memoryOnly = false; // host-installed token: never write it to storage
let stateEpoch = 0; // bumped whenever the selected credential changes
// Resolves a bootstrap that is waiting on the network when a host token
// arrives. The late response is fenced by stateEpoch.
let pendingBootstrapRelease = null;
const HOST_INSTALL = Symbol('host install');

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

function loadBearer() {
    try {
        return localStorage.getItem(BEARER_KEY) || null;
    } catch {
        return null;
    }
}

function storeBearer(token) {
    try {
        localStorage.setItem(BEARER_KEY, token);
    } catch {
        // The in-memory token still works for this page load.
    }
}

function clearStoredBearer(token) {
    try {
        if (localStorage.getItem(BEARER_KEY) === token)
            localStorage.removeItem(BEARER_KEY);
    } catch {
        /* ignored */
    }
}

// adoptToken installs a v2 credential this module obtained. A host-installed
// session stays memory-only for the rest of the page load: later module calls
// (password change, reauthentication) must not write it to storage.
function adoptToken(token, { persist = false } = {}) {
    accessToken = token;
    accessEnabled = true;
    selectedProtocol = 'v2';
    stateEpoch++;
    if (persist && !memoryOnly) storeBearer(token);
    // A replacement credential makes an open reauthentication prompt moot.
    if (pendingOverlay) pendingOverlay.finish({ enabled: true });
}

// rejectToken clears only the token that failed. A delayed 401 for token A
// must not clear a token B installed after it, and a rejection never changes
// the selected protocol.
function rejectToken(token) {
    // A host-installed session owns no standalone storage; never delete a
    // token from another session just because its value matches.
    if (
        accessToken !== token &&
        (memoryOnly || loadBearer() !== token)
    )
        return;
    // A rejection does not supersede a credential operation that is already
    // in flight: its replacement token is newer than this failure.
    if (accessToken === token) accessToken = null;
    // Token absence alone must not select v1: keep the v2 choice.
    selectedProtocol = 'v2';
    if (!memoryOnly) clearStoredBearer(token);
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password }),
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
        if (!payload || typeof payload.token !== 'string' || !payload.token)
            throw new Error('Unable to sign in');
        return payload.token;
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
    const headers = { 'Content-Type': 'application/json' };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    const payload = await withAuthDeadline(async (signal) => {
        const res = await fetch('/api/auth/v2/password', {
            method: 'POST',
            headers,
            body: JSON.stringify({ password }),
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
    if (
        !payload ||
        payload.enabled !== true ||
        typeof payload.token !== 'string' ||
        !payload.token
    )
        throw new Error('Unable to save access password');
    if (epoch === stateEpoch) adoptToken(payload.token, { persist: true });
    return { enabled: true };
}

async function clearV2Password() {
    if (!accessEnabled && !accessToken) return { enabled: false };
    const epoch = stateEpoch;
    const activeToken = accessToken;
    const headers = { 'Content-Type': 'application/json' };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    const payload = await withAuthDeadline(async (signal) => {
        const res = await fetch('/api/auth/v2/password', {
            method: 'POST',
            headers,
            body: JSON.stringify({ password: '' }),
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
    // Remove only the token this session owned; a host session and another
    // standalone token belong to different sessions.
    if (activeToken && !memoryOnly) clearStoredBearer(activeToken);
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
// the in-memory bearer, and a rejected token can trigger one unlock overlay.
// It never replays the request that failed.
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
        const response = await baseFetch(
            input,
            init ? { ...init, headers } : { headers },
        );
        if (
            (response.status === 401 || response.status === 403) &&
            accessToken === token
        ) {
            rejectToken(token);
            requestReauth();
        }
        return response;
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
                    adoptToken(token, { persist: true });
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

// Called before App.init() so the normal UI never starts fetching protected
// data until either the bearer, the session cookie, or a remembered derived
// credential works. The selection is fixed for the rest of the page load: a
// v2 failure never falls back to v1.
export async function bootstrapAccessAuth() {
    installAccessFetch();
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
    // Fix the protocol before any login attempt; the cookie and saved
    // verifier branches below are the only v2-to-v1 change.
    selectedProtocol = protocol;
    if (protocol === 'v1' && hadV2Selection) {
        // A v1-only server cannot use the bearer; keep the stored token for
        // a server that can, but stop sending it here. This holds even when
        // the server reports authentication disabled.
        accessToken = null;
    }
    if (!status.enabled) return { enabled: false };

    if (protocol === 'v2') {
        const stored = loadBearer();
        const token = accessToken || stored;
        if (token) {
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
                // A stored token is already persisted; a host token is not.
                adoptToken(token);
                return { enabled: true };
            }
            rejectToken(token);
            // No cookie fallback: an explicit v2 credential decides alone.
            return showUnlockPrompt('v2');
        }
        if (hadV2Selection) {
            // The token was cleared after a rejection: token absence alone
            // must not select v1 on a server that still advertises v2.
            return showUnlockPrompt('v2');
        }
    }

    if (status.authenticated) {
        selectedProtocol = 'v1';
        return { enabled: true };
    }

    // A saved v1 verifier is only usable when the status still carries v1 KDF
    // metadata; a v2-only status must not be rejected by those bounds.
    if (hasV1Metadata(status)) {
        const verifier = savedVerifier(status.raw);
        if (verifier) {
            const verdict = await wait(login(status.raw, verifier));
            if (verdict === HOST_INSTALL || installed())
                return { enabled: accessEnabled };
            if (verdict === 'ok') {
                selectedProtocol = 'v1';
                return { enabled: true };
            }
            if (verdict === 'transient')
                throw new Error('Unable to check Phi access protection');
        }
    }
    return showUnlockPrompt(protocol);
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
// body continue bootstrap.
export function installToken(token) {
    if (typeof token !== 'string' || !token) return false;
    accessToken = token;
    accessEnabled = true;
    selectedProtocol = 'v2';
    memoryOnly = true;
    stateEpoch++;
    // Release a bootstrap still waiting on discovery or a status check.
    const releaseBootstrap = pendingBootstrapRelease;
    pendingBootstrapRelease = null;
    if (releaseBootstrap) releaseBootstrap();
    if (pendingOverlay) pendingOverlay.finish({ enabled: true });
    return true;
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
    if (
        selectedProtocol !== 'v2' ||
        !accessToken ||
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

if (typeof window !== 'undefined') {
    const bridge = window.phiAccessAuth || {};
    bridge.installToken = installToken;
    bridge.getAccessToken = getAccessToken;
    bridge.webSocketURL = webSocketURL;
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
    stateEpoch++;
    reauthInFlight = null;
    pendingOverlay = null;
    reloadPage = () => location.reload();
}

function setReload(fn) {
    reloadPage = fn;
}

function getAccessState() {
    return { selectedProtocol, accessEnabled, accessToken, memoryOnly };
}
