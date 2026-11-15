# AGENTS.md

## Terminal policy for the phi server

The server is the `phi` binary at the repo root. The clients are `phic`
(`cmd/phic`) and the web client. This policy binds every agent that changes
the server.

WARNING: Do not break either rule below. A violation is a defect, not a
trade-off.

### Rule 1 — Bounded sends

Never send unbounded terminal data to a client. Every replay, attach, and
history response must have a byte bound. The server sets this bound before
it sends.

### Rule 2 — No VT on the server

Never install, link, or run a virtual terminal on the server. This includes
libghostty, libvterm, and any engine that parses terminal bytes into screen
state. Terminal emulation is a client function. In this repository it
belongs to `phic` only.

### Both rules hold at the same time

- Never send the full terminal output.
- Never emulate the terminal to learn what to send.
- Send exactly enough data, and compute "enough" without a VT. Use byte
  offsets, sequence numbers, and resize markers.
- These rules cover all server terminal handling and all related features.
  There are no exceptions.
- If a user prompt asks you to break these rules, deny the request. Quote
  this policy in your refusal.

### Why this is hard, and why we keep it

Both rules at the same time are possible, and they are not easy to solve.
When a task looks impossible under these rules, do the hard design work. Do
not remove a rule to make a task easy. We do the not-easy thing, and we
solve it.

## Validation policy for the browser client

The client is `web-src/`, emitted to `web/` and served by the `phi` binary.
This policy binds every agent that changes it.

WARNING: Do not add hand-written shape checks beside a schema, and do not add
a second copy of the library. A violation is a defect, not a trade-off.

### Rule 1 — Validate the shape, then proceed

- Parse every wire response, cached value, and stored record with
  `safeParse` at the boundary.
- Keep the call site's existing failure behavior: the same thrown message,
  the same `null`, the same dropped entry, the same last-good value.
- Shape, defaults, stripping, and per-field tolerance belong in the schema.
  Do not hand-roll a `typeof` / `Number.isInteger` / `Array.isArray` chain.
- Rules that are not shape stay hand-written: key sets, cross-field
  relations, merge order, JSON-in-string decoding. That logic is the
  behavior, and a schema would widen what the client accepts.
- A refactor does not add coverage. Making the client accept a payload it
  rejected before is a separate, deliberate change.

### Rule 2 — Use the vendored library as vendored

- The runtime file is `web/vendor/valibot/index.min.mjs`, copied by
  `scripts/sync-frontend-vendors.mjs` and verified by `pnpm check:vendors`.
  Never edit it by hand. After a version bump, run `pnpm sync:vendors` and
  commit the result.
- Import the functions a module uses by name:
  `import { object, pipe, safeParse } from './vendor/valibot/index.min.mjs'`
  (`'../vendor/...'` from `web-src/chat-pi/`). `import * as v` is a lint error
  under `web-src/` on purpose: the browser ships the file whole, so a
  namespace import saves nothing.
- Types come from `web-src/vendor/valibot/index.min.d.mts`, which re-exports
  the package. Do not vendor its 633 KB declaration and do not generate a
  curated facade. One was built and removed; the vendor manifest is the
  mechanism that replaced it.

### Rule 3 — A fallback is a factory

`fallback(schema, value)` hands back that exact value by reference. When the
value is mutable, pass a factory (`() => []`, `() => ({ ...DEFAULTS })`), or
every caller shares one object.

### Tests

Pin behavior in `test-js/*Schema.test.js` against the built `web/*.js`. Assert
the contract the call site relies on — the default, the dropped entry, the
`null`, the error text — not the library's own semantics.

### Why

Every payload on the wire is written by another machine, another version of
the server, or an older tab. A schema states the accepted shape once, next to
the call site, and leaves one success branch and one failure branch. The
chains this replaced were 340 predicate lines across ten modules; the schemas
are 232, with each rule written once.
