// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, setupDomHarness } from './_dom.js';

vi.mock('../web/vendor/noble-hashes/pbkdf2.js', () => ({
    pbkdf2Async: vi.fn(async () => {
        // Tests can hold a derivation to interleave a superseding event.
        if (globalThis.__pbkdf2Gate) await globalThis.__pbkdf2Gate;
        return new Uint8Array(32).fill(9);
    }),
}));

const {
    bootstrapAccessAuth,
    clearAccessPassword,
    logoutAccess,
    installAccessFetch,
    installToken,
    setAccessPassword,
    __test__,
} = await import('../web/auth.js');

setupDomHarness();

const BEARER_KEY = 'phi_access_bearer_v1';
const CREDENTIAL_KEY = 'phi_access_credential_v1';

const DUAL_STATUS = {
    enabled: true,
    authenticated: false,
    protocols: ['v1', 'v2'],
    version: 'v1',
    algorithm: 'pbkdf2-sha256',
    iterations: 600000,
    salt: 'EREREREREREREREREREREQ',
    challenge: 'one-time-challenge',
};

const LEGACY_BEARER_KEY = 'phi_access_bearer_v1';

// A complete credential bundle, exactly as the server sends it. expires_in is
// a duration; the three deadlines are integer Unix seconds.
const BUNDLE = {
    enabled: true,
    token: 'jwt-bundle',
    expires_at: 1800000000,
    expires_in: 3600,
    refresh_idle_expires_at: 1802000000,
    refresh_absolute_expires_at: 1807000000,
};

// mockAuth adds the refresh route to a test's fetch stub. Unless the handler
// answers it, the page holds no working refresh cookie - the state a v1
// recovery test or a password-prompt test starts from.
function mockAuth(handler) {
    return mockFetch((url, options) => {
        const answer = handler ? handler(url, options) : undefined;
        if (answer !== undefined) return answer;
        if (url === '/api/auth/v2/refresh') return { ok: false, status: 401 };
        return undefined;
    });
}

function submitOverlay(password) {
    const overlay = document.querySelector('.access-auth-overlay');
    if (!overlay) throw new Error('no unlock overlay');
    overlay.querySelector('input[type="password"]').value = password;
    overlay
        .querySelector('form')
        .dispatchEvent(
            new Event('submit', { cancelable: true, bubbles: true }),
        );
    return overlay;
}

beforeEach(() => {
    __test__.resetAccessState();
    __test__.setReload(vi.fn());
});

describe('v2 selection', () => {
    it('remembers the preferred protocol without logging in when disabled', async () => {
        const fetchSpy = mockAuth(() => ({
            enabled: false,
            protocols: ['v1', 'v2'],
        }));
        await expect(bootstrapAccessAuth()).resolves.toEqual({
            enabled: false,
        });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(__test__.getAccessState().selectedProtocol).toBe('v2');
        expect(document.querySelector('.access-auth-overlay')).toBeNull();
    });

    it('treats an absent capability field as v1-only', async () => {
        mockAuth(() => ({ enabled: false }));
        await expect(bootstrapAccessAuth()).resolves.toEqual({
            enabled: false,
        });
        expect(__test__.getAccessState().selectedProtocol).toBe('v1');
    });

    it('reuses a stored bearer the server still accepts', async () => {
        installToken('jwt-stored');
        const fetchSpy = mockAuth((url) => {
            if (url === '/api/auth/status') return DUAL_STATUS;
            if (url === '/api/auth/v2/status') {
                return { enabled: true, authenticated: true };
            }
            throw new Error(`unexpected fetch ${url}`);
        });
        await expect(bootstrapAccessAuth()).resolves.toEqual({ enabled: true });
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        const state = __test__.getAccessState();
        expect(state.selectedProtocol).toBe('v2');
        expect(state.accessToken).toBe('jwt-stored');
        expect(document.querySelector('.access-auth-overlay')).toBeNull();
    });

    it('clears only a rejected bearer and asks for a v2 password without a cookie fallback', async () => {
        installToken('jwt-stale');
        const fetchSpy = mockAuth((url) => {
            if (url === '/api/auth/status')
                return { ...DUAL_STATUS, authenticated: true };
            if (url === '/api/auth/v2/status') {
                return { enabled: true, authenticated: false };
            }
            if (url === '/api/auth/login')
                throw new Error('v1 login must not run after a v2 rejection');
            return undefined;
        });
        void bootstrapAccessAuth();
        await vi.waitFor(() =>
            expect(document.querySelector('.access-auth-overlay')).toBeTruthy(),
        );
        expect(localStorage.getItem(BEARER_KEY)).toBeNull();
        expect(__test__.getAccessState().accessToken).toBeNull();
        expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
            '/api/auth/status',
            '/api/auth/v2/status',
        ]);
    });

    it('keeps an in-memory token when the token check fails transiently', async () => {
        installToken('jwt-stored');
        mockAuth((url) => {
            if (url === '/api/auth/status') return DUAL_STATUS;
            if (url === '/api/auth/v2/status')
                return { ok: false, status: 503 };
            return undefined;
        });
        await expect(bootstrapAccessAuth()).rejects.toThrow(
            'Unable to check Phi access protection',
        );
        expect(__test__.getAccessState().accessToken).toBe('jwt-stored');
        expect(localStorage.getItem(LEGACY_BEARER_KEY)).toBeNull();
    });

    it('keeps v1 when the cookie is still valid even though v2 is advertised', async () => {
        mockAuth(() => ({ ...DUAL_STATUS, authenticated: true }));
        await expect(bootstrapAccessAuth()).resolves.toEqual({ enabled: true });
        expect(__test__.getAccessState().selectedProtocol).toBe('v1');
        expect(document.querySelector('.access-auth-overlay')).toBeNull();
    });

    it('keeps a v2 selection with no token instead of falling back to v1', async () => {
        // A browser-obtained token, not a host install: a host-installed token
        // is renewed by the host and never refreshed standalone.
        mockAuth((url) => {
            if (url === '/api/auth/status')
                return { ...DUAL_STATUS, authenticated: false };
            if (url === '/api/auth/v2/refresh')
                return { ...BUNDLE, token: 'jwt-stale' };
            return undefined;
        });
        await expect(bootstrapAccessAuth()).resolves.toEqual({ enabled: true });
        expect(__test__.getAccessState().accessToken).toBe('jwt-stale');

        // The server no longer accepts it. Only the credential clears.
        mockAuth((url) => {
            if (url === '/api/auth/status')
                return { ...DUAL_STATUS, authenticated: true };
            if (url === '/api/auth/v2/status')
                return { enabled: true, authenticated: false };
            if (url === '/api/auth/login')
                throw new Error('v1 login must not run after a v2 rejection');
            return undefined;
        });
        void bootstrapAccessAuth();
        await vi.waitFor(() =>
            expect(
                document.querySelectorAll('.access-auth-overlay'),
            ).toHaveLength(1),
        );
        expect(__test__.getAccessState().accessToken).toBeNull();

        // A second bootstrap must not use the valid v1 cookie: the rejected
        // token cleared only the credential, not the protocol selection.
        const fetchSpy = mockAuth((url) => {
            if (url === '/api/auth/status')
                return { ...DUAL_STATUS, authenticated: true };
            if (url === '/api/auth/login')
                throw new Error('v1 login must not run');
            return undefined;
        });
        void bootstrapAccessAuth();
        await vi.waitFor(() =>
            expect(
                document.querySelectorAll('.access-auth-overlay'),
            ).toHaveLength(2),
        );
        expect(__test__.getAccessState().selectedProtocol).toBe('v2');
        expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
            '/api/auth/status',
            '/api/auth/v2/refresh',
        ]);
    });

    it('drops the in-memory bearer when a v1-only server disables auth', async () => {
        installToken('jwt-host');
        const fetchSpy = mockAuth((url) => {
            if (url === '/api/auth/status')
                return {
                    ...DUAL_STATUS,
                    protocols: ['v1'],
                    enabled: false,
                    authenticated: false,
                };
            throw new Error(`unexpected fetch ${url}`);
        });
        await expect(bootstrapAccessAuth()).resolves.toEqual({
            enabled: false,
        });
        const state = __test__.getAccessState();
        expect(state.selectedProtocol).toBe('v1');
        // The bearer must not keep reaching a server that cannot verify it.
        expect(state.accessToken).toBeNull();
        expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
            '/api/auth/status',
        ]);
    });

    it('downgrades an existing v2 selection only on v1-only discovery', async () => {
        installToken('jwt-host');
        const fetchSpy = mockAuth((url) => {
            if (url === '/api/auth/status')
                return {
                    ...DUAL_STATUS,
                    protocols: ['v1'],
                    authenticated: true,
                };
            throw new Error(`unexpected fetch ${url}`);
        });
        await expect(bootstrapAccessAuth()).resolves.toEqual({ enabled: true });
        const state = __test__.getAccessState();
        expect(state.selectedProtocol).toBe('v1');
        // The bearer must stop reaching a server that cannot verify it.
        expect(state.accessToken).toBeNull();
        expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
            '/api/auth/status',
        ]);
    });

    it('keeps v1 when the saved verifier still logs in and retains it', async () => {
        const verifier = new Uint8Array(32).fill(7);
        localStorage.setItem(
            CREDENTIAL_KEY,
            JSON.stringify({
                version: DUAL_STATUS.version,
                algorithm: DUAL_STATUS.algorithm,
                iterations: DUAL_STATUS.iterations,
                salt: DUAL_STATUS.salt,
                verifier: __test__.bytesToBase64URL(verifier),
            }),
        );
        const fetchSpy = mockAuth((url) => {
            if (url === '/api/auth/status') return DUAL_STATUS;
            if (url === '/api/auth/login') return { ok: true };
            throw new Error(`unexpected fetch ${url}`);
        });
        await expect(bootstrapAccessAuth()).resolves.toEqual({ enabled: true });
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(__test__.getAccessState().selectedProtocol).toBe('v1');
        expect(localStorage.getItem(CREDENTIAL_KEY)).not.toBeNull();
    });

    it('signs in with a raw password and keeps the token in memory only', async () => {
        const fetchSpy = mockAuth((url) => {
            if (url === '/api/auth/status') return DUAL_STATUS;
            if (url === '/api/auth/v2/login')
                return { ...BUNDLE, token: 'jwt-fresh' };
            if (url === '/api/auth/login')
                throw new Error('v1 login must not run for a v2 sign-in');
            return undefined;
        });
        void bootstrapAccessAuth();
        await vi.waitFor(() =>
            expect(document.querySelector('.access-auth-overlay')).toBeTruthy(),
        );
        submitOverlay('password123');
        await vi.waitFor(() =>
            expect(__test__.getAccessState().accessToken).toBe('jwt-fresh'),
        );
        const loginCall = fetchSpy.mock.calls.find(
            ([url]) => url === '/api/auth/v2/login',
        );
        expect(JSON.parse(loginCall[1].body)).toEqual({
            password: 'password123',
        });
        expect(loginCall[1].headers['X-Phi-Auth']).toBe('v2');
        expect(loginCall[1].credentials).toBe('same-origin');
        // The access token is memory-only: no browser storage holds it.
        expect(localStorage.getItem(LEGACY_BEARER_KEY)).toBeNull();
        expect(Object.keys(localStorage)).toEqual([]);
        expect(document.querySelector('.access-auth-overlay')).toBeNull();
    });

    it('never downgrades to v1 when a v2 sign-in fails', async () => {
        const fetchSpy = mockAuth((url) => {
            if (url === '/api/auth/status') return DUAL_STATUS;
            if (url === '/api/auth/v2/login') return { ok: false, status: 401 };
            if (url === '/api/auth/login')
                throw new Error('v1 login must not run');
            return undefined;
        });
        void bootstrapAccessAuth();
        await vi.waitFor(() =>
            expect(document.querySelector('.access-auth-overlay')).toBeTruthy(),
        );
        submitOverlay('wrong-password');
        await vi.waitFor(() =>
            expect(
                document.querySelector('.access-auth-error').textContent,
            ).toBe('Wrong password'),
        );
        expect(
            fetchSpy.mock.calls.some(([url]) => url === '/api/auth/login'),
        ).toBe(false);
    });

    it('rejects an unusable capability response instead of downgrading', async () => {
        mockAuth(() => ({
            enabled: true,
            authenticated: false,
            protocols: [],
        }));
        await expect(bootstrapAccessAuth()).rejects.toThrow(
            'Phi returned invalid access protection settings',
        );
    });

    it('ignores unknown protocols only beside a supported one', async () => {
        mockAuth(() => ({
            enabled: false,
            protocols: ['v3', 'v2', 'v1'],
        }));
        await expect(bootstrapAccessAuth()).resolves.toEqual({
            enabled: false,
        });
        expect(__test__.getAccessState().selectedProtocol).toBe('v2');
    });
});

