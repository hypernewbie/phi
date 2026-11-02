import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { createConnectionService } from '../src/platform/http.ts';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});
const signal = () => new AbortController().signal;
const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });

it.each([
    [false, false, 'disabled'],
    [false, true, 'disabled'],
    [true, false, 'protected'],
    [true, true, 'protected'],
] as const)(
    'maps enabled=%s authenticated=%s to %s',
    async (enabled, authenticated, expected) => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValue(json({ enabled, authenticated }));
        const service = createConnectionService(
            fetcher,
            'http://fixture.invalid',
        );
        expect(service.serverLabel).toBe('http://fixture.invalid');
        expect(await service.getStatus(signal())).toBe(expected);
        expect(fetcher).toHaveBeenCalledExactlyOnceWith(
            '/api/auth/v2/status',
            expect.objectContaining({
                method: 'GET',
                credentials: 'omit',
                redirect: 'error',
                headers: { Accept: 'application/json' },
            }),
        );
    },
);

it.each([404, 405])('maps HTTP %s only to unsupported', async (status) => {
    const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('not JSON', { status }));
    expect(
        await createConnectionService(fetcher, 'fixture').getStatus(signal()),
    ).toBe('unsupported');
    expect(fetcher).toHaveBeenCalledOnce();
});

it.each([201, 204, 301, 302, 400, 401, 403, 429, 500])(
    'rejects HTTP %s without fallback',
    async (status) => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response(null, { status }));
        expect(
            await createConnectionService(fetcher, 'fixture').getStatus(
                signal(),
            ),
        ).toBe('unavailable');
        expect(fetcher).toHaveBeenCalledOnce();
    },
);

it.each([404, 405, 500])(
    'closes an unfinished HTTP %s body before returning',
    async (status) => {
        let closed = Promise.resolve();
        const server = createServer((_request, response) => {
            closed = once(response, 'close').then(() => {});
            response.writeHead(status, { 'Content-Type': 'text/plain' });
            response.write('unfinished body');
        });
        try {
            await new Promise<void>((done, fail) => {
                server.once('error', fail);
                server.listen(0, '127.0.0.1', done);
            });
            const address = server.address();
            if (!address || typeof address === 'string')
                throw new Error('Missing fixture port.');
            const origin = `http://127.0.0.1:${address.port}`;
            let requestSignal: AbortSignal | null | undefined;
            const service = createConnectionService((path, options) => {
                requestSignal = options?.signal;
                return fetch(`${origin}${path}`, options);
            }, origin);
            expect(await service.getStatus(signal())).toBe(
                status === 500 ? 'unavailable' : 'unsupported',
            );
            expect(requestSignal?.aborted).toBe(true);
            await closed;
        } finally {
            server.closeAllConnections();
            await new Promise<void>((done, fail) => {
                server.close((error) => (error ? fail(error) : done()));
            });
        }
    },
);

it.each([
    null,
    [],
    {},
    { enabled: false },
    { enabled: 'false', authenticated: false },
    { enabled: true, authenticated: 0 },
])('rejects malformed fields %j', async (body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(body));
    expect(
        await createConnectionService(fetcher, 'fixture').getStatus(signal()),
    ).toBe('unavailable');
});

it('rejects malformed JSON, redirects, and secret-bearing exceptions', async () => {
    const redirected = json({ enabled: false, authenticated: false });
    Object.defineProperty(redirected, 'redirected', { value: true });
    const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('{secret'))
        .mockResolvedValueOnce(redirected)
        .mockRejectedValueOnce(new Error('secret-token'));
    const service = createConnectionService(fetcher, 'fixture');
    for (let index = 0; index < 3; index++)
        expect(await service.getStatus(signal())).toBe('unavailable');
    expect(fetcher).toHaveBeenCalledTimes(3);
});

it('does not fetch for an already cancelled request', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    expect(
        await createConnectionService(fetcher, 'fixture').getStatus(
            controller.signal,
        ),
    ).toBe('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
});

