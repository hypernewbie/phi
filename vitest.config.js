import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Frontend JS tests live outside web/ on purpose: web/ is baked into
        // the Go binary via `//go:embed all:web`, so anything under web/ would
        // ship inside phi.exe. Keep tests in test-js/ instead.
        include: [
            'test-js/**/*.test.js',
            'packages/phi-core/test/**/*.test.ts',
            'packages/web-react/test/**/*.test.{ts,tsx}',
        ],
        exclude: ['e2e/**', 'packages/*/test/e2e/**', 'node_modules/**'],

        // Default to a plain Node environment (fast, no DOM). Pure helpers do
        // not need a DOM. For a file that exercises document/window, add a
        // docblock at the top of that file:
        //   // @vitest-environment jsdom
        // and install jsdom (not needed yet for the current pure-function tests).
        environment: 'node',

        coverage: {
            provider: 'v8',
            include: [
                'web/**/*.js',
                'packages/phi-core/src/**/*.ts',
                'packages/web-react/src/**/*.{ts,tsx}',
            ],
            exclude: ['web/vendor/**'],
            reportsDirectory: 'coverage',
        },
    },
});
