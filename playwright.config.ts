/// <reference types="node" />

import { defineConfig } from '@playwright/test';

// Spot-checks only (e2e/). The suites in test-js/ remain the default
// `pnpm test` (vitest); these specs need a real browser + a live phi
// server, so they run on demand: `npx playwright test`.
export default defineConfig({
    testDir: './e2e',
    // Native acceptance needs a desktop display + built Electron assets.
    // Run it explicitly with pnpm test:e2e:desktop, not in Chromium CI.
    testIgnore: '**/mobile-settings-desktop.spec.ts',
    timeout: 120_000,
    retries: 0,
    // Sibling paths, not the shared parents: each suite wipes its own
    // outputDir and report folder, and packages/web-react writes under
    // test-results/web-react and playwright-report/web-react.
    outputDir: 'test-results/legacy',
    reporter: [
        ['line'],
        ['html', { outputFolder: 'playwright-report/legacy', open: 'never' }],
    ],
    use: {
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        // Local runs reuse the machine's Edge instead of downloading
        // Chromium (CI has no Edge: set PW_CHANNEL=chromium there, or
        // leave unset and `npx playwright install chromium` in the job).
        ...(process.env.PW_CHANNEL
            ? { channel: process.env.PW_CHANNEL as 'msedge' }
            : {}),
    },
});
