import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { ProxyOptions } from 'vite';
import { afterEach, expect, it, vi } from 'vitest';
import { makeViteConfig } from '../vite.config.js';

afterEach(() => vi.unstubAllEnvs());

it('uses only loopback, the default port, strict ownership, and no automatic environment exposure', () => {
    vi.stubEnv('PHI_PORT', undefined);
    const config = makeViteConfig();
    expect(config.server).toMatchObject({
        host: '127.0.0.1',
        port: 5173,
        strictPort: true,
    });
    expect(config.envPrefix).toEqual([]);
    expect(config.define).toEqual({
        __PHI_UPSTREAM_ORIGIN__: '"http://127.0.0.1:7070"',
        __PHI_DIRECT_SERVE__: 'false',
    });
});

it('marks a phi-served build when PHI_DIRECT=1', () => {
    vi.stubEnv('PHI_DIRECT', '1');
    expect(makeViteConfig().define?.__PHI_DIRECT_SERVE__).toBe('true');
});

it.each(['1', '65535', '17070'])('uses validated PHI_PORT %s', (port) => {
    vi.stubEnv('PHI_PORT', port);
    const config = makeViteConfig();
    expect(config.define?.__PHI_UPSTREAM_ORIGIN__).toBe(
        JSON.stringify(`http://127.0.0.1:${port}`),
    );
    const proxies = config.server?.proxy ?? {};
    expect(proxies['/ws']).toEqual({
        target: `http://127.0.0.1:${port}`,
        changeOrigin: false,
        ws: true,
    });
    expect(proxies['/api']).toMatchObject({
        target: `http://127.0.0.1:${port}`,
        changeOrigin: false,
    });
    expect(typeof (proxies['/api'] as ProxyOptions).bypass).toBe('function');
    expect(typeof (proxies['/api'] as ProxyOptions).configure).toBe('function');
    expect(proxies['/ws']).not.toHaveProperty('rewriteWsOrigin');
});

it.each([
    '',
    '0',
    '65536',
    '-1',
    '1.5',
    '1e3',
    ' 7070',
    '7070 ',
    'secret.invalid',
])('rejects invalid port %j', (port) => {
    expect(() => makeViteConfig(port)).toThrow(
        'PHI_PORT must be an integer from 1 to 65535.',
    );
});

it('proxies exactly the two public documents and strips their credentials without rewriting Host/Origin', () => {
    const proxies = makeViteConfig('17070').server?.proxy ?? {};
    expect(Object.keys(proxies)).toEqual([
        '/api',
        '/ws',
        '^/help\\.md$',
        '^/changelog\\.md$',
    ]);
    for (const path of ['/help.md', '/changelog.md']) {
        const key = Object.keys(proxies).find(
            (candidate) =>
                candidate.startsWith('^') && new RegExp(candidate).test(path),
        );
        expect(key).toBeDefined();
        expect(new RegExp(key ?? '').test(`${path}/secret`)).toBe(false);
        expect(new RegExp(key ?? '').test(`${path}.html`)).toBe(false);
        const proxy = proxies[key ?? ''] as ProxyOptions;
        const server = new EventEmitter();
        const request = { removeHeader: vi.fn() };
        proxy.configure?.(
            server as Parameters<NonNullable<ProxyOptions['configure']>>[0],
            proxy,
        );
        server.emit('proxyReq', request);
        expect(request.removeHeader.mock.calls).toEqual([
            ['Authorization'],
            ['Cookie'],
        ]);
        expect(proxy.changeOrigin).toBe(false);
    }
});

it.each([
    ['matching header', [['X-Phi-Upstream', 'http://127.0.0.1:17070']], null],
    ['missing header', [], false],
    [
        'duplicate header',
        [
            ['X-Phi-Upstream', 'http://127.0.0.1:17070'],
            ['X-Phi-Upstream', 'http://127.0.0.1:17070'],
        ],
        false,
    ],
    ['stale target', [['X-Phi-Upstream', 'http://127.0.0.1:1']], false],
    [
        'case-insensitive name',
        [['X-PHI-UPSTREAM', 'http://127.0.0.1:17070']],
        null,
    ],
] as const)('guards the API proxy on %s', (_name, headers, expected) => {
    const proxy = makeViteConfig('17070').server?.proxy?.[
        '/api'
    ] as ProxyOptions;
    const setHeader = vi.fn();
    const result = proxy.bypass?.(
        { rawHeaders: headers.flat() } as never,
        { setHeader } as never,
        {} as never,
    );
    expect(result).toBe(expected ?? null);
    if (expected === false) {
        expect(setHeader.mock.calls).toEqual([
            ['X-Phi-Proxy-Error', 'upstream-mismatch'],
            ['Cache-Control', 'no-store'],
        ]);
    } else {
        expect(setHeader).not.toHaveBeenCalled();
    }
});

