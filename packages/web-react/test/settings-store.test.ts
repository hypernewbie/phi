// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type {
    AuthStatusOutcome,
    ClearPasswordOutcome,
    ConfigDocumentOutcome,
    ConfigOutcome,
    ConnectionService,
    LoginOutcome,
    MobileFenceOutcome,
    MobileReadOutcome,
    MobileSaveOutcome,
    PostOutcome,
    RefreshOutcome,
    SetPasswordOutcome,
    VersionOutcome,
} from '../src/platform/http.ts';
import { createConnectionService } from '../src/platform/http.ts';
import type { CredentialBundle } from '@phi/core';
import { writeProfileOverride } from '../src/platform/appearance-scope.ts';
import { createSettingsStore } from '../src/platform/settings-store.ts';

const UPSTREAM = 'http://fixture.invalid';
const flush = () => new Promise<void>((done) => setTimeout(done, 0));
const signal = () => new AbortController().signal;

const SCOPE = {
    profileId: '',
    pageOrigin: 'http://fixture.invalid',
    backendOrigin: 'http://fixture.invalid',
};
const OWNER = JSON.stringify([
    'http://fixture.invalid',
    '',
    'http://fixture.invalid',
]);
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
    themeColor: 'purple',
    uiFontFamily: '',
    uiFontSize: 0,
    terminalFontFamily: '',
    terminalFontSize: 0,
    mobileScrollbackRows: 0,
    hostnameOverride: '',
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
        storage?: Map<string, string> | null;
        token?: string | null;
        scope?: typeof SCOPE | null;
        setPassword?: SetPasswordOutcome;
        clearPassword?: ClearPasswordOutcome;
        authStatus?: AuthStatusOutcome;
        protection?: 'enabled' | 'disabled' | 'unknown';
    } = {},
) {
    const backing = options.storage ?? new Map<string, string>();
    const store = backing;
    const seen: Array<string | undefined> = [];
    const posts: Array<{ path: string; body: string }> = [];
    const appearancePosts: Array<string> = [];
    const themePosts: Array<string> = [];
    const passwordPosts: Array<string> = [];
    let clearPosts = 0;
    const adopted: Array<CredentialBundle> = [];
    let disabledCalls = 0;
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
        postAppearance: (body) => {
            appearancePosts.push(body);
            return Promise.resolve(
                options.post ?? ({ kind: 'ok' } as PostOutcome),
            );
        },
        postTheme: (body) => {
            themePosts.push(body);
            return Promise.resolve(
                options.post ?? ({ kind: 'ok' } as PostOutcome),
            );
        },
        setPassword: (password) => {
            passwordPosts.push(password);
            return Promise.resolve(
                options.setPassword ??
                    ({ kind: 'unavailable' } as SetPasswordOutcome),
            );
        },
        clearPassword: () => {
            clearPosts += 1;
            return Promise.resolve(
                options.clearPassword ??
                    ({ kind: 'unavailable' } as ClearPasswordOutcome),
            );
        },
        getMobileAppearance: () =>
            Promise.resolve({
                kind: 'unavailable',
            } as MobileReadOutcome),
        postMobileAppearance: () =>
            Promise.resolve({ kind: 'unknown' } as MobileSaveOutcome),
        postMobileFence: () =>
            Promise.resolve({ kind: 'unknown' } as MobileFenceOutcome),
    };
    if (options.authStatus !== undefined) {
        const status = options.authStatus;
        http.getAuthStatus = () => Promise.resolve(status);
    }
    const settings = createSettingsStore(
        http,
        () => token,
        options.storage === null
            ? null
            : {
                  getItem: (key: string) => store.get(key) ?? null,
                  setItem: (key: string, value: string) => {
                      store.set(key, value);
                  },
                  removeItem: (key: string) => {
                      store.delete(key);
                  },
              },
        (type, payload) => {
            broadcasts.push({ type, payload });
        },
        options.scope === undefined ? SCOPE : options.scope,
        {
            protection: () => options.protection ?? 'enabled',
            adoptBundle: (bundle) => {
                adopted.push(bundle);
            },
            accessDisabled: () => {
                disabledCalls += 1;
            },
        },
    );
    return {
        settings,
        store,
        seen,
        posts,
        appearancePosts,
        themePosts,
        passwordPosts,
        adopted,
        broadcasts,
        clearPosts: () => clearPosts,
        disabledCalls: () => disabledCalls,
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
        postAppearance: () => Promise.resolve({ kind: 'ok' } as PostOutcome),
        postTheme: () => Promise.resolve({ kind: 'ok' } as PostOutcome),
        setPassword: () =>
            Promise.resolve({
                kind: 'unavailable',
            } as SetPasswordOutcome),
        clearPassword: () =>
            Promise.resolve({
                kind: 'unavailable',
            } as ClearPasswordOutcome),
        getMobileAppearance: () =>
            Promise.resolve({
                kind: 'unavailable',
            } as MobileReadOutcome),
        postMobileAppearance: () =>
            Promise.resolve({ kind: 'unknown' } as MobileSaveOutcome),
        postMobileFence: () =>
            Promise.resolve({ kind: 'unknown' } as MobileFenceOutcome),
    };
    const settings = createSettingsStore(http, () => null, {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
            store.set(key, value);
        },
        removeItem: (key: string) => {
            store.delete(key);
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
            themeColor: '',
            uiFontFamily: '',
            uiFontSize: 0,
            terminalFontFamily: '',
            terminalFontSize: 0,
            mobileScrollbackRows: 0,
            hostnameOverride: '',
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

const VALID_BUNDLE_BODY = {
    token: 'rotated-token',
    expires_at: 1000,
    expires_in: 300,
    refresh_idle_expires_at: 2000,
    refresh_absolute_expires_at: 3000,
};

const ROTATED: CredentialBundle = {
    token: 'rotated-token',
    expiresAt: 1000,
    expiresIn: 300,
    refreshIdleExpiresAt: 2000,
    refreshAbsoluteExpiresAt: 3000,
};

it('rejects out-of-range passwords locally without touching the network', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const service = createConnectionService(fetcher, UPSTREAM);
    expect(await service.setPassword('short', signal(), 'tok')).toEqual({
        kind: 'invalid-length',
    });
    expect(
        await service.setPassword('x'.repeat(1025), signal(), 'tok'),
    ).toEqual({ kind: 'invalid-length' });
    expect(fetcher).not.toHaveBeenCalled();
});

it('sets the password bearer-authed and decodes the rotation bundle', async () => {
    const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ enabled: true, ...VALID_BUNDLE_BODY }));
    const service = createConnectionService(fetcher, UPSTREAM);
    expect(
        await service.setPassword('new-secret-12', signal(), 'old-tok'),
    ).toEqual({ kind: 'ok', bundle: ROTATED });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
        '/api/auth/v2/password',
        expect.objectContaining({
            method: 'POST',
            credentials: 'same-origin',
            body: JSON.stringify({ password: 'new-secret-12' }),
            headers: expect.objectContaining({
                Authorization: 'Bearer old-tok',
                'X-Phi-Auth': 'v2',
            }),
        }),
    );
});

