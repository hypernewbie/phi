import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';

const outputDir = process.env.PHI_AUTH_E2E_OUTPUT_DIR;
if (!outputDir) throw new Error('PHI_AUTH_E2E_OUTPUT_DIR is required');

export default defineConfig({
    ...base,
    outputDir,
    reporter: 'line',
    use: {
        ...base.use,
        trace: 'off',
        screenshot: 'off',
        video: 'off',
    },
});
