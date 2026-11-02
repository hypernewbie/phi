// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createAuthSession } from '../src/platform/auth-session.ts';
import type {
    AuthStatusOutcome,
    ConfigDocumentOutcome,
    ConfigOutcome,
    ConnectionService,
    LoginOutcome,
    PostOutcome,
    RefreshOutcome,
    VersionOutcome,
} from '../src/platform/http.ts';
import { createConnectionService } from '../src/platform/http.ts';
import { createServerStateAdapter } from '../src/platform/server-state.ts';
import { createSettingsStore } from '../src/platform/settings-store.ts';

const UPSTREAM = 'http://fixture.invalid';
const flush = () => new Promise<void>((done) => setTimeout(done, 0));
const signal = () => new AbortController().signal;

const BUNDLE = {
    token: 'test-access-token',
    expiresAt: 1_700_000_000,
    expiresIn: 3600,
    refreshIdleExpiresAt: 1_700_000_000,
    refreshAbsoluteExpiresAt: 1_700_000_000,
};

function memoryStorage() {
    const store = new Map<string, string>();
    return {
        store,
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

function sessionHarness() {
    const status: Array<{ resolve: (value: AuthStatusOutcome) => void }> = [];
    const logins: Array<{ resolve: (value: LoginOutcome) => void }> = [];
    const memory = memoryStorage();
    const http: ConnectionService = {
        serverLabel: UPSTREAM,
        getStatus: () => Promise.resolve('disabled'),
        getAuthStatus: () =>
            new Promise<AuthStatusOutcome>((resolve) => {
                status.push({ resolve });
            }),
        login: () =>
            new Promise<LoginOutcome>((resolve) => {
                logins.push({ resolve });
            }),
        refresh: () => Promise.resolve({ kind: 'cancelled' } as RefreshOutcome),
        getConfigHostname: () =>
            Promise.resolve({ kind: 'unavailable' } as ConfigOutcome),
        getConfigDocument: () =>
            Promise.resolve({ kind: 'unavailable' } as ConfigDocumentOutcome),
        getVersion: () =>
            Promise.resolve({ kind: 'unavailable' } as VersionOutcome),
        postConfig: () =>
            Promise.resolve({ kind: 'unavailable' } as PostOutcome),
    };
    const session = createAuthSession(http, memory.adapter());
    return { session, status, logins };
}

it('reads no bearer before sign-in', () => {
    const { session } = sessionHarness();
    expect(session.bearer()).toBeNull();
});

it('exposes the live bearer after an accepted sign-in', async () => {
    const { session, status, logins } = sessionHarness();
    const stop = session.start(() => {});
    status[0]?.resolve({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    await flush();
    const result = session.signIn('correct-horse');
    logins[0]?.resolve({ kind: 'accepted', bundle: BUNDLE });
    await expect(result).resolves.toBe('accepted');
    expect(session.bearer()).toBe(BUNDLE.token);
    stop();
});

const CONFIG = {
    hostname: 'fixture-phi',
    workspaces: ['/a', '/b'],
    hiddenTerminal: false,
    reuseTab: true,
    autoReconnect: 'visible',
    fastMode: false,
    piOffline: false,
    piBridgeNoInject: false,
    claudeSkipPermissions: false,
    agyThemeAnsi: false,
    opencodeIdleMinutes: 30,
};
const VERSION = {
    version: '0.33.0',
    commit: 'abc1234567890',
    date: '2026-11-02',
    buildSource: 'test',
};

function storeHarness(
    options: {
        config?: ConfigDocumentOutcome;
        version?: VersionOutcome;
        post?: PostOutcome;
        storage?: Map<string, string>;
        token?: string | null;
    } = {},
) {
    const store = options.storage ?? new Map<string, string>();
    const seen: Array<string | undefined> = [];
    const posts: Array<{ path: string; body: string }> = [];
    const broadcasts: Array<{
        type: string;
        payload?: Record<string, unknown>;
    }> = [];
    let token: string | null = options.token ?? 'live-token';
    const http: ConnectionService = {
        serverLabel: UPSTREAM,
        getStatus: () => Promise.resolve('disabled'),
        getAuthStatus: () =>
            Promise.resolve({ kind: 'cancelled' } as AuthStatusOutcome),
        login: () => Promise.resolve({ kind: 'cancelled' } as LoginOutcome),
        refresh: () => Promise.resolve({ kind: 'cancelled' } as RefreshOutcome),
        getConfigHostname: () =>
            Promise.resolve({ kind: 'unavailable' } as ConfigOutcome),
        getConfigDocument: (_signal, bearer) => {
            seen.push(bearer);
            return Promise.resolve(
                options.config ?? { kind: 'ok', document: CONFIG },
            );
        },
        getVersion: () =>
            Promise.resolve(
                options.version ?? { kind: 'ok', document: VERSION },
            ),
        postConfig: (path, body) => {
            posts.push({ path, body });
            return Promise.resolve(
                options.post ?? ({ kind: 'ok' } as PostOutcome),
            );
        },
    };
    const settings = createSettingsStore(
        http,
        () => token,
        {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => {
                store.set(key, value);
            },
        },
        (type, payload) => {
            broadcasts.push({ type, payload });
        },
    );
    return {
        settings,
        store,
        seen,
        posts,
        broadcasts,
        setToken: (next: string | null) => {
            token = next;
        },
    };
}

it('loads About from the server and caches the config', async () => {
    const { settings, store, seen } = storeHarness();
    const stop = settings.start(() => {});
    await flush();
    expect(settings.view()).toMatchObject({
        ready: true,
        pending: false,
        note: null,
        about: {
            hostname: 'FIXTURE-PHI',
            buildSource: 'test',
            workspaces: 2,
            version: '0.33.0',
            commit: 'abc1234567890',
        },
    });
    expect(seen).toEqual(['live-token']);
    expect(store.get(`phi:settings-config:v1:${UPSTREAM}`)).toBe(
        JSON.stringify({ schema: 1, config: CONFIG }),
    );
    stop();
});

it('reads the bearer per request instead of caching it', async () => {
    const { settings, seen, setToken } = storeHarness();
    const stop = settings.start(() => {});
    await flush();
    setToken('rotated-token');
    settings.retry();
    await flush();
    expect(seen).toEqual(['live-token', 'rotated-token']);
    stop();
});

it('ignores corrupt cache and loads live', async () => {
    const storage = new Map<string, string>([
        [`phi:settings-config:v1:${UPSTREAM}`, '{not json'],
    ]);
    const { settings } = storeHarness({ storage });
    const stop = settings.start(() => {});
    await flush();
    expect(settings.view()).toMatchObject({ ready: true, note: null });
    expect(settings.view().about?.hostname).toBe('FIXTURE-PHI');
    stop();
});

it('ignores cache with a foreign schema', async () => {
    const storage = new Map<string, string>([
        [
            `phi:settings-config:v1:${UPSTREAM}`,
            JSON.stringify({ schema: 999, config: CONFIG }),
        ],
    ]);
    const { settings, store } = storeHarness({ storage });
    const stop = settings.start(() => {});
    await flush();
    // Foreign cache is not trusted, then overwritten by the live load.
    expect(
        JSON.parse(store.get(`phi:settings-config:v1:${UPSTREAM}`) ?? ''),
    ).toMatchObject({ schema: 1 });
    expect(settings.view()).toMatchObject({ ready: true, note: null });
    stop();
});

it('keeps the cached About with a stale note when the load fails', async () => {
    const storage = new Map<string, string>([
        [
            `phi:settings-config:v1:${UPSTREAM}`,
            JSON.stringify({ schema: 1, config: CONFIG }),
        ],
    ]);
    const { settings } = storeHarness({
        storage,
        config: { kind: 'unavailable' },
        version: { kind: 'unavailable' },
    });
    const stop = settings.start(() => {});
    await flush();
    expect(settings.view()).toMatchObject({
        ready: true,
        pending: false,
        note: 'settings-stale',
    });
    expect(settings.view().about?.hostname).toBe('FIXTURE-PHI');
    stop();
});

it('reports unavailable without cache when the load fails', async () => {
    const { settings } = storeHarness({
        config: { kind: 'rejected', status: 401 },
        version: { kind: 'rejected', status: 401 },
    });
    const stop = settings.start(() => {});
    await flush();
    expect(settings.view()).toMatchObject({
        ready: false,
        pending: false,
        about: null,
        note: 'settings-unavailable',
    });
    stop();
});

it('falls back to an empty version without failing the load', async () => {
    const { settings } = storeHarness({
        version: { kind: 'unavailable' },
    });
    const stop = settings.start(() => {});
    await flush();
    expect(settings.view()).toMatchObject({ ready: true, note: null });
    expect(settings.view().about?.version).toBe('');
    stop();
});

it('recovers on retry after a failed load', async () => {
    let attempt = 0;
    const store = new Map<string, string>();
    const http: ConnectionService = {
        serverLabel: UPSTREAM,
        getStatus: () => Promise.resolve('disabled'),
        getAuthStatus: () =>
            Promise.resolve({ kind: 'cancelled' } as AuthStatusOutcome),
        login: () => Promise.resolve({ kind: 'cancelled' } as LoginOutcome),
        refresh: () => Promise.resolve({ kind: 'cancelled' } as RefreshOutcome),
        getConfigHostname: () =>
            Promise.resolve({ kind: 'unavailable' } as ConfigOutcome),
        getConfigDocument: () => {
            attempt += 1;
            return Promise.resolve(
                attempt === 1
                    ? ({ kind: 'unavailable' } as ConfigDocumentOutcome)
                    : ({
                          kind: 'ok',
                          document: CONFIG,
                      } as ConfigDocumentOutcome),
            );
        },
        getVersion: () => Promise.resolve({ kind: 'ok', document: VERSION }),
        postConfig: () => Promise.resolve({ kind: 'ok' } as PostOutcome),
    };
    const settings = createSettingsStore(http, () => null, {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
            store.set(key, value);
        },
    });
    const stop = settings.start(() => {});
    await flush();
    expect(settings.view().note).toBe('settings-unavailable');
    settings.retry();
    await flush();
    expect(settings.view()).toMatchObject({ ready: true, note: null });
    stop();
});

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });

it('strict-decodes the config document through the real service', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        json({
            hostname: 'real-phi',
            workspaces: ['/x'],
            use_hidden_terminal: true,
            use_existing_terminal_tab: false,
            auto_reconnect: 'off',
            fast_mode: false,
            pi_offline: true,
            pi_bridge_no_inject: false,
            claude_dangerously_skip_permissions: false,
            agy_theme_ansi: true,
            opencode_idle_stop_minutes: 60,
            extra: 1,
        }),
    );
    const service = createConnectionService(fetcher, UPSTREAM);
    expect(await service.getConfigDocument(signal(), 'tok')).toEqual({
        kind: 'ok',
        document: {
            hostname: 'real-phi',
            workspaces: ['/x'],
            hiddenTerminal: true,
            reuseTab: false,
            autoReconnect: 'off',
            fastMode: false,
            piOffline: true,
            piBridgeNoInject: false,
            claudeSkipPermissions: false,
            agyThemeAnsi: true,
            opencodeIdleMinutes: 60,
        },
    });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
        '/api/config',
        expect.objectContaining({
            method: 'GET',
            credentials: 'omit',
            headers: expect.objectContaining({
                Authorization: 'Bearer tok',
                'X-Phi-Upstream': UPSTREAM,
            }),
        }),
    );
});

