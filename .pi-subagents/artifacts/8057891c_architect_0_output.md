Ground-truth confirmed. I've read the actual `loadWorktrees` body, the `runCommand` shell-reuse block, both constructors, `ws.js`, and the config/env. Here's my steer.

---

## Executive take

Your instinct in option (c) is the right default, and your own data proves it: Tier A gave you **91% branch coverage from 70 fast, DOM-free tests**. The 3% statement number is noise — it's dominated by giant view-controllers whose bulk is DOM plumbing that no unit test should assert. **Don't chase statement coverage into those classes.** Chase *behaviors that broke in production* (the worktree/tab-sync bugs) and *decision logic*, wherever it lives.

So the framing I'd push: **jsdom is a scalpel, not the new default.** Introduce it, but reach for it only when the produced DOM *is* the assertion. For everything that's really "a decision over plain data," keep extracting pure cores — that's cheaper, faster, and more durable than any jsdom fixture.

---

## Q1 — Is jsdom worth it? Yes, but narrowly.

Worth adding as a dev-dep and using for **exactly one class of test**: "given data X, the built `.worktree-section` DOM has the right `.active`/`.expanded`/`data-worktree-path` structure." That's `loadWorktrees`, and it's your highest-value target because it's the literal site of d862975/bcb3ee5. DOM *is* the contract there — a pure extraction would either re-implement the node-building (testing a copy, not the code) or strip out the very thing that regressed.

Everywhere else in Tier B, prefer (c). Concretely: **your target #1 (diff shell-tab reuse) should NOT be a jsdom test.** The thing under test is the *matching predicate* — `isUsableShell(t) && normalizeCwd(t.cwd) === wanted`, plus the active-tab-wins precedence. That's pure logic over a plain array of tab-like objects. Extract `findReusableShellTab(tabs, activeTab, { useExistingTerminalTab, activeCWD })` → returns a tab or `null`, and unit-test it in the node env with plain object literals. No jsdom, no `new`, no WebSocket. This also captures the exact bug documented in the comment ("must use targetTab not activeTab") as an assertion.

So I'd **reorder**: diff shell-reuse becomes a Tier-A-style pure extraction (do it first, it's trivial and de-risks nothing about jsdom), and **`loadWorktrees` becomes your actual jsdom spike.**

## Q2 — Instantiation strategy for the genuine-DOM test: (a), decisively.

`new SessionsManager(app)` is a trap. The constructor immediately calls `setupEventListeners()`, which does `this.newSessionBtn.addEventListener(...)`, `window.addEventListener('resize')`, `getComputedStyle`, `.coder-tab` wiring, etc. To make `new` not throw you'd have to reproduce ~15 `getElementById` targets from `index.html` and keep that fixture in sync forever. High noise, brittle, and it couples your test to markup that has nothing to do with worktree logic.

**Use (a): `Object.create(SessionsManager.prototype)` + a hand-built `this`.** `loadWorktrees` only touches a small, knowable surface:
- state: `this.sessionList` (a real jsdom `<div>`), `this.activeWorkspace`, `this.activeCWD`, `this.activeCoder`, `this.worktreeDirtyRequestId`
- collaborators to stub as spies: `this.loadWorktreeSessions`, `this.saveWorktreeState`, `this.loadWorktreeDirtyStates`, `this.highlightActiveSession`, `this.app.diffController.refreshDiff`, `this.app.tabManager.getActiveTab`

You assemble exactly that `this`, attach a real jsdom container, mock `fetch`, and call `SessionsManager.prototype.loadWorktrees.call(this, targetCwd)`. This is honest: you're testing the real production method against a real DOM, while the fake `this` documents precisely which collaborators the method depends on. If someone later adds a new `this.x` dependency, the test fails loudly at that seam — which is exactly the signal you want.

Rule of thumb to encode in the test file's header comment: **fake the `this`, real the DOM, spy the collaborators, mock the boundaries (fetch/localStorage).** Never `new` a view-controller in a unit test.

Reserve (b) full-`new` for a possible *later* thin smoke test ("constructor wires without throwing against the real index.html"), and only if you decide constructor wiring itself is a risk worth a regression net. It's a different test category; don't blend it into behavior tests.

## Q3 — Tier B roadmap (small, revertable, with a stop line)

Each phase is an independent commit; each is revertable without touching the ones before it.

- **B0 — jsdom beachhead (infra, 1 commit).** Add `jsdom` dev-dep. Write one throwaway-quality but kept smoke test: a jsdom-env file that builds a `<div>`, asserts `document` works, and asserts your global-mock helper (fetch/localStorage/WebSocket stubs + teardown) functions. This proves the env, the per-file docblock, and your reset discipline *before* you invest in real assertions. Keep the mock/reset helper in a small `test-js/_dom.js` so every jsdom test resets identically.

