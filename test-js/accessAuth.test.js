// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { bootstrapAccessAuth, __test__ } from '../web/auth.js';

setupDomHarness();

const STATUS = {
    enabled: true,
    version: 'v1',
    algorithm: 'pbkdf2-sha256',
    iterations: 600000,
    salt: 'EREREREREREREREREREREQ',
    challenge: 'one-time-challenge',
};

describe('access-password bootstrap', () => {
    it('does nothing when access protection is disabled', async () => {
        mockFetch((url) => {
            expect(url).toBe('/api/auth/status');
            return { enabled: false };
        });
        await expect(bootstrapAccessAuth()).resolves.toEqual({
            enabled: false,
        });
        expect(document.querySelector('.access-auth-overlay')).toBeNull();
    });

    it('continues straight through when the durable session cookie is still valid', async () => {
        const fetchSpy = mockFetch(() => ({ ...STATUS, authenticated: true }));
        await expect(bootstrapAccessAuth()).resolves.toEqual({ enabled: true });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(document.querySelector('.access-auth-overlay')).toBeNull();
    });

    it('silently unlocks with the remembered derived verifier', async () => {
        const verifier = new Uint8Array(32).fill(7);
        localStorage.setItem(
            'phi_access_credential_v1',
            JSON.stringify({
                version: STATUS.version,
                algorithm: STATUS.algorithm,
                iterations: STATUS.iterations,
                salt: STATUS.salt,
                verifier: __test__.bytesToBase64URL(verifier),
            }),
        );
        const fetchSpy = mockFetch((url, options) => {
            if (url === '/api/auth/status') return STATUS;
            if (url === '/api/auth/login') {
                expect(options.method).toBe('POST');
                const payload = JSON.parse(options.body);
                expect(payload.challenge).toBe(STATUS.challenge);
                expect(payload.proof).toMatch(/^[A-Za-z0-9_-]+$/);
                return { ok: true };
            }
            throw new Error(`unexpected fetch ${url}`);
        });

        await expect(bootstrapAccessAuth()).resolves.toEqual({ enabled: true });
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(document.querySelector('.access-auth-overlay')).toBeNull();
    });

    it('derives and stores a verifier, never the raw Config password', async () => {
        const password = 'correct horse battery staple';
        const record = await __test__.createPasswordRecord(password, {
            // Exercise the exact record format without making the whole suite
            // spend a production-strength KDF work factor in jsdom.
            iterations: 1,
            salt: new Uint8Array(16).fill(23),
        });
        const parts = record.passwordHash.split('.');
        expect(parts.slice(0, 3)).toEqual(['v1', 'pbkdf2-sha256', '1']);
        expect(parts).toHaveLength(5);
        expect(record.passwordHash).not.toContain(password);
        __test__.storeCredential(record.status, record.verifier);
        const saved = JSON.parse(
            localStorage.getItem('phi_access_credential_v1'),
        );
        expect(saved.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(JSON.stringify(saved)).not.toContain(password);
    });

    it('shows only the small password prompt when this browser has no credential', async () => {
        mockFetch(() => STATUS);
        void bootstrapAccessAuth();
        await new Promise((resolve) => setTimeout(resolve, 0));
        const overlay = document.querySelector('.access-auth-overlay');
        expect(overlay).toBeTruthy();
        expect(overlay.querySelector('h1').textContent).toBe('Sign in to Phi');
        expect(overlay.querySelector('.access-auth-subtitle').textContent).toBe(
            'Enter your password to continue.',
        );
        expect(overlay.querySelector('input[type="password"]')).toBeTruthy();
        expect(overlay.querySelector('button[type="submit"]').textContent).toBe(
            'Sign in',
        );
    });
});

import { webcrypto } from 'node:crypto';
import { pbkdf2Async } from '../web/vendor/noble-hashes/pbkdf2.js';
import { sha256 } from '../web/vendor/noble-hashes/sha2.js';

const KAT_PASSWORD = 'correct horse battery staple';
const KAT_SALT = new Uint8Array(16).fill(23);
const KAT_SALT_B64URL = __test__.bytesToBase64URL(KAT_SALT);

async function nobleReference() {
    return pbkdf2Async(sha256, KAT_PASSWORD, KAT_SALT, {
        c: 1,
        dkLen: 32,
    });
}

describe('deriveVerifier native acceleration', () => {
    it('prefers SubtleCrypto when exposed and matches noble byte-for-byte', async () => {
        __test__.resetNativeDerive();
        vi.stubGlobal('crypto', webcrypto);
        try {
            const result = await __test__.deriveVerifier(KAT_PASSWORD, {
                enabled: true,
                version: 'v1',
                algorithm: 'pbkdf2-sha256',
                iterations: 1,
                salt: KAT_SALT_B64URL,
                challenge: 'x',
            });
            expect(Array.from(result)).toEqual(
                Array.from(await nobleReference()),
            );
        } finally {
            vi.unstubAllGlobals();
            __test__.resetNativeDerive();
        }
    });

    it('falls back to noble (identical bytes) where SubtleCrypto is absent', async () => {
        __test__.resetNativeDerive();
        vi.stubGlobal('crypto', {
            getRandomValues: webcrypto.getRandomValues,
        });
        try {
            const result = await __test__.deriveVerifier(KAT_PASSWORD, {
                enabled: true,
                version: 'v1',
                algorithm: 'pbkdf2-sha256',
                iterations: 1,
                salt: KAT_SALT_B64URL,
                challenge: 'x',
            });
            expect(Array.from(result)).toEqual(
                Array.from(await nobleReference()),
            );
        } finally {
            vi.unstubAllGlobals();
            __test__.resetNativeDerive();
        }
    });

    it('rejects a SubtleCrypto that disagrees with noble (KAT guard)', async () => {
        __test__.resetNativeDerive();
        const realDeriveBits = webcrypto.subtle.deriveBits.bind(
            webcrypto.subtle,
        );
        const hostile = {
            getRandomValues: webcrypto.getRandomValues,
            subtle: {
                importKey: webcrypto.subtle.importKey.bind(webcrypto.subtle),
                deriveBits: async (...args) => {
                    const bits = await realDeriveBits(...args);
                    new Uint8Array(bits)[0] ^= 0xff; // corrupt every result
                    return bits;
                },
            },
        };
        vi.stubGlobal('crypto', hostile);
        try {
            const result = await __test__.deriveVerifier(KAT_PASSWORD, {
                enabled: true,
                version: 'v1',
                algorithm: 'pbkdf2-sha256',
                iterations: 1,
                salt: KAT_SALT_B64URL,
                challenge: 'x',
            });
            // The 1-iteration KAT caught the corruption and routed the
            // real derivation through noble instead.
            expect(Array.from(result)).toEqual(
                Array.from(await nobleReference()),
            );
        } finally {
            vi.unstubAllGlobals();
            __test__.resetNativeDerive();
        }
    });
});

describe('unlock overlay slow-derive feedback', () => {
    const submitOverlay = async () => {
        let resolveLogin;
        const loginGate = new Promise((r) => {
            resolveLogin = r;
        });
        mockFetch((url) => {
            if (url === '/api/auth/status') return { ...STATUS, iterations: 1 };
            if (url === '/api/auth/login') return loginGate;
            throw new Error(`unexpected fetch ${url}`);
        });
        const boot = bootstrapAccessAuth();
        await new Promise((resolve) => setTimeout(resolve, 0));
        const overlay = document.querySelector('.access-auth-overlay');
        const form = overlay.querySelector('form');
        overlay.querySelector('input[type="password"]').value = KAT_PASSWORD;
        form.dispatchEvent(new Event('submit', { cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        return {
            boot,
            overlay,
            button: overlay.querySelector('button[type="submit"]'),
            subtitle: overlay.querySelector('.access-auth-subtitle'),
            release: () => resolveLogin({ ok: true }),
        };
    };

    it('shows the busy state while signing in', async () => {
        __test__.resetNativeDerive();
        vi.stubGlobal('crypto', {
            getRandomValues: webcrypto.getRandomValues,
        });
        try {
            const state = await submitOverlay();
            expect(state.button.textContent).toBe('Signing in…');
            expect(state.button.disabled).toBe(true);
            // The subtitle never changes - no crypto narration in the UI.
            expect(state.subtitle.textContent).toBe(
                'Enter your password to continue.',
            );
            state.release();
            await expect(state.boot).resolves.toEqual({ enabled: true });
            expect(document.querySelector('.access-auth-overlay')).toBeNull();
        } finally {
            vi.unstubAllGlobals();
            __test__.resetNativeDerive();
        }
    });

    it('restores the button after a wrong password', async () => {
        __test__.resetNativeDerive();
        vi.stubGlobal('crypto', webcrypto);
        try {
            let rejectLogin;
            const gate = new Promise((r) => {
                rejectLogin = r;
            });
            mockFetch((url) => {
                if (url === '/api/auth/status')
                    return { ...STATUS, iterations: 1 };
                if (url === '/api/auth/login') return gate;
                throw new Error();
            });
            const boot = bootstrapAccessAuth();
            await new Promise((resolve) => setTimeout(resolve, 0));
            const overlay = document.querySelector('.access-auth-overlay');
            const form = overlay.querySelector('form');
            overlay.querySelector('input[type="password"]').value =
                KAT_PASSWORD;
            form.dispatchEvent(new Event('submit', { cancelable: true }));
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(
                overlay.querySelector('button[type="submit"]').textContent,
            ).toBe('Signing in…');
            rejectLogin({ ok: false });
            await new Promise((resolve) => setTimeout(resolve, 0));
            const button = overlay.querySelector('button[type="submit"]');
            expect(button.textContent).toBe('Sign in');
            expect(button.disabled).toBe(false);
            expect(
                overlay.querySelector('.access-auth-error').textContent,
            ).toBe('Wrong password');
            overlay.remove();
            void boot;
        } finally {
            vi.unstubAllGlobals();
            __test__.resetNativeDerive();
            document.querySelector('.access-auth-overlay')?.remove();
        }
    });
});
