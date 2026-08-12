/**
 * Rail-selection keyboard shortcuts for the desktop shell: pure chord
 * resolution plus the fixed page probe used by main.ts's
 * before-input-event binding on each retained profile view.
 *
 * Terminal-safety split (verified statically against web/terminal.js and
 * web/vendor/xterm.js; the evidence is pinned by shortcuts.test.ts):
 *   - Always safe: Ctrl+1/2/9. xterm's evaluateKeyboardEvent ctrl branch
 *     maps keyCode 51..55 (Ctrl+3..7) to ESC..US and 56 (Ctrl+8) to DEL;
 *     keyCode 49/50/57 (Ctrl+1/2/9) are absent, so those three digits
 *     produce no PTY byte and may be preventDefaulted with a terminal
 *     focused.
 *   - Conditional: Ctrl+3..8 (the live ESC..US/DEL bytes above) and the
 *     Tab chords — _forwardKeyToPty's plain-keys map is not modifier-
 *     gated, so Ctrl+Tab and Ctrl+Shift+Tab forward as '\t' and '\x1b[Z'
 *     when a terminal is focused. These are never preventDefaulted;
 *     main.ts probes terminal focus after dispatch and switches only
 *     when the page is not focused in a terminal.
 *   - Ctrl+L stays unbound: xterm maps it to the form-feed byte '\x0c'.
 */

/** The before-input-event Input subset the resolver needs. */
export interface RailChordInput {
  type: string;
  key: string;
  shift: boolean;
  control: boolean;
  alt: boolean;
  meta: boolean;
}

/** A resolved rail-selection target. */
export type RailSelectTarget =
  | { kind: 'index'; index: number }
  | { kind: 'next' }
  | { kind: 'prev' };

/**
 * Ctrl+digit chords safe to intercept synchronously at the webContents
 * layer even with a terminal focused (see the file header).
 */
export const ALWAYS_SAFE_RAIL_CHORDS: ReadonlySet<string> = new Set(['1', '2', '9']);

/**
 * Chords that are live terminal bytes with a terminal focused (Ctrl+3..8
 * -> ESC..US/DEL via xterm; Tab/Shift+Tab -> '\t'/'\x1b[Z' via
 * terminal.js). They are never preventDefaulted; main.ts probes terminal
 * focus after dispatch and acts only when the page is not a terminal.
 */
export const CONDITIONAL_RAIL_CHORDS: ReadonlySet<string> = new Set(['3', '4', '5', '6', '7', '8', 'Tab']);

/**
 * Resolves a Ctrl chord to a rail target in rail (insertion) order:
 * Ctrl+1..9 -> index (digit-1; null when the digit exceeds count);
 * Ctrl+Tab -> next, Ctrl+Shift+Tab -> prev (wrap-around; null when count
 * is 0). Everything else resolves to null. Pure: main.ts decides whether
 * a resolved target is acted on synchronously (always-safe digits) or
 * only when the terminal-focus probe reports a non-terminal page.
 */
export function resolveRailChord(input: RailChordInput, count: number): RailSelectTarget | null {
  if (input.type !== 'keyDown') return null;
  if (!input.control || input.alt || input.meta) return null;
  if (input.key === 'Tab') {
    if (count === 0) return null;
    return input.shift ? { kind: 'prev' } : { kind: 'next' };
  }
  if (input.shift) return null;
  if (!ALWAYS_SAFE_RAIL_CHORDS.has(input.key) && !CONDITIONAL_RAIL_CHORDS.has(input.key)) return null;
  const index = Number(input.key) - 1;
  return index < count ? { kind: 'index', index } : null;
}

/**
 * Fixed page probe (executeJavaScript only, never interpolated): true
 * while the focused element lives inside an xterm terminal. A focused
 * terminal keeps its live bytes for the conditional chords; the rest of
 * the page never handles Ctrl+digits or the Tab chords, so this probe is
 * the only gate the binding needs.
 */
export const TERMINAL_FOCUS_SCRIPT = `(() => {
  const el = document.activeElement;
  if (!el || !(el instanceof HTMLElement)) return false;
  return el.closest('.xterm') !== null;
})()`;