it.each(['fetch', 'body'])(
    'bounds a stalled %s to five seconds even if cancellation is ignored',
    async (stage) => {
        vi.useFakeTimers();
        const response = json({});
        vi.spyOn(response, 'json').mockImplementation(
            () => new Promise(() => {}),
        );
        const fetcher = vi
            .fn<typeof fetch>()
            .mockImplementation(() =>
                stage === 'fetch'
                    ? new Promise(() => {})
                    : Promise.resolve(response),
            );
        const controller = new AbortController();
        const remove = vi.spyOn(controller.signal, 'removeEventListener');
        const result = createConnectionService(fetcher, 'fixture').getStatus(
            controller.signal,
        );
        await vi.advanceTimersByTimeAsync(4_999);
        expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await result).toBe('unavailable');
        expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
        expect(vi.getTimerCount()).toBe(0);
    },
);

it('distinguishes caller abort from timeout and cleans listeners and timer', async () => {
    vi.useFakeTimers();
    const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const result = createConnectionService(fetcher, 'fixture').getStatus(
        controller.signal,
    );
    controller.abort();
    expect(await result).toBe('cancelled');
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
});

it('clears timeout and caller listener after success', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ enabled: false, authenticated: false }));
    expect(
        await createConnectionService(fetcher, 'fixture').getStatus(
            controller.signal,
        ),
    ).toBe('disabled');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
});

const UPSTREAM = 'http://fixture.invalid';
const authed = () => createConnectionService(vi.fn(), UPSTREAM);
const streamed = (text: string, chunkSize: number, status = 200) => {
    const bytes = new TextEncoder().encode(text);
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (let index = 0; index < bytes.length; index += chunkSize)
                controller.enqueue(bytes.subarray(index, index + chunkSize));
            controller.close();
        },
    });
    return new Response(stream, { status });
};
const validBundle = () => ({
    token: 'access-token',
    expires_at: 1_700_000_000,
    expires_in: 3600,
    refresh_idle_expires_at: 1_700_000_000,
    refresh_absolute_expires_at: 1_700_000_000,
});

it('sends the exact uncredentialed status request and decodes all flags', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        json({
            enabled: true,
            authenticated: false,
            owned: true,
            extra: 1,
        }),
    );
    const outcome = await createConnectionService(
        fetcher,
        UPSTREAM,
    ).getAuthStatus(signal());
    expect(outcome).toEqual({
        kind: 'ok',
        status: { enabled: true, authenticated: false, owned: true },
    });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
        '/api/auth/v2/status',
        expect.objectContaining({
            method: 'GET',
            credentials: 'omit',
            redirect: 'error',
            cache: 'no-store',
            headers: {
                Accept: 'application/json',
                'X-Phi-Upstream': UPSTREAM,
            },
        }),
    );
});

it('requires a sent bearer before trusting an authenticated status', async () => {
    const body = { enabled: true, authenticated: true, owned: true };
    const open = vi.fn<typeof fetch>().mockResolvedValue(json(body));
    expect(
        await createConnectionService(open, UPSTREAM).getAuthStatus(signal()),
    ).toEqual({ kind: 'unavailable' });
    const bearer = vi.fn<typeof fetch>().mockResolvedValue(json(body));
    expect(
        await createConnectionService(bearer, UPSTREAM).getAuthStatus(
            signal(),
            'bearer-token',
        ),
    ).toEqual({
        kind: 'ok',
        status: body,
    });
    expect(bearer.mock.calls[0]?.[1]).toMatchObject({
        headers: expect.objectContaining({
            Authorization: 'Bearer bearer-token',
        }),
    });
});

it.each([
    { enabled: true, authenticated: true, owned: false },
    { enabled: false, authenticated: true, owned: true },
    { enabled: true, authenticated: 'yes', owned: true },
    { enabled: true, authenticated: false },
    null,
    [],
    '{broken',
])('rejects inconsistent or malformed status %j', async (body) => {
    const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
            typeof body === 'string' ? new Response(body) : json(body),
        );
    expect(
        await createConnectionService(fetcher, UPSTREAM).getAuthStatus(
            signal(),
            'bearer-token',
        ),
    ).toEqual({ kind: 'unavailable' });
});

