// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AuthView } from '../src/platform/auth-session.ts';
import { createAuthSession } from '../src/platform/auth-session.ts';
import type {
    AuthStatusOutcome,
    ConfigOutcome,
    ConnectionService,
    LoginOutcome,
    RefreshOutcome,
} from '../src/platform/http.ts';
import { createServerStateAdapter } from '../src/platform/server-state.ts';

const UPSTREAM = 'http://fixture.invalid';
const BUNDLE = {
    token: 'test-access-token',
    expiresAt: 1_700_000_000,
    expiresIn: 3600,
    refreshIdleExpiresAt: 1_700_000_000,
    refreshAbsoluteExpiresAt: 1_700_000_000,
};

interface Deferred<T> {
    signal: AbortSignal;
    bearer?: string;
    password?: string;
    resolve: (value: T) => void;
}

function deferredHttp() {
    const status: Array<Deferred<AuthStatusOutcome>> = [];
    const logins: Array<Deferred<LoginOutcome>> = [];
    const refreshes: Array<Deferred<RefreshOutcome>> = [];
    const configs: Array<Deferred<ConfigOutcome>> = [];
    const http: ConnectionService = {
        serverLabel: UPSTREAM,
        getStatus: () => Promise.resolve('disabled'),
        getAuthStatus: (signal, bearer) =>
            new Promise<AuthStatusOutcome>((resolve) => {
                status.push({ signal, bearer, resolve });
            }),
        login: (password, signal) =>
            new Promise<LoginOutcome>((resolve) => {
                logins.push({ signal, password, resolve });
            }),
        refresh: (signal) =>
            new Promise<RefreshOutcome>((resolve) => {
                refreshes.push({ signal, resolve });
            }),
        getConfigHostname: (signal, bearer) =>
            new Promise<ConfigOutcome>((resolve) => {
                configs.push({ signal, bearer, resolve });
            }),
    };
    return { http, status, logins, refreshes, configs };
}

function memoryStorage() {
    const store = new Map<string, string>();
    return {
        store,
        writeBinding: vi.fn(),
        adapter: () =>
            createServerStateAdapter(
                {
                    getItem: (key: string) => store.get(key) ?? null,
                    setItem: (key: string, value: string) => {
                        store.set(key, value);
                    },
                },
                UPSTREAM,
            ),
    };
}

const flush = () => new Promise<void>((done) => setTimeout(done, 0));

beforeEach(() => {
    vi.useRealTimers();
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function started() {
    const fake = deferredHttp();
    const memory = memoryStorage();
    const session = createAuthSession(fake.http, memory.adapter());
    const views: AuthView[] = [];
    const stop = session.start((view) => {
        views.push(view);
    });
    return { ...fake, memory, session, views, stop };
}

const last = (views: AuthView[]) => views[views.length - 1] as AuthView;

it('renders the cached hostname synchronously before any request', () => {
    const fake = deferredHttp();
    const memory = memoryStorage();
    memory.store.set(
        `phi.react.server-info.v1:${UPSTREAM}`,
        JSON.stringify({ v: 1, hostname: 'cached-phi' }),
    );
    const session = createAuthSession(fake.http, memory.adapter());
    const initial = session.view();
    expect(initial.hostname).toBeNull();
    const views: AuthView[] = [];
    const stop = session.start((view) => views.push(view));
    expect(views[0]).toMatchObject({
        phase: 'checking',
        hostname: 'cached-phi',
        stale: true,
        pending: true,
    });
    expect(fake.status).toHaveLength(1);
    stop();
});

it('enters disabled mode with an uncredentialed hostname read', async () => {
    const { status, configs, views, stop } = started();
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: false, authenticated: false, owned: true },
    });
    await flush();
    expect(configs).toHaveLength(1);
    expect(configs[0]?.bearer).toBeUndefined();
    configs[0]?.resolve({ kind: 'ok', hostname: 'phi-1' });
    await flush();
    expect(last(views)).toMatchObject({
        phase: 'ready',
        protection: 'disabled',
        hostname: 'phi-1',
        stale: false,
        pending: false,
    });
    stop();
});

it('shows Login for an owned/enabled server without a token', async () => {
    const { status, refreshes, views, stop } = started();
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    expect(last(views)).toMatchObject({
        phase: 'sign-in',
        protection: 'enabled',
        canSignIn: true,
        message: null,
    });
    expect(refreshes).toHaveLength(0);
    stop();
});

it('never unlocks for owned:false, even when the server looks disabled', async () => {
    const { status, configs, views, stop } = started();
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: false, authenticated: false, owned: false },
    });
    await flush();
    expect(last(views).phase).toBe('unavailable');
    expect(configs).toHaveLength(0);
    stop();
});

it('signs in, binds the profile, and reads the hostname with the bearer', async () => {
    const harness = started();
    const { status, logins, configs, views, memory, stop, session } = harness;
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    const result = session.signIn('correct-horse');
    expect(logins).toHaveLength(1);
    expect(logins[0]?.password).toBe('correct-horse');
    logins[0]?.resolve({ kind: 'accepted', bundle: BUNDLE });
    await expect(result).resolves.toBe('accepted');
    await flush();
    expect(memory.store.get('phi.react.auth-server.v1')).toBe(
        JSON.stringify({ v: 1, origin: UPSTREAM }),
    );
    expect(status).toHaveLength(2);
    expect(status[1]?.bearer).toBe(BUNDLE.token);
    status[1]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: true, owned: true },
    });
    await flush();
    expect(configs).toHaveLength(1);
    expect(configs[0]?.bearer).toBe(BUNDLE.token);
    configs[0]?.resolve({ kind: 'ok', hostname: 'phi-1' });
    await flush();
    const ready = last(views);
    expect(ready).toMatchObject({
        phase: 'ready',
        protection: 'enabled',
        hostname: 'phi-1',
        stale: false,
        pending: false,
    });
    expect(JSON.stringify(views)).not.toContain(BUNDLE.token);
    expect(memory.store.get(`phi.react.server-info.v1:${UPSTREAM}`)).toBe(
        JSON.stringify({ v: 1, hostname: 'phi-1' }),
    );
    stop();
});

