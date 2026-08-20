import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // pet-view runs in jsdom; pet-window/pet-main opt out per-file with
    // `// @vitest-environment node` (the same convention as the shell).
    environment: "jsdom",
    testTimeout: 30_000,
  },
});
