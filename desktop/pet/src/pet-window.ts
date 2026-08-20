/** Native pet-cell construction and visible-stage geometry helpers. */
import { BrowserWindow, screen } from "electron";
import path from "node:path";
import type { PetMove, StageRect, TerritoryBounds } from "./pet-bridge.js";

export const GRID_COLS = 4;
export const GRID_ROWS = 2;
const PET_HTML_FILE = "pet.html";
const PET_PRELOAD_FILE = "pet-preload.js";

export interface PetCell { x: number; y: number; width: number; height: number; }
export interface WorkArea { x: number; y: number; width: number; height: number; }

export function computeDefaultCell(workArea: WorkArea): PetCell {
  const width = Math.floor(workArea.width / GRID_COLS);
  const height = Math.floor(workArea.height / GRID_ROWS);
  return { x: workArea.x + workArea.width - width, y: workArea.y + workArea.height - height, width, height };
}

/** Applies a renderer drag delta to the visible stage, not the transparent cell. */
export function candidateMoveStage(cell: Pick<PetCell, "x" | "y">, move: PetMove): StageRect {
  return { x: cell.x + move.dx + move.stage.x, y: cell.y + move.dy + move.stage.y, width: move.stage.width, height: move.stage.height };
}

export function clampStage(stage: StageRect, workArea: WorkArea): StageRect {
  const clampAxis = (value: number, size: number, start: number, extent: number): number => {
    if (size >= extent) return start;
    return Math.min(Math.max(value, start), start + extent - size);
  };
  return {
    x: clampAxis(stage.x, stage.width, workArea.x, workArea.width),
    y: clampAxis(stage.y, stage.height, workArea.y, workArea.height),
    width: stage.width,
    height: stage.height,
  };
}

export function finalCellOrigin(stage: StageRect, localStage: Pick<StageRect, "x" | "y">): Pick<PetCell, "x" | "y"> {
  return { x: stage.x - localStage.x, y: stage.y - localStage.y };
}

/** Local stage positions which keep its visible footprint in the work area. */
export function deriveTerritoryBounds(cell: Pick<PetCell, "x" | "y">, stage: StageRect, workArea: WorkArea): TerritoryBounds {
  const axis = (cellOrigin: number, local: number, size: number, start: number, extent: number): [number, number] => {
    const anchor = start - cellOrigin;
    if (!Number.isFinite(anchor) || !Number.isFinite(size) || !Number.isFinite(extent) || size >= extent) return [Number.isFinite(anchor) ? anchor : local, Number.isFinite(anchor) ? anchor : local];
    const min = start - cellOrigin;
    const max = start + extent - size - cellOrigin;
    return [Math.min(min, max), Math.max(min, max)];
  };
  const [minStageX, maxStageX] = axis(cell.x, stage.x, stage.width, workArea.x, workArea.width);
  const [minStageY, maxStageY] = axis(cell.y, stage.y, stage.height, workArea.y, workArea.height);
  return { minStageX, maxStageX, minStageY, maxStageY };
}

/** Picks the nearest display to a stage center for layout placement. */
export function nearestDisplayForStage<T extends { workArea: WorkArea }>(stage: StageRect, displays: readonly T[]): T | null {
  const cx = stage.x + stage.width / 2;
  const cy = stage.y + stage.height / 2;
  const distance = (area: WorkArea): number => {
    const dx = Math.max(area.x - cx, 0, cx - (area.x + area.width));
    const dy = Math.max(area.y - cy, 0, cy - (area.y + area.height));
    return dx * dx + dy * dy;
  };
  return displays.reduce<T | null>((nearest, display) => !nearest || distance(display.workArea) < distance(nearest.workArea) ? display : nearest, null);
}

export interface PetWindowOptions { root: string; log: (msg: string) => void; query?: Record<string, string>; }

export function createPetWindow(opts: PetWindowOptions): BrowserWindow {
  const cell = computeDefaultCell(screen.getPrimaryDisplay().workArea);
  const win = new BrowserWindow({
    x: cell.x, y: cell.y, width: cell.width, height: cell.height,
    transparent: true, frame: false, resizable: false, focusable: false, skipTaskbar: true,
    show: false, backgroundColor: "#00000000",
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false, preload: path.join(opts.root, "dist", PET_PRELOAD_FILE) },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true);
  win.setIgnoreMouseEvents(true, { forward: true });
  void win.loadFile(path.join(opts.root, "dist", PET_HTML_FILE), opts.query ? { query: opts.query } : undefined).catch((err: unknown) => {
    opts.log(`loadFile failed: ${String(err)}`);
    if (!win.isDestroyed()) win.destroy();
  });
  return win;
}
