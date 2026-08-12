import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The shell/main unit tests run in jsdom; the e2e smoke test opts out
    // per-file with `// @vitest-environment node` (it spawns the real
    // Electron binary and must not pretend to be a browser).
    environment: 'jsdom',
    // Electron cold start + page load in the smoke test can take a while.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