const VALID_DOC = {
    hostname: 'h',
    workspaces: [],
    use_hidden_terminal: false,
    use_existing_terminal_tab: false,
    auto_reconnect: 'visible',
    fast_mode: false,
    pi_offline: false,
    pi_bridge_no_inject: false,
    claude_dangerously_skip_permissions: false,
    agy_theme_ansi: false,
    opencode_idle_stop_minutes: 0,
};

it.each([
    ['missing hostname', { ...VALID_DOC, hostname: undefined }],
    ['blank hostname', { ...VALID_DOC, hostname: '' }],
    ['missing workspaces', { ...VALID_DOC, workspaces: undefined }],
    ['non-string workspace', { ...VALID_DOC, workspaces: [7] }],
    ['non-boolean flag', { ...VALID_DOC, pi_offline: 'yes' }],
    ['non-string reconnect', { ...VALID_DOC, auto_reconnect: 1 }],
    ['negative idle', { ...VALID_DOC, opencode_idle_stop_minutes: -5 }],
    ['fractional idle', { ...VALID_DOC, opencode_idle_stop_minutes: 1.5 }],
    ['array body', []],
])('maps %s to unavailable, never partial', async (_label, body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(body));
    const service = createConnectionService(fetcher, UPSTREAM);
    expect(await service.getConfigDocument(signal())).toEqual({
        kind: 'unavailable',
    });
});

