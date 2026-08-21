/** Main-process pet factory and validated visible-stage placement IPC. */
import { type BrowserWindow, ipcMain, screen } from "electron";
import type {
  PetDragPosition,
  PetHitTestResult,
  PetStageLayout,
  PetZoomRequest,
  PetIdleDwellState,
  StageRect,
} from "./pet-bridge.js";
import {
  defaultStageBounds,
  createPetWindow,
  createPetSettingsWindow,
  type PetBounds,
} from "./pet-window.js";

const MOUSE_PASSTHROUGH = "phi:pet-mouse-passthrough";
const HIT_TEST_REQUEST = "phi:pet-hit-test-request";
const HIT_TEST_RESULT = "phi:pet-hit-test-result";

export type ZoomResult = { percent: number; accepted: boolean };
export type PetZoomConfig = {
  minPercent: number;
  maxPercent: number;
  defaultPercent: number;
  stepPercent: number;
  baseVisualWidth: number;
};
export interface PetDeps {
  root: string;
  log: (msg: string) => void;
  zoom: PetZoomConfig;
  getZoomPercent(): number;
  requestZoomPercent(percent: number): ZoomResult;
  getIdleDwellSeconds?(): number;
  requestIdleDwellSeconds?(dwellSeconds: number): {
    dwellSeconds: number;
    accepted: boolean;
    error?: string;
  };
  getParentWindow?(): unknown;
}
export interface PetHandle {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  setZoomPercent(percent: number): void;
  setIdleDwellSeconds(dwellSeconds: number): void;
  openSettings(): void;
  onRunningChanged(listener: (running: boolean) => void): () => void;
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const validPercent = (value: unknown, zoom: PetZoomConfig): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= zoom.minPercent &&
  value <= zoom.maxPercent &&
  (value - zoom.minPercent) % zoom.stepPercent === 0;
const canonicalPercent = (value: unknown, zoom: PetZoomConfig): number =>
  validPercent(value, zoom) ? value : zoom.defaultPercent;
const validDwellSeconds = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 1 &&
  value <= 3600;

/** Returns the fixed-base, 16:9 native stage dimensions for one zoom value. */
export function stageDimensions(
  zoom: Pick<PetZoomConfig, "baseVisualWidth">,
  percent: number,
): Pick<PetBounds, "width" | "height"> {
  const width = Math.floor((zoom.baseVisualWidth * percent) / 100);
  return { width, height: Math.floor((width * 9) / 16) };
}

const stageRect = (value: unknown): value is StageRect => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const stage = value as Record<string, unknown>;
  return (
    finite(stage.x) &&
    finite(stage.y) &&
    finite(stage.width) &&
    finite(stage.height) &&
    Number.isInteger(stage.width) &&
    Number.isInteger(stage.height) &&
    stage.width > 0 &&
    stage.height > 0
  );
};

const stageLayout = (value: unknown): value is PetStageLayout => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return (
    Object.keys(payload).every((key) => key === "stage") &&
    stageRect(payload.stage)
  );
};

const dragPositionPayload = (value: unknown): value is PetDragPosition => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const position = value as Record<string, unknown>;
  return (
    (position.phase === "move" ||
      position.phase === "end" ||
      position.phase === "cancel") &&
    finite(position.screenX) &&
    finite(position.screenY) &&
    finite(position.anchorX) &&
    finite(position.anchorY) &&
    stageRect(position.stage)
  );
};

const zoomRequest = (
  value: unknown,
  zoom: PetZoomConfig,
): value is PetZoomRequest => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return validPercent((value as Record<string, unknown>).percent, zoom);
};

const hitTestResult = (value: unknown): value is PetHitTestResult => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (
    Object.keys(result).every(
      (key) => key === "requestId" || key === "visible",
    ) &&
    Object.keys(result).length === 2 &&
    typeof result.requestId === "number" &&
    Number.isSafeInteger(result.requestId) &&
    result.requestId > 0 &&
    typeof result.visible === "boolean"
  );
};

