# Phi low-power profiling and KDE tray repair — Venus, 2026-10-15

> **Correction:** these captures measured a specific view/workload, not a
> reliable terminal-rendering reduction. A later A1 test still found ~42–44%
> Phi GPU usage with the saved setting on. We confirmed a legacy-UI startup
> overwrite and unpaced xterm rendering. See
> [the follow-up investigation](2026-10-15-low-power-terminal-rendering.md).
> Do not generalize the 91% figure below to busy terminals or restored sessions.

## Original results: normal vs low power on this laptop

Measured the **real installed desktop client on KDE Wayland**, not Xvfb,
headless Chromium, CPU utilization, or GPU memory allocation.

| 30-second capture | Phi render-engine busy | Whole-iGPU render busy | Whole-iGPU power | CPU-package power |
| --- | ---: | ---: | ---: | ---: |
| Normal, A1 | 53.30% | 67.26% | 5.89 W | 17.44 W |
| Low power, B1 | 4.73% | 7.57% | 0.52 W | 8.05 W |
| Low power, B2 | 4.23% | 6.83% | 0.48 W | 7.77 W |
| Normal, A2 | 46.51% | 56.50% | 1.73 W | 10.77 W |

Phi's mean render-engine usage: **49.90% normal → 4.48% low power**, a
**91.0% relative reduction** (45.42 percentage points). All other Phi GPU
engines (copy, video, video-enhance) measured 0% in these captures.

After the final ordinary, non-debugging relaunch with low power enabled,
a separate 15-second check measured **2.74%** average Phi render-engine use.

### Setup and method

- Intel Core i7-6700HQ; Intel HD Graphics 530 (Skylake GT2), `i915`.
- Linux `7.0.0-38-generic`; KDE Plasma/Wayland, real session `wayland-0`.
- Electron 44.4.3 / Chromium 152.0.7977.130; hardware acceleration enabled.
- Locally built Phi desktop 0.25.0, source based on `4855fe2` plus the
  Linux tray fix described below. Same build and GPU process in all four runs.
- Existing saved profile/session workload, three retained remote body views,
  low-memory mode off, content zoom 100%, window 1939×1051.
- Normal → low → low → normal (A/B/B/A), six seconds settling before each
  30-second measurement. Switched through the **actual KDE D-Bus tray menu**;
  verified the stored preference and `fast-mode` class in all retained body
  views before every capture. Low-power snapshots showed zero running CSS
  animations in those body views.
- Primary measurement: deltas of `/proc/<GPU_PID>/fdinfo/*`
  `drm-engine-render` nanoseconds divided by monotonic elapsed nanoseconds.
  Duplicate descriptors for a DRM client are deduplicated by device/client ID.
  This attributes render-engine time to Phi's GPU process, not the compositor
  or other apps. Primary capture GPU PID: 82037.
- Independent parallel capture: `sudo -n intel_gpu_top -J -s 1000 -n 31`.
  Discarded its initial partial (<500ms) sample; duration-weighted the remaining
  30 samples. Its per-client Phi render percentages agree with the fdinfo
  measurements (53.07%, 4.77%, 4.28%, 46.45%).

**Limits:** this is a short, live-session experiment, not a frozen-content
benchmark. Background apps, tab output, GPU clocks, and CPU load were not
controlled. Whole-device/package wattages include other processes and show
substantial normal-run variability; do not interpret them as Phi-only power,
battery-runtime predictions, or a universal savings percentage. An older
0.22.2 baseline was also recorded but is not pooled into this same-build A/B
comparison. The initial near-100% whole-GPU spot reading was not representative
of that entire baseline window.

### Repeat the per-process measurement

```sh
pgrep -af 'phi.*--type=gpu-process'
# Select Phi's GPU-process PID, not the desktop main process or renderer.
python3 scripts/profile-intel-gpu.py --pid GPU_PID --seconds 30 \
  --label normal --output /tmp/phi-normal.json
# Change the desktop tray Low power mode checkbox, wait at least six seconds.
python3 scripts/profile-intel-gpu.py --pid GPU_PID --seconds 30 \
  --label low-power --output /tmp/phi-low-power.json
```

The helper needs readable DRM fdinfo counters, **not sudo**. It fails instead
of silently returning zero if counters are unavailable, clients change,
counters reset, or the GPU process restarts. Test its parsing/deduplication:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/test_profile_intel_gpu.py
```

Raw captures, runtime metadata, screenshots, the local control script, KDE
menu layouts and quit-test evidence are retained locally (not committed, since
they describe the user's live session) at:

`~/.local/state/phi/profiling/2026-10-15-kde-intel/`

`intel_gpu_top` on this machine writes array brackets to stdout and object
records to the output file; its raw `*-system.json` files need surrounding
`[`/`]` when parsing. `system-summary.json` contains the parsed aggregates.

## KDE tray: cause, fix, and live verification

Before the fix, `com.canonical.dbusmenu.GetLayout` for the installed Phi tray
returned a root with **zero children**. The icon existed, but KDE had no menu
items to display. Phi relied exclusively on `Tray.on('right-click', ...)`;
StatusNotifier hosts need not send that Electron event.

`desktop/electron/src/tray.ts` now uses **`Tray.setContextMenu` on Linux** on
initial creation and **after every menu rebuild**. KDE reads that exported
menu directly. Windows/macOS retain their existing explicit popup handling.

Live verification on this KDE session:

1. Installed the locally built 0.25.0 `.deb` (previous installation: 0.22.2),
   backed up the old app archive and profile document, and restarted only the
   desktop client. No Phi servers/PTYs were stopped.
2. KDE's D-Bus menu now exports profiles, Low power mode, Low memory mode,
   pet menu entries, content zoom, and **Quit**.
3. Toggled Low power mode via D-Bus menu events for the measurements above;
   checked the re-exported checkbox state and body-view convergence.
4. Invoked **Quit** through the exported menu on an ordinary non-debugging
   client; confirmed PID 82574 exited within five seconds. Evidence:
   `quit-test.json`.
5. Relaunched normally without debugger flags, low power **enabled**, existing
   ten saved profiles preserved. Final quit-smoke relaunch PID: 85403.

**Pet caveat:** pet availability/installability is deliberately disabled on
Linux by the existing `isPetAvailable` / `isPetInstallable` checks (no supported
click-through implementation). The tray fix restores menu access; it does not
add Linux pet support or bypass those checks.

Regression coverage exercises Linux native-menu registration without any
click event, replacement-menu refresh, checkbox/pet-entry changes, and the
unchanged Windows/macOS popup paths. Host-lifecycle/fullscreen fakes now model
`setContextMenu` as well.

Local package:
`desktop/electron/out/phi-client-0.25.0-linux-amd64.deb`

SHA-256:
`6b92255d404791c42498bbeb905369966da302fd2ffd5f805d45c97512bc2bf1`