it('maps a 401 config read to rejected with its status', async () => {
    const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 401 }));
    const service = createConnectionService(fetcher, UPSTREAM);
    expect(await service.getConfigDocument(signal(), 'stale')).toEqual({
        kind: 'rejected',
        status: 401,
    });
});

it('strict-decodes the version document with optional fields defaulted', async () => {
    const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ version: '1.2.3' }));
    const service = createConnectionService(fetcher, UPSTREAM);
    expect(await service.getVersion(signal())).toEqual({
        kind: 'ok',
        document: { version: '1.2.3', commit: '', date: '', buildSource: '' },
    });
});

it('maps a version body without a version to unavailable', async () => {
    const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ commit: 'abc' }));
    const service = createConnectionService(fetcher, UPSTREAM);
    expect(await service.getVersion(signal())).toEqual({
        kind: 'unavailable',
    });
});

it('posts toggles optimistically and broadcasts on success', async () => {
    const { settings, posts, broadcasts } = storeHarness();
    const stop = settings.start(() => {});
    await flush();
    settings.setToggle('piOffline', true);
    expect(settings.view().controls.piOffline).toBe(true);
    await flush();
    expect(posts).toEqual([
        {
            path: '/api/config/pi-offline',
            body: JSON.stringify({ enabled: true }),
        },
    ]);
    expect(broadcasts).toEqual([{ type: 'behavior', payload: undefined }]);
    stop();
});

