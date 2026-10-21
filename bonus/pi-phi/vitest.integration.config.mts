import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['test/integration.test.ts', 'test/summary-provider.test.ts'],
        testTimeout: 120_000,
        hookTimeout: 30_000,
        reporters: ['default'],
    },
});
