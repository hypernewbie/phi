// Test-only bridge.
//
// `web-src/*.ts` imports `./valibot.js`, which in the browser is the bundled
// `web/valibot.js` and in TypeScript is the generated `web-src/valibot.d.ts`.
// A few unit tests import the TypeScript sources directly (through Vite), and
// Vite needs a real file at that specifier, so this re-exports the shipped
// bundle unchanged. The browser never loads this file: only `web/` is embedded
// in the server binary.
export { v } from '../web/valibot.js';
