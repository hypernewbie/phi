import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
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
    });
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
    expect(proxies['/api']).toEqual({
        target: `http://127.0.0.1:${port}`,
        changeOrigin: false,
    });
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