it.each([404, 405])(
    'maps unmarked status %s to unsupported',
    async (status) => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response('gone', { status }));
        expect(
            await createConnectionService(fetcher, UPSTREAM).getAuthStatus(
                signal(),
            ),
        ).toEqual({ kind: 'unsupported' });
    },
);

it('maps a proxy-marked 404 to blocked instead of unsupported', async () => {
    const marked = (status: number) =>
        new Response('blocked', {
            status,
            headers: { 'X-Phi-Proxy-Error': 'upstream-mismatch' },
        });
    for (const status of [404, 200]) {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(marked(status));
        const service = createConnectionService(fetcher, UPSTREAM);
        expect(await service.getAuthStatus(signal())).toEqual({
            kind: 'blocked',
        });
        expect(await service.login('password', signal())).toEqual({
            kind: 'blocked',
        });
        expect(await service.getConfigHostname(signal())).toEqual({
            kind: 'blocked',
        });
    }
});

it('bounds the status body to 16 KiB of streamed bytes', async () => {
    const sized = (size: number) => {
        const base =
            '{"enabled":false,"authenticated":false,"owned":true,"pad":""}';
        return base.replace('""', `"${'x'.repeat(size - base.length)}"`);
    };
    const atLimit = vi
        .fn<typeof fetch>()
        .mockResolvedValue(streamed(sized(16 * 1024), 1000));
    expect(
        await createConnectionService(atLimit, UPSTREAM).getAuthStatus(
            signal(),
        ),
    ).toEqual({
        kind: 'ok',
        status: { enabled: false, authenticated: false, owned: true },
    });
    const overLimit = vi
        .fn<typeof fetch>()
        .mockResolvedValue(streamed(sized(16 * 1024 + 1), 1000));
    expect(
        await createConnectionService(overLimit, UPSTREAM).getAuthStatus(
            signal(),
        ),
    ).toEqual({ kind: 'unavailable' });
});

it('sends the exact login request and decodes the bundle', async () => {
    const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(json(validBundle()));
    const outcome = await createConnectionService(fetcher, UPSTREAM).login(
        'correct-horse',
        signal(),
    );
    expect(outcome).toEqual({
        kind: 'accepted',
        bundle: {
            token: 'access-token',
            expiresAt: 1_700_000_000,
            expiresIn: 3600,
            refreshIdleExpiresAt: 1_700_000_000,
            refreshAbsoluteExpiresAt: 1_700_000_000,
        },
    });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
        '/api/auth/v2/login',
        expect.objectContaining({
            method: 'POST',
            credentials: 'same-origin',
            redirect: 'error',
            cache: 'no-store',
            headers: {
                Accept: 'application/json',
                'X-Phi-Upstream': UPSTREAM,
                'Content-Type': 'application/json',
                'X-Phi-Auth': 'v2',
            },
            body: JSON.stringify({ password: 'correct-horse' }),
        }),
    );
});

it.each([
    ['minimum expiry', { expires_in: 1 }],
    ['maximum token', { token: 't'.repeat(8192) }],
    ['additive fields', { enabled: true, session: 'x' }],
])('accepts bundle boundary %s', async (_name, patch) => {
    const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ ...validBundle(), ...patch }));
    const outcome = await createConnectionService(fetcher, UPSTREAM).login(
        'password',
        signal(),
    );
    expect(outcome.kind).toBe('accepted');
});

it.each([
    ['empty token', { token: '' }],
    ['oversized token', { token: 't'.repeat(8193) }],
    ['spaced token', { token: 'has space' }],
    ['unicode token', { token: 'tökén' }],
    ['control token', { token: 'a\tb' }],
    ['zero expiry', { expires_in: 0 }],
    ['overlong expiry', { expires_in: 3601 }],
    ['fractional expiry', { expires_in: 1.5 }],
    ['unsafe expiry', { expires_in: Number.MAX_SAFE_INTEGER + 1 }],
    ['negative idle', { refresh_idle_expires_at: -1 }],
    ['idle past absolute', { refresh_idle_expires_at: 1_700_000_001 }],
    ['missing absolute', { refresh_absolute_expires_at: undefined }],
    ['null body', null],
    ['array body', []],
])('leaves malformed bundle %s unconfirmed', async (_name, patch) => {
    const body =
        patch === null || Array.isArray(patch)
            ? patch
            : { ...validBundle(), ...patch };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(body));
    expect(
        await createConnectionService(fetcher, UPSTREAM).login(
            'password',
            signal(),
        ),
    ).toEqual({ kind: 'unconfirmed' });
});

