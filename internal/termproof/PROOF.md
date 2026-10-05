# phic screen proof status

**Live overlays are not approved or enabled.**

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

The relay does not draw live menus. Ctrl-] q detaches. A live-view request returns an explicit unsupported-operation error after cleanup.

Session and worktree selection run before a backend owns the terminal. `--diff` runs as a separate pager operation, not a live overlay.

The client ignores opaque browser checkpoints. It reads retained recording bytes in bounded requests. It checks geometry before initial replay and rejects known historical terminal queries before painting reused panes. It does not scrub or skip output to fabricate a successful replay.

Fresh launches receive their initial terminal dimensions before the process starts. Their startup query replies can reach the new application.

A same-epoch reconnect preserves the written byte frontier and recovers missed output. A different epoch fails closed instead of merging terminal states.

## Remaining proof

A general live-view implementation still requires measured screen restoration and a reply policy. Restoration of retained content in both native buffers remains unproved. It also requires native terminal checks for the supported backends and keyboard protocols.

The byte fixtures and the headless counterexamples do not replace those checks. No approval for a smaller live-overlay scope is assumed.
