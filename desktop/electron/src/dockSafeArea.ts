/**
 * macOS Dock safe-area trim for the desktop shell.
 *
 * WHY: with an auto-hiding Dock, the app's bottom row (the composer on
 * body views, the rail's add button) sits against the window's bottom
 * edge; pointer travel toward those controls grazes the screen's Dock
 * trigger strip and the Dock slides over the row mid-click.
 *
 * WHAT: a fixed blank trim under the app column (padding-bottom), never
 * a resize: the page keeps its viewport, the terminal grid keeps its
 * rows, and the strip is painted by the page's own background. Injected
 * as an author-origin stylesheet (insertCSS cssOrigin:'author') from
 * the desktop main process on macOS only — author origin because the
 * web page's `* { padding: 0 }` reset is an author-normal declaration
 * and user-normal sheets lose that cascade level outright; an author
 * sheet inserted after the page's own wins on order and specificity
 * (html[data-phi-desktop] .app-container outranks the universal
 * selector). The shipped web bundle never contains these rules, and the
 * body-view rule is additionally scoped to html[data-phi-desktop] (set
 * only when the desktop host loads the page with desktop=1), so a
 * plain browser can never match it.
 *
 * LOW POWER: the trim is static layout, so the low-power controller's
 * animation/transition/backdrop-filter kills cannot affect it and the
 * frame pacer only throttles rAF. The stylesheet is re-inserted after
 * every navigation and reload (the installer re-arms itself on
 * did-finish-load), so reloads and legacy-server navigations keep the
 * trim. Content zoom scales user CSS exactly like page CSS, so the
 * strip tracks the zoomed composer instead of drifting.
 */
import type { WebContents } from 'electron';

/** The trim height in px (unscaled; content zoom scales it with the UI). */
export const DOCK_SAFE_AREA_PX = 24;

/** Body views (embedded shell + legacy servers) and the desktop rail. */
export const DOCK_SAFE_AREA_CSS = [
  '/* phi-desktop macOS Dock safe-area trim — injected, never shipped in web/ */',
  `html[data-phi-desktop] .app-container { padding-bottom: ${DOCK_SAFE_AREA_PX}px; }`,
  `#rail { padding-bottom: ${DOCK_SAFE_AREA_PX}px; }`,
].join('\n');

/** The narrow duck-typed surface the installer needs (fakes may stub it). */
interface InsertCSSWebContents {
  insertCSS?: (
    css: string,
    options?: { cssOrigin?: string },
  ) => Promise<string>;
  on?: (event: string, listener: () => void) => void;
}

/**
 * Installs the trim on one webContents: inserts the user stylesheet now
 * and re-arms after every navigation/reload (insertCSS lives and dies
 * with the document). WebContents without insertCSS/on (unit-test
 * fakes) are skipped silently, mirroring the executeJavaScript guards
 * in views.ts. Never throws: a failed insert is logged by the promise
 * rejection swallow and costs only the trim.
 */
export function installDockSafeArea(wc: WebContents): void {
  const target = wc as unknown as InsertCSSWebContents;
  if (
    !target ||
    typeof target.insertCSS !== 'function' ||
    typeof target.on !== 'function'
  )
    return;
  const apply = (): void => {
    target
      .insertCSS?.(DOCK_SAFE_AREA_CSS, { cssOrigin: 'author' })
      .catch(() => {});
  };
  target.on('did-finish-load', apply);
  apply();
}