it.each([
    ['wrong flag', { enabled: false, ...VALID_BUNDLE_BODY }],
    ['missing flag', { ...VALID_BUNDLE_BODY }],
    ['missing bundle', { enabled: true }],
    ['blank token', { enabled: true, ...VALID_BUNDLE_BODY, token: '' }],
])('maps a set-password %s to unavailable', async (_label, body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(body));
    const service = createConnectionService(fetcher, UPSTREAM);
    expect(await service.setPassword('new-secret-12', signal(), 'tok')).toEqual(
        { kind: 'unavailable' },
    );
});

it('maps a 401 password write to rejected with its status', async () => {
    const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 401 }));
    const service = createConnectionService(fetcher, UPSTREAM);
    expect(
        await service.setPassword('new-secret-12', signal(), 'stale'),
    ).toEqual({ kind: 'rejected', status: 401 });
});

it('clears with an empty password and requires enabled=false', async () => {
    const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ enabled: false }));
    const service = createConnectionService(fetcher, UPSTREAM);
    expect(await service.clearPassword(signal(), 'tok')).toEqual({
        kind: 'ok',
    });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
        '/api/auth/v2/password',
        expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ password: '' }),
        }),
    );
});

it('maps a clear that keeps enabled=true to unavailable', async () => {
    const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ enabled: true }));
    const service = createConnectionService(fetcher, UPSTREAM);
    expect(await service.clearPassword(signal(), 'tok')).toEqual({
        kind: 'unavailable',
    });
});

