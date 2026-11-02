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
import type { PhiAccessAuthBridge } from './types.js';

/** The protocols this client can speak. */
type Protocol = 'v1' | 'v2';

/** Outcome of a v2 token probe. */
type CheckVerdict = 'valid' | 'invalid';

/** Outcome of a v1 login attempt. Only `rejected` may discard the credential. */
type LoginResult = 'ok' | 'rejected' | 'rate-limited' | 'transient';

/** The fetch surface an auth context may supply. Narrower than `typeof fetch`
 *  on purpose: callers passed a string-typed wrapper before this was typed. */
export type FetchLike = (
    input: string | URL | RequestInfo,
    init?: RequestInit,
) => Promise<Response>;

/** The per-server namespace for stored credentials and network calls. */
export interface AuthContext {
    credentialKey?: string;
    fetch?: FetchLike;
}

/** A raw `/api/auth/status` body. Validated by `parseAccessStatus` before use. */
interface RawAccessStatus {
    enabled?: unknown;
    authenticated?: unknown;
    protocols?: unknown;
    version?: unknown;
    algorithm?: unknown;
    iterations?: unknown;
    salt?: unknown;
    challenge?: unknown;
    [key: string]: unknown;
}

/** The v1 PBKDF2 metadata. `validStatus` is the only way to obtain one. */
interface V1Status {
    version: string;
    algorithm: string;
    iterations: number;
    salt: string;
    challenge: string;
    [key: string]: unknown;
}

/** A validated access-status payload. */
interface AccessStatus {
    enabled: boolean;
    authenticated: boolean;
    protocols: Protocol[];
    raw: RawAccessStatus;
    /** Set by the desktop host proxy; absent in a plain browser. */
    hostProtocol?: Protocol;
}

/** Per-server client state. One entry per credential namespace. */
interface AuthState {
    selectedProtocol: Protocol | null;
    accessEnabled: boolean;
    accessToken: string | null;
    persistedToken: string | null;
    memoryOnly: boolean;
    hostSession: boolean;
    accessExpiresAt: number;
    accessRenewAt: number;
    refreshIdleExpiresAt: number;
    refreshAbsoluteExpiresAt: number;
    loggedOut: boolean;
    epoch: number;
    reauthInFlight: Promise<unknown> | null;
    refreshInFlight: Promise<string> | null;
    renewalTimer: ReturnType<typeof setTimeout> | null;
    retryTimer: ReturnType<typeof setTimeout> | null;
    retryDelayMs: number;
    pendingBootstrapRelease: (() => void) | null;
}

/** A rotated token bundle from login, refresh, or another tab. */
interface CredentialBundle {
    token: string;
    expiresAt: number;
    expiresIn: number;
    refreshIdleExpiresAt: number;
    refreshAbsoluteExpiresAt: number;
}

/** A cross-tab auth message (logout or token bundle). */
interface AuthMessage {
    kind?: string;
    origin?: string;
    ownerKey?: string;
    family?: number;
    disabled?: boolean;
    bundle?: Record<string, unknown>;
}

/** The one unlock prompt a page may show at a time. */
interface PendingOverlay {
    ownerKey: string;
    finish(result: { enabled: boolean }): void;
}

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
function credentialKey(context?: AuthContext | null): string {
    return context?.credentialKey || serverKey(CREDENTIAL_KEY);
}

function bearerKey(context?: AuthContext | null): string {
    if (!context?.credentialKey) return serverKey(LEGACY_BEARER_KEY);
    const key = context.credentialKey;
    return key.startsWith(CREDENTIAL_KEY)
        ? `${LEGACY_BEARER_KEY}${key.slice(CREDENTIAL_KEY.length)}`
        : `${LEGACY_BEARER_KEY}:${key}`;
}

function discardLegacyBearer(context?: AuthContext | null) {
    try {
        localStorage.removeItem(bearerKey(context));
    } catch {
        // Storage is blocked, so there is no value to migrate.
    }
}

discardLegacyBearer();

function authFetch(
    context: AuthContext | null | undefined,
    url: string,
    init?: RequestInit,
): Promise<Response> {
    return (context?.fetch || fetch)(url, init);
}
const PASSWORD_MIN_LENGTH = 8;
// Module-owned auth requests must not hold bootstrap or a submit button open
// forever. The deadline covers headers and response-body consumption.
const AUTH_TIMEOUT_MS = 30000;

function bytesToBase64URL(bytes: Uint8Array) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function base64URLToBytes(value: unknown) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new Error('Invalid saved access credential');
    }
    const padded =
        value.replace(/-/g, '+').replace(/_/g, '/') +
        '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function validStatus(status: unknown): status is V1Status {
    const raw = status as V1Status | null | undefined;
    return (
        !!raw &&
        raw.enabled === true &&
        raw.version === 'v1' &&
        raw.algorithm === 'pbkdf2-sha256' &&
        Number.isInteger(raw.iterations) &&
        raw.iterations > 0 &&
        typeof raw.salt === 'string' &&
        typeof raw.challenge === 'string'
    );
}

function invalidStatusError() {
    return new Error('Phi returned invalid access protection settings');
}

// parseProtocols maps the capability field to the protocols this client can
// speak. An absent field is the legacy v1-only response. A present field must
// be a nonempty array of unique nonempty names, and unknown names are only
// tolerated beside a supported protocol.
function parseProtocols(value: unknown): Protocol[] {
    if (value === undefined) return ['v1'];
    if (!Array.isArray(value) || value.length === 0) throw invalidStatusError();
    const seen = new Set<string>();
    for (const protocol of value) {
        if (typeof protocol !== 'string' || !protocol || seen.has(protocol))
            throw invalidStatusError();
        seen.add(protocol);
    }
    const supported = value.filter(
        (p): p is Protocol => p === 'v1' || p === 'v2',
    );
    if (supported.length === 0) throw invalidStatusError();
    return supported;
}

