# Client requirements and drift correction

Source of authority: the user's raw journal, not assistant summaries or passing tests.

## TUI redesign direction — 2026-10-06

The user rejected the project → coder → session wizard as unusable, reopened Charm/Bubble Tea, and requested a console version of the website, with a lighter feature set. The user then explicitly requested a terminal-emulator library.

Latest statements:

- "maybe we jut have to go charm / bubble tea. urghh, if so might as well give it a shot. fuck."
- "ifwe going tui I want basically a console version of the website - lite ofc, not full featured."
- "yes we need a termemu library find a good one"

These statements supersede the earlier raw-only, no-persistent-panels, no-Charm, and no-emulator architecture exclusions below for the redesign. The website is the product-flow reference; desktop remains the shared server-store reference. Existing transport, authentication boundaries, recording integrity, build/install semantics, and server ownership still matter. The console replacement is implemented and installed. Library evaluation is recorded in `temp/phic-tui-evaluation/REPORT.md`; implementation review and native evidence are in `temp/PHIC_PLAN2_REVIEW.md`.

## Console spin feedback — 2026-10-06

- Close-button clicks must work; terminal-focus plain `x` must remain backend input.
- Tab titles need a short cell limit. The operator suggested 18 or 20; the implemented limit is 20 cells, including ellipsis, without changing saved names.
- Remember login across launches, without storing the password. The operator explicitly rejected Keychain use. The implementation stores the server-issued session token in a private per-origin file, not the password or derived verifier/hash. It does not use an OS credential manager.
- Add a Markdown tab beside Diff using the website's configured directories, including `./temp`, `./tmp`, and added directories. The later spin feedback supersedes the initial no-copy request: files open in a wide/fullscreen modal, with a top-right Unicode `[×]`, Copy Markdown, and Copy Filename. No paste/edit/delete controls.
- Connected status must fit the chrome palette instead of using a separate green. Backend colors are not changed.
- Opening a server must sync its existing live panes, including other projects and worktrees. The later Charon report was withdrawn: the user confirmed that server was empty.
- Use compact connection and terminal-strip glyphs, not wordy labels or routine login/switching status chatter.
- Offer a Sessions hide/show shortcut, whole-console refresh/redraw, keyboard width controls, and draggable Sessions/Diff dividers.
- Esc must not directly close the client. Double Esc outside terminal focus opens a Quit confirmation; modal Esc closes only that modal. Backend Escape input is unchanged.
- An empty terminal area uses a styled Phi logo and launch/help text, without Egyptian artwork.
- Add an icon-only btop launch action using the website's fresh server-shell then `btop` behavior.
- Show uppercase PC names without ports in the rail, without rewriting shared profiles or connection origins.
- Never enter a minimum-size blocking mode. Tiny windows retain normal startup, rendering, and input, even if controls clip. This includes initial attachment and launching a new pane.

Implementation and evidence: `temp/PHIC_SPIN_FIXES.md`.

## Earlier requirements and current implementation

1. Browser terminal output must be correct and lossless, with extremely fast interaction on phones. A terminal that eventually catches up but locks the phone is not acceptable. The user subsequently clarified that the latest server has decent performance and the earlier observation may have used an outdated server. Do not claim a current-version lockup without reproducing it. Test current performance; do not make a speculative terminal rewrite.
2. Keep complete output in Phi's recording. Bound the resident terminal and defer older history. Do not obtain speed by dropping bytes, skipping arbitrary ANSI prefixes, or making history inaccessible.
3. `phic` is Phi Desktop Lite. Desktop is the reference for behavior, form flow, labels, theme, identity, and server management. An internal desktop helper is not sufficient evidence. Trace the complete user action through the desktop form and host handler. Read AND write the exact same desktop `profiles.json` server list, with compatible IDs, names, origins, order, and last-used timestamps. Connections added in either client must load in the other. Preserve desktop preferences while changing server metadata. Isolate authentication and pane state by origin.
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
- Earlier request: phone performance is unacceptable; the DOS menu and localhost-only experience violate intent; write requirements and perform 10 positive and 100 negative checks.
- Desktop Lite correction: "phic is phi desktop lite" and "if desktop does it by X, and phic does not do it by X, thats banned." The user includes form aesthetics, terminology, and theme in this requirement.

## Where the implementation drifted

- I compared the internal desktop origin validator with raw form input. The actual desktop form adds the scheme and Phi port, supports bulk paste, and uses browser URL normalization first. Tests of canonical origins missed this error. Assistant-authored identity, color, removal, and form rules also differed from desktop.

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
