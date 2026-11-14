// The Vite-based suites import the TypeScript sources directly, so they
// resolve this path from web-src/. The browser and the desktop copy resolve
// the same specifier to web/vendor/. Types come from index.min.d.mts.
export * from '../../../web/vendor/valibot/index.min.mjs';
