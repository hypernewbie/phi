// Optional access-password bootstrap for Phi. This deliberately uses the
// audited @noble/hashes implementation rather than a hand-written crypto
// routine so it also works when Phi is served over a LAN HTTP address where
// SubtleCrypto is not exposed by the browser.
import { pbkdf2Async } from './vendor/noble-hashes/pbkdf2.js';
import { hmac } from './vendor/noble-hashes/hmac.js';
import { sha256 } from './vendor/noble-hashes/sha2.js';

const CREDENTIAL_KEY = 'phi_access_credential_v1';
const PASSWORD_MIN_LENGTH = 8;

function bytesToBase64URL(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64URLToBytes(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new Error('Invalid saved access credential');
    }
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function validStatus(status) {
    return !!status
        && status.enabled === true
        && status.version === 'v1'
        && status.algorithm === 'pbkdf2-sha256'
        && Number.isInteger(status.iterations)
        && status.iterations > 0
        && typeof status.salt === 'string'
        && typeof status.challenge === 'string';
}

async function getStatus() {
    const res = await fetch('/api/auth/status', { cache: 'no-store' });
    if (!res.ok) throw new Error('Unable to check Phi access protection');
    const status = await res.json();
    if (status.enabled && !validStatus(status)) throw new Error('Phi returned invalid access protection settings');
    return status;
}

async function deriveVerifier(password, status) {
    if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
        throw new Error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
    }
    const salt = base64URLToBytes(status.salt);
    return pbkdf2Async(sha256, password, salt, {
        c: status.iterations,
        dkLen: 32,
        asyncTick: 10,
    });
}

function storeCredential(status, verifier) {
    try {
        localStorage.setItem(CREDENTIAL_KEY, JSON.stringify({
            version: status.version,
            algorithm: status.algorithm,
            iterations: status.iterations,
            salt: status.salt,
            verifier: bytesToBase64URL(verifier),
        }));
    } catch {
        // A cookie session still works when localStorage is blocked. The user
        // will only need to type the password after that session expires.
    }
}

function clearCredential() {
    try { localStorage.removeItem(CREDENTIAL_KEY); } catch { /* ignored */ }
}

function savedVerifier(status) {
    try {
        const saved = JSON.parse(localStorage.getItem(CREDENTIAL_KEY) || 'null');
        if (!saved
            || saved.version !== status.version
            || saved.algorithm !== status.algorithm
            || saved.iterations !== status.iterations
            || saved.salt !== status.salt) {
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

async function login(status, verifier) {
    const proof = bytesToBase64URL(hmac(sha256, verifier, new TextEncoder().encode(status.challenge)));
    const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge: status.challenge, proof }),
    });
    return res.ok;
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
        title.textContent = 'Phi is locked';
        dialog.appendChild(title);

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
        submit.textContent = 'Unlock';
        dialog.appendChild(submit);

        dialog.addEventListener('submit', async (event) => {
            event.preventDefault();
            error.textContent = '';
            submit.disabled = true;
            try {
                const status = await getStatus();
                if (!status.enabled) {
                    overlay.remove();
                    resolve({ enabled: false });
                    return;
                }
                const verifier = await deriveVerifier(input.value, status);
                if (!await login(status, verifier)) {
                    error.textContent = 'Wrong password';
                    input.select();
                    return;
                }
                storeCredential(status, verifier);
                input.value = '';
                overlay.remove();
                resolve({ enabled: true });
            } catch (err) {
                error.textContent = err instanceof Error ? err.message : 'Unable to unlock Phi';
            } finally {
                submit.disabled = false;
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
    if (verifier && await login(status, verifier)) {
        return { enabled: true };
    }
    return showUnlockPrompt();
}

async function createPasswordRecord(password, { iterations = 600000, salt } = {}) {
    if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
        throw new Error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
    }
    if (!salt) {
        if (!globalThis.crypto?.getRandomValues) {
            throw new Error('This browser cannot securely generate a password salt');
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
// only thing written to config.json; the raw password is discarded immediately.
export async function setAccessPassword(password) {
    const { passwordHash, status, verifier } = await createPasswordRecord(password);
    const res = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password_hash: passwordHash }),
    });
    if (!res.ok) throw new Error(await res.text() || 'Unable to save access password');
    storeCredential(status, verifier);
    return { enabled: true };
}

export async function clearAccessPassword() {
    const res = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password_hash: '' }),
    });
    if (!res.ok) throw new Error(await res.text() || 'Unable to clear access password');
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
};
