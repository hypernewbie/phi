// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
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
        await expect(bootstrapAccessAuth()).resolves.toEqual({ enabled: false });
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
        localStorage.setItem('phi_access_credential_v1', JSON.stringify({
            version: STATUS.version,
            algorithm: STATUS.algorithm,
            iterations: STATUS.iterations,
            salt: STATUS.salt,
            verifier: __test__.bytesToBase64URL(verifier),
        }));
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
        const saved = JSON.parse(localStorage.getItem('phi_access_credential_v1'));
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
        expect(overlay.querySelector('.access-auth-subtitle').textContent).toBe('Enter your password to continue.');
        expect(overlay.querySelector('input[type="password"]')).toBeTruthy();
        expect(overlay.querySelector('button[type="submit"]').textContent).toBe('Sign in');
    });
});