it('sends one login for concurrent submits', async () => {
    const { status, logins, stop, session } = started();
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    const first = session.signIn('password-1');
    const second = session.signIn('password-2');
    expect(logins).toHaveLength(1);
    logins[0]?.resolve({ kind: 'invalid-length' });
    await expect(first).resolves.toBe('invalid-length');
    await expect(second).resolves.toBe('invalid-length');
    stop();
});

it('checks status once after a 401 before reporting a wrong password', async () => {
    const { status, logins, views, stop, session } = started();
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    const result = session.signIn('wrong-password');
    logins[0]?.resolve({
        kind: 'rejected',
        status: 401,
        retryAfterMs: null,
    });
    await flush();
    expect(status).toHaveLength(2);
    expect(logins).toHaveLength(1);
    status[1]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await expect(result).resolves.toBe('wrong-password');
    expect(last(views)).toMatchObject({ phase: 'sign-in', pending: false });
    stop();
});

it('enters disabled mode when the 401 recheck finds protection cleared', async () => {
    const { status, logins, configs, views, stop, session } = started();
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    const result = session.signIn('stale-password');
    logins[0]?.resolve({
        kind: 'rejected',
        status: 401,
        retryAfterMs: null,
    });
    await flush();
    status[1]?.resolve({
        kind: 'ok',
        status: { enabled: false, authenticated: false, owned: true },
    });
    await flush();
    configs[0]?.resolve({ kind: 'ok', hostname: 'phi-1' });
    await expect(result).resolves.toBe('rejected');
    expect(last(views)).toMatchObject({
        phase: 'ready',
        protection: 'disabled',
        hostname: 'phi-1',
    });
    stop();
});

it('retains the form with a note when the 401 recheck cannot confirm', async () => {
    const { status, logins, views, stop, session } = started();
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    const result = session.signIn('password');
    logins[0]?.resolve({
        kind: 'rejected',
        status: 401,
        retryAfterMs: null,
    });
    await flush();
    status[1]?.resolve({ kind: 'unavailable' });
    await expect(result).resolves.toBe('unconfirmed');
    expect(last(views)).toMatchObject({
        phase: 'sign-in',
        protection: 'unknown',
        message: 'status-unavailable',
        canSignIn: false,
    });
    stop();
});

it('cools down for the server wait after login 429, then re-enables', async () => {
    vi.useFakeTimers();
    const fake = deferredHttp();
    const memory = memoryStorage();
    const session = createAuthSession(fake.http, memory.adapter());
    const views: AuthView[] = [];
    const stop = session.start((view) => views.push(view));
    fake.status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = session.signIn('password');
    fake.logins[0]?.resolve({
        kind: 'rejected',
        status: 429,
        retryAfterMs: 120_000,
    });
    await expect(result).resolves.toBe('rate-limited');
    expect(last(views).canSignIn).toBe(false);
    expect(fake.logins).toHaveLength(1);
    await expect(session.signIn('password')).resolves.toBe('rate-limited');
    expect(fake.logins).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(last(views).canSignIn).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(last(views).canSignIn).toBe(true);
    stop();
    expect(vi.getTimerCount()).toBe(0);
});

it('uses a 60-second cooldown for login 429 without a usable wait', async () => {
    vi.useFakeTimers();
    const fake = deferredHttp();
    const memory = memoryStorage();
    const session = createAuthSession(fake.http, memory.adapter());
    const views: AuthView[] = [];
    const stop = session.start((view) => views.push(view));
    fake.status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = session.signIn('password');
    fake.logins[0]?.resolve({
        kind: 'rejected',
        status: 429,
        retryAfterMs: null,
    });
    await expect(result).resolves.toBe('rate-limited');
    await vi.advanceTimersByTimeAsync(59_999);
    expect(last(views).canSignIn).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(last(views).canSignIn).toBe(true);
    stop();
});

it('reports a server unlock failure distinctly from a rejected request', async () => {
    const { status, logins, views, stop, session } = started();
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    const failed = session.signIn('password');
    logins[0]?.resolve({
        kind: 'rejected',
        status: 500,
        retryAfterMs: null,
    });
    await expect(failed).resolves.toBe('rejected');
    expect(last(views).message).toBe('unlock-failed');
    const refused = session.signIn('password');
    logins[1]?.resolve({
        kind: 'rejected',
        status: 403,
        retryAfterMs: null,
    });
    await expect(refused).resolves.toBe('rejected');
    stop();
});

it('blocks sign-in for a foreign binding without sending any credential', async () => {
    const { status, logins, refreshes, configs, views, memory, stop } =
        started();
    memory.store.set(
        'phi.react.auth-server.v1',
        JSON.stringify({ v: 1, origin: 'http://other.invalid' }),
    );
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    expect(last(views)).toMatchObject({
        phase: 'sign-in',
        message: 'separate-profile',
        canSignIn: false,
    });
    expect(logins).toHaveLength(0);
    expect(refreshes).toHaveLength(0);
    expect(configs).toHaveLength(0);
    expect(status).toHaveLength(1);
    stop();
});

