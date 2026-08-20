/**
 * Ctrl/Cmd + (+/- / 0) zoom in, zoom out, and reset zoom shortcuts for the
 * phi-desktop shell.
 *
 * Pure TypeScript: only 'electron' type imports (erased at runtime), so
 * vitest runs it directly and every Electron surface arrives injected —
 * matching the convention in fullscreen.ts, reload.ts, and views.ts.
 *
 * before-input-event fires per webContents, so the helper is installed
 * on every desktop-owned surface: the retained remote body views (via
 * ProfileViewManager), the main window's host page, and child popups/picker.
 *
 * Chords supported:
 *   - Zoom in: Ctrl/Cmd + Plus, Equal, Add, NumpadAdd
 *   - Zoom out: Ctrl/Cmd + Minus, Underscore, Subtract, NumpadSubtract
 *   - Reset zoom: Ctrl/Cmd + Digit0, Numpad0
 * Alt chords are left untouched.
 */
import type { WebContents } from 'electron';

export type ZoomAction = 'in' | 'out' | 'reset';

export interface ZoomChordInput {
  type: string;
  key: string;
  control?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
}

/** Resolves a keydown input to a zoom action (or null if not a zoom chord). */
export function resolveZoomAction(input: ZoomChordInput): ZoomAction | null {
  if (input.type !== 'keyDown') return null;
  if ((!input.control && !input.meta) || input.alt) return null;

  const key = input.key;
  if (key === '+' || key === '=' || key === 'Add' || key === 'NumpadAdd') {
    return 'in';
  }
  if (
    key === '-' ||
    key === '_' ||
    key === 'Subtract' ||
    key === 'NumpadSubtract'
  ) {
    return 'out';
  }
  if (key === '0' || key === 'Numpad0') {
    return 'reset';
  }
  return null;
}

/** Applies a zoom action to the target WebContents. */
export function applyZoomAction(target: WebContents, action: ZoomAction): void {
  if (typeof target.isDestroyed === 'function' && target.isDestroyed()) return;
  const current =
    typeof target.getZoomLevel === 'function' ? target.getZoomLevel() : 0;
  if (action === 'in') {
    target.setZoomLevel(Math.min(current + 0.5, 9.0));
  } else if (action === 'out') {
    target.setZoomLevel(Math.max(current - 0.5, -8.0));
  } else if (action === 'reset') {
    target.setZoomLevel(0);
  }
}

/** Installs the zoom shortcuts on one webContents. */
export function installZoomShortcuts(
  contents: WebContents,
  targetGetter?: () => WebContents | null,
): void {
  contents.on('before-input-event', (event, input) => {
    const action = resolveZoomAction(input);
    if (action !== null) {
      event.preventDefault();
      const target = targetGetter ? (targetGetter() ?? contents) : contents;
      applyZoomAction(target, action);
    }
  });
}
