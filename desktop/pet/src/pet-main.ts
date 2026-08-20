/** Main-process pet factory and validated visible-stage placement IPC. */
import { type BrowserWindow, ipcMain, screen } from "electron";
import type { PetMove, PetScaleRequest, PetStageLayout, StageRect } from "./pet-bridge.js";
import { candidateMoveStage, clampStage, createPetWindow, deriveTerritoryBounds, finalCellOrigin } from "./pet-window.js";

export type ScaleResult = { tick: number; accepted: boolean };
export type PetScaleConfig = {
  minTick: number;
  maxTick: number;
  defaultTick: number;
  minFactor: number;
  stepFactor: number;
};
export interface PetDeps {
  root: string;
  log: (msg: string) => void;
  scale: PetScaleConfig;
  getScaleTick(): number;
  requestScaleTick(tick: number): ScaleResult;
}
export interface PetHandle {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  setScaleTick(tick: number): void;
  resetPosition(): void;
  onRunningChanged(listener: (running: boolean) => void): () => void;
}

type PetDisplay = { id?: number; workArea: Electron.Rectangle };

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const validTick = (value: unknown, scale: PetScaleConfig): value is number =>
  typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) && value >= scale.minTick && value <= scale.maxTick;
const canonicalTick = (value: unknown, scale: PetScaleConfig): number => validTick(value, scale) ? value : scale.defaultTick;

const stageRect = (value: unknown): value is StageRect => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const stage = value as Record<string, unknown>;
  return finite(stage.x) && finite(stage.y) && finite(stage.width) && finite(stage.height) && stage.width > 0 && stage.height > 0;
};

const stageLayout = (value: unknown): value is PetStageLayout => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  if (!stageRect(payload.stage)) return false;
  return !Object.hasOwn(payload, "resetPosition") || typeof payload.resetPosition === "boolean";
};

const movePayload = (value: unknown): value is PetMove => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const move = value as Record<string, unknown>;
  return finite(move.dx) && finite(move.dy) && finite(move.screenX) && finite(move.screenY) && stageRect(move.stage);
};

const scaleRequest = (value: unknown, scale: PetScaleConfig): value is PetScaleRequest => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return validTick((value as Record<string, unknown>).tick, scale);
};

