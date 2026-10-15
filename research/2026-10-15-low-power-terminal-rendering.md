# Low power follow-up: CSS is not terminal render pacing

## Why the original claim did not hold

The user's independent A1 training-room test found 30.6/31.1 FPS with Phi
running (~42–44% Phi GPU usage), versus 68 FPS with Phi's GPU process stopped.
Those results contradict a general claim that the previous change reliably
eliminated contention. The original 91% result described one measured view
and workload; it did not establish busy-terminal behavior or reliable startup.

We confirmed two separate gaps:

1. **Persisted ON did not imply applied ON.** After a cold desktop launch,
   Venus's actual remote page had `phi_low_power="1"` but no `fast-mode` body
   class. Venus and the remote peers still serve older web code: their
   `App.applyFastMode` reads `config.fast_mode`, not the browser key. Their
   asynchronous `SessionsManager.loadConfig` overwrites the desktop's one-time
   class change after `did-finish-load`. The desktop header/rail were not
   receiving the preference at all.
2. **CSS low power did not pace terminal rendering.** A six-second Chromium
   trace of the active Pi terminal recorded 150 xterm animation-frame function
   calls and 76 websocket message callbacks, with zero running CSS animations.
   Reapplying the class, applying it to chrome too, and even disabling all CSS
   motion/backdrop filters left ~14% Phi render-engine usage in that live
   terminal state. Incoming TUI updates still drive xterm/WebGL paints.

Diagnostic frame pacing at 10/5/1fps measured 11.41% / 6.19% / 2.03% Phi
GPU render-engine usage respectively in that terminal. These are short local
captures, not the user's exact prior game/content workload.

## Local patch

`desktop/electron/src/lowPowerRendering.ts` implements a self-contained page
controller, serialized by `lowPowerApplyScript` so it also works on old servers:

- Persist the desktop preference independently of server config.
- Guard the body class against asynchronous legacy-config overwrites, observing
  only that attribute (no polling or observation of the terminal subtree).
- Disable CSS motion/backdrop effects while enabled, including effects not in
  the old hand-maintained selector list.
- Batch rAF callbacks to **at most 10fps focused / 1fps unfocused or hidden**.
  This paces xterm redraws without stopping PTYs, parsing, or websocket traffic.
- Wake pending rendering promptly on focus; restore native cadence when off.
- Preserve cancellation, batch timestamps, and callbacks queued during a frame.
- Apply the controller to local header/rail as well as retained remote bodies
  on each load and tray change. Local rail width is not treated as a phone.

This is intentionally a display-update tradeoff, not a hard GPU quota or a
promise that all possible GPU work is intercepted. Focused interaction can
still cost GPU time: one ordinary focused terminal capture with the new
10fps budget measured 11.43%. Continuous output now updates less often in
low power, especially when another application has focus.

## Verified training-room rerun

Same existing AE release runtime binary as the user's test, launched from
`~/code/a1` with `projects/a1`, copied XDG cache, 960×1280 saved viewport,
editor off, CPU frame caps/low-latency pacing off, GPU timers on. Original
user config hashes were checked unchanged on exit. Verified **stage 10**,
15 draw calls, seven static-model draw calls, one billboard, 4,402 triangles.
Phi window: 1200×800; active Venus Pi terminal retained; game focused and all
Phi views unfocused. Measurements: 15 seconds per condition after settling.

| Condition | A1 FPS (1000 / median sampled frame ms) | Phi render-engine busy |
| --- | ---: | ---: |
| New low power, first capture | 67.07 | 1.74% |
| CSS-only control, pacing/guard removed | 65.62 | 11.25% |
| New low power, second capture | 66.38 | 1.61% |
| New low power, final ordinary restart (no debug flags) | 66.91 | 1.22% |

The control retained the `fast-mode` class and saved ON preference but removed
our new controller, restoring native rAF and the legacy CSS-only behavior.
Restored the controller through actual tray toggles before the final capture.
No Phi GPU SIGSTOP was used in these reruns.

**Important limit:** this did **not** reproduce the user's exact ~43% Phi /
~31 FPS control. Terminal contents, output cadence, window placement, clocks,
and background activity differ. The table establishes that the new background
pacer works in the verified training room; it is not evidence of an exact
31→67 FPS fix under the original captured conditions. That scenario should
be independently retested. No new semaphore-wait capture was taken.

Two earlier diagnostic game runs used the wrong working directory and did not
load A1 (zero draw calls). Those are **excluded**, not game-performance results.
The subsequent run added explicit stage/render-count validation before capture.

## Validation and retained evidence

- Cold installed-client startup: remote body and both local chrome pages had
  the enabled class, stored key, and live controller; zero CSS animations.
- Tests cover legacy asynchronous class overwrite, focus/visibility pacing,
  cancellation (including during dispatch and pre-install requests), batching,
  toggle-off restoration, idempotence, mobile behavior, and chrome fan-out/load.
- 822 desktop tests passed (one skipped); typecheck, build, and lint checks
  passed (lint reported existing warnings).
- Final installed client was restarted without inspector/remote-debugging flags;
  the final verified training-room capture above used that ordinary instance.
- Existing servers/PTYs were not stopped; game source/config was not edited.
- Temporary game processes/caches were cleaned up; low power restored ON.

Raw DOM snapshots, Chromium trace, per-process GPU counters, sampled A1 stats,
verified stage/render metadata, test/build logs and local scripts are retained
privately, not committed:

`~/.local/state/phi/profiling/2026-10-15-terminal-rendering/`

The previous report is retained as historical capture data with a correction
at its top. It must not be presented as a general 91% GPU savings guarantee.
