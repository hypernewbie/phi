# phic screen proof status

**Inline client views use recording rebuilds, not native-buffer snapshots.**

The original `TestProofReport` contained a hard-coded compatibility table. It did not measure rendered screens. That table is removed.

## What the fixtures measure

The Go PTY fixtures measure raw byte delivery. They do not measure cells, cursor position, alternate-buffer content, or terminal modes.

`test-js/phicScreenProof.test.js` now uses a development-only headless terminal. It gets the actual candidate operations from `TestCandidateOracleInput`.

The measured counterexamples are:

- Opening the alternate-buffer menu destroys an already active alternate screen.
- Replaying a terminal query produces another application-input reply.
- Replaying output at the current geometry does not reproduce an earlier alternate-screen layout.

These are failure evidence. They are not a passing compatibility matrix. The shipped client does not import the oracle or contain a screen model.

## Runtime boundary

The operator approved a practical recording-rebuild scope: raw backend output, temporary inline client menus, no emulator, and current-geometry replay. Exact reconstruction across arbitrary historical resizes is not claimed.

Ctrl-] s/d/w/? transfers ownership after both relay workers stop. Menus and the native pager do not race with backend output. Phi keeps recording while the client view is open. On return, the controller neutralizes terminal input modes, unwinds observed backend keyboard pushes, initializes both native buffers, reconnects, and rebuilds from the recording.

The client ignores opaque browser checkpoints. Repaint suppresses historical reply-producing queries and clipboard writes without changing Phi's recording. New live controls remain raw, including replies and ambiguous legacy keys. The client remembers a source frontier per origin and pane, without retaining output. Requests issued while away are processed live after input ownership resumes. A request incomplete at the frontier has not produced a reply yet, so its prefix resumes live too. Work is bounded by recording pages and a 1 MiB unfinished-control limit.

Fresh launches receive their initial terminal dimensions before the process starts. Their startup query replies can reach the new application.

A same-epoch reconnect preserves the written byte frontier and recovers missed output. A different epoch fails closed instead of merging terminal states.

## Native checks and parser barrier

`TestNativeTMUXParserBarrier` runs in a separate tmux socket. It sends a random, unknown private-mode request (`DECRQM`). The native terminal echoes the mode number with status 0. The headless oracle checks that the same request does not change cells, cursor, active buffer, or modes.

This proves a parser boundary for that terminal. It does not prove screen restoration or a complete reply policy. Legacy Shift-F3 and a cursor report at row 1, column 2 both encode as `ESC [ 1 ; 2 R`. The experimental filter consumes that key. `TestLegacyShiftF3CannotBeDistinguishedFromCursorReport` records this counterexample. The filter remains in the proof package and is not linked into the client.

A parser barrier alone also cannot establish that every asynchronous terminal service has sent its reply. Do not use it as permission to forward later clipboard or color replies into a live application.

`scripts/test-phic-native.py` runs actual installed backends through Phi and phic in an isolated native tmux terminal. It checks rendered startup, six view returns (help, sessions, worktrees, diff, servers, help again), styled cells, cursor and buffer state, historical reattachment, detach acknowledgment, and backend survival. Shell retains an unfinished input line. The local run covered Shell, Pi 1.0.1, Codex 0.160.0, Claude 2.1.289, and OpenCode 2.0.21 in full TUI and Mini modes. All six backends passed. Codex and Claude reached onboarding screens without user credentials; these checks do not claim successful model access.

The OpenCode fixture assigns an isolated service port. A separate HOME alone does not isolate its default port. The runner never stops or changes a service in the user's HOME.

## Recording-rebuild evidence

`test-js/phicRebuild.test.js` imports the actual production reset and repaint operations from `TestRebuildOracleInput`. Six fixed-geometry cases compare visible cells, cursor, modes, and future output after three consecutive menu returns: normal, alternate, both buffers, custom tabs/scroll region/styles, keyboard modes, and historical queries. The dual-buffer case also returns to the normal buffer. No historical query reply is generated during reconstruction. Native scrollback is excluded: it contains inline menus and replayed output, not a virtual client archive.

`TestCLIInlineViewsReplayOutputAndSwitchPaneWithoutInputLoss` runs the CLI in a controlling PTY. It proves help/session/worktree cancellation, pager return, output recorded while a menu is open, same-read menu responses, exact pane switching, old-query suppression, and unchanged legacy Shift-F3 plus bracketed paste. It uses isolated HTTP/WS fixtures, not installed provider processes.

`TestReturningDeliversQueriesIssuedWhileAwayButNotSeenQueries` reproduces and checks cursor/color queries issued while away, including a request incomplete at the old frontier. The CLI PTY fixture confirms that a menu-time query reaches the native terminal once, its reply reaches the backend, and later reconstruction does not repeat it.

`TestCLIDesktopProfilesColoredServerSwitchOriginIsolationAndRememberedPane` checks same-host, different-port origins with identical pane IDs, distinct paths/colors/cookies, per-server pane return, failed-switch rollback, and raw input. The config file is byte-identical after the run.

The installed-backend native pass is now separate evidence from both the Go PTY fixtures and headless oracle. Linux CI also runs the credential-free native Shell views/reattachment fixture. Exact reconstruction across historical resizes, asynchronous native services in flight during handoff, and arbitrary terminal extensions remain compatibility limits, not a universal emulator claim.