it('refreshes once on a current bearer rejection, then returns to Login on refresh 401', async () => {
    const fake = deferredHttp();
    const memory = memoryStorage();
    memory.store.set(
        `phi.react.server-info.v1:${UPSTREAM}`,
        JSON.stringify({ v: 1, hostname: 'cached-phi' }),
    );
    const session = createAuthSession(fake.http, memory.adapter());
    const views: AuthView[] = [];
    const stop = session.start((view) => views.push(view));
    const { status, logins, refreshes, configs } = fake;
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    const result = session.signIn('password');
    logins[0]?.resolve({ kind: 'accepted', bundle: BUNDLE });
    await expect(result).resolves.toBe('accepted');
    await flush();
    status[1]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    expect(refreshes).toHaveLength(1);
    refreshes[0]?.resolve({
        kind: 'rejected',
        status: 401,
        retryAfterMs: null,
    });
    await flush();
    status[2]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    expect(last(views)).toMatchObject({
        phase: 'sign-in',
        protection: 'enabled',
        hostname: 'cached-phi',
        canSignIn: true,
    });
    expect(refreshes).toHaveLength(1);
    expect(configs).toHaveLength(0);
    stop();
});

it('retains the token through a protected-read 403', async () => {
    const { status, logins, configs, views, stop, session } = started();
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    const result = session.signIn('password');
    logins[0]?.resolve({ kind: 'accepted', bundle: BUNDLE });
    await expect(result).resolves.toBe('accepted');
    await flush();
    status[1]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: true, owned: true },
    });
    await flush();
    configs[0]?.resolve({ kind: 'rejected', status: 403 });
    await flush();
    expect(last(views)).toMatchObject({
        phase: 'ready',
        stale: true,
        message: 'read-stale',
    });
    session.retry();
    await flush();
    expect(status).toHaveLength(3);
    expect(status[2]?.bearer).toBeUndefined();
    status[2]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    expect(status).toHaveLength(4);
    expect(status[3]?.bearer).toBe(BUNDLE.token);
    stop();
});

it('rechecks status once after an uncredentialed 401, then shows Login', async () => {
    const { status, configs, views, stop } = started();
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: false, authenticated: false, owned: true },
    });
    await flush();
    configs[0]?.resolve({ kind: 'rejected', status: 401 });
    await flush();
    expect(status).toHaveLength(2);
    status[1]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    expect(last(views)).toMatchObject({
        phase: 'sign-in',
        protection: 'enabled',
    });
    expect(configs).toHaveLength(1);
    stop();
});

it('fences a late acceptance after teardown without writing state', async () => {
    const { status, logins, views, memory, stop, session } = started();
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    const result = session.signIn('password');
    expect(logins[0]?.signal.aborted).toBe(false);
    stop();
    expect(logins[0]?.signal.aborted).toBe(true);
    logins[0]?.resolve({ kind: 'accepted', bundle: BUNDLE });
    await expect(result).resolves.toBe('cancelled');
    expect(memory.store.has('phi.react.auth-server.v1')).toBe(false);
    expect(views.every((view) => view.phase !== 'ready')).toBe(true);
});

it('supersedes pending work when another tab changes storage', async () => {
    const { status, logins, stop, session } = started();
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    const result = session.signIn('password');
    window.dispatchEvent(new Event('storage'));
    await flush();
    expect(logins[0]?.signal.aborted).toBe(true);
    expect(status).toHaveLength(2);
    logins[0]?.resolve({ kind: 'accepted', bundle: BUNDLE });
    await expect(result).resolves.toBe('cancelled');
    status[1]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    stop();
});

it('restarts cleanly after teardown', async () => {
    const fake = deferredHttp();
    const memory = memoryStorage();
    const session = createAuthSession(fake.http, memory.adapter());
    const first: AuthView[] = [];
    const stopFirst = session.start((view) => first.push(view));
    fake.status[0]?.resolve({ kind: 'unavailable' });
    await flush();
    const frozen = first.length;
    stopFirst();
    const second: AuthView[] = [];
    const stopSecond = session.start((view) => second.push(view));
    expect(second[0]?.phase).toBe('checking');
    fake.status[1]?.resolve({
        kind: 'ok',
        status: { enabled: false, authenticated: false, owned: true },
    });
    await flush();
    fake.configs[0]?.resolve({ kind: 'ok', hostname: 'phi-1' });
    await flush();
    expect(second[second.length - 1]).toMatchObject({
        phase: 'ready',
        hostname: 'phi-1',
    });
    expect(first).toHaveLength(frozen);
    stopSecond();
});

it('clears the memory token and stops on a blocked upstream', async () => {
    const { status, logins, views, stop, session } = started();
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    const result = session.signIn('password');
    logins[0]?.resolve({ kind: 'accepted', bundle: BUNDLE });
    await expect(result).resolves.toBe('accepted');
    await flush();
    status[1]?.resolve({ kind: 'blocked' });
    await flush();
    expect(last(views).phase).toBe('blocked');
    await expect(session.signIn('password')).resolves.toBe('cancelled');
    stop();
});

function bind(memory: { store: Map<string, string> }, origin: string) {
    memory.store.set(
        'phi.react.auth-server.v1',
        JSON.stringify({ v: 1, origin }),
    );
}

const BUNDLE_B = {
    token: 'test-access-token-b',
    expiresAt: 1_700_000_000,
    expiresIn: 3600,
    refreshIdleExpiresAt: 1_700_000_000,
    refreshAbsoluteExpiresAt: 1_700_000_000,
};

function stubLocks(
    request: (
        name: string,
        options: { signal: AbortSignal },
        callback: () => Promise<unknown>,
    ) => Promise<unknown>,
) {
    const navigatorObject = globalThis.navigator as Navigator & {
        locks?: unknown;
    };
    const had = 'locks' in navigatorObject;
    const previous = navigatorObject.locks;
    Object.defineProperty(navigatorObject, 'locks', {
        value: { request },
        configurable: true,
        writable: true,
    });
    return () => {
        if (had) {
            Object.defineProperty(navigatorObject, 'locks', {
                value: previous,
                configurable: true,
                writable: true,
            });
        } else {
            delete (navigatorObject as Record<string, unknown>).locks;
        }
    };
}

