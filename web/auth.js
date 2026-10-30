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

async function getStatus() {
    const res = await fetch('/api/auth/status', { cache: 'no-store' });
    if (!res.ok) throw new Error('Unable to check Phi access protection');
    const status = await res.json();
    if (status.enabled && !validStatus(status))
        throw new Error('Phi returned invalid access protection settings');
    return status;
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

async function login(status, verifier) {
    const proof = bytesToBase64URL(
        hmac(sha256, verifier, new TextEncoder().encode(status.challenge)),
    );
    const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge: status.challenge, proof }),
    });
    return { ok: res.ok, status: res.status };
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

function showUnlockPrompt() {
    return new Promise((resolve) => {
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
            try {
                const status = await getStatus();
                if (!status.enabled) {
                    overlay.remove();
                    resolve({ enabled: false });
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
                const result = await login(challenge, verifier);
                if (result.status === 429) {
                    // Rate limited, not a wrong password: the server refuses
                    // every attempt until its backoff ends, so saying "Wrong
                    // password" would send the user into a retry loop that
                    // cannot work.
                    error.textContent =
                        'Too many attempts. Wait about a minute, then try again.';
                    input.select();
                    return;
                }
                if (!result.ok) {
                    error.textContent = 'Wrong password';
                    input.select();
                    return;
                }
                storeCredential(status, verifier);
                input.value = '';
                overlay.remove();
                resolve({ enabled: true });
            } catch (err) {
                error.textContent =
                    err instanceof Error ? err.message : 'Unable to unlock Phi';
            } finally {
                cancelAnimationFrame(ticker);
                submit.disabled = false;
                submit.textContent = 'Sign in';
            }
        });

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        requestAnimationFrame(() => input.focus());
    });
}

// Called before App.init() so the normal UI never starts fetching protected
// data until either the session cookie or remembered derived credential works.
export async function bootstrapAccessAuth() {
    const status = await getStatus();
    if (!status.enabled) return { enabled: false };
    if (status.authenticated === true) return { enabled: true };

    const verifier = savedVerifier(status);
    if (verifier && (await login(status, verifier)).ok) {
        return { enabled: true };
    }
    return showUnlockPrompt();
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
    const { passwordHash, status, verifier } =
        await createPasswordRecord(password);
    const res = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password_hash: passwordHash }),
    });
    if (!res.ok)
        throw new Error((await res.text()) || 'Unable to save access password');
    storeCredential(status, verifier);
    return { enabled: true };
}

export async function clearAccessPassword() {
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
    return { enabled: false };
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
};