const sameStageRect = (left: StageRect, right: StageRect): boolean =>
  left.x === right.x &&
  left.y === right.y &&
  left.width === right.width &&
  left.height === right.height;

export function createPet(deps: PetDeps): PetHandle {
  let win: BrowserWindow | null = null;
  let settingsWin: BrowserWindow | null = null;
  let settingsParent: BrowserWindow | null = null;
  let settingsParentClosedListener: (() => void) | null = null;
  let petCreating = false;
  let shown = false;
  let rendererReady = false;
  let desiredPercent = canonicalPercent(deps.getZoomPercent(), deps.zoom);
  let pendingZoomState: ZoomResult | null = null;
  const initialDwell = deps.getIdleDwellSeconds?.() ?? 10;
  let desiredDwellSeconds = validDwellSeconds(initialDwell) ? initialDwell : 10;
  let pendingDwellSeconds: number | null = null;
  let running = false;
  const runningListeners = new Set<(running: boolean) => void>();
  let activeDrag = false;
  let dragOrigin: { x: number; y: number } | null = null;
  let lastRoundedPosition: { x: number; y: number } | null = null;
  let nextHitTestRequestId = 1;
  let pendingHitTest: {
    requestId: number;
    screen: { x: number; y: number };
    window: StageRect;
  } | null = null;
  let ignoreMouseEvents: boolean | null = null;
  let deferredHitTest = false;

  const notifyRunning = (next: boolean): void => {
    if (running === next) return;
    running = next;
    for (const listener of [...runningListeners]) listener(next);
  };

  const isPetSender = (sender: unknown): boolean =>
    win !== null && !win.isDestroyed() && sender === win.webContents;
  const liveWindow = (): BrowserWindow | null =>
    win && !win.isDestroyed() ? win : null;
  const liveSettingsWindow = (): BrowserWindow | null =>
    settingsWin && !settingsWin.isDestroyed() ? settingsWin : null;
  const detachSettingsParentListener = (): void => {
    if (settingsParent && settingsParentClosedListener) {
      settingsParent.removeListener("closed", settingsParentClosedListener);
    }
    settingsParent = null;
    settingsParentClosedListener = null;
  };
  const sendOverlayDwellState = (dwellSeconds: number): void => {
    liveWindow()?.webContents.send("phi:pet-idle-dwell-state", {
      dwellSeconds,
    } satisfies PetIdleDwellState);
  };
  const sendDwellState = (dwellSeconds: number): void => {
    const state: PetIdleDwellState = { dwellSeconds };
    sendOverlayDwellState(dwellSeconds);
    liveSettingsWindow()?.webContents.send("phi:pet-idle-dwell-state", state);
  };
  const clearDragState = (): void => {
    activeDrag = false;
    dragOrigin = null;
    lastRoundedPosition = null;
  };

  // Electron ignores the whole window and forwards only mouse movement while
  // ignored, so a cursor can cross the sampled edge before native state flips.
  // Keep unknown or stale state ignored; this is safe but not atomic per-pixel.
  const applyIgnoreMouseEvents = (ignore: boolean): void => {
    const current = liveWindow();
    if (!current || ignoreMouseEvents === ignore) return;
    try {
      current.setIgnoreMouseEvents(ignore, { forward: true });
      ignoreMouseEvents = ignore;
    } catch (error) {
      ignoreMouseEvents = null;
      deps.log(`setIgnoreMouseEvents failed: ${String(error)}`);
    }
  };

  const issueHitTest = (): void => {
    const current = liveWindow();
    if (!current) return;
    try {
      const point = screen.getCursorScreenPoint();
      const bounds = current.getBounds();
      const windowRect: StageRect = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      };
      const requestId = nextHitTestRequestId;
      nextHitTestRequestId += 1;
      pendingHitTest = {
        requestId,
        screen: { x: point.x, y: point.y },
        window: windowRect,
      };
      current.webContents.send(HIT_TEST_REQUEST, {
        requestId,
        screenX: point.x,
        screenY: point.y,
        window: windowRect,
      });
    } catch (error) {
      pendingHitTest = null;
      applyIgnoreMouseEvents(true);
      deps.log(`hit-test request failed: ${String(error)}`);
    }
  };

  const sendZoomState = (state: ZoomResult): void => {
    const current = liveWindow();
    if (!current || !rendererReady) return;
    current.webContents.send("phi:pet-zoom-state", {
      percent: state.percent,
      accepted: state.accepted,
    });
  };

  const resizeStage = (stage: StageRect, initial: boolean): boolean => {
    const current = liveWindow();
    if (!current) return false;
    const bounds = current.getBounds();
    if (bounds.width === stage.width && bounds.height === stage.height)
      return false;
    current.setBounds(
      initial
        ? {
            x: bounds.x,
            y: bounds.y,
            width: stage.width,
            height: stage.height,
          }
        : {
            x: bounds.x + Math.round((bounds.width - stage.width) / 2),
            y: bounds.y + bounds.height - stage.height,
            width: stage.width,
            height: stage.height,
          },
    );
    return true;
  };

  ipcMain.on("phi:pet-zoom-request", (event, payload: unknown) => {
    if (!isPetSender(event.sender) || !zoomRequest(payload, deps.zoom)) return;
    const result = deps.requestZoomPercent(payload.percent);
    const response: ZoomResult = {
      percent: canonicalPercent(result.percent, deps.zoom),
      accepted: result.accepted === true,
    };
    desiredPercent = response.percent;
    if (!rendererReady) {
      pendingZoomState = response;
      return;
    }
    sendZoomState(response);
  });

  ipcMain.on(MOUSE_PASSTHROUGH, (event, payload: unknown) => {
    if (!isPetSender(event.sender) || typeof payload !== "boolean") return;
    applyIgnoreMouseEvents(activeDrag ? false : payload);
  });

  ipcMain.on(HIT_TEST_RESULT, (event, payload: unknown) => {
    const current = liveWindow();
    if (!isPetSender(event.sender) || !current || !hitTestResult(payload))
      return;
    const pending = pendingHitTest;
    if (!pending || pending.requestId !== payload.requestId) return;
    try {
      const bounds = current.getBounds();
      if (
        !sameStageRect(pending.window, {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        })
      ) {
        pendingHitTest = null;
        applyIgnoreMouseEvents(true);
        issueHitTest();
        return;
      }
      const point = screen.getCursorScreenPoint();
      if (point.x !== pending.screen.x || point.y !== pending.screen.y) {
        pendingHitTest = null;
        applyIgnoreMouseEvents(true);
        issueHitTest();
        return;
      }
      pendingHitTest = null;
      applyIgnoreMouseEvents(activeDrag ? false : !payload.visible);
    } catch (error) {
      pendingHitTest = null;
      applyIgnoreMouseEvents(true);
      deps.log(`hit-test result validation failed: ${String(error)}`);
    }
  });

  if (
    typeof (ipcMain as unknown as { handle?: Function }).handle === "function"
  ) {
    ipcMain.handle(
      "phi:pet-settings-idle-dwell-request",
      (event, payload: unknown) => {
        const current = liveSettingsWindow();
        if (
          !current ||
          event.sender !== current.webContents ||
          !payload ||
          typeof payload !== "object" ||
          Array.isArray(payload)
        ) {
          return {
            dwellSeconds: desiredDwellSeconds,
            accepted: false,
            error: "Invalid pet settings request.",
          };
        }
        const record = payload as Record<string, unknown>;
        if (
          Object.keys(record).length !== 1 ||
          !validDwellSeconds(record.dwellSeconds)
        ) {
          return {
            dwellSeconds: desiredDwellSeconds,
            accepted: false,
            error: "Invalid pet settings request.",
          };
        }
        try {
          const result = deps.requestIdleDwellSeconds?.(
            record.dwellSeconds,
          ) ?? {
            dwellSeconds: desiredDwellSeconds,
            accepted: false,
            error: "Unable to save pet idle interval.",
          };
          const canonical = validDwellSeconds(result.dwellSeconds)
            ? result.dwellSeconds
            : desiredDwellSeconds;
          if (result.accepted && canonical !== desiredDwellSeconds) {
            desiredDwellSeconds = canonical;
          }
          return {
            dwellSeconds: canonical,
            accepted: result.accepted === true,
            ...(result.error ? { error: result.error } : {}),
          };
        } catch {
          return {
            dwellSeconds: desiredDwellSeconds,
            accepted: false,
            error: "Unable to save pet idle interval.",
          };
        }
      },
    );
  }

  ipcMain.on("phi:pet-stage-layout", (event, payload: unknown) => {
    if (!isPetSender(event.sender) || !stageLayout(payload)) return;
    const stage = payload.stage;
    if (stage.x !== 0 || stage.y !== 0) return;
    const current = liveWindow();
    if (!current) return;
    const dimensions = stageDimensions(deps.zoom, desiredPercent);
    if (
      stage.width !== dimensions.width ||
      stage.height !== dimensions.height
    ) {
      if (!rendererReady && pendingZoomState !== null) {
        current.webContents.send("phi:pet-zoom-state", {
          percent: pendingZoomState.percent,
          accepted: pendingZoomState.accepted,
        });
      }
      return;
    }
    const initial = !rendererReady;
    const resized = resizeStage({ ...stage, ...dimensions }, initial);
    if (initial) {
      rendererReady = true;
      const initialZoom = pendingZoomState ?? {
        percent: desiredPercent,
        accepted: true,
      };
      pendingZoomState = null;
      sendZoomState(initialZoom);
      if (pendingDwellSeconds !== null) {
        sendOverlayDwellState(pendingDwellSeconds);
        pendingDwellSeconds = null;
      }
      if (!shown) {
        shown = true;
        current.show();
      }
      issueHitTest();
    } else if (resized) {
      if (activeDrag) {
        deferredHitTest = true;
      } else {
        pendingHitTest = null;
        applyIgnoreMouseEvents(true);
        issueHitTest();
      }
    }
  });

  ipcMain.on("phi:pet-drag-position", (event, payload: unknown) => {
    const current = liveWindow();
    if (!isPetSender(event.sender) || !current || !dragPositionPayload(payload))
      return;

    if (payload.phase === "end") {
      if (!activeDrag) return;
      try {
        const bounds = current.getBounds();
        const workArea = screen.getDisplayNearestPoint({
          x: payload.screenX,
          y: payload.screenY,
        }).workArea;
        const x =
          bounds.width >= workArea.width
            ? workArea.x
            : Math.min(
                Math.max(bounds.x, workArea.x),
                workArea.x + workArea.width - bounds.width,
              );
        const y =
          bounds.height >= workArea.height
            ? workArea.y
            : Math.min(
                Math.max(bounds.y, workArea.y),
                workArea.y + workArea.height - bounds.height,
              );
        if (x !== bounds.x || y !== bounds.y) {
          current.setPosition(x, y);
        }
      } catch {
        // Native coordinate conversion can reject a transient drag position.
      } finally {
        clearDragState();
      }
      if (deferredHitTest) {
        deferredHitTest = false;
        applyIgnoreMouseEvents(true);
        issueHitTest();
      }
      return;
    }

    if (payload.phase === "cancel") {
      if (!activeDrag || !dragOrigin) return;
      current.setPosition(dragOrigin.x, dragOrigin.y);
      clearDragState();
      if (deferredHitTest) {
        deferredHitTest = false;
        applyIgnoreMouseEvents(true);
        issueHitTest();
      }
      return;
    }

    if (!activeDrag) {
      const bounds = current.getBounds();
      activeDrag = true;
      dragOrigin = { x: bounds.x, y: bounds.y };
      lastRoundedPosition = null;
    }
    const x = Math.round(payload.screenX - payload.anchorX);
    const y = Math.round(payload.screenY - payload.anchorY);
    if (lastRoundedPosition?.x === x && lastRoundedPosition.y === y) return;
    lastRoundedPosition = { x, y };
    try {
      current.setPosition(x, y);
    } catch {
      // Native coordinate conversion can reject a transient drag position.
    }
  });

  return {
    start(): void {
      if (petCreating) return;
      if (win && !win.isDestroyed()) return;
      if (win?.isDestroyed()) win = null;
      petCreating = true;
      try {
        desiredPercent = canonicalPercent(deps.getZoomPercent(), deps.zoom);
        const dimensions = stageDimensions(deps.zoom, desiredPercent);
        const bounds = defaultStageBounds(
          screen.getPrimaryDisplay().workArea,
          dimensions.width,
          dimensions.height,
        );
        const created = createPetWindow({
          root: deps.root,
          log: deps.log,
          bounds,
          query: {
            petZoomPercent: String(desiredPercent),
            petZoomMinPercent: String(deps.zoom.minPercent),
            petZoomMaxPercent: String(deps.zoom.maxPercent),
            petZoomDefaultPercent: String(deps.zoom.defaultPercent),
            petZoomStepPercent: String(deps.zoom.stepPercent),
            petBaseVisualWidth: String(deps.zoom.baseVisualWidth),
            petIdleDwellSeconds: String(desiredDwellSeconds),
          },
        });
        win = created;
        ignoreMouseEvents = null;
        try {
          created.setIgnoreMouseEvents(true, { forward: true });
          ignoreMouseEvents = true;
        } catch (error) {
          deps.log(`setIgnoreMouseEvents failed: ${String(error)}`);
        }
        shown = false;
        rendererReady = false;
        pendingHitTest = null;
        deferredHitTest = false;
        pendingZoomState = null;
        clearDragState();
        created.once("closed", () => {
          if (win !== created) return;
          win = null;
          shown = false;
          rendererReady = false;
          pendingZoomState = null;
          pendingHitTest = null;
          deferredHitTest = false;
          ignoreMouseEvents = null;
          clearDragState();
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
      pendingZoomState = null;
      pendingHitTest = null;
      deferredHitTest = false;
      ignoreMouseEvents = null;
      clearDragState();
      notifyRunning(false);
    },
    isRunning: (): boolean => running && win !== null && !win.isDestroyed(),
    setZoomPercent(percent: number): void {
      if (!validPercent(percent, deps.zoom)) return;
      desiredPercent = percent;
      pendingZoomState = { percent, accepted: true };
      if (rendererReady) {
        pendingZoomState = null;
        sendZoomState({ percent, accepted: true });
      }
    },
    setIdleDwellSeconds(dwellSeconds: number): void {
      if (!validDwellSeconds(dwellSeconds)) return;
      desiredDwellSeconds = dwellSeconds;
      pendingDwellSeconds = dwellSeconds;
      if (rendererReady) {
        pendingDwellSeconds = null;
        sendDwellState(dwellSeconds);
      } else {
        liveSettingsWindow()?.webContents.send("phi:pet-idle-dwell-state", {
          dwellSeconds,
        } satisfies PetIdleDwellState);
      }
    },
    openSettings(): void {
      const parent = deps.getParentWindow?.();
      if (
        !parent ||
        typeof parent !== "object" ||
        (parent as BrowserWindow).isDestroyed()
      )
        return;
      const existing = liveSettingsWindow();
      if (existing) {
        existing.focus();
        return;
      }
      const parentWindow = parent as BrowserWindow;
      settingsWin = createPetSettingsWindow({
        root: deps.root,
        log: deps.log,
        parent: parentWindow,
        dwellSeconds: desiredDwellSeconds,
        onClosed: (closed) => {
          if (settingsWin === closed) {
            settingsWin = null;
            detachSettingsParentListener();
          }
        },
      });
      const onParentClosed = (): void => {
        const current = liveSettingsWindow();
        detachSettingsParentListener();
        if (current) current.destroy();
        settingsWin = null;
      };
      settingsParent = parentWindow;
      settingsParentClosedListener = onParentClosed;
      parentWindow.once("closed", onParentClosed);
    },
    onRunningChanged(listener: (running: boolean) => void): () => void {
      runningListeners.add(listener);
      return () => runningListeners.delete(listener);
    },
  };
}