it('restores a session on startup with a matching binding', async () => {
    const { status, logins, refreshes, configs, views, memory, stop } =
        started();
    bind(memory, UPSTREAM);
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    expect(refreshes).toHaveLength(1);
    expect(logins).toHaveLength(0);
    refreshes[0]?.resolve({ kind: 'accepted', bundle: BUNDLE_B });
    await flush();
    expect(status).toHaveLength(2);
    expect(status[1]?.bearer).toBe('test-access-token-b');
    status[1]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: true, owned: true },
    });
    await flush();
    expect(configs).toHaveLength(1);
    expect(configs[0]?.bearer).toBe('test-access-token-b');
    configs[0]?.resolve({ kind: 'ok', hostname: 'phi-1' });
    await flush();
    expect(last(views)).toMatchObject({
        phase: 'ready',
        protection: 'enabled',
        hostname: 'phi-1',
        stale: false,
    });
    expect(refreshes).toHaveLength(1);
    stop();
});

it('shows Login without a refresh when the binding is corrupt', async () => {
    const { status, refreshes, views, memory, stop } = started();
    memory.store.set('phi.react.auth-server.v1', '{broken');
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    expect(last(views)).toMatchObject({ phase: 'sign-in', message: null });
    expect(refreshes).toHaveLength(0);
    stop();
});

it('signs in in memory with a quiet note when storage is denied', async () => {
    const fake = deferredHttp();
    const denied = {
        getItem: () => {
            throw new Error('denied');
        },
        setItem: () => {
            throw new Error('denied');
        },
    };
    const session = createAuthSession(
        fake.http,
        createServerStateAdapter(denied, UPSTREAM),
    );
    const views: AuthView[] = [];
    const stop = session.start((view) => views.push(view));
    fake.status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    expect(last(views)).toMatchObject({
        phase: 'sign-in',
        message: 'persistence-note',
        canSignIn: true,
    });
    expect(fake.refreshes).toHaveLength(0);
    const result = session.signIn('password');
    fake.logins[0]?.resolve({ kind: 'accepted', bundle: BUNDLE });
    await expect(result).resolves.toBe('accepted');
    await flush();
    fake.status[1]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: true, owned: true },
    });
    await flush();
    fake.configs[0]?.resolve({ kind: 'ok', hostname: 'phi-1' });
    await flush();
    expect(last(views)).toMatchObject({
        phase: 'ready',
        hostname: 'phi-1',
        message: 'persistence-note',
    });
    stop();
});

it('exhausts restore after refresh 401: Retry rechecks status without repeating the cookie', async () => {
    const { status, refreshes, views, memory, session, stop } = started();
    bind(memory, UPSTREAM);
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    refreshes[0]?.resolve({
        kind: 'rejected',
        status: 401,
        retryAfterMs: null,
    });
    await flush();
    status[1]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    expect(last(views)).toMatchObject({
        phase: 'sign-in',
        protection: 'enabled',
        message: null,
    });
    session.retry();
    await flush();
    expect(status).toHaveLength(3);
    status[2]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    expect(last(views).phase).toBe('sign-in');
    expect(refreshes).toHaveLength(1);
    stop();
});

it('enters uncredentialed mode when the refresh-401 recheck finds protection cleared', async () => {
    const { status, refreshes, configs, views, memory, stop } = started();
    bind(memory, UPSTREAM);
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    refreshes[0]?.resolve({
        kind: 'rejected',
        status: 401,
        retryAfterMs: null,
    });
    await flush();
    status[1]?.resolve({
        kind: 'ok',
        status: { enabled: false, authenticated: false, owned: true },
    });
    await flush();
    expect(configs).toHaveLength(1);
    expect(configs[0]?.bearer).toBeUndefined();
    configs[0]?.resolve({ kind: 'ok', hostname: 'phi-1' });
    await flush();
    expect(last(views)).toMatchObject({
        phase: 'ready',
        protection: 'disabled',
        hostname: 'phi-1',
    });
    stop();
});

it('ends the chain without another refresh when the refreshed bearer is also rejected', async () => {
    const { status, logins, refreshes, views, stop, session } = started();
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    const result = session.signIn('password');
    logins[0]?.resolve({ kind: 'accepted', bundle: BUNDLE });
    await expect(result).resolves.toBe('accepted');
    await flush();
    status[1]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    expect(refreshes).toHaveLength(1);
    refreshes[0]?.resolve({ kind: 'accepted', bundle: BUNDLE_B });
    await flush();
    expect(status[2]?.bearer).toBe('test-access-token-b');
    status[2]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    expect(last(views)).toMatchObject({
        phase: 'sign-in',
        protection: 'enabled',
    });
    expect(refreshes).toHaveLength(1);
    stop();
});

