# Client requirements and drift correction

Source of authority: the user's raw journal, not assistant summaries or passing tests.

## What the user asked for

1. Browser terminal output must be correct and lossless, with extremely fast interaction on phones. A terminal that eventually catches up but locks the phone is not acceptable. The user subsequently clarified that the latest server has decent performance and the earlier observation may have used an outdated server. Do not claim a current-version lockup without reproducing it. Test current performance; do not make a speculative terminal rewrite.
2. Keep complete output in Phi's recording. Bound the resident terminal and defer older history. Do not obtain speed by dropping bytes, skipping arbitrary ANSI prefixes, or making history inaccessible.
3. `phic` is a Phi client, like the desktop client. Read AND write the exact same desktop `profiles.json` server list, with compatible IDs, names, origins, order, and last-used timestamps. Connections added in either client must load in the other. Preserve desktop preferences while changing server metadata. Isolate authentication and pane state by origin.
4. `phic` must not depend on a running localhost server before offering server selection. It must offer a connection path when no saved servers exist.
5. Backend terminal mode is raw, full-terminal passthrough. Client menus are temporary inline TUIs, with Phi aesthetics and useful controls. A numbered DOS prompt is not the requested interface.
6. Show a compact, per-server colored bar and highlighted current server. Session and diff client chrome use the active server's theme. Do not recolor backend bytes.
7. Support terminal-friendly server shortcuts: Ctrl-1..9 where the terminal reports them distinctly, and a portable prefix shortcut elsewhere. Make the portable shortcut visible. Do not infer Ctrl-digit from plain digits or claim that holding Ctrl is universally observable.
8. Keep backend processes alive during menus and switching. Join relay workers before menus take terminal ownership. Return to the exact pane safely, preserving keyboard state, terminal modes, authentication boundaries, and source frontiers.
9. Keep sessions, new/resumed backends, projects, worktrees, diff, help, and detach usable. Menus may have TUI controls; no permanent panel renderer over raw backend output.
10. `phic` uses Go and the existing Phi HTTP/WebSocket/recording paths. No Charm/Bubble Tea, runtime terminal emulator in `phic`, output sidecar, second server database, or new Makefile/build system for `phic`.

## Raw evidence

- `166061a5`: native Go `phic`; avoid Charm; full-terminal raw output; special keys for sessions/diff.
- `b864e2c1`: the buffer/printf menu is a mental-model example; explicitly asks for something "10000x better than that slop" without a terminal emulator.
- `ca93eed5`: "like phi desktop client"; same server configuration; colored server bar and shortcuts; "the menus don't have to be minimal they can have tui etc and phi aesthetics"; "terminal mode raw dog, menus inline tui."
- Current request: phone performance is unacceptable; the DOS menu and localhost-only experience violate intent; write requirements and perform 10 positive and 100 negative checks.

## Where the implementation drifted

- I imposed read-only access and run-local additions on a request for a shared server configuration. That restriction was not the user's instruction. The initial correction and its 100 exclusion checks missed this and must not be treated as proof that the requested sharing was complete.

- `chooseStyled` added colors to a number/Enter prompt, but no focused selection, arrow navigation, filtering, or coherent client surface. Tests checked strings and byte safety rather than the requested user experience.
- Startup authenticated the selected/default localhost origin before presenting server selection. The error path only offered a picker when at least two profiles already existed. Missing profiles therefore made a multi-server client appear localhost-only.
- Profile discovery omitted desktop's legacy `Phi` directory. Tests used explicit fixture paths, not first-run discovery.
- Terminal tests accepted 20–30-second settling and measured row/byte bounds, not event-loop stalls on slow phones. Those gates cannot establish fast interaction.
- Assistant-authored summaries described delivery as complete and strengthened "no Charm/emulator" into a blanket minimal-menu constraint. That extra constraint did not come from the user.

## Change boundaries

Fix browser terminal responsiveness and the `phic` connection/menu experience. Preserve unrelated browser/desktop UX, wire protocol, backend launch defaults, trust boundaries, build commands, and release versions. Do not publish another release as part of this correction. Server-list and last-used changes are shared writes to the desktop file, not run-local connections or another store. Do not discard or change unrelated desktop preferences. No credentials, model prompts, real service restarts, or caller-state modifications in tests.

## Acceptance evidence

Record the relevant user statements verbatim, reproduction, baseline timings, regression tests, corrected timings, visual/native menu evidence, and residual limitations in `temp/CLIENT_CORRECTION_AUDIT.md`. At the end, perform 10 distinct positive conformance reviews and 100 distinct exclusion/regression checks. Mark an unverified claim as unverified; never convert eventual correctness or a green suite into a claim of universal perfection.
