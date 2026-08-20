/** Main-process pet factory and validated visible-stage placement IPC. */
import { type BrowserWindow, ipcMain, screen } from "electron";
import type { PetMove, StageRect } from "./pet-bridge.js";
import { candidateMoveStage, clampStage, createPetWindow, deriveTerritoryBounds, finalCellOrigin } from "./pet-window.js";

export interface PetDeps { root: string; log: (msg: string) => void; }
export interface PetHandle { start(): void; stop(): void; isRunning(): boolean; }

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const stageRect = (value: unknown): value is StageRect => {
  if (!value || typeof value !== "object") return false;
  const stage = value as Record<string, unknown>;
  return finite(stage.x) && finite(stage.y) && finite(stage.width) && finite(stage.height) && stage.width > 0 && stage.height > 0;
};
const movePayload = (value: unknown): value is PetMove => {
  if (!value || typeof value !== "object") return false;
  const move = value as Record<string, unknown>;
  return finite(move.dx) && finite(move.dy) && finite(move.screenX) && finite(move.screenY) && stageRect(move.stage);
};

export function createPet(deps: PetDeps): PetHandle {
  let win: BrowserWindow | null = null;
  let petCreating = false;
  let shown = false;
  const isPetSender = (sender: unknown): boolean => win !== null && !win.isDestroyed() && sender === win.webContents;

  const positionStage = (localStage: StageRect, globalStage: StageRect, display: { workArea: Electron.Rectangle }): void => {
    if (!win || win.isDestroyed()) return;
    const clamped = clampStage(globalStage, display.workArea);
    const cell = finalCellOrigin(clamped, localStage);
    const x = Math.round(cell.x);
    const y = Math.round(cell.y);
    win.setPosition(x, y);
    win.webContents.send("phi:pet-territory-bounds", deriveTerritoryBounds({ x, y }, localStage, display.workArea));
  };

  ipcMain.on("phi:pet-hit", (event, inside: unknown) => {
    if (!isPetSender(event.sender)) return;
    const isInside = inside === true;
    win?.setIgnoreMouseEvents(!isInside, { forward: !isInside });
  });

  ipcMain.on("phi:pet-stage-layout", (event, payload: unknown) => {
    if (!isPetSender(event.sender) || !win || win.isDestroyed()) return;
    const stage = (payload as { stage?: unknown } | null)?.stage;
    if (!stageRect(stage)) return;
    const bounds = win.getBounds();
    const globalStage = { x: bounds.x + stage.x, y: bounds.y + stage.y, width: stage.width, height: stage.height };
    const display = screen.getDisplayNearestPoint({ x: globalStage.x + globalStage.width / 2, y: globalStage.y + globalStage.height / 2 });
    positionStage(stage, globalStage, display);
    if (!shown && win && !win.isDestroyed()) {
      shown = true;
      win.show();
    }
  });

  ipcMain.on("phi:pet-window-move", (event, payload: unknown) => {
    if (!isPetSender(event.sender) || !win || win.isDestroyed() || !movePayload(payload)) return;
    const bounds = win.getBounds();
    const candidate = candidateMoveStage(bounds, payload);
    const target = screen.getDisplayNearestPoint({ x: payload.screenX, y: payload.screenY });
    positionStage(payload.stage, candidate, target);
  });

  return {
    start(): void {
      if (petCreating) return;
      if (win && !win.isDestroyed()) return;
      petCreating = true;
      try {
        const created = createPetWindow({ root: deps.root, log: deps.log });
        win = created;
        shown = false;
        created.once("closed", () => { if (win === created) win = null; });
      } finally { petCreating = false; }
    },
    stop(): void { if (win && !win.isDestroyed()) win.destroy(); win = null; shown = false; },
    isRunning: (): boolean => win !== null && !win.isDestroyed(),
  };
}