it('maps auto-reconnect on to visible and off to off', async () => {
    const { settings, posts } = storeHarness();
    const stop = settings.start(() => {});
    await flush();
    expect(settings.view().controls.autoReconnect).toBe(true);
    settings.setToggle('autoReconnect', false);
    await flush();
    expect(posts).toEqual([
        {
            path: '/api/config/auto-reconnect',
            body: JSON.stringify({ enabled: false }),
        },
    ]);
    stop();
});

it('reads auto-reconnect off as unchecked', async () => {
    const { settings } = storeHarness({
        config: {
            kind: 'ok',
            document: { ...CONFIG, autoReconnect: 'off' },
        },
    });
    const stop = settings.start(() => {});
    await flush();
    expect(settings.view().controls.autoReconnect).toBe(false);
    stop();
});

it('disables reuse while hidden is on, both directions', async () => {
    const { settings } = storeHarness();
    const stop = settings.start(() => {});
    await flush();
    expect(settings.view().controls.reuseDisabled).toBe(false);
    settings.setToggle('hidden', true);
    expect(settings.view().controls.reuseDisabled).toBe(true);
    settings.setToggle('reuse', false);
    expect(settings.view().controls.reuse).toBe(true);
    settings.setToggle('hidden', false);
    expect(settings.view().controls.reuseDisabled).toBe(false);
    settings.setToggle('reuse', false);
    expect(settings.view().controls.reuse).toBe(false);
    stop();
});

it('keeps the optimistic value when the save fails', async () => {
    const { settings, posts } = storeHarness({
        post: { kind: 'unavailable' },
    });
    const stop = settings.start(() => {});
    await flush();
    settings.setToggle('agyTheme', true);
    await flush();
    expect(posts).toHaveLength(1);
    expect(settings.view().controls.agyTheme).toBe(true);
    expect(settings.view().note).toBeNull();
    stop();
});

it('treats a 401 save as failure without touching the session', async () => {
    const { settings } = storeHarness({
        post: { kind: 'rejected', status: 401 },
    });
    const stop = settings.start(() => {});
    await flush();
    settings.setToggle('piOffline', true);
    await flush();
    expect(settings.view().controls.piOffline).toBe(true);
    expect(settings.view().note).toBeNull();
    expect(settings.view().ready).toBe(true);
    stop();
});

