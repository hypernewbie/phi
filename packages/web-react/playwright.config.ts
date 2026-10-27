import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig({
    testDir: './test/e2e',
    timeout: 120_000,
    workers: 1,
    retries: 0,
    outputDir: `${root}test-results/web-react/browser`,
    reporter: [
        ['list'],
        [
            'html',
            {
                outputFolder: `${root}playwright-report/web-react`,
                open: 'never',
            },
        ],
    ],
    use: {
        browserName: 'chromium',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        serviceWorkers: 'block',
    },
    projects: [
        { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
        { name: 'narrow', use: { viewport: { width: 390, height: 844 } } },
    ],
});
