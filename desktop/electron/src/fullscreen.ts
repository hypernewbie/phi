/**
 * Plain-F11 fullscreen toggle for the phi-desktop main process.
 *
 * Pure TypeScript: only 'electron' type imports (erased at runtime), so
 * vitest runs it directly and every Electron surface arrives
 * constructor-injected — the same convention as views.ts.
 *
 * before-input-event fires per webContents, so the same helper is
 * installed on every desktop-owned surface: the main window's page, the
 * retained remote body views (via ProfileViewManager), and the local
 * modal child windows. Plain F11 only — modified chords (Ctrl/Shift/Alt/
 * Cmd+F11) are left untouched for terminal-focused pages; xterm.js does
 * not claim plain F11, so the toggle is also safe with a terminal
 * focused.
 */
import type { BrowserWindow, WebContents } from 'electron';

/** Installs the plain-F11 fullscreen toggle on one webContents. */
export function installFullscreenToggle(contents: WebContents, win: BrowserWindow): void {
  contents.on('before-input-event', (event, input) => {
    if (
      input.type === 'keyDown' &&
      input.key === 'F11' &&
      !input.control &&
      !input.alt &&
      !input.meta &&
      !input.shift
    ) {
      event.preventDefault();
      if (!win.isDestroyed()) win.setFullScreen(!win.isFullScreen());
    }
  });
}