it('retains the token with a stale note when a refresh is rate-limited', async () => {
    vi.useFakeTimers();
    try {
        const { status, logins, refreshes, configs, views, stop, session } =
            started();
        status[0]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: false, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        const result = session.signIn('password');
        logins[0]?.resolve({ kind: 'accepted', bundle: BUNDLE });
        await expect(result).resolves.toBe('accepted');
        await vi.advanceTimersByTimeAsync(0);
        status[1]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: true, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        configs[0]?.resolve({ kind: 'ok', hostname: 'phi-1' });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(3_540_000);
        expect(refreshes).toHaveLength(1);
        refreshes[0]?.resolve({
            kind: 'rejected',
            status: 429,
            retryAfterMs: 5_000,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(last(views)).toMatchObject({
            phase: 'ready',
            hostname: 'phi-1',
            stale: true,
            message: 'read-stale',
        });
        stop();
    } finally {
        vi.useRealTimers();
    }
});

it('renews once at lifetime minus the lead, even when time jumps past it', async () => {
    vi.useFakeTimers();
    try {
        const { status, logins, refreshes, configs, stop, session } = started();
        status[0]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: false, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        const result = session.signIn('password');
        logins[0]?.resolve({ kind: 'accepted', bundle: BUNDLE });
        await expect(result).resolves.toBe('accepted');
        await vi.advanceTimersByTimeAsync(0);
        status[1]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: true, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        configs[0]?.resolve({ kind: 'ok', hostname: 'phi-1' });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(3_539_999);
        expect(refreshes).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(refreshes).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(36_000_000);
        expect(refreshes).toHaveLength(1);
        stop();
    } finally {
        vi.useRealTimers();
    }
});

it('halves the renewal lead for short lifetimes', async () => {
    vi.useFakeTimers();
    try {
        const { status, logins, refreshes, configs, stop, session } = started();
        const short = { ...BUNDLE, expiresIn: 100 };
        status[0]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: false, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        const result = session.signIn('password');
        logins[0]?.resolve({ kind: 'accepted', bundle: short });
        await expect(result).resolves.toBe('accepted');
        await vi.advanceTimersByTimeAsync(0);
        status[1]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: true, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        configs[0]?.resolve({ kind: 'ok', hostname: 'phi-1' });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(49_999);
        expect(refreshes).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(refreshes).toHaveLength(1);
        stop();
    } finally {
        vi.useRealTimers();
    }
});

it('blocks bearer sends for an expired token and refreshes instead', async () => {
    vi.useFakeTimers();
    try {
        const { status, logins, refreshes, configs, stop, session } = started();
        const short = { ...BUNDLE, expiresIn: 100 };
        status[0]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: false, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        const result = session.signIn('password');
        logins[0]?.resolve({ kind: 'accepted', bundle: short });
        await expect(result).resolves.toBe('accepted');
        await vi.advanceTimersByTimeAsync(0);
        status[1]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: true, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        configs[0]?.resolve({ kind: 'ok', hostname: 'phi-1' });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(50_000);
        expect(refreshes).toHaveLength(1);
        refreshes[0]?.resolve({ kind: 'unconfirmed' });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(60_000);
        session.retry();
        await vi.advanceTimersByTimeAsync(0);
        expect(status).toHaveLength(3);
        status[2]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: false, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(refreshes).toHaveLength(2);
        expect(status).toHaveLength(3);
        stop();
    } finally {
        vi.useRealTimers();
    }
});

it('rechecks bearer status once on online and coalesces with pending work', async () => {
    const { status, logins, configs, views, stop, session } = started();
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    const result = session.signIn('password');
    logins[0]?.resolve({ kind: 'accepted', bundle: BUNDLE });
    await expect(result).resolves.toBe('accepted');
    await flush();
    status[1]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: true, owned: true },
    });
    await flush();
    configs[0]?.resolve({ kind: 'ok', hostname: 'phi-1' });
    await flush();
    expect(last(views).phase).toBe('ready');
    window.dispatchEvent(new window.Event('online'));
    window.dispatchEvent(new window.Event('online'));
    await flush();
    expect(status).toHaveLength(3);
    expect(status[2]?.bearer).toBeUndefined();
    status[2]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    expect(status).toHaveLength(4);
    expect(status[3]?.bearer).toBe('test-access-token');
    status[3]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: true, owned: true },
    });
    await flush();
    configs[1]?.resolve({ kind: 'ok', hostname: 'phi-1' });
    await flush();
    expect(last(views)).toMatchObject({ phase: 'ready', stale: false });
    stop();
});

it('ignores hidden visibility changes and resyncs once when visible', async () => {
    const { status, logins, configs, stop, session } = started();
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    const result = session.signIn('password');
    logins[0]?.resolve({ kind: 'accepted', bundle: BUNDLE });
    await expect(result).resolves.toBe('accepted');
    await flush();
    status[1]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: true, owned: true },
    });
    await flush();
    configs[0]?.resolve({ kind: 'ok', hostname: 'phi-1' });
    await flush();
    const descriptor = Object.getOwnPropertyDescriptor(
        document,
        'visibilityState',
    );
    Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
    });
    try {
        document.dispatchEvent(new window.Event('visibilitychange'));
        await flush();
        expect(status).toHaveLength(2);
    } finally {
        if (descriptor === undefined)
            delete (document as unknown as Record<string, unknown>)
                .visibilityState;
        else Object.defineProperty(document, 'visibilityState', descriptor);
    }
    Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        configurable: true,
    });
    try {
        document.dispatchEvent(new window.Event('visibilitychange'));
        await flush();
        expect(status).toHaveLength(3);
    } finally {
        if (descriptor === undefined)
            delete (document as unknown as Record<string, unknown>)
                .visibilityState;
        else Object.defineProperty(document, 'visibilityState', descriptor);
    }
    stop();
});

it('ignores a stale rejection after a newer token is installed', async () => {
    const { status, logins, refreshes, configs, views, stop, session } =
        started();
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    const result = session.signIn('password');
    logins[0]?.resolve({ kind: 'accepted', bundle: BUNDLE });
    await expect(result).resolves.toBe('accepted');
    await flush();
    status[1]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    refreshes[0]?.resolve({ kind: 'accepted', bundle: BUNDLE_B });
    await flush();
    expect(status[2]?.bearer).toBe('test-access-token-b');
    window.dispatchEvent(new window.Event('storage'));
    await flush();
    status[2]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    status[3]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    expect(status[4]?.bearer).toBe('test-access-token-b');
    status[4]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: true, owned: true },
    });
    await flush();
    configs[0]?.resolve({ kind: 'ok', hostname: 'phi-1' });
    await flush();
    expect(last(views)).toMatchObject({ phase: 'ready', stale: false });
    expect(refreshes).toHaveLength(1);
    stop();
});