it.each([
    ['7 bytes', 'a'.repeat(7), false],
    ['8 bytes', 'a'.repeat(8), true],
    ['1024 bytes', 'a'.repeat(1024), true],
    ['1025 bytes', 'a'.repeat(1025), false],
    ['multibyte minimum', 'é'.repeat(4), true],
    ['multibyte overflow', 'é'.repeat(513), false],
    ['whitespace kept', ' '.repeat(8), true],
])(
    'validates password %s locally without normalization',
    async (_name, password, sends) => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValue(json(validBundle()));
        const outcome = await createConnectionService(fetcher, UPSTREAM).login(
            password,
            signal(),
        );
        expect(outcome.kind).toBe(sends ? 'accepted' : 'invalid-length');
        expect(fetcher).toHaveBeenCalledTimes(sends ? 1 : 0);
        if (sends)
            expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
                body: JSON.stringify({ password }),
            });
    },
);

it.each([400, 401, 403, 429, 500, 503])(
    'maps login %s to a rejected attempt without a body leak',
    async (status) => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response('refused', { status }));
        expect(
            await createConnectionService(fetcher, UPSTREAM).login(
                'password',
                signal(),
            ),
        ).toEqual({ kind: 'rejected', status, retryAfterMs: null });
    },
);

it.each([[201], [408], [502]])(
    'leaves login %s unconfirmed',
    async (status) => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response('odd', { status }));
        expect(
            await createConnectionService(fetcher, UPSTREAM).login(
                'password',
                signal(),
            ),
        ).toEqual({ kind: 'unconfirmed' });
    },
);

it.each([
    ['delta seconds', '120', null, 120_000],
    ['zero delay', '0', null, 0],
    ['negative delay', '-1', null, null],
    ['integer prefix', '12x', null, null],
    ['decimal delay', '1.5', null, null],
    ['word delay', 'soon', null, null],
    ['unsafe delay', '99999999999999999999', null, Number.POSITIVE_INFINITY],
] as const)(
    'parses login Retry-After %s',
    async (_name, retryAfter, _date, expected) => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
            new Response('slow', {
                status: 429,
                headers: { 'Retry-After': retryAfter },
            }),
        );
        expect(
            await createConnectionService(fetcher, UPSTREAM).login(
                'password',
                signal(),
            ),
        ).toEqual({ kind: 'rejected', status: 429, retryAfterMs: expected });
    },
);

it('derives HTTP-date waits from the Date header when valid', async () => {
    const target = 'Wed, 01 Jan 2025 00:01:00 GMT';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response('slow', {
            status: 503,
            headers: {
                'Retry-After': target,
                Date: 'Wed, 01 Jan 2025 00:00:00 GMT',
            },
        }),
    );
    expect(
        await createConnectionService(fetcher, UPSTREAM).login(
            'password',
            signal(),
        ),
    ).toEqual({ kind: 'rejected', status: 503, retryAfterMs: 60_000 });
});

it('falls back to receipt time for HTTP-date waits without a valid Date', async () => {
    const target = new Date(Date.now() + 30_000).toUTCString();
    for (const date of [null, 'not-a-date']) {
        const headers: Record<string, string> = { 'Retry-After': target };
        if (date !== null) headers.Date = date;
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response('slow', { status: 503, headers }));
        const outcome = await createConnectionService(fetcher, UPSTREAM).login(
            'password',
            signal(),
        );
        expect(outcome.kind).toBe('rejected');
        const wait = outcome.kind === 'rejected' ? outcome.retryAfterMs : null;
        expect(wait).toBeGreaterThan(25_000);
        expect(wait).toBeLessThanOrEqual(30_000);
    }
});