const VALID_MOBILE = {
    revision: 4,
    ui_font_size: 17,
    terminal_font_size: null,
    ui_font_family: 'Inter',
    terminal_font_family: null,
};

it('reads mobile appearance bearer-authed without cookies', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(VALID_MOBILE));
    const service = createConnectionService(fetcher, UPSTREAM);
    expect(await service.getMobileAppearance(signal(), 'tok')).toEqual({
        kind: 'ok',
        state: VALID_MOBILE,
    });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
        '/api/config/mobile-appearance',
        expect.objectContaining({
            method: 'GET',
            credentials: 'omit',
            headers: expect.objectContaining({
                Authorization: 'Bearer tok',
            }),
        }),
    );
});

it.each([
    ['extra key', { ...VALID_MOBILE, extra: 1 }],
    ['missing key', { revision: 1 }],
    ['negative revision', { ...VALID_MOBILE, revision: -1 }],
    ['fractional revision', { ...VALID_MOBILE, revision: 1.5 }],
    ['ui size too small', { ...VALID_MOBILE, ui_font_size: 9 }],
    ['ui size too large', { ...VALID_MOBILE, ui_font_size: 25 }],
    ['term size too small', { ...VALID_MOBILE, terminal_font_size: 7 }],
    ['term size too large', { ...VALID_MOBILE, terminal_font_size: 33 }],
    ['family too long', { ...VALID_MOBILE, ui_font_family: 'x'.repeat(513) }],
    ['family with control', { ...VALID_MOBILE, ui_font_family: 'a\u0007b' }],
    ['array body', []],
])('maps a mobile read %s to unavailable', async (_label, body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(body));
    const service = createConnectionService(fetcher, UPSTREAM);
    expect(await service.getMobileAppearance(signal(), 'tok')).toEqual({
        kind: 'unavailable',
    });
});

it('maps mobile read statuses to rejected/unsupported/unavailable', async () => {
    for (const status of [401, 403]) {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response(null, { status }));
        const service = createConnectionService(fetcher, UPSTREAM);
        expect(await service.getMobileAppearance(signal(), 'tok')).toEqual({
            kind: 'rejected',
            status,
        });
    }
    for (const status of [400, 500]) {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response(null, { status }));
        const service = createConnectionService(fetcher, UPSTREAM);
        expect(await service.getMobileAppearance(signal(), 'tok')).toEqual({
            kind: 'unavailable',
        });
    }
    const missing = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 404 }));
    expect(
        await createConnectionService(missing, UPSTREAM).getMobileAppearance(
            signal(),
            'tok',
        ),
    ).toEqual({ kind: 'unsupported' });
});

it('saves mobile fields and returns the 200 state as saved', async () => {
    const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ ...VALID_MOBILE, revision: 5 }));
    const service = createConnectionService(fetcher, UPSTREAM);
    const body = JSON.stringify({
        revision: 4,
        fields: { ui_font_size: 17 },
    });
    expect(await service.postMobileAppearance(body, signal(), 'tok')).toEqual({
        kind: 'saved',
        state: { ...VALID_MOBILE, revision: 5 },
    });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
        '/api/config/mobile-appearance',
        expect.objectContaining({
            method: 'POST',
            credentials: 'omit',
            body,
            headers: expect.objectContaining({
                Authorization: 'Bearer tok',
                'X-Phi-Auth': 'v2',
            }),
        }),
    );
});