it('never lets an old login write binding or cache after supersede', async () => {
    const { status, logins, views, memory, stop, session } = started();
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    const result = session.signIn('password');
    window.dispatchEvent(new window.Event('storage'));
    status[1]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    logins[0]?.resolve({ kind: 'accepted', bundle: BUNDLE });
    await expect(result).resolves.toBe('cancelled');
    await flush();
    expect(memory.store.has('phi.react.auth-server.v1')).toBe(false);
    expect(status).toHaveLength(2);
    expect(last(views).phase).toBe('sign-in');
    stop();
});

it('restarts through Strict Mode teardown with one restoration', async () => {
    const fake = deferredHttp();
    const memory = memoryStorage();
    bind(memory, UPSTREAM);
    const session = createAuthSession(fake.http, memory.adapter());
    const first: AuthView[] = [];
    const stopFirst = session.start((view) => first.push(view));
    expect(fake.status[0]?.signal.aborted).toBe(false);
    stopFirst();
    expect(fake.status[0]?.signal.aborted).toBe(true);
    const second: AuthView[] = [];
    const stopSecond = session.start((view) => second.push(view));
    fake.status[1]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    expect(fake.refreshes).toHaveLength(1);
    fake.refreshes[0]?.resolve({ kind: 'accepted', bundle: BUNDLE });
    await flush();
    fake.status[2]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: true, owned: true },
    });
    await flush();
    fake.configs[0]?.resolve({ kind: 'ok', hostname: 'phi-1' });
    await flush();
    expect(second[second.length - 1]).toMatchObject({
        phase: 'ready',
        hostname: 'phi-1',
    });
    expect(fake.refreshes).toHaveLength(1);
    stopSecond();
});

it('releases timers and listeners on teardown', async () => {
    vi.useFakeTimers();
    try {
        const { status, logins, refreshes, configs, stop, session } = started();
        status[0]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: false, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        const result = session.signIn('password');
        logins[0]?.resolve({ kind: 'accepted', bundle: BUNDLE });
        await expect(result).resolves.toBe('accepted');
        await vi.advanceTimersByTimeAsync(0);
        status[1]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: true, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        configs[0]?.resolve({ kind: 'ok', hostname: 'phi-1' });
        await vi.advanceTimersByTimeAsync(0);
        stop();
        window.dispatchEvent(new window.Event('online'));
        window.dispatchEvent(new window.Event('storage'));
        await vi.advanceTimersByTimeAsync(36_000_000);
        expect(refreshes).toHaveLength(0);
        expect(status).toHaveLength(2);
    } finally {
        vi.useRealTimers();
    }
});

it('verifies again with the same bearer after a protected-read 403', async () => {
    const { status, logins, configs, views, stop, session } = started();
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    const result = session.signIn('password');
    logins[0]?.resolve({ kind: 'accepted', bundle: BUNDLE });
    await expect(result).resolves.toBe('accepted');
    await flush();
    status[1]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: true, owned: true },
    });
    await flush();
    configs[0]?.resolve({ kind: 'rejected', status: 403 });
    await flush();
    expect(last(views)).toMatchObject({ phase: 'ready', stale: true });
    session.retry();
    await flush();
    expect(status).toHaveLength(3);
    status[2]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    expect(status).toHaveLength(4);
    expect(status[3]?.bearer).toBe('test-access-token');
    stop();
});

it('keeps Login mounted with unknown protection when ownership is lost', async () => {
    const { status, views, stop } = started();
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    expect(last(views).phase).toBe('sign-in');
    window.dispatchEvent(new window.Event('storage'));
    await flush();
    status[1]?.resolve({
        kind: 'ok',
        status: { enabled: false, authenticated: false, owned: false },
    });
    await flush();
    expect(last(views)).toMatchObject({
        phase: 'sign-in',
        protection: 'unknown',
        message: 'status-unavailable',
    });
    stop();
});

it('serializes login under the upstream lock name', async () => {
    const names: string[] = [];
    const restore = stubLocks(async (name, _options, callback) => {
        names.push(name);
        return callback();
    });
    try {
        const { status, logins, stop, session } = started();
        status[0]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: false, owned: true },
        });
        await flush();
        const result = session.signIn('password');
        await flush();
        expect(names).toEqual([`phi.react.auth:${UPSTREAM}`]);
        logins[0]?.resolve({ kind: 'accepted', bundle: BUNDLE });
        await expect(result).resolves.toBe('accepted');
        stop();
    } finally {
        restore();
    }
});

it('falls back once when lock acquisition rejects before entry', async () => {
    const attempts: string[] = [];
    const restore = stubLocks(async (name) => {
        attempts.push(name);
        throw new Error('no locks in this profile');
    });
    try {
        const { status, logins, views, stop, session } = started();
        status[0]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: false, owned: true },
        });
        await flush();
        const result = session.signIn('password');
        await flush();
        logins[0]?.resolve({ kind: 'accepted', bundle: BUNDLE });
        await expect(result).resolves.toBe('accepted');
        await flush();
        expect(attempts).toHaveLength(1);
        expect(logins).toHaveLength(1);
        expect(last(views).phase).toBe('ready');
        stop();
    } finally {
        restore();
    }
});

it('never reruns after an entered lock callback fails', async () => {
    const restore = stubLocks(async (_name, _options, callback) => callback());
    try {
        const fake = deferredHttp();
        let attempts = 0;
        fake.http.login = () => {
            attempts += 1;
            return Promise.reject(new Error('transport down'));
        };
        const memory = memoryStorage();
        const session = createAuthSession(fake.http, memory.adapter());
        const stop = session.start(() => {});
        fake.status[0]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: false, owned: true },
        });
        await flush();
        await expect(session.signIn('password')).resolves.toBe('unconfirmed');
        expect(attempts).toBe(1);
        stop();
    } finally {
        restore();
    }
});

