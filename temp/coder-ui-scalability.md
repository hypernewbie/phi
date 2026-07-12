# Coder picker — scalability discussion

Date: 2026-07-12
Status: decision made (Design B), not yet implemented
Participants: user, pi (assistant), architect subagent

## Context

The coder picker lives in the left sidebar (`web/index.html:189-205`). It's
a single horizontal row of 5 buttons (OpenCode, Claude, Agy, Pi, Shell),
each with a favicon + text label, `flex: 1`. CSS at `web/style.css:476`:
`padding: 6px 4px; font-size: 11px`. Adding a 6th visibly squeezes the
labels. Adding 7+ breaks.

The picker is hardcoded in HTML, the favicon map is hardcoded in
`web/terminal.js:7-14`, and coder-specific behavior lives as scattered
`if (activeCoder === 'agy' || 'claude')` branches in `web/sessions.js`
plus a `coderName` if/else chain at lines 606-610.

User wants to add more coders (Aider, Cursor, Gemini CLI, etc.) without
ruining the UX.

## My initial take (5 approaches)

1. Horizontal overflow + "+N" popover
2. Icon-only mode with overflow menu
3. Single dropdown chip ("OpenCode ▾")
4. Grouped chip grid with category headers
5. Recent/favorites + "More" link
6. Config-driven with `which <bin>` auto-detect

My pick: combination of #6 (config-driven data layer) + #3 or #4 for UI.

## Architect's take

Pushed back on the whole framing. Said the **real problem isn't the
picker width** — it's that *capabilities are encoded as identity
string-matching*. Adding a coder isn't "add a chip," it's "guess which
if/else club it belongs to."

Architect's capability schema:

```yaml
{ id, label, favicon, bin, capabilities: [review, rename, args], group }
```

Cited Hick's Law / Miller's Law: ≤6 = flat chips genuinely work, 7–12 =
needs grouping or search, 13+ = must be search-first (command palette).

Recommended pattern hybrid:
- ≤5 → flat chip row with labels (do nothing)
- 6+ → row auto-collapses to icon-only, last slot becomes `⋯ +N`
  opening a searchable popover grouped by `group`
- 13+ → search-first command palette, sidebar row becomes a status pill

Architect also flagged:
- Picker should stay in sidebar (the session list is filtered by it)
- ADD a status-bar pill + Ctrl-K palette entry for power users
- Make adding a coder a user action (`coders.yaml` editable, `which`-based
  auto-detect, "Show all" toggle for uninstalled)

## User pushback

> no. these are just so different, that backend hardcoding is exactly
> the right way to handle it. I dont like the dropdowns. need 1 click
> hot path here. hmmm. any 1-click immediate viable UI designs?

User's priorities are now:
1. **1-click hot path** — no dropdowns, no menus, no second clicks
2. **All visible** — every coder reachable in one click
3. **Backend hardcoding stays** — coders are different enough that
   per-coder code paths are the right tool
4. **No layout restructuring** — the picker stays where it is

## Revised designs (1-click only)

### A — Wrap to rows
Just `flex-wrap: wrap` on the existing row. Same chips, same hover,
same click. Loses "single strip" feel past 5. Honest.

### B — Icon-only row, label moves below  *(user's pick)*
Drop the `<span>` label from each chip. Icons stay 16px, ~32px per chip
slot → fits 7-8 in the same strip. Active coder's name shown in a small
text label between the row and the New Session button (or in the empty-
state). Scales to ~12 before wrap. Zero new component.

### C — Two-row always
Force exactly 2 rows: row 1 = primary agents, row 2 = shells/tools.
Visual hierarchy by row. Scales to ~10 before needing scroll.

### D — Vertical icon rail
Move picker to a ~32px column on the sidebar's left edge. Scales
infinitely. Restructures the sidebar (narrower session list, new left
gutter). Big change, big payoff.

## Decision

**Design B** — icon-only row + active label below.

Reasons:
- 1-click stays (click the icon, done)
- All visible up to ~8 coders, wraps to a 2nd row after that
- Active state moves to a small text label in the header area
- No new component, no dropdown, no overflow menu, no scroll
- "What's active" info still 1-glance away
- 5→8 jump = 60% more headroom before any layout surgery

## Out of scope (for now)

- Config-driven capability schema — user explicitly rejected this
- Command palette entry / Ctrl-K shortcut — would be a separate feature
- Auto-detect via `which <bin>` — would require backend changes user
  doesn't want
- Moving picker to status bar / top bar — breaks "list below is filtered
  by picker" mental model

## When to revisit

When coders actually cross 8 and the 2-row wrap starts looking like
3 rows. By then we'll know what the next coder looks like and can
make a more informed UX call.