it('returns the 409 current state as conflict', async () => {
    const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
            new Response(JSON.stringify(VALID_MOBILE), { status: 409 }),
        );
    const service = createConnectionService(fetcher, UPSTREAM);
    expect(await service.postMobileAppearance('{}', signal(), 'tok')).toEqual({
        kind: 'conflict',
        state: VALID_MOBILE,
    });
});

it.each([[400], [401], [403], [404], [405], [413], [415]])(
    'maps a mobile save %s to rejected',
    async (status) => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response(null, { status }));
        const service = createConnectionService(fetcher, UPSTREAM);
        expect(
            await service.postMobileAppearance('{}', signal(), 'tok'),
        ).toEqual({ kind: 'rejected', status });
    },
);

it.each([[500], [503], [418]])(
    'maps a mobile save %s to unknown, never rejected',
    async (status) => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response(null, { status }));
        const service = createConnectionService(fetcher, UPSTREAM);
        expect(
            await service.postMobileAppearance('{}', signal(), 'tok'),
        ).toEqual({ kind: 'unknown' });
    },
);

it('maps a malformed 200 save body to unknown', async () => {
    const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ revision: 5 }));
    const service = createConnectionService(fetcher, UPSTREAM);
    expect(await service.postMobileAppearance('{}', signal(), 'tok')).toEqual({
        kind: 'unknown',
    });
});

it('fences with an empty body and treats 404 as rejected', async () => {
    const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 404 }));
    const service = createConnectionService(fetcher, UPSTREAM);
    expect(await service.postMobileFence(signal(), 'tok')).toEqual({
        kind: 'rejected',
        status: 404,
    });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
        '/api/config/mobile-appearance/fence',
        expect.objectContaining({ method: 'POST', body: '{}' }),
    );
});

it('maps a malformed 200 fence body to unknown', async () => {
    const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ revision: 'six' }));
    const service = createConnectionService(fetcher, UPSTREAM);
    expect(await service.postMobileFence(signal(), 'tok')).toEqual({
        kind: 'unknown',
    });
});

const AUTH_ENABLED: AuthStatusOutcome = {
    kind: 'ok',
    status: { enabled: true, authenticated: true, owned: true },
};

const AUTH_DISABLED: AuthStatusOutcome = {
    kind: 'ok',
    status: { enabled: false, authenticated: false, owned: true },
};

it('initializes security state from the session protection', async () => {
    const { settings } = storeHarness({ protection: 'enabled' });
    const stop = settings.start(() => {});
    await flush();
    expect(settings.view().security).toEqual({
        enabled: true,
        busy: false,
        error: null,
        done: null,
    });
    stop();
});

it.each([
    ['blank', '', ''],
    ['short', 'short', 'short'],
])(
    'rejects a %s password locally without a network call',
    async (_label, next, confirm) => {
        const { settings, passwordPosts } = storeHarness();
        const stop = settings.start(() => {});
        await flush();
        settings.setAccessPassword(next, confirm);
        expect(passwordPosts).toHaveLength(0);
        expect(settings.view().security).toMatchObject({
            error: 'too-short',
            done: null,
            busy: false,
        });
        stop();
    },
);

it('rejects a mismatched confirmation locally without a network call', async () => {
    const { settings, passwordPosts } = storeHarness();
    const stop = settings.start(() => {});
    await flush();
    settings.setAccessPassword('long-enough-1', 'different-2');
    expect(passwordPosts).toHaveLength(0);
    expect(settings.view().security.error).toBe('mismatch');
    stop();
});

it('adopts the rotated bundle on set success and refreshes enabled', async () => {
    const { settings, adopted, passwordPosts } = storeHarness({
        setPassword: { kind: 'ok', bundle: ROTATED },
        authStatus: AUTH_ENABLED,
    });
    const stop = settings.start(() => {});
    await flush();
    settings.setAccessPassword('new-secret-12', 'new-secret-12');
    expect(settings.view().security.busy).toBe(true);
    await flush();
    await flush();
    expect(passwordPosts).toEqual(['new-secret-12']);
    expect(adopted).toEqual([ROTATED]);
    expect(settings.view().security).toMatchObject({
        busy: false,
        error: null,
        done: 'updated',
        enabled: true,
    });
    stop();
});