it('bounds a stalled login to fifteen seconds and releases ownership', async () => {
    vi.useFakeTimers();
    const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    let settled = false;
    const result = createConnectionService(fetcher, UPSTREAM)
        .login('password', controller.signal)
        .finally(() => {
            settled = true;
        });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ kind: 'unconfirmed' });
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
});

it('closes an unfinished rejection body before returning', async () => {
    let closed = Promise.resolve();
    const server = createServer((_request, response) => {
        closed = once(response, 'close').then(() => {});
        response.writeHead(401, { 'Content-Type': 'text/plain' });
        response.write('unfinished body');
    });
    try {
        await new Promise<void>((done, fail) => {
            server.once('error', fail);
            server.listen(0, '127.0.0.1', done);
        });
        const address = server.address();
        if (!address || typeof address === 'string')
            throw new Error('Missing fixture port.');
        const origin = `http://127.0.0.1:${address.port}`;
        const service = createConnectionService(
            (path, options) => fetch(`${origin}${path}`, options),
            origin,
        );
        expect(await service.login('password', signal())).toEqual({
            kind: 'rejected',
            status: 401,
            retryAfterMs: null,
        });
        await closed;
    } finally {
        server.closeAllConnections();
        await new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
        });
    }
});

it('sends the exact config request and projects only the hostname', async () => {
    const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
            json({ hostname: 'phi-1', secret: 'discarded', nested: { a: 1 } }),
        );
    const outcome = await createConnectionService(
        fetcher,
        UPSTREAM,
    ).getConfigHostname(signal(), 'bearer-token');
    expect(outcome).toEqual({ kind: 'ok', hostname: 'phi-1' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
        '/api/config',
        expect.objectContaining({
            method: 'GET',
            credentials: 'omit',
            redirect: 'error',
            cache: 'no-store',
            headers: {
                Accept: 'application/json',
                'X-Phi-Upstream': UPSTREAM,
                Authorization: 'Bearer bearer-token',
            },
        }),
    );
});

it('omits the bearer for uncredentialed config reads', async () => {
    const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ hostname: 'phi-1' }));
    expect(
        await createConnectionService(fetcher, UPSTREAM).getConfigHostname(
            signal(),
        ),
    ).toEqual({ kind: 'ok', hostname: 'phi-1' });
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
        headers: {
            Accept: 'application/json',
            'X-Phi-Upstream': UPSTREAM,
        },
    });
});

it.each([
    ['absent hostname', {}, 'unavailable'],
    ['empty hostname', { hostname: '' }, 'unavailable'],
    ['oversized hostname', { hostname: 'h'.repeat(256) }, 'unavailable'],
    ['401 rejection', null, 'rejected-401'],
    ['403 route error', null, 'rejected-403'],
    ['missing route', null, 'unsupported'],
    ['server failure', null, 'unavailable'],
] as const)(
    'maps config %s without leaking state',
    async (_name, body, expected) => {
        const status =
            expected === 'rejected-401'
                ? 401
                : expected === 'rejected-403'
                  ? 403
                  : expected === 'unsupported'
                    ? 404
                    : expected === 'unavailable' && body === null
                      ? 500
                      : 200;
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValue(
                body === null
                    ? new Response('x', { status })
                    : json(body, status),
            );
        const outcome = await createConnectionService(
            fetcher,
            UPSTREAM,
        ).getConfigHostname(signal(), 'bearer-token');
        if (expected === 'rejected-401')
            expect(outcome).toEqual({ kind: 'rejected', status: 401 });
        else if (expected === 'rejected-403')
            expect(outcome).toEqual({ kind: 'rejected', status: 403 });
        else if (expected === 'unsupported')
            expect(outcome).toEqual({ kind: 'unsupported' });
        else expect(outcome).toEqual({ kind: 'unavailable' });
    },
);

