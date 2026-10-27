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
                '/api': { target: upstreamOrigin, changeOrigin: false },
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