- **B1 — diff shell-reuse as a pure extraction (node env, 1–2 commits).** Extract `findReusableShellTab(...)` behavior-preservingly (Tier A discipline: refactor commit, then wire it into `runCommand`), then a test commit. Cases: active shell wins; dead/btop excluded; CWD exact-match reuse when flag on; no-match → null; different-worktree tab not reused. This is your cheapest win and it locks the documented bug.

- **B2 — `loadWorktrees` DOM behavior via Object.create (jsdom, 1 commit).** The centerpiece. Assert against a mocked `fetch` returning a worktrees array:
  - active-CWD selection precedence: `targetCwd` arg wins → else existing `activeCWD` if still present → else `wt.active` → else `worktrees[0]`.
  - exactly the current-CWD section gets `.active`; `.expanded` applied for `isCurrentCWD || wt.expanded`; correct `data-worktree-path`.
  - empty/`null` worktrees → the "No worktrees found" branch, no sections.
  - `--no-workspace--` section appended only when `activeCoder === 'agy'`.
  - `normalizePath` cross-platform matching (the `/` vs `\` axis that bit you).
  This is where the real regression protection lives.

- **B3 — one adjacent sessions behavior, only if B2 was smooth (jsdom, optional 1 commit).** E.g. `updateWorktreeState`/`saveWorktreeState`'s "which section stays active/expanded" toggling, reusing the same fixture harness. Stop here for sessions.js.

- **STOP LINE.** Do **not** open terminal.js `switchTab` as a jsdom test. It's a 4-axis matrix (workspace/coder/cwd change) buried in a 2360-line class with the heaviest collaborator graph and the highest WebSocket exposure. If any of it is worth covering, cover it the Tier-A way: identify the pure *decision* ("given from-tab and to-tab attributes, what must change?") and extract that predicate. If you can't cleanly extract it, that's a signal it's genuinely integration-level — leave it to manual/e2e, not unit tests. Diminishing returns hit hard here; the mocking cost exceeds the regression value.

General stop heuristic: **once a Tier B test needs more than ~5 stubbed collaborators or a fixture that mirrors index.html, stop and either extract a pure core or walk away.** That ratio is your signal-to-noise tripwire.

## Q4 — Concrete jsdom + Vitest traps for *this* codebase

- **Node 24 makes `WebSocket` and `fetch` real globals.** This is the sharp one. Under Node 24, `new WebSocket(url)` won't throw — it'll attempt a real network connection, and `fetch` will hit the network. Your loadWorktrees path doesn't construct a socket, but keep `PTYWebSocket`/socket-spawning collaborators stubbed, and **always `vi.stubGlobal('fetch', ...)`** so nothing escapes to the network. Consider stubbing `WebSocket` globally in `_dom.js` too, as a safety net for any accidental construction.
- **`localStorage`:** jsdom provides it via `window`; the default node env does *not* (Node's is flag-gated). `loadWorktrees` calls `localStorage.setItem` unconditionally — so that test *must* be jsdom-env, or you stub it. Don't try to run it in node env.
- **Module side effects are clean — verified.** `ws.js` only declares a class (no top-level `new WebSocket`); `sessions.js` imports only pure `util.js`; no dynamic `import()` anywhere in `web/*.js`. So importing `diff.js`/`sessions.js` under jsdom is safe. **Never import `app.js`** — that's the wiring root and will drag the whole graph.
- **jsdom "not implemented" gaps:** `scrollIntoView` (used in sessions.js line 887), `getComputedStyle` width reads, `window.innerHeight/innerWidth` layout, `element.scrollTo`. None are on the `loadWorktrees` path, but they lurk in neighboring methods — another reason to keep tests tightly scoped to one method and stub collaborators rather than let execution wander.
- **`window.marked` / `window.hljs`** (lines 989–993) are vendor globals from `web/vendor`; jsdom won't have them. Again off your target path, but confirms: don't test the transcript/markdown methods without deliberately providing those globals.
- **Test hygiene:** reset `document.body.innerHTML = ''` and `vi.unstubAllGlobals()` / `vi.restoreAllMocks()` in `afterEach`. jsdom document state and stubbed globals leak across tests within a file and will produce maddening order-dependent failures. Bake this into `_dom.js`.
- **Coverage optics:** importing a 1000-line class to exercise one method will *lower* per-file statement % while raising branch coverage on the lines that matter. Expect it, and keep steering by branch/behavior, not statements — exactly as you've been doing.

---

### Bottom line
Add jsdom, but treat B1 (pure extraction, node) and B2 (`loadWorktrees` via `Object.create`, jsdom) as the whole valuable core of Tier B. Reorder so the pure diff-matcher goes first and `loadWorktrees` is the real jsdom spike. Use `Object.create` + hand-built `this` + spied collaborators — never `new` the controller. Stop before terminal.js `switchTab` unless you can extract a pure predicate from it. Guard against Node 24's live `fetch`/`WebSocket` globals with unconditional stubs and strict per-test teardown.