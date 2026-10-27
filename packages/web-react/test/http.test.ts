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