it('never sends after a timed-out lock acquisition', async () => {
    vi.useFakeTimers();
    const restore = stubLocks(
        (_name, options) =>
            new Promise<unknown>((_resolve, reject) => {
                options.signal.addEventListener('abort', () => {
                    reject(new Error('aborted'));
                });
            }),
    );
    try {
        const { status, logins, stop, session } = started();
        status[0]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: false, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        const result = session.signIn('password');
        await vi.advanceTimersByTimeAsync(15_000);
        await expect(result).resolves.toBe('unconfirmed');
        expect(logins).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(logins).toHaveLength(0);
        stop();
    } finally {
        restore();
        vi.useRealTimers();
    }
});

it('never sends from a queued callback after cancellation', async () => {
    let captured: unknown = null;
    const restore = stubLocks(
        async (_name, options, callback) =>
            new Promise<unknown>((_resolve, reject) => {
                captured = callback;
                options.signal.addEventListener('abort', () => {
                    reject(new Error('aborted'));
                });
            }),
    );
    try {
        const { status, logins, stop, session } = started();
        status[0]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: false, owned: true },
        });
        await flush();
        const result = session.signIn('password');
        await flush();
        expect(captured).not.toBeNull();
        stop();
        await expect(result).resolves.toBe('cancelled');
        const queued = captured as (() => Promise<unknown>) | null;
        if (queued === null) throw new Error('Lock callback was not queued.');
        await expect(queued()).resolves.toBe('cancelled');
        expect(logins).toHaveLength(0);
    } finally {
        restore();
    }
});

it('backs off 2/4/8/16/30 seconds across repeated transient failures', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
        const { status, logins, refreshes, configs, stop, session } = started();
        status[0]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: false, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        const result = session.signIn('password');
        logins[0]?.resolve({ kind: 'accepted', bundle: BUNDLE });
        await expect(result).resolves.toBe('accepted');
        await vi.advanceTimersByTimeAsync(0);
        status[1]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: true, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        configs[0]?.resolve({ kind: 'ok', hostname: 'phi-1' });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(3_540_000);
        expect(refreshes).toHaveLength(1);
        refreshes[0]?.resolve({ kind: 'unconfirmed' });
        await vi.advanceTimersByTimeAsync(0);
        for (const [wait, index] of [
            [2_000, 2],
            [4_000, 3],
            [8_000, 4],
            [16_000, 5],
            [30_000, 6],
            [30_000, 7],
        ] as const) {
            await vi.advanceTimersByTimeAsync(wait - 1);
            expect(status).toHaveLength(index);
            await vi.advanceTimersByTimeAsync(1);
            expect(status).toHaveLength(index + 1);
            status[index]?.resolve({ kind: 'unavailable' });
            await vi.advanceTimersByTimeAsync(0);
        }
        expect(refreshes).toHaveLength(1);
        stop();
    } finally {
        vi.useRealTimers();
    }
});

it('bounds recovery jitter between the base and 120 percent', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    try {
        const { status, logins, refreshes, configs, stop, session } = started();
        status[0]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: false, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        const result = session.signIn('password');
        logins[0]?.resolve({ kind: 'accepted', bundle: BUNDLE });
        await expect(result).resolves.toBe('accepted');
        await vi.advanceTimersByTimeAsync(0);
        status[1]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: true, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        configs[0]?.resolve({ kind: 'ok', hostname: 'phi-1' });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(3_540_000);
        refreshes[0]?.resolve({ kind: 'unconfirmed' });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(1_999);
        expect(status).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(401);
        expect(status).toHaveLength(3);
        stop();
    } finally {
        vi.useRealTimers();
    }
});

it('keeps the backoff step after a partial chain success', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
        const { status, logins, refreshes, configs, stop, session } = started();
        status[0]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: false, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        const result = session.signIn('password');
        logins[0]?.resolve({ kind: 'accepted', bundle: BUNDLE });
        await expect(result).resolves.toBe('accepted');
        await vi.advanceTimersByTimeAsync(0);
        status[1]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: true, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        configs[0]?.resolve({ kind: 'ok', hostname: 'phi-1' });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(3_540_000);
        refreshes[0]?.resolve({ kind: 'unconfirmed' });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(status).toHaveLength(3);
        status[2]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: false, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(status[3]?.bearer).toBe('test-access-token');
        status[3]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: true, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        configs[1]?.resolve({ kind: 'unavailable' });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(3_999);
        expect(status).toHaveLength(4);
        await vi.advanceTimersByTimeAsync(1);
        expect(status).toHaveLength(5);
        stop();
    } finally {
        vi.useRealTimers();
    }
});

it('honors the refresh Retry-After wait instead of the backoff', async () => {
    vi.useFakeTimers();
    try {
        const { status, logins, refreshes, configs, views, stop, session } =
            started();
        status[0]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: false, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        const result = session.signIn('password');
        logins[0]?.resolve({ kind: 'accepted', bundle: BUNDLE });
        await expect(result).resolves.toBe('accepted');
        await vi.advanceTimersByTimeAsync(0);
        status[1]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: true, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        configs[0]?.resolve({ kind: 'ok', hostname: 'phi-1' });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(3_540_000);
        refreshes[0]?.resolve({
            kind: 'rejected',
            status: 429,
            retryAfterMs: 9_000,
        });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(8_999);
        expect(status).toHaveLength(2);
        expect(refreshes).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(status).toHaveLength(3);
        status[2]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: false, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        status[3]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: true, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        configs[1]?.resolve({ kind: 'ok', hostname: 'phi-1' });
        await vi.advanceTimersByTimeAsync(0);
        expect(last(views)).toMatchObject({ phase: 'ready', stale: false });
        stop();
    } finally {
        vi.useRealTimers();
    }
});