// parseAccessStatus validates the status contract shared by both protocols.
function parseAccessStatus(payload: unknown): AccessStatus {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        throw invalidStatusError();
    const raw = payload as RawAccessStatus;
    if (typeof raw.enabled !== 'boolean') throw invalidStatusError();
    const protocols = parseProtocols(raw.protocols);
    if (raw.enabled && typeof raw.authenticated !== 'boolean')
        throw invalidStatusError();
    return {
        enabled: raw.enabled,
        authenticated: raw.authenticated === true,
        protocols,
        raw,
    };
}

function preferredProtocol(protocols: Protocol[]): Protocol {
    return protocols.includes('v2') ? 'v2' : 'v1';
}

// v1 KDF metadata is only required before using the v1 path; a v2 status must
// not be rejected by v1-only bounds.
function hasV1Metadata(
    status: AccessStatus,
): status is AccessStatus & { raw: V1Status } {
    return (
        status.raw.version === 'v1' &&
        status.raw.algorithm === 'pbkdf2-sha256' &&
        typeof status.raw.iterations === 'number' &&
        Number.isInteger(status.raw.iterations) &&
        status.raw.iterations > 0 &&
        typeof status.raw.salt === 'string' &&
        typeof status.raw.challenge === 'string'
    );
}

async function getStatus(context?: AuthContext | null) {
    return withAuthDeadline(async (signal: AbortSignal) => {
        const res = await authFetch(context, '/api/auth/status', {
            cache: 'no-store',
            redirect: 'error',
            signal,
        });
        if (res.status !== 200)
            throw new Error('Unable to check Phi access protection');
        let payload: unknown;
        try {
            payload = await res.json();
        } catch {
            throw invalidStatusError();
        }
        return parseAccessStatus(payload);
    });
}

async function deriveVerifierNative(
    subtle: SubtleCrypto,
    password: Uint8Array,
    salt: Uint8Array,
    iterations: number,
): Promise<Uint8Array> {
    const key = await subtle.importKey(
        'raw',
        password as BufferSource,
        { name: 'PBKDF2' },
        false,
        ['deriveBits'],
    );
    const bits = await subtle.deriveBits(
        {
            name: 'PBKDF2',
            hash: 'SHA-256',
            salt: salt as BufferSource,
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
            !expected.every((byte: number, i: number) => byte === actual[i])
        ) {
            return false;
        }
        return (password: Uint8Array, salt: Uint8Array, iterations: number) =>
            deriveVerifierNative(subtle, password, salt, iterations);
    } catch {
        return false;
    }
}

let nativeDerivePromise: ReturnType<typeof probeNativeDerive> | undefined;
function nativeDerive() {
    if (!nativeDerivePromise) nativeDerivePromise = probeNativeDerive();
    return nativeDerivePromise;
}

function resetNativeDerive() {
    nativeDerivePromise = undefined;
}