describe('protected fetch wrapper', () => {
    async function bootstrapWithBearer(token = 'jwt-a') {
        installToken(token);
        mockAuth((url) => {
            if (url === '/api/auth/status') return DUAL_STATUS;
            if (url === '/api/auth/v2/status') {
                return { enabled: true, authenticated: true };
            }
            return undefined;
        });
        await bootstrapAccessAuth();
        expect(__test__.getAccessState().accessToken).toBe(token);
    }

    it('attaches the bearer only to same-origin protected api paths', async () => {
        await bootstrapWithBearer();
        const seen = [];
        mockAuth((url, options) => {
            seen.push([url, options?.headers?.get?.('Authorization') ?? null]);
            return { ok: true };
        });
        installAccessFetch();
        await fetch('/api/coders');
        await fetch('/api/auth/v2/status');
        await fetch('/api/sync/messages');
        await fetch('/api/sync/messages/key');
        await fetch('https://elsewhere.example/api/coders');
        await fetch('/healthz');
        expect(seen).toEqual([
            ['/api/coders', 'Bearer jwt-a'],
            ['/api/auth/v2/status', null],
            ['/api/sync/messages', null],
            ['/api/sync/messages/key', null],
            ['https://elsewhere.example/api/coders', null],
            ['/healthz', null],
        ]);
    });

    it('preserves caller options and caller Authorization', async () => {
        await bootstrapWithBearer();
        const controller = new AbortController();
        const seen = [];
        mockAuth((url, options) => {
            seen.push([url, options]);
            return { ok: true };
        });
        installAccessFetch();
        await fetch('/api/coders', {
            method: 'POST',
            body: 'payload',
            cache: 'no-store',
            credentials: 'include',
            signal: controller.signal,
        });
        await fetch('/api/coders', { headers: { Authorization: '' } });
        const [first] = seen[0];
        expect(first).toBe('/api/coders');
        expect(seen[0][1].method).toBe('POST');
        expect(seen[0][1].body).toBe('payload');
        expect(seen[0][1].cache).toBe('no-store');
        expect(seen[0][1].credentials).toBe('include');
        expect(seen[0][1].signal).toBe(controller.signal);
        expect(seen[0][1].headers.get('Authorization')).toBe('Bearer jwt-a');
        expect(new Headers(seen[1][1].headers).get('Authorization')).toBe('');
    });

    it('clears a rejected token, coalesces one overlay, and reloads once', async () => {
        await bootstrapWithBearer('jwt-a');
        const reload = vi.fn();
        __test__.setReload(reload);
        const fetchSpy = mockAuth((url) => {
            if (url === '/api/one' || url === '/api/two')
                return { ok: false, status: 401 };
            if (url === '/api/auth/v2/login')
                return { ...BUNDLE, token: 'jwt-b' };
            return { ok: true };
        });
        installAccessFetch();
        const results = await Promise.all([
            fetch('/api/one'),
            fetch('/api/two'),
        ]);
        expect(results.map((r) => r.status)).toEqual([401, 401]);
        expect(document.querySelectorAll('.access-auth-overlay')).toHaveLength(
            1,
        );
        submitOverlay('password123');
        await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
        expect(__test__.getAccessState().accessToken).toBe('jwt-b');
        expect(localStorage.getItem(LEGACY_BEARER_KEY)).toBeNull();
        // The failed requests were never replayed.
        expect(
            fetchSpy.mock.calls.filter(([url]) => url === '/api/one'),
        ).toHaveLength(1);
        expect(
            fetchSpy.mock.calls.filter(([url]) => url === '/api/two'),
        ).toHaveLength(1);
    });

    it('does not let a delayed failure for token A clear token B', async () => {
        await bootstrapWithBearer('jwt-a');
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        mockAuth((url) => {
            if (url === '/api/slow')
                return gate.then(() => ({ ok: false, status: 401 }));
            if (url === '/api/auth/v2/password')
                return { ...BUNDLE, token: 'jwt-b' };
            return { ok: true };
        });
        installAccessFetch();
        const slow = fetch('/api/slow');
        await setAccessPassword('password123');
        expect(__test__.getAccessState().accessToken).toBe('jwt-b');
        release();
        await slow;
        expect(__test__.getAccessState().accessToken).toBe('jwt-b');
        expect(localStorage.getItem(LEGACY_BEARER_KEY)).toBeNull();
    });
});

