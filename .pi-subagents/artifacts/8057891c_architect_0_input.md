# Task for architect

Follow-up to our earlier review of incremental Vitest coverage for phi's vanilla-ESM browser code (C:/code/github/phi/web/, no bundler, files embedded in a Go binary via go:embed; tests live in test-js/, default Node env).

STATUS: Tier A done — extracted 11 pure helpers into web/util.js (normalizePath, normalizeCwd, projectWorktreeLabel, relativeToCwd, escapeHtml, priorityMeta, isDoneBucket, getLastFolderName, formatWorkspaceLabel, cpuLevel, buildProxyUrl), all 100% covered, 70 tests, each an isolated behavior-preserving refactor commit. Also added a `node --check` syntax guard (which surfaced a shipped duplicate-const SyntaxError in terminal.js that I fixed). Overall statements ~3%, branches ~91%. Pure pickings are now thin.

NEXT: Tier B — jsdom-based controller tests. This needs a new dev-dep (jsdom), per-file `// @vitest-environment jsdom`, and mocks for fetch / WebSocket / localStorage. These controllers are large class-based UI managers (SessionsManager ~1029 lines, TabManager ~2360, DiffController ~750) constructed with `new X(app)` where `app` wires many cross-references and the constructors query the DOM.

Candidate targets, my proposed order:
1. diff.js shell-tab reuse matching (normalizeCwd-based find over a Map of tabs) — lightest, spike to shake out jsdom setup.
2. sessions.js loadWorktrees active-CWD selection + which .worktree-section gets .active/.expanded — highest value (this is the exact logic behind recent worktree/tab-sync bug fixes d862975/bcb3ee5). Needs mocked fetch returning a worktrees array + a real DOM sessionList container.
3. terminal.js switchTab workspace/coder/cwd change matrix — heaviest mocking, defer.

KEY RISK I foresee: these methods live on big classes whose constructors do heavy DOM/app wiring, so `new SessionsManager(app)` in jsdom may be painful or require a large fake `app`. I don't want to refactor production constructors just to test. Options I'm weighing: (a) construct via Object.create(SessionsManager.prototype) and call the method with a hand-built `this`; (b) build a minimal fake `app` + document fixture and actually `new` it; (c) extract more logic into pure functions that take plain data (like Tier A) and keep DOM in the method — favor testing pure cores over instantiating controllers.

Questions:
1. Is jsdom worth it here, or should I keep leaning on the Tier A "extract pure core, test that" strategy for these too (option c) and use jsdom only where DOM interaction is genuinely the thing under test?
2. For methods where DOM IS the point (loadWorktrees building .worktree-section nodes), which instantiation strategy — (a) Object.create + prototype method call, (b) full fake app + new, or something else — gives the best signal-to-noise without production refactors?
3. Concrete phase-by-phase roadmap for Tier B (small commits, low blast radius, revertable), including where to stop (diminishing returns).
4. Any traps with jsdom + Vitest for this codebase (globals, WebSocket absence, localStorage, dynamic import of ./ws.js which constructs a real WebSocket, ESM module side effects)?

Give prioritized, concrete guidance and a roadmap. Don't write code — review and steer.

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```