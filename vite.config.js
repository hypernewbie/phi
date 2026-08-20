import { defineConfig } from 'vite';

// Dev-only live-reload server. Prod serving is the Go binary's embedded web/.
const backend = `localhost:${process.env.PHI_PORT ?? 7070}`;

export default defineConfig({
    root: 'web',
    server: {
        proxy: {
            '/api': `http://${backend}`,
            '/ws': { target: `ws://${backend}`, ws: true },
        },
    },
});
