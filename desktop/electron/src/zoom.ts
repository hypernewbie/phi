/**
 * Ctrl/Cmd + (+/- / 0) content-zoom shortcuts for the phi-desktop shell.
 *
 * Pure TypeScript: only 'electron' type imports (erased at runtime), so
 * vitest runs it directly and every Electron surface arrives injected —
 * matching the convention in fullscreen.ts, reload.ts, and views.ts.
 *
 * Content zoom is global application state owned by the controller. The
 * shortcuts therefore never mutate the focused webContents directly:
 * before-input-event fires per webContents, so the helper is installed on
 * every desktop-owned surface, but every chord is projected to a global
 * zoom action. The host loop selects the next persisted percentage and
 * fans the resulting zoom factor out to every live content view.
 *
 * Chords supported:
 *   - Zoom in: Ctrl/Cmd + Plus, Equal, Add, NumpadAdd
 *   - Zoom out: Ctrl/Cmd + Minus, Underscore, Subtract, NumpadSubtract
 *   - Reset zoom: Ctrl/Cmd + Digit0, Numpad0
 * Alt chords are left untouched.
 */
import type { WebContents } from 'electron';
import {
  CONTENT_ZOOM_DEFAULT_PERCENT,
  CONTENT_ZOOM_LEVELS,
} from './controller.js';

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

/** Selects the next canonical content-zoom percentage for a global action. */
export function nextContentZoomPercent(
  current: number,
  action: ZoomAction,
): number {
  if (action === 'reset') return CONTENT_ZOOM_DEFAULT_PERCENT;
  const exact = CONTENT_ZOOM_LEVELS.indexOf(current);
  if (exact >= 0) {
    if (action === 'in') {
      return CONTENT_ZOOM_LEVELS[
        Math.min(exact + 1, CONTENT_ZOOM_LEVELS.length - 1)
      ];
    }
    return CONTENT_ZOOM_LEVELS[Math.max(exact - 1, 0)];
  }
  const higher = CONTENT_ZOOM_LEVELS.findIndex((level) => level > current);
  if (higher < 0) {
    return action === 'in'
      ? CONTENT_ZOOM_LEVELS[CONTENT_ZOOM_LEVELS.length - 1]
      : CONTENT_ZOOM_LEVELS[CONTENT_ZOOM_LEVELS.length - 2];
  }
  if (action === 'in') return CONTENT_ZOOM_LEVELS[higher];
  return CONTENT_ZOOM_LEVELS[Math.max(higher - 1, 0)];
}

/** Applies a persisted content-zoom percentage to one content WebContents. */
export function applyContentZoom(target: WebContents, percent: number): void {
  if (typeof target.isDestroyed === 'function' && target.isDestroyed()) return;
  target.setZoomMode('manual');
  target.setZoomFactor(percent / 100);
}

/** Installs the global content-zoom shortcuts on one webContents. */
export function installZoomShortcuts(
  contents: WebContents,
  onAction: (action: ZoomAction) => void,
): void {
  contents.on('before-input-event', (event, input) => {
    const action = resolveZoomAction(input);
    if (action !== null) {
      event.preventDefault();
      onAction(action);
    }
  });
}
