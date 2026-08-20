/**
 * Pet window lifecycle for the phi desktop overlay. Owns the transparent
 * BrowserWindow (one cell of a 4×2 grid over the host display's workArea),
 * the cell math, the re-clamp on move, and the loadFile of the local pet
 * page. Electron surfaces are touched only inside functions (DI-style,
 * mirroring tray.ts) so unit tests stub 'electron' with vi.mock and never
 * construct a real window.
 */
import { BrowserWindow, screen } from "electron";
import path from "node:path";

/** The terrarium grid: 4 columns × 2 rows over the workArea. */
export const GRID_COLS = 4;
export const GRID_ROWS = 2;

/** The pet page + preload shipped under dist/ by `pnpm build`. */
const PET_HTML_FILE = "pet.html";
const PET_PRELOAD_FILE = "pet-preload.js";

/** One cell of the grid (a transparent-window "terrarium"). */
export interface PetCell {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The bottom-right cell of a workArea (the default home). */
export function computeDefaultCell(workArea: {
  x: number;
  y: number;
  width: number;
  height: number;
}): PetCell {
  const w = Math.floor(workArea.width / GRID_COLS);
  const h = Math.floor(workArea.height / GRID_ROWS);
  return {
    x: workArea.x + workArea.width - w,
    y: workArea.y + workArea.height - h,
    width: w,
    height: h,
  };
}

/** Clamp a window-sized rectangle fully inside a workArea. */
export function clampBounds(
  bounds: { x: number; y: number; width: number; height: number },
  workArea: { x: number; y: number; width: number; height: number },
): { x: number; y: number } {
  const x = Math.min(
    Math.max(bounds.x, workArea.x),
    workArea.x + workArea.width - bounds.width,
  );
  const y = Math.min(
    Math.max(bounds.y, workArea.y),
    workArea.y + workArea.height - bounds.height,
  );
  return { x, y };
}

/** Re-clamps a live window into the nearest display's workArea. Skipped on
 *  linux (Wayland prohibits programmatic position). */
export function reclampPetWindow(win: BrowserWindow): void {
  if (process.platform === "linux") return;
  if (win.isDestroyed()) return;
  const bounds = win.getBounds();
  const next = clampBounds(bounds, screen.getDisplayMatching(bounds).workArea);
  if (next.x !== bounds.x || next.y !== bounds.y)
    win.setPosition(next.x, next.y);
}

export interface PetWindowOptions {
  /** Absolute path of the pet package root (holds dist/ + assets/). */
  root: string;
  /** Diagnostics logger. */
  log: (msg: string) => void;
  /** Extra loadFile query params (the verify harness passes {verify:'1'}). */
  query?: Record<string, string>;
}

/** Creates the transparent, frameless pet window in the bottom-right cell
 *  of the primary display's workArea, loads dist/pet.html, and wires the
 *  moved → re-clamp. */
export function createPetWindow(opts: PetWindowOptions): BrowserWindow {
  const cell = computeDefaultCell(screen.getPrimaryDisplay().workArea);
  const win = new BrowserWindow({
    x: cell.x,
    y: cell.y,
    width: cell.width,
    height: cell.height,
    transparent: true,
    frame: false,
    resizable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      preload: path.join(opts.root, "dist", PET_PRELOAD_FILE),
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true);
  // Start click-through: transparent pixels (and the pet itself until the
  // renderer's mousemove hit-test reports the cursor is over it) pass
  // clicks through; forward keeps mousemove flowing for the hit-test.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.on("moved", () => reclampPetWindow(win));
  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) win.show();
  });
  void win
    .loadFile(
      path.join(opts.root, "dist", PET_HTML_FILE),
      opts.query ? { query: opts.query } : undefined,
    )
    .catch((err: unknown) => {
      opts.log(`loadFile failed: ${String(err)}`);
    });
  return win;
}