export function createPet(deps: PetDeps): PetHandle {
  let win: BrowserWindow | null = null;
  let petCreating = false;
  let shown = false;
  let rendererReady = false;
  let awaitingInitialScaleLayout = false;
  let pendingReset = false;
  let awaitingResetLayout = false;
  let desiredTick = canonicalTick(deps.getScaleTick(), deps.scale);
  let pendingScaleState: ScaleResult | null = null;
  let latestDisplayId: number | null = null;
  let latestGlobalStageCenter = { x: 0, y: 0 };
  let running = false;
  const runningListeners = new Set<(running: boolean) => void>();

  const notifyRunning = (next: boolean): void => {
    if (running === next) return;
    running = next;
    for (const listener of [...runningListeners]) listener(next);
  };

  const isPetSender = (sender: unknown): boolean => win !== null && !win.isDestroyed() && sender === win.webContents;
  const liveWindow = (): BrowserWindow | null => win && !win.isDestroyed() ? win : null;

  const sendScaleState = (state: ScaleResult): void => {
    const current = liveWindow();
    if (!current || !rendererReady) return;
    current.webContents.send("phi:pet-scale-state", { tick: state.tick, accepted: state.accepted });
  };

  const sendReset = (): void => {
    const current = liveWindow();
    if (!current || !rendererReady) return;
    current.webContents.send("phi:pet-reset-position");
  };

  const displayForRetainedPlacement = (): PetDisplay => {
    if (latestDisplayId !== null && typeof screen.getAllDisplays === "function") {
      const retained = screen.getAllDisplays().find((display) => display.id === latestDisplayId);
      if (retained) return retained;
    }
    return screen.getDisplayNearestPoint(latestGlobalStageCenter);
  };

  const positionStage = (localStage: StageRect, globalStage: StageRect, display: PetDisplay): void => {
    const current = liveWindow();
    if (!current) return;
    const clamped = clampStage(globalStage, display.workArea);
    const cell = finalCellOrigin(clamped, localStage);
    const x = Math.round(cell.x);
    const y = Math.round(cell.y);
    current.setPosition(x, y);
    latestDisplayId = typeof display.id === "number" ? display.id : null;
    latestGlobalStageCenter = {
      x: clamped.x + clamped.width / 2,
      y: clamped.y + clamped.height / 2,
    };
    current.webContents.send("phi:pet-territory-bounds", deriveTerritoryBounds({ x, y }, localStage, display.workArea));
  };

  const homeStage = (localStage: StageRect): void => {
    const display = displayForRetainedPlacement();
    const target = {
      x: display.workArea.x + display.workArea.width - localStage.width,
      y: display.workArea.y + display.workArea.height - localStage.height,
      width: localStage.width,
      height: localStage.height,
    };
    positionStage(localStage, target, display);
  };

  ipcMain.on("phi:pet-hit", (event, inside: unknown) => {
    if (!isPetSender(event.sender) || typeof inside !== "boolean") return;
    liveWindow()?.setIgnoreMouseEvents(!inside, { forward: !inside });
  });

  ipcMain.on("phi:pet-scale-request", (event, payload: unknown) => {
    if (!isPetSender(event.sender) || !scaleRequest(payload, deps.scale)) return;
    const result = deps.requestScaleTick(payload.tick);
    const response: ScaleResult = {
      tick: canonicalTick(result.tick, deps.scale),
      accepted: result.accepted === true,
    };
    desiredTick = response.tick;
    if (!rendererReady) {
      pendingScaleState = response;
      return;
    }
    sendScaleState(response);
  });

  ipcMain.on("phi:pet-stage-layout", (event, payload: unknown) => {
    if (!isPetSender(event.sender) || !stageLayout(payload)) return;
    const current = liveWindow();
    if (!current) return;
    const stage = payload.stage;
    const bounds = current.getBounds();
    const globalStage = {
      x: bounds.x + stage.x,
      y: bounds.y + stage.y,
      width: stage.width,
      height: stage.height,
    };
    const nearestDisplay = (): PetDisplay => screen.getDisplayNearestPoint({
      x: globalStage.x + globalStage.width / 2,
      y: globalStage.y + globalStage.height / 2,
    });

    if (!rendererReady) {
      positionStage(stage, globalStage, nearestDisplay());
      rendererReady = true;
      awaitingInitialScaleLayout = true;
      const initial = pendingScaleState ?? { tick: desiredTick, accepted: true };
      pendingScaleState = null;
      sendScaleState(initial);
      return;
    }

    if (awaitingInitialScaleLayout) {
      positionStage(stage, globalStage, nearestDisplay());
      awaitingInitialScaleLayout = false;
      if (pendingReset) {
        awaitingResetLayout = true;
        sendReset();
      } else if (!shown) {
        shown = true;
        current.show();
      }
      return;
    }

    if (awaitingResetLayout) {
      if (payload.resetPosition === true) {
        homeStage(stage);
        pendingReset = false;
        awaitingResetLayout = false;
        if (!shown) {
          shown = true;
          current.show();
        }
      } else {
        positionStage(stage, globalStage, nearestDisplay());
      }
      return;
    }

    positionStage(stage, globalStage, nearestDisplay());
  });

  ipcMain.on("phi:pet-window-move", (event, payload: unknown) => {
    const current = liveWindow();
    if (!isPetSender(event.sender) || !current || !movePayload(payload)) return;
    const bounds = current.getBounds();
    const candidate = candidateMoveStage(bounds, payload);
    const target = screen.getDisplayNearestPoint({ x: payload.screenX, y: payload.screenY });
    positionStage(payload.stage, candidate, target);
  });

  return {
    start(): void {
      if (petCreating) return;
      if (win && !win.isDestroyed()) return;
      if (win?.isDestroyed()) win = null;
      petCreating = true;
      try {
        desiredTick = canonicalTick(deps.getScaleTick(), deps.scale);
        const created = createPetWindow({
          root: deps.root,
          log: deps.log,
          query: {
            petScaleTick: String(desiredTick),
            petScaleMinTick: String(deps.scale.minTick),
            petScaleMaxTick: String(deps.scale.maxTick),
            petScaleDefaultTick: String(deps.scale.defaultTick),
            petScaleMinFactor: String(deps.scale.minFactor),
            petScaleStepFactor: String(deps.scale.stepFactor),
          },
        });
        win = created;
        shown = false;
        rendererReady = false;
        awaitingInitialScaleLayout = false;
        pendingReset = false;
        awaitingResetLayout = false;
        created.once("closed", () => {
          if (win !== created) return;
          win = null;
          shown = false;
          rendererReady = false;
          awaitingInitialScaleLayout = false;
          pendingScaleState = null;
          pendingReset = false;
          awaitingResetLayout = false;
          notifyRunning(false);
        });
        notifyRunning(true);
      } finally {
        petCreating = false;
      }
    },
    stop(): void {
      const current = win;
      if (current && !current.isDestroyed()) current.destroy();
      if (win === current) win = null;
      shown = false;
      rendererReady = false;
      awaitingInitialScaleLayout = false;
      pendingScaleState = null;
      pendingReset = false;
      awaitingResetLayout = false;
      notifyRunning(false);
    },
    isRunning: (): boolean => running && win !== null && !win.isDestroyed(),
    setScaleTick(tick: number): void {
      if (!validTick(tick, deps.scale)) return;
      desiredTick = tick;
      pendingScaleState = { tick, accepted: true };
      if (rendererReady) {
        pendingScaleState = null;
        sendScaleState({ tick, accepted: true });
      }
    },
    resetPosition(): void {
      if (!liveWindow() || pendingReset || awaitingResetLayout) return;
      pendingReset = true;
      if (!rendererReady || awaitingInitialScaleLayout || !shown) return;
      awaitingResetLayout = true;
      sendReset();
    },
    onRunningChanged(listener: (running: boolean) => void): () => void {
      runningListeners.add(listener);
      return () => runningListeners.delete(listener);
    },
  };
}
