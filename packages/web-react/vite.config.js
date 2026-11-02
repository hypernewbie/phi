/** @param {string | undefined} port @returns {import('vite').UserConfig} */
export function makeViteConfig(port = process.env.PHI_PORT) {
    if (
        port !== undefined &&
        (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    ) {
        throw new Error('PHI_PORT must be an integer from 1 to 65535.');
    }
    const upstreamOrigin = `http://127.0.0.1:${port === undefined ? 7070 : Number(port)}`;
    /** @type {import('vite').ProxyOptions} */
    const apiProxy = {
        target: upstreamOrigin,
        changeOrigin: false,
        // An old tab must not send a bearer or refresh cookie through a
        // newly retargeted proxy. Count occurrences in rawHeaders: Node
        // joins duplicate headers, which would hide a second value.
        bypass(req, res) {
            const values = [];
            const raw = req.rawHeaders ?? [];
            for (let index = 0; index < raw.length; index += 2) {
                if (String(raw[index]).toLowerCase() === 'x-phi-upstream')
                    values.push(raw[index + 1]);
            }
            if (values.length !== 1 || values[0] !== upstreamOrigin) {
                res?.setHeader('X-Phi-Proxy-Error', 'upstream-mismatch');
                res?.setHeader('Cache-Control', 'no-store');
                return false;
            }
            return null;
        },
        configure(proxy) {
            proxy.on('proxyReq', (proxyReq, req) => {
                proxyReq.removeHeader('X-Phi-Upstream');
                const path = String(req.url ?? '').split('?')[0];
                const refresh =
                    req.method === 'POST' && path === '/api/auth/v2/refresh';
                if (!refresh) {
                    proxyReq.removeHeader('Cookie');
                    return;
                }
                const kept = [];
                const raw = req.rawHeaders ?? [];
                for (let index = 0; index < raw.length; index += 2) {
                    if (String(raw[index]).toLowerCase() !== 'cookie') continue;
                    for (const pair of String(raw[index + 1]).split(';')) {
                        const trimmed = pair.trim();
                        if (
                            trimmed.split('=')[0].trim() ===
                            'phi_access_refresh'
                        )
                            kept.push(trimmed);
                    }
                }
                proxyReq.removeHeader('Cookie');
                if (kept.length > 0)
                    proxyReq.setHeader('Cookie', kept.join('; '));
            });
        },
    };
    /** @type {import('vite').ProxyOptions} */
    const publicDocument = {
        target: upstreamOrigin,
        changeOrigin: false,
        configure(proxy) {
            proxy.on('proxyReq', (request) => {
                request.removeHeader('Authorization');
                request.removeHeader('Cookie');
            });
        },
    };
    return {
        envPrefix: [],
        define: { __PHI_UPSTREAM_ORIGIN__: JSON.stringify(upstreamOrigin) },
        server: {
            host: '127.0.0.1',
            port: 5173,
            strictPort: true,
            proxy: {
                '/api': apiProxy,
                '/ws': {
                    target: upstreamOrigin,
                    changeOrigin: false,
                    ws: true,
                },
                '^/help\\.md$': publicDocument,
                '^/changelog\\.md$': publicDocument,
            },
        },
    };
}

export default makeViteConfig();