it('keeps edited values across a refresh that changes them', async () => {
    const configs = [
        { kind: 'ok', document: CONFIG },
        {
            kind: 'ok',
            document: { ...CONFIG, piOffline: true },
        },
    ] as Array<ConfigDocumentOutcome>;
    let attempt = 0;
    const store = new Map<string, string>();
    const http: ConnectionService = {
        serverLabel: UPSTREAM,
        getStatus: () => Promise.resolve('disabled'),
        getAuthStatus: () =>
            Promise.resolve({ kind: 'cancelled' } as AuthStatusOutcome),
        login: () => Promise.resolve({ kind: 'cancelled' } as LoginOutcome),
        refresh: () => Promise.resolve({ kind: 'cancelled' } as RefreshOutcome),
        getConfigHostname: () =>
            Promise.resolve({ kind: 'unavailable' } as ConfigOutcome),
        getConfigDocument: () =>
            Promise.resolve(
                configs[Math.min(attempt++, 1)] as ConfigDocumentOutcome,
            ),
        getVersion: () => Promise.resolve({ kind: 'ok', document: VERSION }),
        postConfig: () => Promise.resolve({ kind: 'ok' } as PostOutcome),
    };
    const settings = createSettingsStore(http, () => null, {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
            store.set(key, value);
        },
    });
    const stop = settings.start(() => {});
    await flush();
    settings.setIdleMinutes(120);
    expect(settings.view().controls.idleMinutes).toBe(120);
    settings.retry();
    await flush();
    // Server said piOffline=true (un-edited: applied) while the edited
    // idle value survives.
    expect(settings.view().controls.piOffline).toBe(true);
    expect(settings.view().controls.idleMinutes).toBe(120);
    stop();
});

it('posts idle minutes as a number', async () => {
    const { settings, posts } = storeHarness();
    const stop = settings.start(() => {});
    await flush();
    settings.setIdleMinutes(240);
    await flush();
    expect(posts).toEqual([
        {
            path: '/api/config/opencode-idle-stop',
            body: JSON.stringify({ minutes: 240 }),
        },
    ]);
    settings.setIdleMinutes(-1);
    settings.setIdleMinutes(1.5);
    expect(settings.view().controls.idleMinutes).toBe(240);
    expect(posts).toHaveLength(1);
    stop();
});

it('keeps low power local-only and broadcasts the change', async () => {
    const { settings, posts, broadcasts, store } = storeHarness();
    const stop = settings.start(() => {});
    await flush();
    settings.setLowPower(true);
    expect(settings.view().controls.lowPower).toBe(true);
    expect(posts).toHaveLength(0);
    expect(store.get('phi_low_power')).toBe('1');
    expect(broadcasts).toEqual([
        { type: 'low-power', payload: { enabled: true } },
    ]);
    stop();
});

it('migrates a legacy server fast_mode into local storage once', async () => {
    const { settings, store } = storeHarness({
        config: { kind: 'ok', document: { ...CONFIG, fastMode: true } },
    });
    const stop = settings.start(() => {});
    await flush();
    expect(settings.view().controls.lowPower).toBe(true);
    expect(store.get('phi_low_power')).toBe('1');
    stop();
});

it('prefers the stored low-power choice over the server flag', async () => {
    const storage = new Map<string, string>([['phi_low_power', '0']]);
    const { settings } = storeHarness({
        storage,
        config: { kind: 'ok', document: { ...CONFIG, fastMode: true } },
    });
    const stop = settings.start(() => {});
    await flush();
    expect(settings.view().controls.lowPower).toBe(false);
    stop();
});

it('posts toggles with the bearer and v2 auth headers', async () => {
    const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ enabled: true }));
    const service = createConnectionService(fetcher, UPSTREAM);
    expect(
        await service.postConfig(
            '/api/config/pi-offline',
            '{"enabled":true}',
            signal(),
            'tok',
        ),
    ).toEqual({ kind: 'ok' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
        '/api/config/pi-offline',
        expect.objectContaining({
            method: 'POST',
            credentials: 'omit',
            body: '{"enabled":true}',
            headers: expect.objectContaining({
                Authorization: 'Bearer tok',
                'Content-Type': 'application/json',
                'X-Phi-Auth': 'v2',
                'X-Phi-Upstream': UPSTREAM,
            }),
        }),
    );
});

it.each([[500], [400]])(
    'maps a %s toggle save to unavailable',
    async (status) => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response(null, { status }));
        const service = createConnectionService(fetcher, UPSTREAM);
        expect(
            await service.postConfig(
                '/api/config/pi-offline',
                '{"enabled":true}',
                signal(),
            ),
        ).toEqual({ kind: 'unavailable' });
    },
);

afterEach(() => {
    vi.restoreAllMocks();
});
