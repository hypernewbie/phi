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

function storeBearer(token) {
    localStorage.setItem(BEARER_KEY, token);
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
        const fetchSpy = mockFetch(() => ({
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
        mockFetch(() => ({ enabled: false }));
        await expect(bootstrapAccessAuth()).resolves.toEqual({
            enabled: false,
        });
        expect(__test__.getAccessState().selectedProtocol).toBe('v1');
    });

    it('reuses a stored bearer the server still accepts', async () => {
        storeBearer('jwt-stored');
        const fetchSpy = mockFetch((url) => {
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
        storeBearer('jwt-stale');
        const fetchSpy = mockFetch((url) => {
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

    it('keeps a stored bearer when the token check fails transiently', async () => {
        storeBearer('jwt-stored');
        mockFetch((url) => {
            if (url === '/api/auth/status') return DUAL_STATUS;
            if (url === '/api/auth/v2/status')
                return { ok: false, status: 503 };
            return undefined;
        });
        await expect(bootstrapAccessAuth()).rejects.toThrow(
            'Unable to check Phi access protection',
        );
        expect(localStorage.getItem(BEARER_KEY)).toBe('jwt-stored');
    });

    it('keeps v1 when the cookie is still valid even though v2 is advertised', async () => {
        mockFetch(() => ({ ...DUAL_STATUS, authenticated: true }));
        await expect(bootstrapAccessAuth()).resolves.toEqual({ enabled: true });
        expect(__test__.getAccessState().selectedProtocol).toBe('v1');
        expect(document.querySelector('.access-auth-overlay')).toBeNull();
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
        const fetchSpy = mockFetch((url) => {
            if (url === '/api/auth/status') return DUAL_STATUS;
            if (url === '/api/auth/login') return { ok: true };
            throw new Error(`unexpected fetch ${url}`);
        });
        await expect(bootstrapAccessAuth()).resolves.toEqual({ enabled: true });
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(__test__.getAccessState().selectedProtocol).toBe('v1');
        expect(localStorage.getItem(CREDENTIAL_KEY)).not.toBeNull();
    });

    it('signs in with a raw password and persists the bearer', async () => {
        const fetchSpy = mockFetch((url) => {
            if (url === '/api/auth/status') return DUAL_STATUS;
            if (url === '/api/auth/v2/login') return { token: 'jwt-fresh' };
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
        expect(localStorage.getItem(BEARER_KEY)).toBe('jwt-fresh');
        expect(document.querySelector('.access-auth-overlay')).toBeNull();
    });

    it('never downgrades to v1 when a v2 sign-in fails', async () => {
        const fetchSpy = mockFetch((url) => {
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
        mockFetch(() => ({
            enabled: true,
            authenticated: false,
            protocols: [],
        }));
        await expect(bootstrapAccessAuth()).rejects.toThrow(
            'Phi returned invalid access protection settings',
        );
    });

    it('ignores unknown protocols only beside a supported one', async () => {
        mockFetch(() => ({
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
        storeBearer(token);
        mockFetch((url) => {
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
        mockFetch((url, options) => {
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
        mockFetch((url, options) => {
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
        const fetchSpy = mockFetch((url) => {
            if (url === '/api/one' || url === '/api/two')
                return { ok: false, status: 401 };
            if (url === '/api/auth/v2/login') return { token: 'jwt-b' };
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
        expect(localStorage.getItem(BEARER_KEY)).toBe('jwt-b');
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
        mockFetch((url) => {
            if (url === '/api/slow')
                return gate.then(() => ({ ok: false, status: 401 }));
            if (url === '/api/auth/v2/password')
                return { enabled: true, token: 'jwt-b' };
            return { ok: true };
        });
        installAccessFetch();
        const slow = fetch('/api/slow');
        await setAccessPassword('password123');
        expect(__test__.getAccessState().accessToken).toBe('jwt-b');
        release();
        await slow;
        expect(__test__.getAccessState().accessToken).toBe('jwt-b');
        expect(localStorage.getItem(BEARER_KEY)).toBe('jwt-b');
    });
});

describe('v2 password route', () => {
    it('posts the raw password with the current bearer', async () => {
        storeBearer('jwt-a');
        mockFetch((url) => {
            if (url === '/api/auth/status') return DUAL_STATUS;
            if (url === '/api/auth/v2/status')
                return { enabled: true, authenticated: true };
            if (url === '/api/auth/v2/password')
                return { enabled: true, token: 'jwt-b' };
            return undefined;
        });
        await bootstrapAccessAuth();
        const fetchSpy = mockFetch((url, options) => {
            if (url === '/api/auth/v2/password')
                return { enabled: true, token: 'jwt-b' };
            return undefined;
        });
        await expect(setAccessPassword('password123')).resolves.toEqual({
            enabled: true,
        });
        const [, options] = fetchSpy.mock.calls[0];
        expect(fetchSpy.mock.calls[0][0]).toBe('/api/auth/v2/password');
        expect(options.headers.Authorization).toBe('Bearer jwt-a');
        expect(JSON.parse(options.body)).toEqual({ password: 'password123' });
        expect(__test__.getAccessState().accessToken).toBe('jwt-b');
        expect(localStorage.getItem(BEARER_KEY)).toBe('jwt-b');
    });

    it('enables a dual server without a bearer', async () => {
        mockFetch(() => ({ enabled: false, protocols: ['v1', 'v2'] }));
        await bootstrapAccessAuth();
        const fetchSpy = mockFetch(() => ({ enabled: true, token: 'jwt-new' }));
        await setAccessPassword('password123');
        const [, options] = fetchSpy.mock.calls[0];
        expect(fetchSpy.mock.calls[0][0]).toBe('/api/auth/v2/password');
        expect(options.headers.Authorization).toBeUndefined();
        expect(JSON.parse(options.body)).toEqual({ password: 'password123' });
    });

    it('keeps the v1 hash route for a v1-only server', async () => {
        mockFetch(() => ({ enabled: false }));
        await bootstrapAccessAuth();
        vi.stubGlobal('crypto', {
            getRandomValues(bytes) {
                bytes.fill(23);
                return bytes;
            },
        });
        const fetchSpy = mockFetch(() => ({ enabled: true }));
        await setAccessPassword('password123');
        expect(fetchSpy.mock.calls[0][0]).toBe('/api/auth/password');
        expect(
            JSON.parse(fetchSpy.mock.calls[0][1].body).password_hash,
        ).toMatch(/^v1\.pbkdf2-sha256\./);
    });

    it('rejects a v2 password outside the byte bounds', async () => {
        mockFetch(() => ({ enabled: false, protocols: ['v1', 'v2'] }));
        await bootstrapAccessAuth();
        const fetchSpy = mockFetch(() => ({ enabled: true, token: 'jwt-new' }));
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
        mockFetch((url) => {
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
        const fetchSpy = mockFetch((url) => {
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
        storeBearer('jwt-stale');
        mockFetch((url) => {
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
        mockFetch(() => ({
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
        mockFetch((url) => {
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
        mockFetch((url) => {
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
        mockFetch((url) => {
            if (url === '/api/auth/status') return DUAL_STATUS;
            if (url === '/api/auth/v2/login')
                return gate.then(() => ({ token: 'stale-token' }));
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
        expect(localStorage.getItem(BEARER_KEY)).toBeNull();
    });

    it('keeps a host session out of storage after a password change', async () => {
        const { installToken } = await import('../web/auth.js');
        installToken('host-token');
        mockFetch((url) => {
            if (url === '/api/auth/v2/password')
                return { enabled: true, token: 'replacement-token' };
            return undefined;
        });
        await expect(setAccessPassword('password123')).resolves.toEqual({
            enabled: true,
        });
        expect(__test__.getAccessState().accessToken).toBe('replacement-token');
        expect(localStorage.getItem(BEARER_KEY)).toBeNull();
    });

    it('keeps a host session out of storage after reauthentication', async () => {
        const { installToken } = await import('../web/auth.js');
        installToken('host-token');
        mockFetch((url) => {
            if (url === '/api/protected') return { ok: false, status: 401 };
            if (url === '/api/auth/v2/login')
                return { token: 'replacement-token' };
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
        expect(localStorage.getItem(BEARER_KEY)).toBeNull();
    });
});

describe('credential ownership and superseded derivations', () => {
    it('keeps a host session memory-only across clear and re-enable', async () => {
        const { installToken } = await import('../web/auth.js');
        installToken('host-token');
        let calls = 0;
        mockFetch((url) => {
            if (url !== '/api/auth/v2/password') return undefined;
            calls += 1;
            return calls === 1
                ? { enabled: false }
                : { enabled: true, token: 'replacement-token' };
        });
        await expect(clearAccessPassword()).resolves.toEqual({
            enabled: false,
        });
        await expect(setAccessPassword('password123')).resolves.toEqual({
            enabled: true,
        });
        expect(__test__.getAccessState().accessToken).toBe('replacement-token');
        expect(localStorage.getItem(BEARER_KEY)).toBeNull();
    });

    it('does not post a v1 record after a superseding install', async () => {
        mockFetch(() => ({ enabled: false }));
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
        storeBearer('jwt-a');
        mockFetch((url) => {
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
        const fetchSpy = mockFetch((url) => {
            if (url === '/api/auth/v2/password')
                return gate.then(() => ({ enabled: true, token: 'jwt-b' }));
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
        mockFetch((url) => {
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
        mockFetch((url) => {
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
            mockFetch(() => new Promise(() => {}));
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
            mockFetch((url) => {
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
        const fetchSpy = mockFetch((url) =>
            url === '/api/auth/v2/password'
                ? { enabled: true, token: 'jwt-b' }
                : undefined,
        );
        await setAccessPassword('password123');
        const [url, options] = fetchSpy.mock.calls[0];
        expect(url).toBe('/api/auth/v2/password');
        expect(options.redirect).toBe('error');
        expect(options.signal).toBeInstanceOf(AbortSignal);
    });

    it('keeps a stored token when the clear response is not a clear', async () => {
        installToken('jwt-a');
        mockFetch(() => ({ enabled: true, token: 'jwt-b' }));
        await expect(clearAccessPassword()).rejects.toThrow(
            'Unable to clear access password',
        );
        const state = __test__.getAccessState();
        expect(state.accessToken).toBe('jwt-a');
        expect(state.accessEnabled).toBe(true);
    });

    it('does not delete standalone storage owned by another session', async () => {
        storeBearer('jwt-standalone');
        installToken('jwt-standalone');
        mockFetch((url) =>
            url === '/api/protected'
                ? { ok: false, status: 401 }
                : { ok: true },
        );
        installAccessFetch();
        await fetch('/api/protected');
        await vi.waitFor(() =>
            expect(__test__.getAccessState().accessToken).toBeNull(),
        );
        expect(localStorage.getItem(BEARER_KEY)).toBe('jwt-standalone');
    });

    it('keeps another standalone token when a host session clears access', async () => {
        storeBearer('jwt-other');
        installToken('host-token');
        mockFetch((url) =>
            url === '/api/auth/v2/password' ? { enabled: false } : undefined,
        );
        await expect(clearAccessPassword()).resolves.toEqual({
            enabled: false,
        });
        expect(localStorage.getItem(BEARER_KEY)).toBe('jwt-other');
    });
});