describe('v2 password route', () => {
    it('posts the raw password with the current bearer', async () => {
        installToken('jwt-a');
        mockAuth((url) => {
            if (url === '/api/auth/status') return DUAL_STATUS;
            if (url === '/api/auth/v2/status')
                return { enabled: true, authenticated: true };
            if (url === '/api/auth/v2/password')
                return { ...BUNDLE, enabled: true, token: 'jwt-b' };
            return undefined;
        });
        await bootstrapAccessAuth();
        const fetchSpy = mockAuth((url, options) => {
            if (url === '/api/auth/v2/password')
                return { ...BUNDLE, token: 'jwt-b' };
            return undefined;
        });
        await expect(setAccessPassword('password123')).resolves.toEqual({
            enabled: true,
        });
        const [, options] = fetchSpy.mock.calls[0];
        expect(fetchSpy.mock.calls[0][0]).toBe('/api/auth/v2/password');
        expect(options.headers.Authorization).toBe('Bearer jwt-a');
        expect(options.headers['X-Phi-Auth']).toBe('v2');
        expect(options.credentials).toBe('same-origin');
        expect(JSON.parse(options.body)).toEqual({ password: 'password123' });
        expect(__test__.getAccessState().accessToken).toBe('jwt-b');
        expect(localStorage.getItem(LEGACY_BEARER_KEY)).toBeNull();
    });

    it('enables a dual server without a bearer', async () => {
        mockAuth(() => ({ enabled: false, protocols: ['v1', 'v2'] }));
        await bootstrapAccessAuth();
        const fetchSpy = mockAuth(() => ({
            ...BUNDLE,
            enabled: true,
            token: 'jwt-new',
        }));
        await setAccessPassword('password123');
        const [, options] = fetchSpy.mock.calls[0];
        expect(fetchSpy.mock.calls[0][0]).toBe('/api/auth/v2/password');
        expect(options.headers.Authorization).toBeUndefined();
        expect(options.headers['X-Phi-Auth']).toBe('v2');
        expect(JSON.parse(options.body)).toEqual({ password: 'password123' });
    });

    it('keeps the v1 hash route for a v1-only server', async () => {
        mockAuth(() => ({ enabled: false }));
        await bootstrapAccessAuth();
        vi.stubGlobal('crypto', {
            getRandomValues(bytes) {
                bytes.fill(23);
                return bytes;
            },
        });
        const fetchSpy = mockAuth(() => ({ enabled: true }));
        await setAccessPassword('password123');
        expect(fetchSpy.mock.calls[0][0]).toBe('/api/auth/password');
        expect(
            JSON.parse(fetchSpy.mock.calls[0][1].body).password_hash,
        ).toMatch(/^v1\.pbkdf2-sha256\./);
    });

    it('rejects a v2 password outside the byte bounds', async () => {
        mockAuth(() => ({ enabled: false, protocols: ['v1', 'v2'] }));
        await bootstrapAccessAuth();
        const fetchSpy = mockAuth(() => ({
            ...BUNDLE,
            enabled: true,
            token: 'jwt-new',
        }));
        await expect(setAccessPassword('short')).rejects.toThrow('at least 8');
        await expect(setAccessPassword('é'.repeat(600))).rejects.toThrow(
            'at most 1024 bytes',
        );
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

describe('host bridge', () => {
    it('installs a memory-only token and never touches storage', async () => {
        const { installToken, getAccessToken } = await import('../web/auth.js');
        expect(installToken('')).toBe(false);
        expect(installToken(null)).toBe(false);
        expect(installToken('host-token')).toBe(true);
        expect(getAccessToken()).toBe('host-token');
        expect(__test__.getAccessState().selectedProtocol).toBe('v2');
        expect(localStorage.getItem(BEARER_KEY)).toBeNull();
        expect(window.phiAccessAuth.installToken).toBe(installToken);
        expect(window.phiAccessAuth.getAccessToken).toBe(getAccessToken);
    });

    it('releases a pending unlock overlay', async () => {
        mockAuth((url) => {
            if (url === '/api/auth/status') return DUAL_STATUS;
            return undefined;
        });
        const boot = bootstrapAccessAuth();
        await vi.waitFor(() =>
            expect(document.querySelector('.access-auth-overlay')).toBeTruthy(),
        );
        const { installToken } = await import('../web/auth.js');
        installToken('host-token');
        await expect(boot).resolves.toEqual({ enabled: true });
        expect(document.querySelector('.access-auth-overlay')).toBeNull();
        expect(__test__.getAccessState().accessToken).toBe('host-token');
    });

    it('is not overwritten by a late legacy discovery', async () => {
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const fetchSpy = mockAuth((url) => {
            if (url === '/api/auth/status')
                return gate.then(() => ({
                    ...DUAL_STATUS,
                    authenticated: true,
                }));
            throw new Error(`unexpected fetch ${url}`);
        });
        const boot = bootstrapAccessAuth();
        await Promise.resolve();
        const { installToken } = await import('../web/auth.js');
        expect(installToken('host-token')).toBe(true);
        release();
        await expect(boot).resolves.toEqual({ enabled: true });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const state = __test__.getAccessState();
        expect(state.accessToken).toBe('host-token');
        expect(state.selectedProtocol).toBe('v2');
        expect(localStorage.getItem(BEARER_KEY)).toBeNull();
        expect(document.querySelector('.access-auth-overlay')).toBeNull();
    });

    it('releases bootstrap when a host token lands mid-discovery', async () => {
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        mockAuth((url) => {
            if (url === '/api/auth/status') return gate.then(() => DUAL_STATUS);
            throw new Error(`unexpected fetch ${url}`);
        });
        const boot = bootstrapAccessAuth();
        await Promise.resolve();
        const { installToken } = await import('../web/auth.js');
        expect(installToken('host-token')).toBe(true);
        // The discovery request is still pending: bootstrap must not wait for
        // its 30-second deadline before starting the app.
        await expect(boot).resolves.toEqual({ enabled: true });
        expect(__test__.getAccessState().accessToken).toBe('host-token');
        release();
    });
});

describe('webSocketURL bridge', () => {
    it('appends one encoded token and preserves existing parameters', async () => {
        const { installToken, webSocketURL } = await import('../web/auth.js');
        installToken('jwt a/b');
        const input = new URL('ws://localhost:3000/ws/pane/p1?state=ansi-v1');
        const result = webSocketURL(input);
        expect(result).not.toBe(input);
        expect(input.searchParams.get('token')).toBeNull();
        expect(result.searchParams.get('token')).toBe('jwt a/b');
        expect(result.searchParams.get('state')).toBe('ansi-v1');
        expect(result.href).not.toContain('jwt a/b');
    });

    it('leaves v1 URLs cookie-only', async () => {
        const { webSocketURL } = await import('../web/auth.js');
        const input = new URL('ws://localhost:3000/ws/pane/p1?state=ansi-v1');
        const result = webSocketURL(input);
        expect(result.href).toBe(input.href);
        expect(result.searchParams.get('token')).toBeNull();
    });

    it('never sends the token to a foreign origin', async () => {
        const { installToken, webSocketURL } = await import('../web/auth.js');
        installToken('jwt-a');
        const foreign = new URL('wss://elsewhere.example/ws/pane/p1');
        expect(webSocketURL(foreign).searchParams.get('token')).toBeNull();
        // Normalized wss/https comparison accepts the page's own origin.
        const sameOrigin = new URL('ws://localhost:3000/ws/control');
        expect(webSocketURL(sameOrigin).searchParams.get('token')).toBe(
            'jwt-a',
        );
    });
});

describe('superseded responses and transient failures', () => {
    function seedVerifier() {
        localStorage.setItem(
            CREDENTIAL_KEY,
            JSON.stringify({
                version: DUAL_STATUS.version,
                algorithm: DUAL_STATUS.algorithm,
                iterations: DUAL_STATUS.iterations,
                salt: DUAL_STATUS.salt,
                verifier: __test__.bytesToBase64URL(new Uint8Array(32).fill(7)),
            }),
        );
    }

    it('keeps the v2 selection after a stored token is rejected', async () => {
        installToken('jwt-stale');
        mockAuth((url) => {
            if (url === '/api/auth/status') return DUAL_STATUS;
            if (url === '/api/auth/v2/status')
                return { enabled: true, authenticated: false };
            return undefined;
        });
        void bootstrapAccessAuth();
        await vi.waitFor(() =>
            expect(document.querySelector('.access-auth-overlay')).toBeTruthy(),
        );
        const state = __test__.getAccessState();
        expect(state.accessToken).toBeNull();
        expect(state.selectedProtocol).toBe('v2');
    });

    it('rejects a non-200 discovery response instead of selecting', async () => {
        mockAuth(() => ({
            status: 201,
            enabled: false,
            protocols: ['v1', 'v2'],
        }));
        await expect(bootstrapAccessAuth()).rejects.toThrow(
            'Unable to check Phi access protection',
        );
        expect(__test__.getAccessState().selectedProtocol).toBeNull();
    });

    it('treats a transient saved-v1 login as an error, not a prompt', async () => {
        seedVerifier();
        mockAuth((url) => {
            if (url === '/api/auth/status') return DUAL_STATUS;
            if (url === '/api/auth/login') return { ok: false, status: 429 };
            return undefined;
        });
        await expect(bootstrapAccessAuth()).rejects.toThrow(
            'Unable to check Phi access protection',
        );
        expect(document.querySelector('.access-auth-overlay')).toBeNull();
        expect(localStorage.getItem(CREDENTIAL_KEY)).not.toBeNull();
        // The preference is fixed, but nothing prompts or downgrades.
        expect(__test__.getAccessState().selectedProtocol).toBe('v2');
    });

    it('prompts for the preferred protocol when the saved v1 verifier is rejected', async () => {
        seedVerifier();
        mockAuth((url) => {
            if (url === '/api/auth/status') return DUAL_STATUS;
            if (url === '/api/auth/login') return { ok: false, status: 401 };
            return undefined;
        });
        void bootstrapAccessAuth();
        await vi.waitFor(() =>
            expect(document.querySelector('.access-auth-overlay')).toBeTruthy(),
        );
        expect(__test__.getAccessState().selectedProtocol).toBe('v2');
    });

    it('does not let a late login response overwrite a host token', async () => {
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        mockAuth((url) => {
            if (url === '/api/auth/status') return DUAL_STATUS;
            if (url === '/api/auth/v2/login')
                return gate.then(() => ({ ...BUNDLE, token: 'stale-token' }));
            return undefined;
        });
        const boot = bootstrapAccessAuth();
        await vi.waitFor(() =>
            expect(document.querySelector('.access-auth-overlay')).toBeTruthy(),
        );
        const overlay = submitOverlay('password123');
        const submit = overlay.querySelector('button');
        await vi.waitFor(() => expect(submit.textContent).toBe('Signing in…'));
        const { installToken } = await import('../web/auth.js');
        installToken('host-token');
        release();
        // Wait for the stale handler to leave its finally block, so the
        // assertions below cannot run before the released response is fenced.
        await vi.waitFor(() => expect(submit.textContent).toBe('Sign in'));
        await expect(boot).resolves.toEqual({ enabled: true });
        const state = __test__.getAccessState();
        expect(state.accessToken).toBe('host-token');
        expect(state.selectedProtocol).toBe('v2');
        expect(localStorage.getItem(LEGACY_BEARER_KEY)).toBeNull();
    });

    it('keeps a host session out of storage after a password change', async () => {
        const { installToken } = await import('../web/auth.js');
        installToken('host-token');
        mockAuth((url) => {
            if (url === '/api/auth/v2/password')
                return { ...BUNDLE, token: 'replacement-token' };
            return undefined;
        });
        await expect(setAccessPassword('password123')).resolves.toEqual({
            enabled: true,
        });
        expect(__test__.getAccessState().accessToken).toBe('replacement-token');
        expect(localStorage.getItem(LEGACY_BEARER_KEY)).toBeNull();
    });

    it('keeps a host session out of storage after reauthentication', async () => {
        const { installToken } = await import('../web/auth.js');
        installToken('host-token');
        mockAuth((url) => {
            if (url === '/api/protected') return { ok: false, status: 401 };
            if (url === '/api/auth/v2/login')
                return { ...BUNDLE, token: 'replacement-token' };
            return { ok: true };
        });
        installAccessFetch();
        await fetch('/api/protected');
        await vi.waitFor(() =>
            expect(document.querySelector('.access-auth-overlay')).toBeTruthy(),
        );
        submitOverlay('password123');
        await vi.waitFor(() =>
            expect(__test__.getAccessState().accessToken).toBe(
                'replacement-token',
            ),
        );
        expect(localStorage.getItem(LEGACY_BEARER_KEY)).toBeNull();
    });
});

describe('credential ownership and superseded derivations', () => {
    it('keeps a host session memory-only across clear and re-enable', async () => {
        const { installToken } = await import('../web/auth.js');
        installToken('host-token');
        let calls = 0;
        mockAuth((url) => {
            if (url !== '/api/auth/v2/password') return undefined;
            calls += 1;
            return calls === 1
                ? { enabled: false }
                : { ...BUNDLE, token: 'replacement-token' };
        });
        await expect(clearAccessPassword()).resolves.toEqual({
            enabled: false,
        });
        await expect(setAccessPassword('password123')).resolves.toEqual({
            enabled: true,
        });
        expect(__test__.getAccessState().accessToken).toBe('replacement-token');
        expect(localStorage.getItem(LEGACY_BEARER_KEY)).toBeNull();
    });

    it('does not post a v1 record after a superseding install', async () => {
        mockAuth(() => ({ enabled: false }));
        await bootstrapAccessAuth();
        let release;
        globalThis.__pbkdf2Gate = new Promise((resolve) => {
            release = resolve;
        });
        try {
            const change = setAccessPassword('password123');
            await Promise.resolve();
            const { installToken } = await import('../web/auth.js');
            installToken('host-token');
            release();
            await expect(change).rejects.toThrow('Phi access changed');
        } finally {
            delete globalThis.__pbkdf2Gate;
        }
        expect(__test__.getAccessState().accessToken).toBe('host-token');
    });

    it('keeps a replacement token when the old token is rejected mid-change', async () => {
        installToken('jwt-a');
        mockAuth((url) => {
            if (url === '/api/auth/status') return DUAL_STATUS;
            if (url === '/api/auth/v2/status')
                return { enabled: true, authenticated: true };
            return undefined;
        });
        await bootstrapAccessAuth();
        expect(__test__.getAccessState().accessToken).toBe('jwt-a');
        const reload = vi.fn();
        __test__.setReload(reload);
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const fetchSpy = mockAuth((url) => {
            if (url === '/api/auth/v2/password')
                return gate.then(() => ({ ...BUNDLE, token: 'jwt-b' }));
            if (url === '/api/protected') return { ok: false, status: 401 };
            return { ok: true };
        });
        installAccessFetch();
        const change = setAccessPassword('password123');
        await vi.waitFor(() =>
            expect(
                fetchSpy.mock.calls.some(
                    ([url]) => url === '/api/auth/v2/password',
                ),
            ).toBe(true),
        );
        await fetch('/api/protected');
        await vi.waitFor(() =>
            expect(document.querySelector('.access-auth-overlay')).toBeTruthy(),
        );
        release();
        await expect(change).resolves.toEqual({ enabled: true });
        await vi.waitFor(() =>
            expect(__test__.getAccessState().accessToken).toBe('jwt-b'),
        );
        // The replacement resolves the now-redundant prompt and reloads once.
        expect(document.querySelector('.access-auth-overlay')).toBeNull();
        await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    });

    it('keeps an existing v1 selection through a transient re-bootstrap', async () => {
        mockAuth((url) => {
            if (url === '/api/auth/status')
                return { ...DUAL_STATUS, authenticated: true };
            return undefined;
        });
        await expect(bootstrapAccessAuth()).resolves.toEqual({ enabled: true });
        expect(__test__.getAccessState().selectedProtocol).toBe('v1');

        localStorage.setItem(
            CREDENTIAL_KEY,
            JSON.stringify({
                version: DUAL_STATUS.version,
                algorithm: DUAL_STATUS.algorithm,
                iterations: DUAL_STATUS.iterations,
                salt: DUAL_STATUS.salt,
                verifier: __test__.bytesToBase64URL(new Uint8Array(32).fill(7)),
            }),
        );
        mockAuth((url) => {
            if (url === '/api/auth/status') return DUAL_STATUS;
            if (url === '/api/auth/login') return { ok: false, status: 429 };
            return undefined;
        });
        await expect(bootstrapAccessAuth()).rejects.toThrow(
            'Unable to check Phi access protection',
        );
        expect(__test__.getAccessState().selectedProtocol).toBe('v1');
        expect(document.querySelector('.access-auth-overlay')).toBeNull();
    });
});

describe('request deadlines and credential retention', () => {
    it('gives up on a discovery request that never answers', async () => {
        vi.useFakeTimers();
        try {
            mockAuth(() => new Promise(() => {}));
            const boot = bootstrapAccessAuth();
            const failure = expect(boot).rejects.toThrow(
                'Phi did not respond. Try again.',
            );
            await vi.advanceTimersByTimeAsync(30000);
            await failure;
            expect(__test__.getAccessState().selectedProtocol).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('reports a sign-in that never answers and stays open for a retry', async () => {
        vi.useFakeTimers();
        try {
            mockAuth((url) => {
                if (url === '/api/auth/status') return DUAL_STATUS;
                if (url === '/api/auth/v2/login') return new Promise(() => {});
                return undefined;
            });
            void bootstrapAccessAuth();
            await vi.advanceTimersByTimeAsync(0);
            const overlay = submitOverlay('password123');
            await vi.advanceTimersByTimeAsync(30000);
            expect(
                overlay.querySelector('.access-auth-error').textContent,
            ).toBe('Phi did not respond. Try again.');
            expect(overlay.querySelector('button').disabled).toBe(false);
            expect(__test__.getAccessState().accessToken).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('never follows a redirect on a module-owned auth request', async () => {
        installToken('jwt-a');
        const fetchSpy = mockAuth((url) =>
            url === '/api/auth/v2/password'
                ? { ...BUNDLE, token: 'jwt-b' }
                : undefined,
        );
        await setAccessPassword('password123');
        const [url, options] = fetchSpy.mock.calls[0];
        expect(url).toBe('/api/auth/v2/password');
        expect(options.redirect).toBe('error');
        expect(options.signal).toBeInstanceOf(AbortSignal);
    });

    it('keeps the live token when the clear response is not a clear', async () => {
        installToken('jwt-a');
        mockAuth(() => ({ ...BUNDLE, enabled: true, token: 'jwt-b' }));
        await expect(clearAccessPassword()).rejects.toThrow(
            'Unable to clear access password',
        );
        const state = __test__.getAccessState();
        expect(state.accessToken).toBe('jwt-a');
        expect(state.accessEnabled).toBe(true);
    });

    it('discards the superseded stored bearer without ever sending it', async () => {
        localStorage.setItem(LEGACY_BEARER_KEY, 'legacy-jwt');
        const fetchSpy = mockAuth((url) => {
            if (url === '/api/auth/status') return DUAL_STATUS;
            return undefined;
        });
        void bootstrapAccessAuth();
        await vi.waitFor(() =>
            expect(document.querySelector('.access-auth-overlay')).toBeTruthy(),
        );
        // The superseded key is removed, and no request ever carried it.
        expect(localStorage.getItem(LEGACY_BEARER_KEY)).toBeNull();
        expect(__test__.getAccessState().accessToken).toBeNull();
        expect(
            fetchSpy.mock.calls.some(([, options]) =>
                JSON.stringify(options || {}).includes('legacy-jwt'),
            ),
        ).toBe(false);
    });

    it('never writes a token to browser storage, host-owned or not', async () => {
        installToken('host-token');
        mockAuth((url) =>
            url === '/api/auth/v2/password'
                ? { ...BUNDLE, token: 'replacement-token' }
                : undefined,
        );
        await expect(setAccessPassword('password123')).resolves.toEqual({
            enabled: true,
        });
        expect(__test__.getAccessState().accessToken).toBe('replacement-token');
        expect(Object.keys(localStorage)).toEqual([]);
    });
});

describe('refresh-cookie bootstrap', () => {
    it('installs a v2 session from the refresh cookie after a reload', async () => {
        const fetchSpy = mockAuth((url) => {
            if (url === '/api/auth/status')
                return { ...DUAL_STATUS, authenticated: false };
            if (url === '/api/auth/v2/refresh')
                return { ...BUNDLE, token: 'jwt-refreshed' };
            return undefined;
        });
        await expect(bootstrapAccessAuth()).resolves.toEqual({
            enabled: true,
        });
        const state = __test__.getAccessState();
        expect(state.selectedProtocol).toBe('v2');
        expect(state.accessToken).toBe('jwt-refreshed');
        expect(document.querySelector('.access-auth-overlay')).toBeNull();
        // Never v1: a refresh-cookie session has no verifier and no login.
        expect(
            fetchSpy.mock.calls.some(([url]) => url === '/api/auth/login'),
        ).toBe(false);
        const refreshCall = fetchSpy.mock.calls.find(
            ([url]) => url === '/api/auth/v2/refresh',
        );
        expect(refreshCall[1].method).toBe('POST');
        expect(refreshCall[1].body).toBe('{}');
        expect(refreshCall[1].headers['X-Phi-Auth']).toBe('v2');
        expect(refreshCall[1].credentials).toBe('same-origin');
    });

    it('keeps a selected v2 session and prompts v2 when the refresh is rejected', async () => {
        // A selected v2 session never falls back to a working v1 cookie.
        mockAuth((url) => {
            if (url === '/api/auth/status')
                return { ...DUAL_STATUS, authenticated: false };
            if (url === '/api/auth/v2/refresh') return { ...BUNDLE };
            return undefined;
        });
        await expect(bootstrapAccessAuth()).resolves.toEqual({ enabled: true });
        expect(__test__.getAccessState().selectedProtocol).toBe('v2');
        // Drop the token the way a page loses it: a confirmed logout keeps the
        // v2 selection and leaves no in-memory credential behind.
        mockAuth((url) =>
            url === '/api/auth/v2/logout' ? { json: { ok: true } } : undefined,
        );
        await logoutAccess();
        expect(__test__.getAccessState().accessToken).toBeNull();
        expect(__test__.getAccessState().selectedProtocol).toBe('v2');

        const fetchSpy = mockAuth((url) => {
            if (url === '/api/auth/status')
                return { ...DUAL_STATUS, authenticated: true };
            if (url === '/api/auth/v2/refresh')
                return { ok: false, status: 401 };
            return undefined;
        });
        void bootstrapAccessAuth();
        await vi.waitFor(() =>
            expect(document.querySelector('.access-auth-overlay')).toBeTruthy(),
        );
        expect(__test__.getAccessState().selectedProtocol).toBe('v2');
        expect(
            fetchSpy.mock.calls.some(([url]) => url === '/api/auth/login'),
        ).toBe(false);
    });

    it('retries rather than downgrading when the refresh fails transiently', async () => {
        mockAuth((url) => {
            if (url === '/api/auth/status') return DUAL_STATUS;
            if (url === '/api/auth/v2/refresh')
                return { ok: false, status: 503 };
            return undefined;
        });
        await expect(bootstrapAccessAuth()).rejects.toThrow(
            'Unable to refresh access session',
        );
        expect(__test__.getAccessState().selectedProtocol).toBe('v2');
        expect(document.querySelector('.access-auth-overlay')).toBeNull();
    });

    it('does not install a malformed bundle', async () => {
        mockAuth((url) => {
            if (url === '/api/auth/status') return DUAL_STATUS;
            if (url === '/api/auth/v2/refresh')
                return { token: 'jwt-no-deadlines' };
            return undefined;
        });
        await expect(bootstrapAccessAuth()).rejects.toThrow(
            'Phi returned invalid access protection settings',
        );
        expect(__test__.getAccessState().accessToken).toBeNull();
        expect(document.querySelector('.access-auth-overlay')).toBeNull();
    });

    it('coalesces simultaneous refreshes into one request', async () => {
        const fetchSpy = mockAuth((url) =>
            url === '/api/auth/v2/refresh'
                ? { ...BUNDLE, token: 'jwt-once' }
                : undefined,
        );
        const [first, second] = await Promise.all([
            __test__.refreshSession(),
            __test__.refreshSession(),
        ]);
        expect(first).toBe('installed');
        expect(second).toBe('installed');
        expect(
            fetchSpy.mock.calls.filter(
                ([url]) => url === '/api/auth/v2/refresh',
            ),
        ).toHaveLength(1);
        expect(__test__.getAccessState().accessToken).toBe('jwt-once');
    });
});

describe('strict credential bundle shapes', () => {
    it('rejects a password response without the deadline fields', async () => {
        installToken('jwt-a');
        mockAuth((url) =>
            url === '/api/auth/v2/password'
                ? { enabled: true, token: 'jwt-b' }
                : undefined,
        );
        await expect(setAccessPassword('password123')).rejects.toThrow(
            'Unable to save access password',
        );
        expect(__test__.getAccessState().accessToken).toBe('jwt-a');
    });

    it('rejects a bundle whose absolute deadline precedes the idle one', async () => {
        mockAuth((url) => {
            if (url === '/api/auth/status') return DUAL_STATUS;
            if (url === '/api/auth/v2/refresh')
                return {
                    ...BUNDLE,
                    refresh_idle_expires_at: 1807000000,
                    refresh_absolute_expires_at: 1802000000,
                };
            return undefined;
        });
        await expect(bootstrapAccessAuth()).rejects.toThrow(
            'Phi returned invalid access protection settings',
        );
        expect(__test__.getAccessState().accessToken).toBeNull();
    });

    it('rejects a login response that is not a credential bundle', async () => {
        mockAuth((url) => {
            if (url === '/api/auth/status') return DUAL_STATUS;
            if (url === '/api/auth/v2/login') return { token: 'jwt-only' };
            return undefined;
        });
        void bootstrapAccessAuth();
        await vi.waitFor(() =>
            expect(document.querySelector('.access-auth-overlay')).toBeTruthy(),
        );
        submitOverlay('password123');
        await vi.waitFor(() =>
            expect(
                document.querySelector('.access-auth-error').textContent,
            ).toBe('Unable to sign in'),
        );
        expect(__test__.getAccessState().accessToken).toBeNull();
    });
});

describe('logout', () => {
    it('revokes the family and drops the in-memory credential', async () => {
        installToken('jwt-a');
        const fetchSpy = mockAuth((url) =>
            url === '/api/auth/v2/logout' ? { json: { ok: true } } : undefined,
        );
        await expect(logoutAccess()).resolves.toEqual({ ok: true });
        const [url, options] = fetchSpy.mock.calls[0];
        expect(url).toBe('/api/auth/v2/logout');
        expect(options.headers.Authorization).toBe('Bearer jwt-a');
        expect(options.headers['X-Phi-Auth']).toBe('v2');
        expect(options.credentials).toBe('same-origin');
        expect(JSON.parse(options.body)).toEqual({ all: false });
        expect(__test__.getAccessState().accessToken).toBeNull();
    });

    it('asks for every family when logout-all is requested', async () => {
        installToken('jwt-a');
        const fetchSpy = mockAuth(() => ({ json: { ok: true } }));
        await logoutAccess(true);
        expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
            all: true,
        });
    });

    it('keeps the credential when the server does not confirm', async () => {
        installToken('jwt-a');
        mockAuth(() => ({ ok: false, status: 500 }));
        await expect(logoutAccess()).rejects.toThrow('Unable to logout');
        expect(__test__.getAccessState().accessToken).toBe('jwt-a');
    });

    it('requires a live credential', async () => {
        await expect(logoutAccess()).rejects.toThrow('Sign in to continue');
    });
});

describe('protected request failure handling', () => {
    it('never treats an application 403 as an expired credential', async () => {
        installToken('jwt-a');
        const reload = vi.fn();
        __test__.setReload(reload);
        const fetchSpy = mockAuth((url) =>
            url === '/api/forbidden' ? { ok: false, status: 403 } : undefined,
        );
        installAccessFetch();
        const res = await fetch('/api/forbidden');
        expect(res.status).toBe(403);
        // The caller's own refusal reaches the caller: no overlay, no reload,
        // and no refresh attempt behind it.
        expect(document.querySelector('.access-auth-overlay')).toBeNull();
        expect(reload).not.toHaveBeenCalled();
        expect(refreshCalls(fetchSpy)).toHaveLength(0);
        expect(__test__.getAccessState().accessToken).toBe('jwt-a');
    });

    it('keeps the credential when a protected request fails with 429 or 500', async () => {
        installToken('jwt-a');
        mockAuth((url) =>
            url === '/api/limited'
                ? { ok: false, status: 429 }
                : { ok: false, status: 500 },
        );
        installAccessFetch();
        await fetch('/api/limited');
        await fetch('/api/other');
        expect(__test__.getAccessState().accessToken).toBe('jwt-a');
        expect(document.querySelector('.access-auth-overlay')).toBeNull();
    });
});

// --- refresh ownership ---------------------------------------------------

const nowSeconds = () => Math.floor(Date.now() / 1000);

// bundleFor builds a complete bundle whose access deadline is relative to now,
// so a renewal test can place it on either side of the 60-second lead.
function bundleFor(token, expiresIn = 3600) {
    const now = nowSeconds();
    return {
        enabled: true,
        token,
        expires_at: now + expiresIn,
        expires_in: expiresIn,
        refresh_idle_expires_at: now + 30 * 86400,
        refresh_absolute_expires_at: now + 90 * 86400,
    };
}

// startV2 bootstraps a browser session from the refresh cookie, which is how a
// non-host page obtains its in-memory token.
async function startV2(token, expiresIn = 3600) {
    mockAuth((url) => {
        if (url === '/api/auth/status') return DUAL_STATUS;
        if (url === '/api/auth/v2/refresh') return bundleFor(token, expiresIn);
        return undefined;
    });
    await expect(bootstrapAccessAuth()).resolves.toEqual({ enabled: true });
}

function refreshCalls(fetchSpy) {
    return fetchSpy.mock.calls.filter(
        ([url]) => String(url) === '/api/auth/v2/refresh',
    );
}

// shiftMonotonic moves only the monotonic clock forward, the way a suspended
// tab's timers lag behind it. It leaves Date alone, so a test that shifts one
// clock proves which one renewal actually reads.
function shiftMonotonic(ms) {
    const real = performance.now.bind(performance);
    const offset = ms;
    const spy = vi
        .spyOn(performance, 'now')
        .mockImplementation(() => real() + offset);
    return () => spy.mockRestore();
}

// siblingBundle builds the message another tab broadcasts after its own
// rotation: same family, so it is this session's newer credential.
function siblingBundle(token, expiresIn = 3600) {
    const bundle = bundleFor(token, expiresIn);
    return {
        kind: 'bundle',
        origin: location.origin,
        bundle: {
            token,
            expiresAt: bundle.expires_at,
            expiresIn: bundle.expires_in,
            refreshIdleExpiresAt: bundle.refresh_idle_expires_at,
            refreshAbsoluteExpiresAt: bundle.refresh_absolute_expires_at,
        },
    };
}

describe('receipt-relative renewal', () => {
    it('does not treat a fresh token as due when the wall clock runs ahead', async () => {
        await startV2('jwt-fresh', 3600);
        const fetchSpy = mockAuth(() => {
            throw new Error('no refresh expected');
        });
        // Two hours ahead: an absolute-deadline client would refresh at once.
        vi.useFakeTimers();
        try {
            vi.setSystemTime(Date.now() + 7200 * 1000);
            expect(__test__.refreshDue()).toBe(false);
            await __test__.renewIfDue();
            expect(refreshCalls(fetchSpy)).toHaveLength(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('still renews on time when the wall clock runs behind', async () => {
        vi.useFakeTimers();
        try {
            await startV2('jwt-behind', 3600);
            const fetchSpy = mockAuth((url) =>
                url === '/api/auth/v2/refresh'
                    ? bundleFor('jwt-renewed', 3600)
                    : undefined,
            );
            // Ten minutes behind perspective: the monotonic deadline is what
            // decides, so renewal still happens one minute before expiry.
            vi.setSystemTime(Date.now() - 600 * 1000);
            await vi.advanceTimersByTimeAsync((3600 - 61) * 1000);
            expect(refreshCalls(fetchSpy)).toHaveLength(0);
            await vi.advanceTimersByTimeAsync(2000);
            expect(refreshCalls(fetchSpy)).toHaveLength(1);
            expect(__test__.getAccessState().accessToken).toBe('jwt-renewed');
        } finally {
            vi.useRealTimers();
        }
    });

    it('arms renewal for a token obtained by a typed sign-in', async () => {
        vi.useFakeTimers();
        try {
            const fetchSpy = mockAuth((url) => {
                if (url === '/api/auth/status') return DUAL_STATUS;
                if (url === '/api/auth/v2/login') return bundleFor('jwt-typed', 3600);
                return undefined;
            });
            const boot = bootstrapAccessAuth();
            await vi.advanceTimersByTimeAsync(0);
            submitOverlay('correct horse battery staple');
            const result = await boot;
            expect(result).toEqual({ enabled: true });
            expect(__test__.getAccessState().accessToken).toBe('jwt-typed');
            expect(__test__.refreshDue()).toBe(false);
            const before = refreshCalls(fetchSpy).length;
            await vi.advanceTimersByTimeAsync((3600 - 61) * 1000);
            expect(refreshCalls(fetchSpy)).toHaveLength(before);
            // The renewal that was armed by the typed sign-in now runs.
            fetchSpy.mockImplementation(
                vi.fn(async (url) => {
                    if (String(url) === '/api/auth/v2/refresh')
                        return {
                            ok: true,
                            status: 200,
                            headers: { get: () => 'application/json' },
                            json: async () => bundleFor('jwt-renewed', 3600),
                        };
                    throw new Error(`unexpected fetch ${url}`);
                }),
            );
            await vi.advanceTimersByTimeAsync(2000);
            // A typed sign-in renews in the background like a cookie bootstrap.
            expect(refreshCalls(fetchSpy)).toHaveLength(before + 1);
            expect(__test__.getAccessState().accessToken).toBe('jwt-renewed');
        } finally {
            vi.useRealTimers();
        }
    });

    it('arms renewal for a token obtained by a password change', async () => {
        vi.useFakeTimers();
        try {
            await startV2('jwt-initial', 3600);
            const fetchSpy = mockAuth((url) => {
                if (url === '/api/auth/v2/password')
                    return bundleFor('jwt-after-change', 3600);
                if (url === '/api/auth/v2/refresh')
                    return bundleFor('jwt-renewed', 3600);
                return undefined;
            });
            await setAccessPassword('correct horse battery staple');
            expect(__test__.getAccessState().accessToken).toBe(
                'jwt-after-change',
            );
            expect(__test__.refreshDue()).toBe(false);
            const before = refreshCalls(fetchSpy).length;
            await vi.advanceTimersByTimeAsync((3600 - 61) * 1000);
            expect(refreshCalls(fetchSpy)).toHaveLength(before);
            await vi.advanceTimersByTimeAsync(2000);
            expect(refreshCalls(fetchSpy)).toHaveLength(before + 1);
            expect(__test__.getAccessState().accessToken).toBe('jwt-renewed');
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('refresh ownership', () => {
    it('renews in the background one minute before expiry', async () => {
        vi.useFakeTimers();
        try {
            const fetchSpy = mockAuth((url) => {
                if (url === '/api/auth/status') return DUAL_STATUS;
                if (url === '/api/auth/v2/refresh')
                    return bundleFor('jwt-renewed', 7200);
                return undefined;
            });
            // The first response is the bootstrap credential.
            fetchSpy.mockImplementationOnce(
                vi.fn(async () => ({
                    ok: true,
                    status: 200,
                    headers: { get: () => 'application/json' },
                    json: async () => ({ ...DUAL_STATUS, enabled: true }),
                    text: async () => '',
                })),
            );
            const boot = bootstrapAccessAuth();
            await vi.advanceTimersByTimeAsync(0);
            await boot;
            expect(__test__.getAccessState().accessToken).toBe('jwt-renewed');

            // Nothing is due yet: the renewal is scheduled, not immediate.
            expect(refreshCalls(fetchSpy)).toHaveLength(1);

            await vi.advanceTimersByTimeAsync((7200 - 61) * 1000);
            expect(refreshCalls(fetchSpy)).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(2000);
            expect(refreshCalls(fetchSpy)).toHaveLength(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('renews a stale token when the tab becomes visible again', async () => {
        await startV2('jwt-first', 3600);
        const fetchSpy = mockAuth((url) =>
            url === '/api/auth/v2/refresh'
                ? bundleFor('jwt-visible', 3600)
                : undefined,
        );
        // A hidden tab's timers are throttled: the monotonic clock moves on
        // without any scheduled callback having run.
        const restore = shiftMonotonic(3590 * 1000);
        try {
            document.dispatchEvent(new Event('visibilitychange'));
            await vi.waitFor(() =>
                expect(refreshCalls(fetchSpy)).toHaveLength(1),
            );
        } finally {
            restore();
        }
        expect(__test__.getAccessState().accessToken).toBe('jwt-visible');
    });

    it('does not renew a token that is not due', async () => {
        await startV2('jwt-fresh', 3600);
        const fetchSpy = mockFetch(() => {
            throw new Error('no request expected');
        });
        await __test__.renewIfDue();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(__test__.getAccessState().accessToken).toBe('jwt-fresh');
    });

    it('serializes renewals through the per-origin lock', async () => {
        await startV2('jwt-locked', 3600);
        const request = vi.fn(async (_name, run) => run());
        vi.stubGlobal('navigator', { locks: { request } });
        const fetchSpy = mockAuth((url) =>
            url === '/api/auth/v2/refresh'
                ? bundleFor('jwt-after-lock', 3600)
                : undefined,
        );
        await __test__.renewIfDue({ ifDue: false });
        expect(request).toHaveBeenCalledWith(
            `phi-access-refresh:${location.origin}`,
            expect.any(Function),
        );
        expect(refreshCalls(fetchSpy)).toHaveLength(1);
        expect(__test__.getAccessState().accessToken).toBe('jwt-after-lock');
    });

    it('skips the request when another tab refreshed while the lock was held', async () => {
        vi.useFakeTimers();
        try {
            await startV2('jwt-waiting', 3600);
            // Past the renewal lead, so this caller really is due.
            const restore = shiftMonotonic(3590 * 1000);
            try {
                const request = vi.fn(async (_name, run) => {
                    // The sibling tab's bundle lands before this caller runs.
                    __test__.receiveBundle(siblingBundle('jwt-sibling', 7200));
                    return run();
                });
                vi.stubGlobal('navigator', { locks: { request } });
                const fetchSpy = mockAuth(() => {
                    throw new Error('no refresh expected');
                });
                const renewal = __test__.renewIfDue({ ifDue: true });
                await vi.advanceTimersByTimeAsync(0);
                await renewal;
                expect(fetchSpy).not.toHaveBeenCalled();
                expect(__test__.getAccessState().accessToken).toBe(
                    'jwt-sibling',
                );
            } finally {
                restore();
            }
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not let a refresh queued behind the lock overwrite a host token', async () => {
        await startV2('jwt-browser', 3600);
        let grant;
        const request = vi.fn(
            (_name, run) =>
                new Promise((resolve) => {
                    grant = () => resolve(run());
                }),
        );
        vi.stubGlobal('navigator', { locks: { request } });
        const fetchSpy = mockAuth((url) =>
            url === '/api/auth/v2/refresh'
                ? bundleFor('jwt-stale-answer', 3600)
                : undefined,
        );
        const queued = __test__.refreshSession();
        // The host installs a newer credential while this attempt waits.
        installToken('jwt-host-newer');
        grant();
        await queued;
        // No request went out and the host token still owns the page.
        expect(refreshCalls(fetchSpy)).toHaveLength(0);
        const state = __test__.getAccessState();
        expect(state.accessToken).toBe('jwt-host-newer');
        expect(state.memoryOnly).toBe(true);
    });

    it('does not start a queued refresh after logout', async () => {
        await startV2('jwt-before-logout', 3600);
        let grant;
        vi.stubGlobal('navigator', {
            locks: {
                request: (_name, run) =>
                    new Promise((resolve) => {
                        grant = () => resolve(run());
                    }),
            },
        });
        const fetchSpy = mockAuth((url) => {
            if (url === '/api/auth/v2/logout') return { json: { ok: true } };
            if (url === '/api/auth/v2/refresh')
                return bundleFor('jwt-after-logout', 3600);
            return undefined;
        });
        const queued = __test__.refreshSession();
        await logoutAccess();
        grant();
        await queued;
        expect(refreshCalls(fetchSpy)).toHaveLength(0);
        expect(__test__.getAccessState().accessToken).toBeNull();
    });

    it('adopts a bundle broadcast by another tab without a request', async () => {
        await startV2('jwt-tab-a', 3600);
        const fetchSpy = mockFetch(() => {
            throw new Error('no request expected');
        });
        __test__.receiveBundle(siblingBundle('jwt-tab-b', 7200));
        expect(fetchSpy).not.toHaveBeenCalled();
        const state = __test__.getAccessState();
        expect(state.accessToken).toBe('jwt-tab-b');
        expect(state.memoryOnly).toBe(false);
        // The bundle never reaches storage.
        expect(localStorage.getItem(BEARER_KEY)).toBeNull();
        expect(localStorage.getItem(LEGACY_BEARER_KEY)).toBeNull();
    });

    it('ignores a bundle and a logout from another family after a new sign-in', async () => {
        await startV2('jwt-current', 3600);
        const stranger = bundleFor('jwt-other-family', 7200);
        __test__.receiveBundle({
            kind: 'bundle',
            origin: location.origin,
            bundle: {
                token: stranger.token,
                expiresAt: stranger.expires_at,
                expiresIn: stranger.expires_in,
                refreshIdleExpiresAt: stranger.refresh_idle_expires_at,
                // A different family: another login, not this one's rotation.
                refreshAbsoluteExpiresAt: 1,
            },
        });
        expect(__test__.getAccessState().accessToken).toBe('jwt-current');
        __test__.receiveLogout({
            kind: 'logout',
            origin: location.origin,
            family: 1,
        });
        const state = __test__.getAccessState();
        expect(state.accessToken).toBe('jwt-current');
        expect(state.loggedOut).toBe(false);
    });

    it('stays logged out when a delayed bundle arrives after logout', async () => {
        await startV2('jwt-session', 3600);
        mockAuth((url) =>
            url === '/api/auth/v2/logout' ? { json: { ok: true } } : undefined,
        );
        await logoutAccess();
        __test__.receiveBundle(siblingBundle('jwt-delayed', 7200));
        const state = __test__.getAccessState();
        expect(state.accessToken).toBeNull();
        expect(state.loggedOut).toBe(true);
    });

    it('ignores an older bundle and a foreign-origin bundle', async () => {
        await startV2('jwt-newer', 7200);
        const older = siblingBundle('jwt-older', 60);
        __test__.receiveBundle(older);
        const foreign = siblingBundle('jwt-foreign', 86400);
        __test__.receiveBundle({ ...foreign, origin: 'https://elsewhere.example' });
        expect(__test__.getAccessState().accessToken).toBe('jwt-newer');
    });

    it('keeps the credential and retries after a 500, with no prompt', async () => {
        vi.useFakeTimers();
        try {
            await startV2('jwt-kept', 3600);
            const fetchSpy = mockAuth(() => ({ ok: false, status: 500 }));
            const renewal = __test__.renewIfDue({ ifDue: false });
            await vi.advanceTimersByTimeAsync(0);
            await renewal;
            expect(__test__.getAccessState().accessToken).toBe('jwt-kept');
            expect(document.querySelector('.access-auth-overlay')).toBeNull();
            expect(refreshCalls(fetchSpy)).toHaveLength(1);

            // Bounded backoff retries without any user action.
            await vi.advanceTimersByTimeAsync(3000);
            expect(refreshCalls(fetchSpy)).toHaveLength(2);
            expect(__test__.getAccessState().accessToken).toBe('jwt-kept');
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps the credential and retries when the network is gone', async () => {
        vi.useFakeTimers();
        try {
            await startV2('jwt-offline', 3600);
            const fetchSpy = mockFetch(() => {
                throw new Error('network down');
            });
            const renewal = __test__.renewIfDue({ ifDue: false });
            await vi.advanceTimersByTimeAsync(0);
            await renewal;
            expect(__test__.getAccessState().accessToken).toBe('jwt-offline');
            expect(document.querySelector('.access-auth-overlay')).toBeNull();
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(3000);
            expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('honors Retry-After on a 429', async () => {
        vi.useFakeTimers();
        try {
            await startV2('jwt-429', 3600);
            const calls = [];
            vi.stubGlobal(
                'fetch',
                vi.fn(async (url) => {
                    calls.push(String(url));
                    return {
                        ok: false,
                        status: 429,
                        headers: {
                            get: (key) =>
                                String(key).toLowerCase() === 'retry-after'
                                    ? '30'
                                    : null,
                        },
                        json: async () => ({}),
                        text: async () => '',
                    };
                }),
            );
            const renewal = __test__.renewIfDue({ ifDue: false });
            await vi.advanceTimersByTimeAsync(0);
            await renewal;
            expect(calls).toHaveLength(1);
            // The server asked for 30 seconds; backoff must not undercut it.
            await vi.advanceTimersByTimeAsync(10000);
            expect(calls).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(21000);
            expect(calls.length).toBeGreaterThan(1);
            expect(__test__.getAccessState().accessToken).toBe('jwt-429');
        } finally {
            vi.useRealTimers();
        }
    });

    it('treats a refresh 401 as terminal and prompts once, staying on v2', async () => {
        await startV2('jwt-gone', 3600);
        const fetchSpy = mockAuth((url) => {
            if (url === '/api/auth/v2/refresh')
                return { ok: false, status: 401 };
            if (url === '/api/auth/login')
                throw new Error('v1 login must not run after a v2 401');
            return undefined;
        });
        await __test__.renewIfDue({ ifDue: false });
        expect(__test__.getAccessState().accessToken).toBeNull();
        expect(__test__.getAccessState().selectedProtocol).toBe('v2');
        expect(document.querySelectorAll('.access-auth-overlay')).toHaveLength(
            1,
        );
        expect(refreshCalls(fetchSpy)).toHaveLength(1);
    });

    it('never refreshes a host-installed token', async () => {
        installToken('jwt-host');
        const fetchSpy = mockAuth(() => {
            throw new Error('no request expected');
        });
        await __test__.renewIfDue();
        document.dispatchEvent(new Event('visibilitychange'));
        await Promise.resolve();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(__test__.getAccessState().accessToken).toBe('jwt-host');
    });
});

describe('stale-token recovery in the fetch wrapper', () => {
    it('refreshes once and retries an idempotent GET with the new token', async () => {
        await startV2('jwt-stale', 3600);
        const fetchSpy = mockAuth((url, options) => {
            const auth = options?.headers?.get?.('Authorization');
            if (url === '/api/auth/v2/refresh')
                return bundleFor('jwt-fresh', 3600);
            if (url === '/api/data')
                return auth === 'Bearer jwt-fresh'
                    ? { ok: true, status: 200, json: { ok: true } }
                    : { ok: false, status: 401 };
            return undefined;
        });
        installAccessFetch();
        const res = await fetch('/api/data');
        expect(res.status).toBe(200);
        const dataCalls = fetchSpy.mock.calls.filter(
            ([url]) => String(url) === '/api/data',
        );
        expect(dataCalls).toHaveLength(2);
        expect(refreshCalls(fetchSpy)).toHaveLength(1);
        expect(__test__.getAccessState().accessToken).toBe('jwt-fresh');
    });

    it('retries a HEAD request but never a mutation', async () => {
        await startV2('jwt-stale', 3600);
        const fetchSpy = mockAuth((url, options) => {
            const auth = options?.headers?.get?.('Authorization');
            if (url === '/api/auth/v2/refresh')
                return bundleFor('jwt-fresh', 3600);
            if (url === '/api/data')
                return auth === 'Bearer jwt-fresh'
                    ? { ok: true, status: 200, json: { ok: true } }
                    : { ok: false, status: 401 };
            return undefined;
        });
        installAccessFetch();
        const head = await fetch('/api/data', { method: 'HEAD' });
        expect(head.status).toBe(200);

        __test__.resetAccessState();
        await startV2('jwt-stale', 3600);
        const postSpy = mockAuth((url) => {
            if (url === '/api/auth/v2/refresh')
                return bundleFor('jwt-fresh', 3600);
            if (url === '/api/data') return { ok: false, status: 401 };
            return undefined;
        });
        installAccessFetch();
        const post = await fetch('/api/data', {
            method: 'POST',
            body: JSON.stringify({ name: 'x' }),
        });
        expect(post.status).toBe(401);
        expect(
            postSpy.mock.calls.filter(([url]) => String(url) === '/api/data'),
        ).toHaveLength(1);
        expect(fetchSpy).toBeTruthy();
        // The refreshed credential is installed; the caller resubmits.
        expect(__test__.getAccessState().accessToken).toBe('jwt-fresh');
    });

    it('prompts after the refresh behind a 401 is itself rejected', async () => {
        await startV2('jwt-stale', 3600);
        const fetchSpy = mockAuth((url) => {
            if (url === '/api/auth/v2/refresh')
                return { ok: false, status: 401 };
            if (url === '/api/data') return { ok: false, status: 401 };
            return undefined;
        });
        installAccessFetch();
        const res = await fetch('/api/data');
        expect(res.status).toBe(401);
        expect(
            fetchSpy.mock.calls.filter(([url]) => String(url) === '/api/data'),
        ).toHaveLength(1);
        await vi.waitFor(() =>
            expect(
                document.querySelectorAll('.access-auth-overlay'),
            ).toHaveLength(1),
        );
    });
});

describe('refreshAccessIfDue', () => {
    it('returns synchronously when no v2 credential exists', async () => {
        const { refreshAccessIfDue } = await import('../web/auth.js');
        // A v1 cookie/verifier session has nothing to renew: sockets must not
        // be deferred by a microtask on the strength of an empty promise.
        expect(refreshAccessIfDue()).toBeUndefined();
    });

    it('never renews a host-installed token', async () => {
        const { refreshAccessIfDue } = await import('../web/auth.js');
        const fetchSpy = mockAuth(() => ({ ok: true, status: 200 }));
        installToken('jwt-host');
        expect(refreshAccessIfDue()).toBeUndefined();
        expect(refreshCalls(fetchSpy)).toHaveLength(0);
    });

    it('skips a fresh browser token without a request', async () => {
        const { refreshAccessIfDue } = await import('../web/auth.js');
        let refreshCount = 0;
        mockAuth((url) => {
            if (url === '/api/auth/status') return DUAL_STATUS;
            if (url === '/api/auth/v2/refresh') {
                refreshCount += 1;
                return bundleFor('jwt-a', 3600);
            }
            return undefined;
        });
        await bootstrapAccessAuth();
        const before = refreshCount;
        expect(refreshAccessIfDue()).toBeUndefined();
        expect(refreshCount).toBe(before);
    });

    it('refreshes once when the token is inside the renewal lead', async () => {
        const { refreshAccessIfDue } = await import('../web/auth.js');
        let refreshCount = 0;
        mockAuth((url) => {
            if (url === '/api/auth/status') return DUAL_STATUS;
            if (url === '/api/auth/v2/refresh') {
                refreshCount += 1;
                // A 30-second access deadline is inside the 60-second lead.
                return refreshCount === 1
                    ? bundleFor('jwt-a', 30)
                    : bundleFor('jwt-renewed', 7200);
            }
            return undefined;
        });
        await bootstrapAccessAuth();
        const before = refreshCount;
        const pending = refreshAccessIfDue();
        // The scheduled owner may already have coalesced into this renewal, in
        // which case nothing is due any more and the call returns undefined.
        if (pending) await pending;
        expect(refreshCount).toBeLessThanOrEqual(before + 1);
        expect(__test__.getAccessState().accessToken).toBe('jwt-renewed');
    });
});
