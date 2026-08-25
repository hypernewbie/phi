import { defineConfig } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)));
const runtimeHome = resolve(root, 'test/e2e/.runtime-home');
const runtimeDir = resolve(root, '.playwright');
const fixtureBin = resolve(root, 'test/e2e/fixtures/bin');
const fakeLog = resolve(runtimeDir, 'pi-fake.log');
const binary = resolve(runtimeDir, 'phi-e2e');

mkdirSync(resolve(runtimeHome, '.phi'), { recursive: true });
mkdirSync(runtimeDir, { recursive: true });
rmSync(fakeLog, { force: true });
process.env.PI_FAKE_LOG = fakeLog;

export default defineConfig({
    workers: 1,
    outputDir: 'test-results/pi-rpc',
    globalTeardown: './test/e2e/global-teardown.js',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    use: {
        baseURL: 'http://127.0.0.1:17891',
        viewport: { width: 1280, height: 800 },
    },
    projects: [
        {
            name: 'chromium',
            use: { browserName: 'chromium' },
        },
    ],
    webServer: {
        command: `mkdir -p "${runtimeHome}/.phi" "${runtimeDir}" && env HOME="${runtimeHome}" USERPROFILE="${runtimeHome}" PATH="${fixtureBin}:${process.env.PATH || ''}" PI_FAKE_LOG="${fakeLog}" "${binary}" --port 17891 --ip 127.0.0.1`,
        url: 'http://127.0.0.1:17891/readyz',
        reuseExistingServer: false,
        timeout: 120_000,
        gracefulShutdown: 'SIGTERM',
    },
});