it.each([
    [
        'strips cookies from status reads',
        'GET',
        '/api/auth/v2/status',
        ['Cookie', 'ambient=1'],
        null,
    ],
    [
        'keeps only the refresh cookie on refresh',
        'POST',
        '/api/auth/v2/refresh',
        [
            'Cookie',
            'phi_access_refresh=r1; ambient=1',
            'Cookie',
            'phi_access_asset=a; phi_access_refresh=r2',
        ],
        'phi_access_refresh=r1; phi_access_refresh=r2',
    ],
    [
        'ignores the refresh query string',
        'POST',
        '/api/auth/v2/refresh?probe=1',
        ['Cookie', 'phi_access_refresh=r1'],
        'phi_access_refresh=r1',
    ],
] as const)(
    'filters proxy cookies: %s',
    (_name, method, url, rawHeaders, expected) => {
        const proxy = makeViteConfig('17070').server?.proxy?.[
            '/api'
        ] as ProxyOptions;
        const server = new EventEmitter();
        proxy.configure?.(
            server as Parameters<NonNullable<ProxyOptions['configure']>>[0],
            proxy,
        );
        const proxyReq = { removeHeader: vi.fn(), setHeader: vi.fn() };
        server.emit('proxyReq', proxyReq, { method, url, rawHeaders });
        expect(proxyReq.removeHeader.mock.calls).toContainEqual([
            'X-Phi-Upstream',
        ]);
        expect(proxyReq.removeHeader.mock.calls).toContainEqual(['Cookie']);
        if (expected === null) {
            expect(proxyReq.setHeader).not.toHaveBeenCalled();
        } else {
            expect(proxyReq.setHeader.mock.calls).toEqual([
                ['Cookie', expected],
            ]);
        }
    },
);

it('blocks retargeted API requests at the proxy with zero upstream contact', async () => {
    const { createServer: createVite } = await import('vite');
    const upstreamHits: string[] = [];
    const upstream = createServer((req, res) => {
        upstreamHits.push(
            `${req.method} ${req.url} cookie=${req.headers.cookie ?? ''} ` +
                `upstream=${req.headers['x-phi-upstream'] ?? ''}`,
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
    });
    await new Promise<void>((done, fail) => {
        upstream.once('error', fail);
        upstream.listen(0, '127.0.0.1', done);
    });
    const address = upstream.address();
    if (!address || typeof address === 'string')
        throw new Error('Missing fixture port.');
    const api = makeViteConfig(String(address.port)).server?.proxy?.['/api'];
    if (!api || typeof api === 'string') throw new Error('Missing API proxy.');
    const target = `http://127.0.0.1:${address.port}`;
    const server = await createVite({
        configFile: false,
        root: fileURLToPath(new URL('../', import.meta.url)),
        server: { port: 0, strictPort: false, proxy: { '/api': api } },
    });
    try {
        await server.listen();
        const base = (server.resolvedUrls?.local[0] ?? '').replace(/\/$/, '');
        expect(base).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+$/);
        const attempts: Array<Record<string, string>> = [
            {},
            { 'X-Phi-Upstream': 'http://127.0.0.1:1' },
        ];
        for (const headers of attempts) {
            const blocked = await fetch(`${base}/api/auth/v2/status`, {
                headers,
            });
            expect(blocked.status).toBe(404);
            expect(blocked.headers.get('x-phi-proxy-error')).toBe(
                'upstream-mismatch',
            );
            expect(blocked.headers.get('cache-control')).toBe('no-store');
            await blocked.arrayBuffer();
        }
        expect(upstreamHits).toEqual([]);
        const stripped = await fetch(`${base}/api/auth/v2/status`, {
            headers: { 'X-Phi-Upstream': target, Cookie: 'ambient=1' },
        });
        expect(stripped.status).toBe(200);
        await stripped.arrayBuffer();
        const refresh = await fetch(`${base}/api/auth/v2/refresh`, {
            method: 'POST',
            headers: {
                'X-Phi-Upstream': target,
                Cookie: 'ambient=1; phi_access_refresh=r1',
            },
            body: '{}',
        });
        expect(refresh.status).toBe(200);
        await refresh.arrayBuffer();
        expect(upstreamHits).toEqual([
            'GET /api/auth/v2/status cookie= upstream=',
            'POST /api/auth/v2/refresh cookie=phi_access_refresh=r1 upstream=',
        ]);
    } finally {
        await server.close();
        upstream.closeAllConnections();
        await new Promise<void>((done) => upstream.close(() => done()));
    }
});

it('loads only package-owned fonts with all CSS URLs present', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    expect(readFileSync(`${root}/index.html`, 'utf8')).toContain(
        'href="/fonts/fonts.css"',
    );
    const css = readFileSync(`${root}/public/fonts/fonts.css`, 'utf8');
    const fonts = [...css.matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)].map(
        (match) => match[1],
    );
    expect(new Set(fonts).size).toBe(13);
    for (const font of fonts)
        expect(existsSync(`${root}/public/fonts/${font}`)).toBe(true);
    expect(css).not.toMatch(/https?:/);
});
