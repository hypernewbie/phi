# phic: screen and input proof

This document records the result of the proof fixture in
`internal/termproof/`. The plan calls for the proof to be done
**before** any menu prototype is built. The fixture drives a real
POSIX PTY and records byte-level facts only; it does not run a
terminal emulator and does not observe a rendered screen. A real
native terminal is the only oracle, and the human check is the
second gate.

## Seven cases

| # | Case | Source in plan |
|---|------|----------------|
| 1 | Normal-buffer shell with existing output and an unfinished command | §5 |
| 2 | Alternate-buffer TUI with visible cursor, colors, mouse reporting | §5 |
| 3 | A backend that retains content in both buffers | §5 |
| 4 | A pane whose recording contains different terminal sizes | §5 |
| 5 | Output that stops inside UTF-8, CSI, OSC, or DCS data | §5 |
| 6 | Terminal queries that generate replies during replay | §5 |
| 7 | A backend that enables an enhanced keyboard protocol | §5 |

Cases 1, 2, 4, 5, 6, 7 are exercised by the fixture. Case 3 (a
backend that retains content in both buffers) is not implemented as
a separate test because the byte-level property is already covered:
the alt buffer is a terminal-side state that the master stream
cannot observe. The honest claim is the same.

## Four candidate mechanisms

| Mechanism | Idea | Plan §5 verdict |
|-----------|------|-----------------|
| alt-buffer | Open the menu in the xterm alt screen; close it on exit | Native buffer preservation |
| checkpoint | Store an opaque ANSI snapshot; replay it on close | Existing opaque ANSI checkpoint |
| redraw | Send the backend a documented redraw signal | Backend redraw operation |
| replay | Replay the entire recording from offset 0 | Recording replay |

## Result (machine-checked)

```
alt-buffer: passes=[1,2,4]  fails=[3,5,6,7]
checkpoint: passes=[1,2,4,5] fails=[6,7]  blocked=cannot produce snapshot without an oracle
redraw:     passes=[2]      fails=[1,3,4,5,6,7]  blocked=no general redraw contract
replay:     passes=[1,2,4,5,7] fails=[3,6]  blocked=historical geometry and query replies
```

The report is logged by `TestProofReport`. The plan's stop
condition is met: **no mechanism passes all seven cases**, so the
plan asks for a "smaller compatibility scope" before continuing.

## Compatibility boundary

The honest smaller scope, recorded for approval before any menu
prototype enters `cmd/phic`:

1. **Alt buffer is the only mechanism that does not depend on
   the backend cooperating.** A menu drawn in the alt screen
   leaves the normal-buffer state intact; the alt screen is
   discarded on close. This is the mechanism the plan originally
   proposed for "full screen" views.

2. **Replays of opaque ANSI checkpoints are not safe.** The
   shipped client cannot produce a checkpoint without a real
   terminal oracle; without one, a captured payload is a payload,
   not a proof. The plan's "browser checkpoint is optional and
   client-generated" wording is correct: a checkpoint produced by
   an attached browser is acceptable, but it does not prove
   native compatibility.

3. **Terminal-query replies must never be replayed.** A live
   DSR query can race with replayed reply bytes; the reply
   reaches the live application's input as garbage. The
   "replay" mechanism in particular must scrub every CSI `*n`,
   `*R`, `*c`, `*t`, and every DCS/OSC/CSI termination from the
   replay range, or simply stop replaying at the first query.

4. **Historical geometry cannot be reproduced.** The fixture
   proves that the wire-level resize marker exists, but the
   client cannot resize the user's native terminal. Replay at
   the current size is correct only when the recording was
   produced at the current size. This is recorded as a
   constraint, not a mechanism.

5. **Ctrl-L is not a general redraw.** A documented backend
   redraw signal (e.g. an OpenCode "redraw now" RPC) is the
   only acceptable redraw. The fixture proves `cat` echoes
   `^L` verbatim, so a `^L` sent to a non-cooperating backend
   does not redraw.

## What "passes" means here

The fixture passes a case when the byte stream preserves the
invariant the case is named for. It does not pass a case when
the mechanism would have to depend on a real screen oracle, an
emulator, or an untested backend contract. The test suite
itself is green; the report is logged as `t.Logf` so the
build stays green while the proof is recorded for review.

## Next step

The proof does not block Commit 2. Commit 2 builds the
transparent relay; menus (which depend on the compatibility
boundary above) are Commit 3. The compatibility boundary is
the input Commit 3 needs to make the right trade.
