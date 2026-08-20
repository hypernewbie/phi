// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';

vi.mock('../web/vendor/noble-hashes/pbkdf2.js', () => ({
    pbkdf2Async: vi.fn(async () => new Uint8Array(32).fill(9)),
}));

const { setAccessPassword } = await import('../web/auth.js');

setupDomHarness();

describe('access-password Config save', () => {
    it('posts only a KDF verifier and remembers only its derived credential', async () => {
        vi.stubGlobal('crypto', {
            getRandomValues(bytes) {
                bytes.fill(23);
                return bytes;
            },
        });
        const password = 'correct horse battery staple';
        const fetchSpy = mockFetch((url, options) => {
            expect(url).toBe('/api/auth/password');
            expect(options.method).toBe('POST');
            const record = JSON.parse(options.body).password_hash;
            const parts = record.split('.');
            expect(parts.slice(0, 3)).toEqual([
                'v1',
                'pbkdf2-sha256',
                '600000',
            ]);
            expect(parts).toHaveLength(5);
            expect(record).not.toContain(password);
            return { enabled: true };
        });

        await expect(setAccessPassword(password)).resolves.toEqual({
            enabled: true,
        });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const saved = JSON.parse(
            localStorage.getItem('phi_access_credential_v1'),
        );
        expect(saved.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(JSON.stringify(saved)).not.toContain(password);
    });
});
