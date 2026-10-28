// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';

vi.mock('../web/vendor/noble-hashes/pbkdf2.js', () => ({
    pbkdf2Async: vi.fn(async () => new Uint8Array(32).fill(9)),
}));

const {
    setAccessPassword,
    clearAccessPassword,
    bootstrapAccessAuth,
    __test__,
} = await import('../web/auth.js');
const { setEmbeddedBackend } = await import('../web/util.js');
const { appearanceRequestContext } = await import(
    '../web/mobile-appearance.js'
);
const { BackendScope } = await import('../web/backend-scope.js');

setupDomHarness();
beforeEach(() => __test__.resetAccessState());

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

    it('binds password writes and credential cleanup to the opener after an active-backend switch', async () => {
        const context = appearanceRequestContext(
            new BackendScope('server-a', 'http://a.test'),
        );
        let release;
        const request = vi.fn(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        vi.stubGlobal('fetch', request);
        localStorage.setItem(
            'phi_access_credential_v1:server-b',
            'fixture B credential',
        );
        const save = setAccessPassword('fixture password', context);
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
        setEmbeddedBackend('server-b', 'http://b.test');
        expect(request.mock.calls[0][1].headers['X-Phi-Backend']).toBe(
            'server-a',
        );
        release(Response.json({ enabled: true }));
        await save;
        expect(
            localStorage.getItem('phi_access_credential_v1:server-a'),
        ).toBeTruthy();
        expect(localStorage.getItem('phi_access_credential_v1:server-b')).toBe(
            'fixture B credential',
        );
        request.mockResolvedValue(Response.json({ enabled: false }));
        await clearAccessPassword(context);
        expect(
            localStorage.getItem('phi_access_credential_v1:server-a'),
        ).toBeNull();
        expect(localStorage.getItem('phi_access_credential_v1:server-b')).toBe(
            'fixture B credential',
        );
        expect(request.mock.calls[1][1].headers['X-Phi-Backend']).toBe(
            'server-a',
        );
    });

    it('keeps owner-bound reauthentication and the unlock prompt on A after switching to B', async () => {
        const context = appearanceRequestContext(
            new BackendScope('server-a', 'http://a.test'),
        );
        localStorage.setItem(
            'phi_access_credential_v1:server-a',
            'stale fixture credential',
        );
        localStorage.setItem(
            'phi_access_credential_v1:server-b',
            'fixture B credential',
        );
        let release;
        const request = vi.fn(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        vi.stubGlobal('fetch', request);
        const boot = bootstrapAccessAuth(context);
        setEmbeddedBackend('server-b', 'http://b.test');
        release(
            Response.json({
                enabled: true,
                authenticated: false,
                version: 'v1',
                algorithm: 'pbkdf2-sha256',
                iterations: 600000,
                salt: 'EREREREREREREREREREREQ',
                challenge: 'fixture challenge',
            }),
        );
        await vi.waitFor(() =>
            expect(
                document.querySelector('.access-auth-overlay'),
            ).not.toBeNull(),
        );
        expect(
            localStorage.getItem('phi_access_credential_v1:server-a'),
        ).toBeNull();
        expect(localStorage.getItem('phi_access_credential_v1:server-b')).toBe(
            'fixture B credential',
        );
        request.mockResolvedValue(Response.json({ enabled: false }));
        document
            .querySelector('.access-auth-dialog')
            .dispatchEvent(
                new Event('submit', { bubbles: true, cancelable: true }),
            );
        await boot;
        expect(
            request.mock.calls.every(
                ([, init]) => init.headers['X-Phi-Backend'] === 'server-a',
            ),
        ).toBe(true);
    });

    it('keeps a late v2 save and clear bound to A after B becomes active', async () => {
        const contextA = appearanceRequestContext(
            new BackendScope('server-a', 'http://a.test'),
        );
        const contextB = appearanceRequestContext(
            new BackendScope('server-b', 'http://b.test'),
        );
        localStorage.setItem('phi_access_bearer_v1:server-a', 'jwt-a-old');
        localStorage.setItem('phi_access_bearer_v1:server-b', 'jwt-b-old');
        let releaseSaveA;
        const calls = [];
        const bundle = (token) =>
            Response.json({
                enabled: true,
                token,
                expires_at: 1800000000,
                expires_in: 3600,
                refresh_idle_expires_at: 1802000000,
                refresh_absolute_expires_at: 1807000000,
            });
        const request = vi.fn((url, init) => {
            const headers = new Headers(init.headers);
            const owner = headers.get('X-Phi-Backend');
            calls.push({ url, owner, headers, body: init.body });
            if (url === '/api/auth/status') {
                return Response.json({
                    enabled: true,
                    authenticated: false,
                    protocols: ['v2'],
                });
            }
            if (url === '/api/auth/v2/refresh')
                return bundle(owner === 'server-a' ? 'jwt-a-old' : 'jwt-b-old');
            if (url === '/api/auth/v2/status')
                return Response.json({ enabled: true, authenticated: true });
            if (url === '/api/auth/v2/password') {
                const body = JSON.parse(init.body);
                if (owner === 'server-a' && body.password === 'change-A') {
                    return new Promise((resolve) => {
                        releaseSaveA = resolve;
                    });
                }
                if (owner === 'server-b' && body.password === 'change-B')
                    return bundle('jwt-b-new');
                if (owner === 'server-a' && body.password === '')
                    return Response.json({ enabled: false });
            }
            throw new Error(`unexpected request ${owner} ${url}`);
        });
        vi.stubGlobal('fetch', request);

        await expect(bootstrapAccessAuth(contextA)).resolves.toEqual({
            enabled: true,
        });
        const saveA = setAccessPassword('change-A', contextA);
        await vi.waitFor(() => expect(releaseSaveA).toBeTypeOf('function'));

        await expect(bootstrapAccessAuth(contextB)).resolves.toEqual({
            enabled: true,
        });
        await setAccessPassword('change-B', contextB);
        expect(__test__.getAccessState().accessToken).toBe('jwt-b-new');

        releaseSaveA(bundle('jwt-a-new'));
        await saveA;
        expect(__test__.getAccessState().accessToken).toBe('jwt-b-new');
        expect(
            localStorage.getItem('phi_access_bearer_v1:server-a'),
        ).toBeNull();
        expect(
            localStorage.getItem('phi_access_bearer_v1:server-b'),
        ).toBeNull();

        await clearAccessPassword(contextA);
        expect(__test__.getAccessState().accessToken).toBe('jwt-b-new');
        expect(
            localStorage.getItem('phi_access_bearer_v1:server-a'),
        ).toBeNull();
        expect(
            localStorage.getItem('phi_access_bearer_v1:server-b'),
        ).toBeNull();
        expect(
            calls
                .filter((call) => call.url.endsWith('/api/auth/v2/password'))
                .map((call) => [call.owner, call.headers.get('Authorization')]),
        ).toEqual([
            ['server-a', 'Bearer jwt-a-old'],
            ['server-b', 'Bearer jwt-b-old'],
            ['server-a', 'Bearer jwt-a-new'],
        ]);
    });
});
