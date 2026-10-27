// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { bootstrapAccessAuth, __test__ } from '../web/auth.js';

setupDomHarness();

const STATUS = {
    enabled: true,
    authenticated: false,
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
    // The post-submit path crosses a derive plus several fetch/UI hops, so
    // poll for the settled label instead of assuming a tick count.
    const settled = async (overlay) => {
        const deadline = Date.now() + 2000;
        for (;;) {
            const label = overlay.querySelector(
                'button[type="submit"]',
            ).textContent;
            if (label === 'Sign in') return;
            if (Date.now() > deadline)
                throw new Error(
                    `button never restored (last: ${JSON.stringify(label)})`,
                );
            await new Promise((r) => setTimeout(r, 10));
        }
    };

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
            // The label gains an elapsed-seconds suffix once the first tick
            // fires, so assert the busy prefix rather than the exact string.
            expect(state.button.textContent).toMatch(/^Signing in…/);
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

    it('reports a rate-limited attempt as rate limiting, not a wrong password', async () => {
        __test__.resetNativeDerive();
        vi.stubGlobal('crypto', webcrypto);
        try {
            mockFetch((url) => {
                if (url === '/api/auth/status')
                    return { ...STATUS, iterations: 1 };
                if (url === '/api/auth/login')
                    return { ok: false, status: 429 };
                throw new Error();
            });
            const boot = bootstrapAccessAuth();
            await new Promise((resolve) => setTimeout(resolve, 0));
            const overlay = document.querySelector('.access-auth-overlay');
            overlay.querySelector('input[type="password"]').value =
                KAT_PASSWORD;
            overlay
                .querySelector('form')
                .dispatchEvent(new Event('submit', { cancelable: true }));
            await settled(overlay);
            expect(
                overlay.querySelector('.access-auth-error').textContent,
            ).toBe('Too many attempts. Wait about a minute, then try again.');
            overlay.remove();
            void boot;
        } finally {
            vi.unstubAllGlobals();
            __test__.resetNativeDerive();
            document.querySelector('.access-auth-overlay')?.remove();
        }
    });

    it('reuses the bootstrap challenge when the derivation was fast', async () => {
        __test__.resetNativeDerive();
        vi.stubGlobal('crypto', webcrypto);
        try {
            let statusCalls = 0;
            let posted;
            mockFetch((url, options) => {
                if (url === '/api/auth/status') {
                    statusCalls += 1;
                    return {
                        ...STATUS,
                        iterations: 1,
                        challenge: `challenge-${statusCalls}`,
                    };
                }
                if (url === '/api/auth/login') {
                    posted = JSON.parse(options.body);
                    return { ok: true };
                }
                throw new Error();
            });
            const boot = bootstrapAccessAuth();
            await new Promise((resolve) => setTimeout(resolve, 0));
            const overlay = document.querySelector('.access-auth-overlay');
            overlay.querySelector('input[type="password"]').value =
                KAT_PASSWORD;
            overlay
                .querySelector('form')
                .dispatchEvent(new Event('submit', { cancelable: true }));
            await expect(boot).resolves.toEqual({ enabled: true });
            // challenge-1 came from the bootstrap, challenge-2 was fetched
            // right before the derivation. A derivation this fast cannot
            // outlive the five-minute TTL, so no third call is made.
            expect(statusCalls).toBe(2);
            expect(posted.challenge).toBe('challenge-2');
        } finally {
            vi.unstubAllGlobals();
            __test__.resetNativeDerive();
            document.querySelector('.access-auth-overlay')?.remove();
        }
    });

    it('refreshes the challenge only after a long derivation', async () => {
        const stale = { ...STATUS, challenge: 'challenge-old' };
        let calls = 0;
        mockFetch((url) => {
            expect(url).toBe('/api/auth/status');
            calls += 1;
            return { ...STATUS, challenge: 'challenge-new' };
        });
        // Below the refresh threshold the fetch is skipped entirely.
        expect(
            await __test__.freshStatus(stale, performance.now() - 80_000),
        ).toBe(stale);
        expect(calls).toBe(0);
        expect(
            (
                await __test__.freshStatus(
                    stale,
                    performance.now() - 4 * 60 * 1000,
                )
            ).challenge,
        ).toBe('challenge-new');
        expect(calls).toBe(1);
    });

    it('falls back to the original challenge when the refresh stalls', async () => {
        const stale = { ...STATUS, challenge: 'challenge-old' };
        // Honors the abort signal the way a real fetch does, so the test
        // proves the deadline fires rather than just that the mock is slow.
        mockFetch(
            (_url, options) =>
                new Promise((_, reject) =>
                    options.signal.addEventListener('abort', () =>
                        reject(new Error('aborted')),
                    ),
                ),
        );
        vi.useFakeTimers();
        try {
            // Still inside the five-minute lifetime after the timeout: the
            // fallback is valid.
            const pending = __test__.freshStatus(
                stale,
                performance.now() - 4.5 * 60 * 1000,
            );
            await vi.advanceTimersByTimeAsync(15_000);
            await expect(pending).resolves.toBe(stale);

            // 290s of derivation plus the 15s timeout crosses the five-minute
            // lifetime, so the fallback must not be handed back for a POST.
            const expired = __test__.freshStatus(
                stale,
                performance.now() - 290_000,
            );
            await vi.advanceTimersByTimeAsync(15_000);
            await expect(expired).resolves.toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('refuses to post a challenge the derivation outlived', async () => {
        const stale = { ...STATUS, challenge: 'challenge-old' };
        mockFetch(() => Promise.reject(new Error('offline')));
        // Past the server's accessChallengeTTL there is no challenge left to
        // post: a null result stops the caller before login sends anything.
        await expect(
            __test__.freshStatus(stale, performance.now() - 5 * 60 * 1000),
        ).resolves.toBeNull();
    });

    it('ticks the busy label by whole seconds and stops when settled', async () => {
        __test__.resetNativeDerive();
        // Noble path: the derivation is then pure microtasks, so settlement
        // depends only on the controlled promises and timers below.
        vi.stubGlobal('crypto', {
            getRandomValues: webcrypto.getRandomValues,
        });
        vi.useFakeTimers({
            toFake: [
                'setTimeout',
                'clearTimeout',
                'Date',
                'performance',
                'requestAnimationFrame',
                'cancelAnimationFrame',
            ],
        });
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
            await vi.advanceTimersByTimeAsync(0);
            const overlay = document.querySelector('.access-auth-overlay');
            const button = overlay.querySelector('button[type="submit"]');
            overlay.querySelector('input[type="password"]').value =
                KAT_PASSWORD;
            overlay
                .querySelector('form')
                .dispatchEvent(new Event('submit', { cancelable: true }));
            await vi.advanceTimersByTimeAsync(0);
            expect(button.textContent).toBe('Signing in…');
            await vi.advanceTimersByTimeAsync(2100);
            expect(button.textContent).toBe('Signing in… 2s');
            rejectLogin({ ok: false });
            await vi.advanceTimersByTimeAsync(0);
            expect(button.textContent).toBe('Sign in');
            await vi.advanceTimersByTimeAsync(3000);
            // The ticker is cancelled on settle: no stray label writes left.
            expect(button.textContent).toBe('Sign in');
            void boot;
        } finally {
            vi.useRealTimers();
            vi.unstubAllGlobals();
            __test__.resetNativeDerive();
            document.querySelector('.access-auth-overlay')?.remove();
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
            // A tick fires on the next frame, so the label may already carry
            // an elapsed-seconds suffix here.
            expect(
                overlay.querySelector('button[type="submit"]').textContent,
            ).toMatch(/^Signing in…/);
            rejectLogin({ ok: false, status: 401 });
            // The post-reject path crosses a real webcrypto derive plus
            // fetch/UI hops; a single fixed tick flakes under CI load.
            // Poll for the settled state instead of assuming tick count.
            // Assertions below are unchanged.
            {
                const deadline = Date.now() + 2000;
                for (;;) {
                    const label = overlay.querySelector(
                        'button[type="submit"]',
                    ).textContent;
                    if (label === 'Sign in') break;
                    if (Date.now() > deadline) {
                        throw new Error(
                            `button never restored (last: ${JSON.stringify(label)})`,
                        );
                    }
                    await new Promise((r) => setTimeout(r, 10));
                }
            }
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
