import { defineConfig } from '@playwright/test';
import browserConfig from './playwright.config.js';

// Real native acceptance, not smoke mode. Requires an installed Electron
// runtime and a desktop display; failures are never converted into skips.
export default defineConfig({
    ...browserConfig,
    testMatch: [
        '**/mobile-settings-desktop.spec.ts',
        '**/terminal-ram-electron.spec.ts',
        '**/desktop-switch-storm.spec.ts',
        '**/desktop-identity-attribution.spec.ts',
        // Real Electron specs that the Chromium suite cannot build for.
        '**/auth-desktop.spec.ts',
        '**/desktop-shell-drawer.spec.ts',
        '**/desktop-workspace-manager.spec.ts',
    ],
    testIgnore: [],
    workers: 1,
    outputDir: 'test-results/desktop',
    reporter: [
        ['line'],
        ['html', { outputFolder: 'playwright-report/desktop', open: 'never' }],
    ],
});