it('maps a 401 set to inline sign-in text without touching the session', async () => {
    const { settings, adopted, disabledCalls } = storeHarness({
        setPassword: { kind: 'rejected', status: 401 },
    });
    const stop = settings.start(() => {});
    await flush();
    settings.setAccessPassword('new-secret-12', 'new-secret-12');
    await flush();
    expect(settings.view().security).toMatchObject({
        error: 'sign-in',
        done: null,
        busy: false,
    });
    expect(adopted).toHaveLength(0);
    expect(disabledCalls()).toBe(0);
    stop();
});

it('maps a 429 set to inline rate-limit text', async () => {
    const { settings } = storeHarness({
        setPassword: { kind: 'rejected', status: 429 },
    });
    const stop = settings.start(() => {});
    await flush();
    settings.setAccessPassword('new-secret-12', 'new-secret-12');
    await flush();
    expect(settings.view().security.error).toBe('rate-limited');
    stop();
});

it('maps an over-cap password to too-long', async () => {
    const { settings } = storeHarness({
        setPassword: { kind: 'invalid-length' },
    });
    const stop = settings.start(() => {});
    await flush();
    settings.setAccessPassword('x'.repeat(1025), 'x'.repeat(1025));
    await flush();
    expect(settings.view().security.error).toBe('too-long');
    stop();
});

it('clears the password, then notifies on enabled=false', async () => {
    const { settings, adopted, clearPosts, disabledCalls } = storeHarness({
        protection: 'enabled',
        clearPassword: { kind: 'ok' },
        authStatus: AUTH_DISABLED,
    });
    const stop = settings.start(() => {});
    await flush();
    settings.clearAccessPassword();
    await flush();
    await flush();
    expect(clearPosts()).toBe(1);
    expect(adopted).toHaveLength(0);
    expect(disabledCalls()).toBe(1);
    expect(settings.view().security).toMatchObject({
        done: 'removed',
        enabled: false,
        error: null,
        busy: false,
    });
    stop();
});

it('maps a failed clear to clear-failed without notifying', async () => {
    const { settings, disabledCalls } = storeHarness({
        clearPassword: { kind: 'unavailable' },
    });
    const stop = settings.start(() => {});
    await flush();
    settings.clearAccessPassword();
    await flush();
    expect(settings.view().security.error).toBe('clear-failed');
    expect(disabledCalls()).toBe(0);
    stop();
});

it('ignores a second security action while busy', async () => {
    const { settings, passwordPosts, clearPosts } = storeHarness({
        setPassword: { kind: 'ok', bundle: ROTATED },
        authStatus: AUTH_ENABLED,
    });
    const stop = settings.start(() => {});
    await flush();
    settings.setAccessPassword('new-secret-12', 'new-secret-12');
    settings.setAccessPassword('other-secret-1', 'other-secret-1');
    settings.clearAccessPassword();
    expect(passwordPosts).toEqual(['new-secret-12']);
    expect(clearPosts()).toBe(0);
    await flush();
    expect(settings.view().security.done).toBe('updated');
    stop();
});

