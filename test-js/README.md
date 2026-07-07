# Frontend JS tests (Vitest)

Unit tests for the browser JS in `web/`. Kept **outside** `web/` on purpose:
`web/` is embedded into the Go binary via `//go:embed all:web`, so any file
placed under `web/` would ship inside `phi.exe`.

This is separate from the Go test suite (`go test ./...`).

## Run

```sh
npm install          # first time only (installs vitest into node_modules/)
npm test             # run once
npm run test:watch   # watch mode
npm run test:coverage
```

## Layout

- `*.test.js` — one file per unit under test.
- Tests import the real modules from `../web/*.js`. Only pure, side-effect-free
  helpers are covered so far (`normalizePath`, `normalizeCwd`).

## Adding DOM-dependent tests

The default environment is plain Node (fast, no DOM). For a test that touches
`document`/`window`, add a docblock at the top of that test file:

```js
// @vitest-environment jsdom
```

and add `jsdom` as a devDependency.
