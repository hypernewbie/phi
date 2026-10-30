import { defineConfig } from '@playwright/test';
import browserConfig from './playwright.config.js';

// Real native acceptance, not smoke mode. Requires an installed Electron
// runtime and a desktop display; failures are never converted into skips.
export default defineConfig({
    ...browserConfig,
    testMatch: '**/mobile-settings-desktop.spec.ts',
    testIgnore: [],
    workers: 1,
    outputDir: 'test-results/desktop',
    reporter: [
        ['line'],
        ['html', { outputFolder: 'playwright-report/desktop', open: 'never' }],
    ],
});