it('pauses automatic recovery on an infinite refresh wait', async () => {
    vi.useFakeTimers();
    try {
        const { status, logins, refreshes, configs, stop, session } = started();
        status[0]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: false, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        const result = session.signIn('password');
        logins[0]?.resolve({ kind: 'accepted', bundle: BUNDLE });
        await expect(result).resolves.toBe('accepted');
        await vi.advanceTimersByTimeAsync(0);
        status[1]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: true, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        configs[0]?.resolve({ kind: 'ok', hostname: 'phi-1' });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(3_540_000);
        refreshes[0]?.resolve({
            kind: 'rejected',
            status: 503,
            retryAfterMs: Number.POSITIVE_INFINITY,
        });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(3_600_000);
        expect(status).toHaveLength(2);
        expect(refreshes).toHaveLength(1);
        session.retry();
        await vi.advanceTimersByTimeAsync(0);
        expect(status).toHaveLength(3);
        stop();
    } finally {
        vi.useRealTimers();
    }
});

it('retries immediately and cancels the scheduled backoff', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
        const { status, logins, refreshes, configs, stop, session } = started();
        status[0]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: false, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        const result = session.signIn('password');
        logins[0]?.resolve({ kind: 'accepted', bundle: BUNDLE });
        await expect(result).resolves.toBe('accepted');
        await vi.advanceTimersByTimeAsync(0);
        status[1]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: true, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        configs[0]?.resolve({ kind: 'ok', hostname: 'phi-1' });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(3_540_000);
        refreshes[0]?.resolve({ kind: 'unconfirmed' });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(status).toHaveLength(2);
        session.retry();
        await vi.advanceTimersByTimeAsync(0);
        expect(status).toHaveLength(3);
        status[2]?.resolve({ kind: 'unavailable' });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(3_999);
        expect(status).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(1);
        expect(status).toHaveLength(4);
        stop();
    } finally {
        vi.useRealTimers();
    }
});

it('recovers a stale page to fresh and resets the backoff', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
        const { status, logins, configs, views, stop, session } = started();
        status[0]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: false, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        const result = session.signIn('password');
        logins[0]?.resolve({ kind: 'accepted', bundle: BUNDLE });
        await expect(result).resolves.toBe('accepted');
        await vi.advanceTimersByTimeAsync(0);
        status[1]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: true, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        configs[0]?.resolve({ kind: 'ok', hostname: 'phi-1' });
        await vi.advanceTimersByTimeAsync(0);
        window.dispatchEvent(new window.Event('online'));
        await vi.advanceTimersByTimeAsync(0);
        status[2]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: false, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(status[3]?.bearer).toBe('test-access-token');
        status[3]?.resolve({ kind: 'unavailable' });
        await vi.advanceTimersByTimeAsync(0);
        expect(last(views)).toMatchObject({
            phase: 'ready',
            hostname: 'phi-1',
            stale: true,
            message: 'read-stale',
        });
        await vi.advanceTimersByTimeAsync(2_000);
        expect(status).toHaveLength(5);
        status[4]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: false, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(status[5]?.bearer).toBe('test-access-token');
        status[5]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: true, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        configs[1]?.resolve({ kind: 'ok', hostname: 'phi-1' });
        await vi.advanceTimersByTimeAsync(0);
        expect(last(views)).toMatchObject({ phase: 'ready', stale: false });
        window.dispatchEvent(new window.Event('online'));
        await vi.advanceTimersByTimeAsync(0);
        status[6]?.resolve({
            kind: 'ok',
            status: { enabled: true, authenticated: false, owned: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        status[7]?.resolve({ kind: 'unavailable' });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(1_999);
        expect(status).toHaveLength(8);
        await vi.advanceTimersByTimeAsync(1);
        expect(status).toHaveLength(9);
        stop();
    } finally {
        vi.useRealTimers();
    }
});

it('cools down a login 503 that names a wait', async () => {
    const { status, logins, views, stop, session } = started();
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    const result = session.signIn('password');
    logins[0]?.resolve({
        kind: 'rejected',
        status: 503,
        retryAfterMs: 600_000,
    });
    await expect(result).resolves.toBe('rate-limited');
    await flush();
    expect(last(views)).toMatchObject({
        phase: 'sign-in',
        canSignIn: false,
    });
    await expect(session.signIn('password')).resolves.toBe('rate-limited');
    expect(logins).toHaveLength(1);
    stop();
});

it('rejects a bare login 503 without a cooldown', async () => {
    const { status, logins, views, stop, session } = started();
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    const result = session.signIn('password');
    logins[0]?.resolve({
        kind: 'rejected',
        status: 503,
        retryAfterMs: null,
    });
    await expect(result).resolves.toBe('rejected');
    await flush();
    expect(last(views)).toMatchObject({
        phase: 'sign-in',
        canSignIn: true,
        message: null,
    });
    session.signIn('password');
    await flush();
    expect(logins).toHaveLength(2);
    stop();
});

it('gives a fresh login its own refresh budget after a spent chain', async () => {
    const { status, logins, refreshes, views, stop, session, memory } =
        started();
    bind(memory, UPSTREAM);
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    expect(refreshes).toHaveLength(1);
    refreshes[0]?.resolve({ kind: 'unconfirmed' });
    await flush();
    expect(last(views)).toMatchObject({ phase: 'sign-in' });
    const result = session.signIn('password');
    logins[0]?.resolve({ kind: 'accepted', bundle: BUNDLE });
    await expect(result).resolves.toBe('accepted');
    await flush();
    expect(status[1]?.bearer).toBe('test-access-token');
    status[1]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    expect(refreshes).toHaveLength(2);
    refreshes[1]?.resolve({
        kind: 'rejected',
        status: 401,
        retryAfterMs: null,
    });
    await flush();
    status[2]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    expect(last(views)).toMatchObject({
        phase: 'sign-in',
        protection: 'enabled',
    });
    stop();
});