it('dismisses the security notice on edit', async () => {
    const { settings } = storeHarness();
    const stop = settings.start(() => {});
    await flush();
    settings.setAccessPassword('short', 'short');
    expect(settings.view().security.error).toBe('too-short');
    settings.dismissSecurity();
    expect(settings.view().security).toMatchObject({
        error: null,
        done: null,
    });
    stop();
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
    settings.setToggle('hidden', true);
    expect(settings.view().controls.hidden).toBe(true);
    await flush();
    expect(posts).toEqual([
        {
            path: '/api/config/use-hidden-terminal',
            body: JSON.stringify({ enabled: true }),
        },
    ]);
    expect(broadcasts).toEqual([
        { type: 'behavior', payload: { owner: OWNER } },
    ]);
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
        postAppearance: () => Promise.resolve({ kind: 'ok' } as PostOutcome),
        postTheme: () => Promise.resolve({ kind: 'ok' } as PostOutcome),
        setPassword: () =>
            Promise.resolve({
                kind: 'unavailable',
            } as SetPasswordOutcome),
        clearPassword: () =>
            Promise.resolve({
                kind: 'unavailable',
            } as ClearPasswordOutcome),
        getMobileAppearance: () =>
            Promise.resolve({
                kind: 'unavailable',
            } as MobileReadOutcome),
        postMobileAppearance: () =>
            Promise.resolve({ kind: 'unknown' } as MobileSaveOutcome),
        postMobileFence: () =>
            Promise.resolve({ kind: 'unknown' } as MobileFenceOutcome),
    };
    const settings = createSettingsStore(http, () => null, {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
            store.set(key, value);
        },
        removeItem: (key: string) => {
            store.delete(key);
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
        { type: 'low-power', payload: { owner: OWNER, enabled: true } },
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

it.each([
    ['hidden', true],
    ['reuse', false],
    ['autoReconnect', false],
] as const)('announces %s saves with the owner', async (key, checked) => {
    const { settings, broadcasts } = storeHarness();
    const stop = settings.start(() => {});
    await flush();
    settings.setToggle(key, checked);
    await flush();
    expect(broadcasts).toEqual([
        { type: 'behavior', payload: { owner: OWNER } },
    ]);
    stop();
});

it.each([
    ['piOffline', true],
    ['piBridgeNoInject', true],
    ['claudeSkip', true],
    ['agyTheme', true],
] as const)('saves %s silently without announcing', async (key, checked) => {
    const { settings, posts, broadcasts } = storeHarness();
    const stop = settings.start(() => {});
    await flush();
    settings.setToggle(key, checked);
    await flush();
    expect(posts).toHaveLength(1);
    expect(broadcasts).toHaveLength(0);
    stop();
});

it('saves idle minutes silently without announcing', async () => {
    const { settings, posts, broadcasts } = storeHarness();
    const stop = settings.start(() => {});
    await flush();
    settings.setIdleMinutes(60);
    await flush();
    expect(posts).toHaveLength(1);
    expect(broadcasts).toHaveLength(0);
    stop();
});

it('writes the hostname to browser storage immediately', async () => {
    const { settings, store } = storeHarness();
    const stop = settings.start(() => {});
    await flush();
    settings.setHostnameOverride('  europa  ');
    expect(settings.view().controls.hostnameOverride).toBe('europa');
    expect(JSON.parse(store.get('phi_appearance') ?? '')).toMatchObject({
        hostname_override: 'europa',
    });
    stop();
});

it('mirrors hostname edits once after 300 ms of quiet', async () => {
    vi.useFakeTimers();
    try {
        const { settings, appearancePosts, broadcasts } = storeHarness();
        const stop = settings.start(() => {});
        await vi.advanceTimersByTimeAsync(0);
        settings.setHostnameOverride('one');
        settings.setHostnameOverride('two');
        expect(appearancePosts).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(300);
        expect(appearancePosts).toEqual([
            JSON.stringify({ hostname_override: 'two' }),
        ]);
        await vi.advanceTimersByTimeAsync(0);
        expect(broadcasts).toEqual([
            { type: 'appearance', payload: { owner: OWNER } },
        ]);
        stop();
    } finally {
        vi.useRealTimers();
    }
});

it('keeps the typed hostname when the mirror fails', async () => {
    vi.useFakeTimers();
    try {
        const { settings, appearancePosts } = storeHarness({
            post: { kind: 'unavailable' },
        });
        const stop = settings.start(() => {});
        await vi.advanceTimersByTimeAsync(0);
        settings.setHostnameOverride('europa');
        await vi.advanceTimersByTimeAsync(300);
        expect(appearancePosts).toHaveLength(1);
        expect(settings.view().controls.hostnameOverride).toBe('europa');
        stop();
    } finally {
        vi.useRealTimers();
    }
});

it('reports unavailable without syncing when the scope is invalid', async () => {
    const { settings, broadcasts } = storeHarness({ scope: null });
    const stop = settings.start(() => {});
    await flush();
    expect(settings.view()).toMatchObject({
        ready: false,
        note: 'settings-unavailable',
    });
    settings.setToggle('hidden', true);
    settings.setHostnameOverride('europa');
    await flush();
    expect(broadcasts).toHaveLength(0);
    stop();
});

it('prefers the local appearance key over the server mirror', async () => {
    const storage = new Map<string, string>();
    storage.set(
        'phi_appearance',
        JSON.stringify({
            ui_font_family: 'Local UI',
            ui_font_size: 18,
            terminal_font_family: 'Local Term',
            terminal_font_size: 16,
            mobile_scrollback_rows: 600,
            hostname_override: 'local-label',
            custom_font_name: 'local.woff2',
        }),
    );
    const { settings } = storeHarness({
        storage,
        config: {
            kind: 'ok',
            document: {
                ...CONFIG,
                uiFontFamily: 'Server UI',
                uiFontSize: 12,
                terminalFontFamily: 'Server Term',
                terminalFontSize: 11,
                mobileScrollbackRows: 700,
                hostnameOverride: 'server-label',
            },
        },
    });
    const stop = settings.start(() => {});
    await flush();
    expect(settings.view().appearance).toMatchObject({
        uiFontFamily: 'Local UI',
        uiFontSize: 18,
        terminalFontFamily: 'Local Term',
        terminalFontSize: 16,
        mobileScrollbackRows: 600,
        customFontName: 'local.woff2',
    });
    expect(settings.view().controls.hostnameOverride).toBe('local-label');
    stop();
});

it('seeds appearance from the server when the local key is absent', async () => {
    const { settings } = storeHarness({
        config: {
            kind: 'ok',
            document: {
                ...CONFIG,
                uiFontFamily: 'Server UI',
                uiFontSize: 12,
                terminalFontFamily: '',
                terminalFontSize: 0,
                mobileScrollbackRows: 0,
                hostnameOverride: 'server-label',
            },
        },
    });
    const stop = settings.start(() => {});
    await flush();
    expect(settings.view().appearance).toMatchObject({
        uiFontFamily: 'Server UI',
        uiFontSize: 12,
        terminalFontFamily: '',
        terminalFontSize: 0,
        mobileScrollbackRows: 0,
    });
    expect(settings.view().controls.hostnameOverride).toBe('server-label');
    stop();
});

it.each([
    ['setUIFontSize', '9'],
    ['setUIFontSize', '25'],
    ['setUIFontSize', 'huge'],
    ['setTerminalFontSize', '7'],
    ['setTerminalFontSize', '33'],
    ['setMobileScrollback', '499'],
    ['setMobileScrollback', '10001'],
    ['setMobileScrollback', 'many'],
] as const)(
    'ignores an out-of-range %s %s without posting',
    async (method, raw) => {
        const { settings, store, appearancePosts } = storeHarness();
        const stop = settings.start(() => {});
        await flush();
        const before = settings.view().appearance;
        settings[method](raw);
        expect(settings.view().appearance).toEqual(before);
        expect(store.get('phi_appearance')).toBeUndefined();
        await flush();
        expect(appearancePosts).toHaveLength(0);
        stop();
    },
);

it('merges appearance edits into one post after 300 ms of quiet', async () => {
    vi.useFakeTimers();
    try {
        const { settings, appearancePosts, broadcasts } = storeHarness();
        const stop = settings.start(() => {});
        await vi.advanceTimersByTimeAsync(0);
        settings.setUIFontFamily('Inter, system-ui, sans-serif');
        settings.setTerminalFontSize('16');
        settings.setMobileScrollback('');
        settings.setMobileScrollback('800');
        expect(appearancePosts).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(300);
        expect(appearancePosts).toEqual([
            JSON.stringify({
                ui_font_family: 'Inter, system-ui, sans-serif',
                terminal_font_size: 16,
                mobile_scrollback_rows: 800,
            }),
        ]);
        await vi.advanceTimersByTimeAsync(0);
        expect(broadcasts).toEqual([
            { type: 'appearance', payload: { owner: OWNER } },
        ]);
        stop();
    } finally {
        vi.useRealTimers();
    }
});

it('resets fonts to zeros while the hostname survives', async () => {
    const storage = new Map<string, string>();
    storage.set(
        'phi_appearance',
        JSON.stringify({
            ui_font_family: 'Local UI',
            ui_font_size: 18,
            hostname_override: 'keep-me',
        }),
    );
    const { settings, appearancePosts, broadcasts } = storeHarness({
        storage,
    });
    const stop = settings.start(() => {});
    await flush();
    settings.resetAppearance();
    expect(settings.view().appearance).toMatchObject({
        uiFontFamily: '',
        uiFontSize: 0,
        terminalFontFamily: '',
        terminalFontSize: 0,
    });
    expect(JSON.parse(storage.get('phi_appearance') ?? '')).toMatchObject({
        ui_font_family: '',
        ui_font_size: 0,
        terminal_font_family: '',
        terminal_font_size: 0,
        hostname_override: 'keep-me',
    });
    await flush();
    expect(appearancePosts).toEqual([
        JSON.stringify({
            ui_font_family: '',
            ui_font_size: 0,
            terminal_font_family: '',
            terminal_font_size: 0,
        }),
    ]);
    expect(broadcasts).toEqual([
        { type: 'appearance', payload: { owner: OWNER } },
    ]);
    stop();
});

it('applies the theme locally, saves it, and announces the click', async () => {
    const { settings, store, themePosts, broadcasts } = storeHarness();
    const stop = settings.start(() => {});
    await flush();
    settings.setThemeColor('teal');
    expect(settings.view().appearance.themeColor).toBe('teal');
    expect(document.documentElement.getAttribute('data-theme-color')).toBe(
        'teal',
    );
    expect(store.get('phi_theme_color')).toBe('teal');
    expect(broadcasts).toEqual([
        { type: 'theme', payload: { owner: OWNER, color: 'teal' } },
    ]);
    await flush();
    expect(themePosts).toEqual([JSON.stringify({ color: 'teal' })]);
    stop();
});

it('keeps the picked theme when the save fails', async () => {
    const { settings } = storeHarness({
        post: { kind: 'unavailable' },
    });
    const stop = settings.start(() => {});
    await flush();
    settings.setThemeColor('teal');
    await flush();
    settings.retry();
    await flush();
    expect(settings.view().appearance.themeColor).toBe('teal');
    stop();
});

it('seeds purple when the server sends no theme color', async () => {
    const { settings } = storeHarness({
        config: { kind: 'ok', document: { ...CONFIG, themeColor: '' } },
    });
    const stop = settings.start(() => {});
    await flush();
    expect(settings.view().appearance.themeColor).toBe('purple');
    expect(document.documentElement.getAttribute('data-theme-color')).toBe(
        'purple',
    );
    stop();
});

it('writes the profile override and reports memory-only storage', async () => {
    const { settings, store } = storeHarness();
    const stop = settings.start(() => {});
    await flush();
    expect(settings.view().appearance.profile).toBe('auto');
    settings.setProfile('mobile');
    expect(store.get('phi_appearance_profile')).toBe('mobile');
    expect(settings.view().appearance.profileMemoryOnly).toBe(false);
    stop();
});

it('flags the profile choice memory-only when storage is missing', async () => {
    const { settings } = storeHarness({ storage: null });
    const stop = settings.start(() => {});
    await flush();
    settings.setProfile('mobile');
    expect(settings.view().appearance.profile).toBe('mobile');
    expect(settings.view().appearance.profileMemoryOnly).toBe(true);
    stop();
});

afterEach(() => {
    writeProfileOverride('auto');
    vi.useRealTimers();
    vi.restoreAllMocks();
});