it('bounds the config body to 4 MiB of streamed bytes', async () => {
    const sized = (size: number) => {
        const base = '{"hostname":"phi-1","pad":""}';
        return base.replace('""', `"${'x'.repeat(size - base.length)}"`);
    };
    const atLimit = vi
        .fn<typeof fetch>()
        .mockResolvedValue(streamed(sized(4 * 1024 * 1024), 65536));
    expect(
        await createConnectionService(atLimit, UPSTREAM).getConfigHostname(
            signal(),
        ),
    ).toEqual({ kind: 'ok', hostname: 'phi-1' });
    const overLimit = vi
        .fn<typeof fetch>()
        .mockResolvedValue(streamed(sized(4 * 1024 * 1024 + 1), 65536));
    expect(
        await createConnectionService(overLimit, UPSTREAM).getConfigHostname(
            signal(),
        ),
    ).toEqual({ kind: 'unavailable' });
});

it('cancels new auth requests without sending when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    const service = createConnectionService(fetcher, UPSTREAM);
    expect(await service.getAuthStatus(controller.signal)).toEqual({
        kind: 'cancelled',
    });
    expect(await service.login('password', controller.signal)).toEqual({
        kind: 'cancelled',
    });
    expect(await service.getConfigHostname(controller.signal)).toEqual({
        kind: 'cancelled',
    });
    expect(fetcher).not.toHaveBeenCalled();
});

it('keeps the shared upstream label on the extended service', () => {
    expect(authed().serverLabel).toBe(UPSTREAM);
});

it('sends the exact refresh request and decodes the bundle', async () => {
    const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(json(validBundle()));
    const outcome = await createConnectionService(fetcher, UPSTREAM).refresh(
        signal(),
    );
    expect(outcome).toEqual({
        kind: 'accepted',
        bundle: {
            token: 'access-token',
            expiresAt: 1_700_000_000,
            expiresIn: 3600,
            refreshIdleExpiresAt: 1_700_000_000,
            refreshAbsoluteExpiresAt: 1_700_000_000,
        },
    });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
        '/api/auth/v2/refresh',
        expect.objectContaining({
            method: 'POST',
            credentials: 'same-origin',
            redirect: 'error',
            cache: 'no-store',
            headers: {
                Accept: 'application/json',
                'X-Phi-Upstream': UPSTREAM,
                'Content-Type': 'application/json',
                'X-Phi-Auth': 'v2',
            },
            body: '{}',
        }),
    );
});

it.each([
    ['rejected 401', 401, 'rejected'],
    ['rejected 500', 500, 'rejected'],
    ['failed 200 body', 200, 'unconfirmed'],
    ['unsupported 404', 404, 'unsupported'],
    ['network failure', 0, 'unconfirmed'],
] as const)(
    'maps refresh outcome %s distinctly',
    async (_name, status, expected) => {
        const fetcher =
            status === 0
                ? vi.fn<typeof fetch>().mockRejectedValue(new Error('down'))
                : vi
                      .fn<typeof fetch>()
                      .mockResolvedValue(
                          status === 200
                              ? json({ nope: true })
                              : json({}, status),
                      );
        const outcome = await createConnectionService(
            fetcher,
            UPSTREAM,
        ).refresh(signal());
        expect(outcome.kind).toBe(expected);
        if (outcome.kind === 'rejected') expect(outcome.status).toBe(status);
    },
);

it('bounds the refresh body to 16 KiB of streamed bytes', async () => {
    const sized = (size: number) => {
        const padding = 'p'.repeat(Math.max(0, size - 20));
        return streamed(JSON.stringify({ token: padding }), 1024);
    };
    const under = vi.fn<typeof fetch>().mockResolvedValue(sized(16 * 1024));
    expect(
        (await createConnectionService(under, UPSTREAM).refresh(signal())).kind,
    ).not.toBe('cancelled');
    const over = vi.fn<typeof fetch>().mockResolvedValue(sized(16 * 1024 + 1));
    expect(
        await createConnectionService(over, UPSTREAM).refresh(signal()),
    ).toEqual({ kind: 'unconfirmed' });
});

it('cancels a refresh without sending when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    expect(
        await createConnectionService(fetcher, UPSTREAM).refresh(
            controller.signal,
        ),
    ).toEqual({ kind: 'cancelled' });
    expect(fetcher).not.toHaveBeenCalled();
});
