// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';

vi.mock('../web/vendor/noble-hashes/pbkdf2.js', () => ({
    pbkdf2Async: vi.fn(async () => new Uint8Array(32).fill(9)),
}));

const { setAccessPassword } = await import('../web/auth.js');
const { setEmbeddedBackend } = await import('../web/util.js');

setupDomHarness();

describe('access credential storage', () => {
    it('keeps one credential per server in the shared embedded page', async () => {
        localStorage.clear();
        mockFetch(async () => ({ enabled: true }));

        // The desktop's embedded page serves every server from one page, so
        // one localStorage holds every server's credential. A shared key made
        // each server overwrite the previous one's credential, and the next
        // server then treated the foreign salt as a rotation and asked for
        // the password again.
        setEmbeddedBackend('server-a', 'http://a.test:7070');
        await setAccessPassword('correct horse battery staple');
        const first = localStorage.getItem('phi_access_credential_v1:server-a');
        expect(first).toBeTruthy();

        setEmbeddedBackend('server-b', 'http://b.test:7070');
        await setAccessPassword('another long password');

        expect(localStorage.getItem('phi_access_credential_v1:server-a')).toBe(
            first,
        );
        expect(
            localStorage.getItem('phi_access_credential_v1:server-b'),
        ).toBeTruthy();
        expect(localStorage.getItem('phi_access_credential_v1')).toBeNull();
    });

    it('uses the plain key outside the embedded page', async () => {
        localStorage.clear();
        mockFetch(async () => ({ enabled: true }));
        setEmbeddedBackend('', '');
        await setAccessPassword('correct horse battery staple');
        expect(localStorage.getItem('phi_access_credential_v1')).toBeTruthy();
        expect(localStorage.getItem('phi_access_credential_v1:')).toBeNull();
    });
});
