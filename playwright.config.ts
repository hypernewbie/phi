import { defineConfig } from '@playwright/test';

// Spot-checks only (e2e/). The suites in test-js/ remain the default
// `pnpm test` (vitest); these specs need a real browser + a live phi
// server, so they run on demand: `npx playwright test`.
export default defineConfig({
    testDir: './e2e',
    timeout: 120_000,
    retries: 0,
    reporter: 'line',
    use: {
        // Local runs reuse the machine's Edge instead of downloading
        // Chromium (CI has no Edge: set PW_CHANNEL=chromium there, or
        // leave unset and `npx playwright install chromium` in the job).
        ...(process.env.PW_CHANNEL
            ? { channel: process.env.PW_CHANNEL as 'msedge' }
            : {}),
    },
});