async function deriveVerifier(
    password: unknown,
    status: V1Status,
): Promise<Uint8Array> {
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

function storeCredential(
    status: V1Status,
    verifier: Uint8Array,
    context?: AuthContext | null,
) {
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

function clearCredential(context?: AuthContext | null) {
    try {
        localStorage.removeItem(credentialKey(context));
    } catch {
        /* ignored */
    }
}

function savedVerifier(
    status: V1Status,
    context?: AuthContext | null,
): Uint8Array | null {
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
async function login(
    status: V1Status,
    verifier: Uint8Array,
    context?: AuthContext | null,
): Promise<LoginResult> {
    const proof = bytesToBase64URL(
        hmac(sha256, verifier, new TextEncoder().encode(status.challenge)),
    );
    try {
        return await withAuthDeadline(async (signal: AbortSignal) => {
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
async function freshStatus(
    fallback: V1Status | null,
    startedAt: number,
    context?: AuthContext | null,
): Promise<V1Status | null> {
    if (performance.now() - startedAt < challengeRefreshAfterMs)
        return fallback;
    try {
        const status = await withAuthDeadline(async (signal: AbortSignal) => {
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

const authStates = new Map<string, AuthState>();
const HOST_INSTALL = Symbol('host install');
const HOST_SESSION_TOKEN = Symbol('phi-host-session');
const REFRESH_LEAD_MS = 60 * 1000;
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const REFRESH_LOCK_PREFIX = 'phi-access-refresh:';
let activeAuthKey: string | null = null;
let activeAuthContext: AuthContext | null = null;

const AUTH_CHANNEL = 'phi-access-auth';
let invalidation: BroadcastChannel | null = null;

function invalidationChannel() {
    if (invalidation) return invalidation;
    if (typeof BroadcastChannel !== 'function') return null;
    try {
        const channel = new BroadcastChannel(AUTH_CHANNEL);
        channel.addEventListener('message', (event) => {
            if (!event.data) return;
            if (event.data.kind === 'logout') {
                receiveLogout(event.data);
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

function broadcastInvalidation(ownerKey: string, family = 0, disabled = false) {
    const channel = invalidationChannel();
    if (!channel) return;
    channel.postMessage({
        kind: 'logout',
        origin: location.origin,
        ownerKey,
        family,
        disabled,
    });
}

function receiveLogout(message: AuthMessage) {
    if (message.origin !== undefined && message.origin !== location.origin)
        return;
    const ownerKey =
        typeof message.ownerKey === 'string'
            ? message.ownerKey
            : (activeAuthKey ?? credentialKey());
    const state = authStates.get(ownerKey);
    if (!state) return;
    const family = Number.isInteger(message.family) ? message.family : 0;
    const currentFamily = state.refreshAbsoluteExpiresAt;
    if (family && currentFamily && family !== currentFamily) return;
    const hasPrompt = pendingOverlay?.ownerKey === ownerKey;
    state.loggedOut = true;
    dropCredential(state);
    if (message.disabled === true) {
        if (hasPrompt) pendingOverlay?.finish({ enabled: false });
        if (activeAuthKey === ownerKey) {
            void bootstrapAccessAuth(activeAuthContext).catch(() => {});
        }
    } else if (activeAuthKey === ownerKey && !hasPrompt) {
        if (hostAuthenticatedMode())
            void bootstrapAccessAuth(activeAuthContext).catch(() => {});
        else void requestReauth(contextForKey(ownerKey));
    }
}

function broadcastBundle(
    context: AuthContext | null | undefined,
    state: AuthState,
) {
    const channel = invalidationChannel();
    if (!channel || !state.accessToken) return;
    channel.postMessage({
        kind: 'bundle',
        origin: location.origin,
        ownerKey: credentialKey(context),
        bundle: {
            token: state.accessToken,
            expiresAt: state.accessExpiresAt,
            expiresIn: remainingDurationSeconds(state),
            refreshIdleExpiresAt: state.refreshIdleExpiresAt,
            refreshAbsoluteExpiresAt: state.refreshAbsoluteExpiresAt,
        },
    });
}

function remainingDurationSeconds(state: AuthState) {
    if (!state.accessRenewAt) return 0;
    const remainingMs =
        state.accessRenewAt - performance.now() + REFRESH_LEAD_MS;
    return Math.max(1, Math.round(remainingMs / 1000));
}

function receiveBundle(message: AuthMessage) {
    if (hostAuthenticatedMode()) return;
    const ownerKey =
        typeof message.ownerKey === 'string'
            ? message.ownerKey
            : (activeAuthKey ?? credentialKey());
    if (message.origin !== location.origin) return;
    const state = stateForKey(ownerKey);
    // Cross-tab messages are untrusted input: check each number before it can
    // reach the token state, exactly as the fetch path does.
    const bundle = message.bundle as Partial<CredentialBundle> | undefined;
    if (!bundle || typeof bundle.token !== 'string' || !bundle.token) return;
    const {
        expiresAt,
        expiresIn,
        refreshIdleExpiresAt,
        refreshAbsoluteExpiresAt,
    } = bundle;
    if (
        typeof expiresAt !== 'number' ||
        !Number.isInteger(expiresAt) ||
        expiresAt <= 0
    )
        return;
    if (
        typeof expiresIn !== 'number' ||
        !Number.isInteger(expiresIn) ||
        expiresIn <= 0
    )
        return;
    if (
        typeof refreshIdleExpiresAt !== 'number' ||
        typeof refreshAbsoluteExpiresAt !== 'number' ||
        !Number.isInteger(refreshIdleExpiresAt) ||
        !Number.isInteger(refreshAbsoluteExpiresAt) ||
        refreshIdleExpiresAt <= 0 ||
        refreshAbsoluteExpiresAt < refreshIdleExpiresAt
    )
        return;
    if (state.memoryOnly || state.hostSession || state.loggedOut) return;
    if (state.selectedProtocol === 'v1') return;
    const family = refreshAbsoluteExpiresAt;
    if (
        family &&
        state.refreshAbsoluteExpiresAt &&
        family !== state.refreshAbsoluteExpiresAt
    )
        return;
    if (state.accessToken && expiresAt <= state.accessExpiresAt) return;
    adoptToken(
        bundle.token,
        {
            token: bundle.token,
            expiresAt,
            expiresIn,
            refreshIdleExpiresAt,
            refreshAbsoluteExpiresAt,
        },
        contextForKey(ownerKey),
        { broadcast: false },
    );
}

function contextForKey(ownerKey: string): AuthContext | null {
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
        hostSession: false,
        accessExpiresAt: 0,
        accessRenewAt: 0,
        refreshIdleExpiresAt: 0,
        refreshAbsoluteExpiresAt: 0,
        loggedOut: false,
        epoch: 0,
        reauthInFlight: null,
        refreshInFlight: null,
        renewalTimer: null,
        retryTimer: null,
        retryDelayMs: 0,
        pendingBootstrapRelease: null,
    };
}

function stateForKey(key: string): AuthState {
    let state = authStates.get(key);
    if (!state) {
        state = newAuthState();
        authStates.set(key, state);
    }
    return state;
}

function stateFor(context: AuthContext | null | undefined): AuthState {
    return stateForKey(credentialKey(context));
}

function activateAuthContext(context?: AuthContext | null) {
    activeAuthContext = context || null;
    activeAuthKey = credentialKey(context);
    return stateForKey(activeAuthKey);
}

function activeAuthState() {
    if (activeAuthKey === null) return activateAuthContext();
    return stateForKey(activeAuthKey);
}

function hostAuthenticatedMode() {
    try {
        return location.protocol === 'phi-app:' && location.host === 'app';
    } catch {
        return false;
    }
}

function utf8Length(value: string): number {
    return new TextEncoder().encode(value).length;
}

function authTimeoutError() {
    return new Error('Phi did not respond. Try again.');
}

// Race the deadline as well as aborting: some fetch implementations ignore
// AbortSignal and would otherwise keep auth UI pending forever.
async function withAuthDeadline<T>(
    run: (signal: AbortSignal) => Promise<T>,
    timeoutMs = AUTH_TIMEOUT_MS,
): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(authTimeoutError());
        }, timeoutMs);
    });
    try {
        return (await Promise.race([run(controller.signal), deadline])) as T;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

function parseCredentialBundle(payload: unknown): CredentialBundle | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return null;
    const {
        token,
        expires_at: expiresAt,
        expires_in: expiresIn,
        refresh_idle_expires_at: refreshIdle,
        refresh_absolute_expires_at: refreshAbsolute,
    } = payload as Record<string, unknown>;
    if (typeof token !== 'string' || !token) return null;
    for (const value of [expiresAt, expiresIn, refreshIdle, refreshAbsolute]) {
        if (typeof value !== 'number' || !Number.isInteger(value)) return null;
    }
    const expires = [
        expiresAt,
        expiresIn,
        refreshIdle,
        refreshAbsolute,
    ] as number[];
    if (expires[0] <= 0 || expires[2] <= 0 || expires[3] <= 0) return null;
    if (expires[2] > expires[3]) return null;
    return {
        token,
        expiresAt: expires[0],
        expiresIn: expires[1],
        refreshIdleExpiresAt: expires[2],
        refreshAbsoluteExpiresAt: expires[3],
    };
}

const REFRESH_INSTALLED = 'installed';
const REFRESH_NONE = 'none';
const REFRESH_SUPERSEDED = 'superseded';

function refreshDue(context: AuthContext | null | undefined) {
    const state = stateFor(context);
    if (!state.accessToken) return true;
    if (!state.accessRenewAt) return false;
    return performance.now() >= state.accessRenewAt;
}

function withRefreshLock<T>(
    origin: string,
    run: () => T | PromiseLike<T>,
): Promise<T> {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
    if (!locks || typeof locks.request !== 'function')
        return Promise.resolve().then(run);
    return withAuthDeadline((signal: AbortSignal) => {
        try {
            // The DOM typing for locks.request is Promise<any>; the callback
            // above is the only producer of this value.
            return Promise.resolve(
                locks.request(REFRESH_LOCK_PREFIX + origin, { signal }, () =>
                    signal.aborted ? REFRESH_SUPERSEDED : run(),
                ) as Promise<T>,
            );
        } catch {
            return Promise.resolve().then(run);
        }
    });
}

function refreshSession(
    { ifDue = false }: { ifDue?: boolean } = {},
    context: AuthContext | null | undefined,
) {
    const state = stateFor(context);
    if (state.refreshInFlight) return state.refreshInFlight;
    if (state.memoryOnly || state.hostSession)
        return Promise.resolve(REFRESH_NONE);
    const origin = location.origin;
    const epoch = state.epoch;
    const attempt = withRefreshLock(origin, () => {
        if (epoch !== state.epoch) return REFRESH_SUPERSEDED;
        if (state.memoryOnly || state.hostSession) return REFRESH_SUPERSEDED;
        if (location.origin !== origin) return REFRESH_SUPERSEDED;
        if (ifDue && !refreshDue(context)) return REFRESH_INSTALLED;
        return runRefresh(context, state, origin, epoch);
    });
    state.refreshInFlight = attempt;
    void attempt
        .catch(() => {})
        .then(() => {
            if (state.refreshInFlight === attempt) state.refreshInFlight = null;
        });
    return attempt;
}

function retryAfterMs(res: Response): number {
    const raw =
        res.headers && typeof res.headers.get === 'function'
            ? res.headers.get('Retry-After')
            : null;
    const seconds = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    if (!Number.isInteger(seconds) || seconds <= 0) return 0;
    return Math.min(seconds, 300) * 1000;
}

function refreshFailure(message: string, waitMs: number) {
    const err: Error & { retryAfterMs?: number } = new Error(message);
    if (waitMs > 0) err.retryAfterMs = waitMs;
    return err;
}

async function runRefresh(
    context: AuthContext | null | undefined,
    state: AuthState,
    origin: string,
    epoch: number,
) {
    let result: {
        status: number;
        retryAfterMs?: number;
        payload?: unknown;
        invalid?: boolean;
    };
    try {
        result = await withAuthDeadline(async (signal: AbortSignal) => {
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
            result.retryAfterMs ?? 0,
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
function adoptToken(
    token: string,
    bundle: CredentialBundle | null | undefined,
    context: AuthContext | null | undefined,
    { broadcast = true }: { broadcast?: boolean } = {},
) {
    const state = stateFor(context);
    const sameToken = token === state.accessToken;
    state.hostSession = false;
    state.loggedOut = false;
    state.accessToken = token;
    state.accessEnabled = true;
    state.selectedProtocol = 'v2';
    state.persistedToken = null;
    state.memoryOnly = false;
    if (bundle) {
        state.accessExpiresAt = bundle.expiresAt;
        state.accessRenewAt =
            bundle.expiresIn > 0
                ? performance.now() + bundle.expiresIn * 1000 - REFRESH_LEAD_MS
                : 0;
        state.refreshIdleExpiresAt = bundle.refreshIdleExpiresAt;
        state.refreshAbsoluteExpiresAt = bundle.refreshAbsoluteExpiresAt;
    } else if (!sameToken) {
        state.accessExpiresAt = 0;
        state.accessRenewAt = 0;
        state.refreshIdleExpiresAt = 0;
        state.refreshAbsoluteExpiresAt = 0;
    }
    state.retryDelayMs = 0;
    if (state.retryTimer !== null) clearTimeout(state.retryTimer);
    state.retryTimer = null;
    state.epoch++;
    scheduleRenewal(context, state);
    if (broadcast) broadcastBundle(context, state);
    if (pendingOverlay?.ownerKey === credentialKey(context))
        pendingOverlay?.finish({ enabled: true });
}

function clearTokenState(state: AuthState) {
    state.accessToken = null;
    state.persistedToken = null;
    state.hostSession = false;
    state.accessExpiresAt = 0;
    state.accessRenewAt = 0;
    state.refreshIdleExpiresAt = 0;
    state.refreshAbsoluteExpiresAt = 0;
    if (state.renewalTimer !== null) clearTimeout(state.renewalTimer);
    if (state.retryTimer !== null) clearTimeout(state.retryTimer);
    state.renewalTimer = null;
    state.retryTimer = null;
    state.retryDelayMs = 0;
}

function dropCredential(state: AuthState) {
    clearTokenState(state);
    state.loggedOut = true;
    state.selectedProtocol = 'v2';
    state.epoch++;
}

// A delayed rejection for token A must not clear token B installed after it.
function rejectToken(
    token: string | null,
    context: AuthContext | null | undefined,
) {
    const state = stateFor(context);
    if (!token || state.accessToken !== token) return;
    clearTokenState(state);
    state.loggedOut = true;
    state.selectedProtocol = 'v2';
}

function scheduleRenewal(
    context: AuthContext | null | undefined,
    state: AuthState = stateFor(context),
) {
    if (state.renewalTimer !== null) clearTimeout(state.renewalTimer);
    state.renewalTimer = null;
    if (!state.accessToken || state.memoryOnly || !state.accessRenewAt) return;
    const epoch = state.epoch;
    const delay = Math.min(
        MAX_TIMEOUT_MS,
        Math.max(0, state.accessRenewAt - performance.now()),
    );
    state.renewalTimer = setTimeout(() => {
        state.renewalTimer = null;
        if (epoch !== state.epoch) return;
        void renewIfDue({}, context);
    }, delay);
}

function scheduleRetry(
    err: unknown,
    context: AuthContext | null | undefined,
    state: AuthState = stateFor(context),
) {
    if (state.retryTimer !== null) clearTimeout(state.retryTimer);
    state.retryTimer = null;
    if (!state.accessToken || state.memoryOnly) return;
    const epoch = state.epoch;
    state.retryDelayMs = state.retryDelayMs
        ? Math.min(RETRY_MAX_MS, state.retryDelayMs * 2)
        : RETRY_BASE_MS;
    const jitter = state.retryDelayMs * 0.2 * Math.random();
    const retryAfterMs = (err as { retryAfterMs?: unknown } | null)
        ?.retryAfterMs;
    const honored = Number.isFinite(retryAfterMs) ? Number(retryAfterMs) : 0;
    const delay = Math.max(honored, state.retryDelayMs + jitter);
    state.retryTimer = setTimeout(() => {
        state.retryTimer = null;
        if (epoch !== state.epoch) return;
        void renewIfDue({ ifDue: false }, context);
    }, delay);
}

async function renewIfDue(
    { ifDue = true }: { ifDue?: boolean } = {},
    context: AuthContext | null | undefined,
) {
    const state = stateFor(context);
    if (!state.accessToken || state.memoryOnly || state.hostSession) return;
    if (state.retryTimer !== null) return;
    if (ifDue && !refreshDue(context)) {
        scheduleRenewal(context, state);
        return;
    }
    const epoch = state.epoch;
    let outcome: string;
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
export function refreshAccessIfDue(
    context?: AuthContext | null,
): Promise<void> | undefined {
    const ownerContext = context ?? activeAuthContext;
    const state = stateFor(ownerContext);
    if (!state.accessToken || state.memoryOnly) return undefined;
    if (state.retryTimer !== null) return undefined;
    if (!refreshDue(ownerContext)) {
        scheduleRenewal(ownerContext, state);
        return undefined;
    }
    return renewIfDue({}, ownerContext);
}

// checkV2Token reports whether the server still accepts token. A rejected
// token is 'invalid'; transport errors and 429/5xx throw, so a transient
// failure never destroys a saved credential or changes protocol.
async function checkV2Token(
    token: string | null,
    context: AuthContext | null | undefined,
) {
    return withAuthDeadline(async (signal: AbortSignal) => {
        // The embedded host proxy supplies its own bearer; the page sends none.
        const headers: Record<string, string> = token
            ? { Authorization: `Bearer ${token}` }
            : {};
        const res = await authFetch(context, '/api/auth/v2/status', {
            headers,
            cache: 'no-store',
            redirect: 'error',
            signal,
        });
        if (res.status === 401) return 'invalid';
        if (res.status !== 200)
            throw new Error('Unable to check Phi access protection');
        let payload: unknown;
        try {
            payload = await res.json();
        } catch {
            throw invalidStatusError();
        }
        const body = payload as {
            enabled?: unknown;
            authenticated?: unknown;
            owned?: unknown;
        } | null;
        if (
            !body ||
            typeof body.enabled !== 'boolean' ||
            typeof body.authenticated !== 'boolean'
        )
            throw invalidStatusError();
        if (!body.enabled) return 'invalid';
        if (body.owned === false)
            throw new Error('Another Phi instance owns access state');
        return body.authenticated ? 'valid' : 'invalid';
    });
}

async function v2Login(
    password: string,
    context: AuthContext | null | undefined,
) {
    return withAuthDeadline(async (signal: AbortSignal) => {
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
        let payload: unknown;
        try {
            payload = await res.json();
        } catch {
            throw new Error('Unable to sign in');
        }
        if (hostAuthenticatedMode()) {
            if ((payload as { ok?: unknown } | null)?.ok === true)
                return HOST_SESSION_TOKEN;
            throw new Error('Unable to sign in');
        }
        const bundle = parseCredentialBundle(payload);
        if (!bundle || bundle.expiresIn <= 0)
            throw new Error('Unable to sign in');
        return bundle;
    });
}

function v2PasswordError(res: Response) {
    if (res.status === 401) return new Error('Sign in to change Phi access');
    if (res.status === 429)
        return new Error('Too many attempts. Try again in a moment.');
    return new Error('Unable to save access password');
}

function validateV2Password(password: unknown): void {
    if (typeof password !== 'string')
        throw new Error('Enter a password to continue');
    const bytes = utf8Length(password);
    if (bytes < PASSWORD_MIN_LENGTH)
        throw new Error(
            `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
        );
    if (bytes > 1024) throw new Error('Password must be at most 1024 bytes');
}

async function saveV2Password(
    password: unknown,
    context: AuthContext | null | undefined,
) {
    validateV2Password(password);
    const state = stateFor(context);
    const epoch = state.epoch;
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Phi-Auth': 'v2',
    };
    if (state.accessToken)
        headers.Authorization = `Bearer ${state.accessToken}`;
    const payload = await withAuthDeadline(async (signal: AbortSignal) => {
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
    if (hostAuthenticatedMode()) {
        if (!payload || payload.ok !== true || payload.enabled !== true)
            throw new Error('Unable to save access password');
        if (epoch === state.epoch) {
            state.hostSession = true;
            state.loggedOut = false;
            state.accessEnabled = true;
            state.selectedProtocol = 'v2';
            state.epoch++;
        }
        return { enabled: true };
    }
    const bundle = parseCredentialBundle(payload);
    if (
        !payload ||
        payload.enabled !== true ||
        !bundle ||
        bundle.expiresIn <= 0
    )
        throw new Error('Unable to save access password');
    if (epoch === state.epoch) adoptToken(bundle.token, bundle, context);
    return { enabled: true };
}

async function clearV2Password(context: AuthContext | null | undefined) {
    const state = stateFor(context);
    if (!state.accessEnabled && !state.accessToken && !state.hostSession)
        return { enabled: false };
    const token = state.accessToken;
    const epoch = state.epoch;
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Phi-Auth': 'v2',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const payload = await withAuthDeadline(async (signal: AbortSignal) => {
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
    const family = state.refreshAbsoluteExpiresAt;
    if (hostAuthenticatedMode()) {
        if (payload.ok !== true)
            throw new Error('Unable to clear access password');
        if (state.epoch !== epoch) return { enabled: false };
        state.loggedOut = true;
        clearTokenState(state);
        state.accessEnabled = false;
        state.selectedProtocol = 'v2';
        state.epoch++;
        broadcastInvalidation(credentialKey(context), family, true);
        if (pendingOverlay?.ownerKey === credentialKey(context))
            pendingOverlay?.finish({ enabled: false });
        return { enabled: false };
    }
    // A credential installed while the clear was in flight is newer than
    // this response; never clear it.
    if (state.epoch !== epoch) return { enabled: false };
    state.loggedOut = true;
    clearTokenState(state);
    state.accessEnabled = false;
    state.selectedProtocol = 'v2';
    state.epoch++;
    broadcastInvalidation(credentialKey(context), family, true);
    if (pendingOverlay?.ownerKey === credentialKey(context))
        pendingOverlay?.finish({ enabled: false });
    return { enabled: false };
}

// --- protected fetch wrapper --------------------------------------------

const WRAPPED_FETCH = Symbol.for('phi.accessFetch');

/** \ carrying the idempotent-install marker. */
type MarkedFetch = typeof fetch & { [WRAPPED_FETCH]?: boolean };
let reloadPage = () => location.reload();

function isSyncMessagePath(path: string): boolean {
    return (
        path === '/api/sync/messages' || path.startsWith('/api/sync/messages/')
    );
}

// isProtectedAPIPath is the wrapper and asset scope: same-origin API data that
// needs a credential, excluding the public auth routes and the sync exemption.
function isProtectedAPIPath(pathname: string): boolean {
    return (
        pathname.startsWith('/api/') &&
        !pathname.startsWith('/api/auth/') &&
        !isSyncMessagePath(pathname)
    );
}

function requestURL(input: URL | RequestInfo): URL | null {
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

function requestHeaders(input: URL | RequestInfo, init?: RequestInit): Headers {
    if (init && init.headers) return new Headers(init.headers);
    if (typeof Request !== 'undefined' && input instanceof Request)
        return new Headers(input.headers);
    return new Headers();
}

// installAccessFetch wraps fetch once so same-origin protected API calls carry
// the in-memory bearer. A stale-token 401 refreshes once and retries only GET
// or HEAD; mutations are never replayed. Route-specific 403 responses pass on.
export function installAccessFetch() {
    const baseFetch = globalThis.fetch as MarkedFetch | undefined;
    if (!baseFetch || baseFetch[WRAPPED_FETCH]) return;
    const wrapped = async (
        input: URL | RequestInfo,
        init?: RequestInit,
    ): Promise<Response> => {
        const url = requestURL(input);
        const ownerKey = activeAuthKey ?? credentialKey();
        const context = activeAuthContext;
        const state = stateForKey(ownerKey);
        if (state.hostSession) {
            // The host proxy authorizes protected API requests and recovers
            // stale tokens itself. Only a terminal 401 from a protected path
            // means that its host-owned session ended; mutations are not replayed.
            const answer = await baseFetch(input, init);
            if (
                answer.status === 401 &&
                url &&
                url.protocol === location.protocol &&
                url.host === location.host &&
                isProtectedAPIPath(url.pathname)
            )
                requestReauth(context);
            return answer;
        }
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
        let outcome: string;
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
        const inputMethod = input instanceof Request ? input.method : undefined;
        const method = (
            (init && init.method) ||
            inputMethod ||
            'GET'
        ).toUpperCase();
        const renewed = state.accessToken;
        const installed =
            outcome === REFRESH_INSTALLED ||
            (outcome === REFRESH_SUPERSEDED && !!renewed && renewed !== token);
        if (!installed || !renewed || (method !== 'GET' && method !== 'HEAD'))
            return response;
        const retryHeaders = requestHeaders(input, init);
        retryHeaders.set('Authorization', `Bearer ${renewed}`);
        return baseFetch(
            input,
            init
                ? { ...init, headers: retryHeaders }
                : { headers: retryHeaders },
        );
    };
    (wrapped as MarkedFetch)[WRAPPED_FETCH] = true;
    globalThis.fetch = wrapped;
}

// requestReauth coalesces every rejected request into one overlay, then reloads
// once after a successful sign-in.
function requestReauth(context: AuthContext | null | undefined) {
    const key = credentialKey(context);
    const state = stateForKey(key);
    if (state.reauthInFlight) return state.reauthInFlight;
    state.reauthInFlight = (async () => {
        try {
            const protocol = state.selectedProtocol === 'v1' ? 'v1' : 'v2';
            const result = await showUnlockPrompt(context, protocol);
            if (result.enabled && activeAuthKey === key) reloadPage();
        } catch {
            /* the overlay reports its own failure */
        } finally {
            state.reauthInFlight = null;
        }
    })();
    return state.reauthInFlight;
}

async function discoverAccessStatus(
    context: AuthContext | null | undefined,
): Promise<AccessStatus> {
    return withAuthDeadline(async (signal: AbortSignal) => {
        const res = await authFetch(context, '/api/auth/status', {
            cache: 'no-store',
            redirect: 'error',
            signal,
        });
        if (res.status !== 200)
            throw new Error('Unable to check Phi access protection');
        let payload: unknown;
        try {
            payload = await res.json();
        } catch {
            throw invalidStatusError();
        }
        const status = parseAccessStatus(payload);
        if (hostAuthenticatedMode()) {
            const protocol = res.headers.get('X-Phi-Host-Auth-Protocol');
            if (protocol === 'v1' || protocol === 'v2')
                status.hostProtocol = protocol;
        }
        return status;
    });
}

let pendingOverlay: PendingOverlay | null = null;

function showUnlockPrompt(
    context: AuthContext | null | undefined,
    protocol: Protocol,
): Promise<{ enabled: boolean }> {
    const state = stateFor(context);
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value: { enabled: boolean }) => {
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
                const seconds = Math.round(
                    (performance.now() - started) / 1000,
                );
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
                    if (bundle === HOST_SESSION_TOKEN) {
                        state.hostSession = true;
                        state.loggedOut = false;
                        state.accessEnabled = true;
                        state.selectedProtocol = 'v2';
                        state.memoryOnly = false;
                        state.epoch++;
                        input.value = '';
                        finish({ enabled: true });
                        return;
                    }
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
                if (!hasV1Metadata(status)) throw invalidStatusError();
                const verifier = await deriveVerifier(input.value, status.raw);
                if (epoch !== state.epoch) return;
                const challenge = await freshStatus(
                    status.raw,
                    started,
                    context,
                );
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
                if (hostAuthenticatedMode()) {
                    // The proxy owns the v1 cookie; the page only tracks that
                    // the host now has an authenticated session.
                    state.hostSession = true;
                    state.loggedOut = false;
                }
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

// The embedded shell owns the v2 bundle in the main process. The page sees
// only the host's token-free status and login answers.
async function bootstrapHostAuthenticated(
    context: AuthContext | null | undefined,
    wait: <T>(promise: Promise<T>) => Promise<T | typeof HOST_INSTALL>,
) {
    invalidationChannel();
    const state = stateFor(context);
    clearTokenState(state);
    state.memoryOnly = false;
    state.hostSession = false;
    const epoch = ++state.epoch;
    const current = () => state.epoch === epoch;

    let status: AccessStatus | typeof HOST_INSTALL;
    try {
        status = await wait(discoverAccessStatus(context));
    } catch (err) {
        if (!current()) return { enabled: state.accessEnabled };
        throw err;
    }
    if (status === HOST_INSTALL || !current())
        return { enabled: state.accessEnabled };
    state.accessEnabled = status.enabled;
    // The host's selected credential wins over capability preference. Older
    // hosts without this metadata retain capability-based negotiation.
    const hostProtocol = status.hostProtocol;
    const protocol =
        hostProtocol && status.protocols.includes(hostProtocol)
            ? hostProtocol
            : preferredProtocol(status.protocols);
    state.selectedProtocol = protocol;
    if (!status.enabled) {
        state.hostSession = false;
        return { enabled: false };
    }

    if (protocol === 'v1') {
        if (status.authenticated) {
            state.hostSession = true;
            state.loggedOut = false;
            return { enabled: true };
        }
        state.hostSession = false;
        return showUnlockPrompt(context, 'v1');
    }

    let verdict: CheckVerdict | typeof HOST_INSTALL;
    try {
        verdict = await wait(checkV2Token(null, context));
    } catch (err) {
        if (!current()) return { enabled: state.accessEnabled };
        throw err;
    }
    if (verdict === HOST_INSTALL || !current())
        return { enabled: state.accessEnabled };
    if (verdict === 'valid') {
        state.hostSession = true;
        state.loggedOut = false;
        return { enabled: true };
    }
    state.hostSession = false;
    return showUnlockPrompt(context, 'v2');
}

// Called before App.init() so the normal UI never starts fetching protected
// data until either the bearer, the session cookie, or a remembered derived
// credential works. The selection is fixed for the rest of the page load: a
// v2 failure never falls back to v1.
export async function bootstrapAccessAuth(
    context?: AuthContext | null,
): Promise<{ enabled: boolean }> {
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
    const wait = <T>(promise: Promise<T>) =>
        Promise.race([promise, hostInstall]) as Promise<
            T | typeof HOST_INSTALL
        >;

    try {
        if (hostAuthenticatedMode())
            return await bootstrapHostAuthenticated(context, wait);
        let status: AccessStatus | typeof HOST_INSTALL;
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
            let verdict: CheckVerdict | typeof HOST_INSTALL;
            try {
                verdict = await wait(checkV2Token(token, context));
            } catch (err) {
                if (superseded()) return { enabled: state.accessEnabled };
                throw err;
            }
            if (verdict === HOST_INSTALL || superseded())
                return { enabled: state.accessEnabled };
            if (verdict === 'valid') return { enabled: true };
            let outcome: string | typeof HOST_INSTALL;
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
                    const verdict = await wait(
                        login(status.raw, verifier, context),
                    );
                    if (verdict === HOST_INSTALL || superseded())
                        return { enabled: state.accessEnabled };
                    if (verdict === 'ok') {
                        state.selectedProtocol = 'v1';
                        return { enabled: true };
                    }
                    if (verdict === 'transient' || verdict === 'rate-limited')
                        throw new Error(
                            'Unable to check Phi access protection',
                        );
                }
            }
        }

        if (protocol === 'v2') {
            let outcome: string | typeof HOST_INSTALL;
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
    password: unknown,
    {
        iterations = 600000,
        salt,
    }: { iterations?: number; salt?: Uint8Array } = {},
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
        const generated = new Uint8Array(16);
        globalThis.crypto.getRandomValues(generated);
        salt = generated;
    }
    // The challenge is added by the caller; a local record only derives a
    // verifier, so an empty placeholder keeps the status type honest.
    const status: V1Status = {
        enabled: true,
        version: 'v1',
        algorithm: 'pbkdf2-sha256',
        iterations,
        salt: bytesToBase64URL(salt),
        challenge: '',
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
export async function setAccessPassword(
    password: unknown,
    context?: AuthContext | null,
) {
    const state = stateFor(context);
    if (state.selectedProtocol === 'v2')
        return saveV2Password(password, context);
    const epoch = state.epoch;
    const { passwordHash, status, verifier } =
        await createPasswordRecord(password);
    if (epoch !== state.epoch) throw new Error('Phi access changed; try again');
    await withAuthDeadline(async (signal: AbortSignal) => {
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

export async function clearAccessPassword(context?: AuthContext | null) {
    const state = stateFor(context);
    if (state.selectedProtocol === 'v2') return clearV2Password(context);
    const epoch = state.epoch;
    await withAuthDeadline(async (signal: AbortSignal) => {
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
export function installToken(token: unknown): boolean {
    if (typeof token !== 'string' || !token) return false;
    const state = activeAuthState();
    if (state.renewalTimer !== null) clearTimeout(state.renewalTimer);
    if (state.retryTimer !== null) clearTimeout(state.retryTimer);
    state.renewalTimer = null;
    state.retryTimer = null;
    state.accessToken = token;
    state.hostSession = false;
    state.loggedOut = false;
    state.accessRenewAt = 0;
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

// A native v2 login owns the credential, but this page may still be waiting
// at its prompt. Verify through the host proxy before releasing bootstrap.
export async function completeHostSession(
    context?: AuthContext | null,
): Promise<boolean> {
    if (!hostAuthenticatedMode()) return false;
    const state = stateFor(context);
    const epoch = state.epoch;
    const verdict = await checkV2Token(null, context);
    if (epoch !== state.epoch || verdict !== 'valid') return false;
    state.hostSession = true;
    state.accessEnabled = true;
    state.selectedProtocol = 'v2';
    state.loggedOut = false;
    state.epoch++;
    const releaseBootstrap = state.pendingBootstrapRelease;
    state.pendingBootstrapRelease = null;
    if (releaseBootstrap) releaseBootstrap();
    if (pendingOverlay?.ownerKey === credentialKey(context))
        pendingOverlay.finish({ enabled: true });
    return true;
}

export async function logoutAccess(all = false, context?: AuthContext | null) {
    const state = stateFor(context);
    if (state.hostSession) {
        const epoch = state.epoch;
        const answerOK = await withAuthDeadline(async (signal: AbortSignal) => {
            const res = await authFetch(context, '/api/auth/v2/logout', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Phi-Auth': 'v2',
                },
                body: JSON.stringify({ all: all === true }),
                credentials: 'same-origin',
                redirect: 'error',
                signal,
            });
            return res.ok;
        });
        if (!answerOK) throw new Error('Unable to logout');
        if (epoch === state.epoch) {
            state.hostSession = false;
            state.loggedOut = true;
            state.epoch++;
            broadcastInvalidation(
                credentialKey(context),
                state.refreshAbsoluteExpiresAt,
            );
        }
        if (pendingOverlay?.ownerKey === credentialKey(context))
            pendingOverlay.finish({ enabled: false });
        return { ok: true };
    }
    const token = state.accessToken;
    if (!token) throw new Error('Sign in to continue');
    const epoch = state.epoch;
    const result = await withAuthDeadline(async (signal: AbortSignal) => {
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
        const family = state.refreshAbsoluteExpiresAt;
        state.loggedOut = true;
        clearTokenState(state);
        state.epoch++;
        broadcastInvalidation(credentialKey(context), family);
    }
    if (pendingOverlay?.ownerKey === credentialKey(context))
        pendingOverlay.finish({ enabled: false });
    return { ok: true };
}

// webSocketURL clones a socket URL and, in v2 mode, appends the bearer as one
// encoded query parameter. The token only travels to the page's own origin.
export function webSocketURL(url: URL | string): URL {
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

if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        void renewIfDue({}, activeAuthContext);
    });
}
if (typeof window !== 'undefined') {
    const bridge: PhiAccessAuthBridge = window.phiAccessAuth || {
        installToken,
        getAccessToken,
        webSocketURL,
    };
    bridge.installToken = installToken;
    bridge.completeHostSession = completeHostSession;
    bridge.getAccessToken = getAccessToken;
    bridge.webSocketURL = webSocketURL;
    bridge.refreshAccessIfDue = refreshAccessIfDue;
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
    receiveLogout,
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

function setReload(fn: () => void) {
    reloadPage = fn;
}

function getAccessState() {
    const {
        selectedProtocol,
        accessEnabled,
        accessToken,
        persistedToken,
        memoryOnly,
        hostSession,
        accessExpiresAt,
        loggedOut,
    } = activeAuthState();
    return {
        selectedProtocol,
        accessEnabled,
        accessToken,
        persistedToken,
        memoryOnly,
        hostSession,
        accessExpiresAt,
        loggedOut,
    };
}
