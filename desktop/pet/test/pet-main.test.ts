// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fakeIpcMain, fakeScreen, FakeBrowserWindow } = vi.hoisted(() => {
  const handlers = new Map<
    string,
    (event: { sender: unknown }, payload: unknown) => void
  >();
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = [];
    destroyed = false;
    closedListener: (() => void) | null = null;
    bounds = { x: 10, y: 20, width: 480, height: 540 };
    webContents = { send: vi.fn() };
    constructor() {
      FakeBrowserWindow.instances.push(this);
    }
    getBounds() {
      return this.bounds;
    }
    setPosition(x: number, y: number): void {
      this.bounds.x = x;
      this.bounds.y = y;
    }
    setIgnoreMouseEvents(): void {}
    setAlwaysOnTop(): void {}
    setVisibleOnAllWorkspaces(): void {}
    loadFile(): Promise<void> {
      return Promise.resolve();
    }
    once(event: string, listener: () => void): void {
      if (event === "closed") this.closedListener = listener;
    }
    show(): void {}
    isDestroyed(): boolean {
      return this.destroyed;
    }
    destroy(): void {
      this.destroyed = true;
      this.closedListener?.();
    }
  }
  return {
    fakeIpcMain: {
      on: vi.fn(
        (
          channel: string,
          handler: (event: { sender: unknown }, payload: unknown) => void,
        ) => handlers.set(channel, handler),
      ),
      handlers,
    },
    fakeScreen: {
      getPrimaryDisplay: vi.fn(() => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      })),
      getDisplayNearestPoint: vi.fn(() => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      })),
      getAllDisplays: vi.fn(
        (): Array<{
          id: number;
          workArea: { x: number; y: number; width: number; height: number };
        }> => [],
      ),
    },
    FakeBrowserWindow,
  };
});
vi.mock("electron", () => ({
  BrowserWindow: FakeBrowserWindow,
  ipcMain: fakeIpcMain,
  screen: fakeScreen,
}));
import { createPet } from "../src/pet-main.js";

const stage = { x: 30, y: 40, width: 100, height: 50 };
const move = {
  dx: 0.6,
  dy: -2.4,
  screenX: 1950,
  screenY: -50,
  stage,
  heldDrag: false,
};
const dragMove = (overrides: Record<string, unknown> = {}) => ({
  phase: "move" as const,
  screenX: 1950,
  screenY: 600,
  anchorX: 40,
  anchorY: 60,
  stage,
  ...overrides,
});
const dragCancel = (overrides: Record<string, unknown> = {}) => ({
  phase: "cancel" as const,
  screenX: 0,
  screenY: 0,
  anchorX: 0,
  anchorY: 0,
  stage,
  ...overrides,
});
const deps = () => ({
  root: "/tmp/pet",
  log: () => {},
  scale: {
    minTick: 0,
    maxTick: 7,
    defaultTick: 2,
    minFactor: 0.4,
    stepFactor: 0.05,
  },
  getScaleTick: () => 2,
  requestScaleTick: (tick: number) => ({ tick, accepted: true }),
});
beforeEach(() => {
  vi.clearAllMocks();
  fakeScreen.getDisplayNearestPoint.mockImplementation(() => ({
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  }));
  fakeScreen.getAllDisplays.mockImplementation(() => []);
  fakeIpcMain.handlers.clear();
  FakeBrowserWindow.instances.length = 0;
});
const started = () => {
  const pet = createPet(deps());
  pet.start();
  return FakeBrowserWindow.instances[0];
};

describe("createPet validated placement", () => {
  it("keeps named lifecycle start/stop behavior", () => {
    const pet = createPet(deps());
    pet.start();
    expect(pet.isRunning()).toBe(true);
    pet.stop();
    expect(pet.isRunning()).toBe(false);
  });
  it("rejects bad senders and invalid move/layout numbers without native movement", () => {
    const win = started();
    const setPosition = vi.spyOn(win, "setPosition");
    const show = vi.spyOn(win, "show");
    fakeIpcMain.handlers.get("phi:pet-window-move")?.({ sender: {} }, move);
    fakeIpcMain.handlers.get("phi:pet-window-move")?.(
      { sender: win.webContents },
      { ...move, dx: NaN },
    );
    fakeIpcMain.handlers.get("phi:pet-window-move")?.(
      { sender: win.webContents },
      { ...move, screenX: undefined },
    );
    fakeIpcMain.handlers.get("phi:pet-window-move")?.(
      { sender: win.webContents },
      { ...move, screenY: Infinity },
    );
    fakeIpcMain.handlers.get("phi:pet-window-move")?.(
      { sender: win.webContents },
      { ...move, stage: { ...stage, width: 0 } },
    );
    fakeIpcMain.handlers.get("phi:pet-stage-layout")?.(
      { sender: win.webContents },
      {},
    );
    fakeIpcMain.handlers.get("phi:pet-stage-layout")?.(
      { sender: win.webContents },
      { stage: { ...stage, x: "30" } },
    );
    fakeIpcMain.handlers.get("phi:pet-stage-layout")?.(
      { sender: win.webContents },
      { stage: { ...stage, height: Infinity } },
    );
    expect(setPosition).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
    fakeIpcMain.handlers.get("phi:pet-window-move")?.(
      { sender: win.webContents },
      move,
    );
    expect(show).not.toHaveBeenCalled();
  });
  it.each([
    {
      name: "layout center selects a negative-coordinate work area",
      channel: "phi:pet-stage-layout",
      payload: { stage },
      display: { workArea: { x: -1600, y: -900, width: 500, height: 400 } },
      initialBounds: { x: -1500, y: -800 },
      point: { x: -1420, y: -735 },
      position: [-1500, -800],
    },
    {
      name: "release point selects a gap display with negative y",
      channel: "phi:pet-window-move",
      payload: move,
      display: { workArea: { x: 2000, y: -100, width: 500, height: 400 } },
      point: { x: 1950, y: -50 },
      position: [1970, 18],
    },
  ])(
    "$name through its IPC handler",
    ({ channel, payload, display, initialBounds, point, position }) => {
      fakeScreen.getDisplayNearestPoint.mockReturnValue(display);
      const win = started();
      if (initialBounds) Object.assign(win.bounds, initialBounds);
      const setPosition = vi.spyOn(win, "setPosition");
      fakeIpcMain.handlers.get(channel)?.({ sender: win.webContents }, payload);
      expect(fakeScreen.getDisplayNearestPoint).toHaveBeenCalledWith(point);
      expect(setPosition).toHaveBeenCalledWith(position[0], position[1]);
    },
  );
  it("uses release display and rounds only final cell coordinates", () => {
    fakeScreen.getDisplayNearestPoint.mockReturnValue({
      workArea: { x: 2000, y: -100, width: 500, height: 400 },
    });
    const win = started();
    const setPosition = vi.spyOn(win, "setPosition");
    fakeIpcMain.handlers.get("phi:pet-window-move")?.(
      { sender: win.webContents },
      move,
    );
    expect(fakeScreen.getDisplayNearestPoint).toHaveBeenCalledWith({
      x: 1950,
      y: -50,
    });
    expect(setPosition).toHaveBeenCalledWith(1970, 18);
    expect(win.webContents.send).toHaveBeenCalledWith(
      "phi:pet-territory-bounds",
      expect.objectContaining({ minStageX: 30, maxStageX: 430 }),
    );
  });
  it("keeps a pre-layout window hidden across repeated starts, then shows it once after layout", () => {
    const pet = createPet(deps());
    pet.start();
    const win = FakeBrowserWindow.instances[0];
    const show = vi.spyOn(win, "show");
    pet.start();
    expect(show).not.toHaveBeenCalled();
    const layout = fakeIpcMain.handlers.get("phi:pet-stage-layout");
    layout?.({ sender: win.webContents }, { stage });
    expect(win.webContents.send).toHaveBeenCalledWith(
      "phi:pet-territory-bounds",
      expect.any(Object),
    );
    expect(show).not.toHaveBeenCalled();
    layout?.({ sender: win.webContents }, { stage });
    expect(show).toHaveBeenCalledTimes(1);
    layout?.({ sender: win.webContents }, { stage });
    fakeIpcMain.handlers.get("phi:pet-window-move")?.(
      { sender: win.webContents },
      move,
    );
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("sends scale state before showing and shows only after the second layout", () => {
    const pet = createPet(deps());
    const changes: boolean[] = [];
    pet.onRunningChanged((running) => changes.push(running));
    pet.start();
    const win = FakeBrowserWindow.instances[0];
    const show = vi.spyOn(win, "show");
    const layout = fakeIpcMain.handlers.get("phi:pet-stage-layout");
    layout?.({ sender: win.webContents }, { stage });
    expect(win.webContents.send).toHaveBeenLastCalledWith(
      "phi:pet-scale-state",
      { tick: 2, accepted: true },
    );
    expect(show).not.toHaveBeenCalled();
    layout?.({ sender: win.webContents }, { stage });
    expect(show).toHaveBeenCalledTimes(1);
    expect(changes).toEqual([true]);
  });

  it("routes valid scale requests and rejects malformed senders without native action", () => {
    const requestScaleTick = vi.fn((tick: number) => ({
      tick: Math.min(tick, 3),
      accepted: tick <= 3,
    }));
    const pet = createPet({ ...deps(), requestScaleTick });
    pet.start();
    const win = FakeBrowserWindow.instances[0];
    const layout = fakeIpcMain.handlers.get("phi:pet-stage-layout");
    layout?.({ sender: win.webContents }, { stage });
    layout?.({ sender: win.webContents }, { stage });
    const send = vi.spyOn(win.webContents, "send");
    send.mockClear();
    const request = fakeIpcMain.handlers.get("phi:pet-scale-request");
    request?.({ sender: {} }, { tick: 3 });
    request?.({ sender: win.webContents }, { tick: 2.5 });
    request?.({ sender: win.webContents }, { tick: 4 });
    expect(requestScaleTick).toHaveBeenCalledWith(4);
    expect(send).toHaveBeenCalledWith("phi:pet-scale-state", {
      tick: 3,
      accepted: false,
    });
    request?.({ sender: win.webContents }, { tick: 3 });
    expect(send).toHaveBeenCalledWith("phi:pet-scale-state", {
      tick: 3,
      accepted: true,
    });
    void pet;
  });

  it("coalesces reset requests and emits one hidden-first reset completion", () => {
    const pet = createPet(deps());
    pet.start();
    const win = FakeBrowserWindow.instances[0];
    const layout = fakeIpcMain.handlers.get("phi:pet-stage-layout");
    layout?.({ sender: win.webContents }, { stage });
    layout?.({ sender: win.webContents }, { stage });
    pet.resetPosition();
    pet.resetPosition();
    expect(win.webContents.send).toHaveBeenCalledWith("phi:pet-reset-position");
    const resetCount = win.webContents.send.mock.calls.filter(
      (call: unknown[]) => call[0] === "phi:pet-reset-position",
    ).length;
    expect(resetCount).toBe(1);
    layout?.({ sender: win.webContents }, { stage, resetPosition: true });
    expect(win.webContents.send).toHaveBeenCalledWith(
      "phi:pet-territory-bounds",
      expect.any(Object),
    );
  });

  it("resets on the retained display instead of the current nearest display", () => {
    const retained = {
      id: 1,
      workArea: { x: 0, y: 0, width: 1000, height: 800 },
    };
    const alternate = {
      id: 2,
      workArea: { x: 2000, y: 100, width: 500, height: 400 },
    };
    fakeScreen.getDisplayNearestPoint.mockReturnValue(retained);
    fakeScreen.getAllDisplays.mockReturnValue([retained, alternate]);
    const pet = createPet(deps());
    pet.start();
    const win = FakeBrowserWindow.instances[0];
    const setPosition = vi.spyOn(win, "setPosition");
    const layout = fakeIpcMain.handlers.get("phi:pet-stage-layout");
    layout?.({ sender: win.webContents }, { stage });
    layout?.({ sender: win.webContents }, { stage });
    const nearestCalls = fakeScreen.getDisplayNearestPoint.mock.calls.length;

    fakeScreen.getDisplayNearestPoint.mockReturnValue(alternate);
    pet.resetPosition();
    layout?.({ sender: win.webContents }, { stage, resetPosition: true });

    expect(fakeScreen.getDisplayNearestPoint).toHaveBeenCalledTimes(
      nearestCalls,
    );
    expect(setPosition).toHaveBeenLastCalledWith(870, 710);
  });

  it("falls back to the nearest display when the retained display disappeared", () => {
    const retained = {
      id: 1,
      workArea: { x: 0, y: 0, width: 1000, height: 800 },
    };
    const fallback = {
      id: 2,
      workArea: { x: 2000, y: -100, width: 500, height: 400 },
    };
    fakeScreen.getDisplayNearestPoint.mockReturnValue(retained);
    fakeScreen.getAllDisplays.mockReturnValue([retained]);
    const pet = createPet(deps());
    pet.start();
    const win = FakeBrowserWindow.instances[0];
    const setPosition = vi.spyOn(win, "setPosition");
    const layout = fakeIpcMain.handlers.get("phi:pet-stage-layout");
    layout?.({ sender: win.webContents }, { stage });
    layout?.({ sender: win.webContents }, { stage });
    fakeScreen.getAllDisplays.mockReturnValue([fallback]);
    fakeScreen.getDisplayNearestPoint.mockReset().mockReturnValue(fallback);

    pet.resetPosition();
    layout?.({ sender: win.webContents }, { stage, resetPosition: true });

    expect(fakeScreen.getDisplayNearestPoint).toHaveBeenCalledWith({
      x: 90,
      y: 85,
    });
    expect(setPosition).toHaveBeenLastCalledWith(2370, 210);
  });

  it("emits one false transition for stop and does not duplicate it through closed", () => {
    const pet = createPet(deps());
    const changes: boolean[] = [];
    pet.onRunningChanged((running) => changes.push(running));
    pet.start();
    pet.stop();
    pet.stop();
    expect(changes).toEqual([true, false]);
  });
});

describe("createPet held-drag positioning", () => {
  it("rejects invalid drag payloads without native movement", () => {
    const win = started();
    const setPosition = vi.spyOn(win, "setPosition");
    const handler = fakeIpcMain.handlers.get("phi:pet-drag-position");
    handler?.({ sender: {} }, dragMove());
    handler?.({ sender: win.webContents }, { ...dragMove(), phase: "invalid" });
    handler?.({ sender: win.webContents }, { ...dragMove(), screenX: NaN });
    handler?.(
      { sender: win.webContents },
      { ...dragMove(), anchorY: Infinity },
    );
    handler?.(
      { sender: win.webContents },
      { ...dragMove(), stage: { ...stage, width: 0 } },
    );
    expect(setPosition).not.toHaveBeenCalled();
  });

  it("moves from absolute cursor coordinates without clamping and coalesces duplicate cells", () => {
    const win = started();
    Object.assign(win.bounds, { x: 100, y: 200 });
    const setPosition = vi.spyOn(win, "setPosition");
    const handler = fakeIpcMain.handlers.get("phi:pet-drag-position");
    handler?.(
      { sender: win.webContents },
      dragMove({ screenX: -250, screenY: -300 }),
    );
    expect(setPosition).toHaveBeenLastCalledWith(-320, -400);
    handler?.(
      { sender: win.webContents },
      dragMove({ screenX: -249.6, screenY: -299.6 }),
    );
    expect(setPosition).toHaveBeenCalledTimes(1);
  });

  it("moves through negative coordinates, then re-homes held release on the nearest different display", () => {
    const win = started();
    Object.assign(win.bounds, { x: 100, y: 200 });
    const setPosition = vi.spyOn(win, "setPosition");
    const dragHandler = fakeIpcMain.handlers.get("phi:pet-drag-position");
    const releaseHandler = fakeIpcMain.handlers.get("phi:pet-window-move");
    const targetDisplay = {
      workArea: { x: 2000, y: 100, width: 500, height: 400 },
    };
    fakeScreen.getDisplayNearestPoint.mockReturnValue(targetDisplay);

    dragHandler?.(
      { sender: win.webContents },
      dragMove({ screenX: -250, screenY: -300 }),
    );
    expect(setPosition).toHaveBeenLastCalledWith(-320, -400);

    releaseHandler?.(
      { sender: win.webContents },
      { ...move, dx: 2500, dy: 0, heldDrag: true, screenX: 2100, screenY: 200 },
    );
    expect(fakeScreen.getDisplayNearestPoint).toHaveBeenLastCalledWith({
      x: 2100,
      y: 200,
    });
    expect(setPosition).toHaveBeenLastCalledWith(1970, 60);

    const completedCalls = setPosition.mock.calls.length;
    releaseHandler?.(
      { sender: win.webContents },
      { ...move, heldDrag: true, screenX: 2100, screenY: 200 },
    );
    expect(setPosition.mock.calls).toHaveLength(completedCalls);
  });

  it("restores the recorded origin on cancel, publishes territory, and ignores stale cancel", () => {
    const win = started();
    Object.assign(win.bounds, { x: 100, y: 200 });
    const setPosition = vi.spyOn(win, "setPosition");
    const handler = fakeIpcMain.handlers.get("phi:pet-drag-position");
    handler?.(
      { sender: win.webContents },
      dragMove({ screenX: 800, screenY: 300 }),
    );
    handler?.({ sender: win.webContents }, dragCancel());
    expect(setPosition).toHaveBeenLastCalledWith(100, 200);
    expect(win.webContents.send).toHaveBeenLastCalledWith(
      "phi:pet-territory-bounds",
      { minStageX: -100, maxStageX: 1720, minStageY: -200, maxStageY: 830 },
    );
    const calls = setPosition.mock.calls.length;
    handler?.({ sender: win.webContents }, dragCancel());
    expect(setPosition.mock.calls).toHaveLength(calls);
  });

  it("defers stage layout while held and accepts it after release", () => {
    const win = started();
    Object.assign(win.bounds, { x: 100, y: 200 });
    const setPosition = vi.spyOn(win, "setPosition");
    const dragHandler = fakeIpcMain.handlers.get("phi:pet-drag-position");
    const layoutHandler = fakeIpcMain.handlers.get("phi:pet-stage-layout");
    dragHandler?.(
      { sender: win.webContents },
      dragMove({ screenX: 800, screenY: 300 }),
    );
    const duringDrag = setPosition.mock.calls.length;
    layoutHandler?.({ sender: win.webContents }, { stage });
    expect(setPosition.mock.calls).toHaveLength(duringDrag);
    fakeIpcMain.handlers.get("phi:pet-window-move")?.(
      { sender: win.webContents },
      { ...move, heldDrag: true, screenX: 800, screenY: 300 },
    );
    const afterRelease = setPosition.mock.calls.length;
    layoutHandler?.({ sender: win.webContents }, { stage });
    expect(setPosition.mock.calls.length).toBeGreaterThan(afterRelease);
  });

  it.each(["stop", "closed"])(
    "clears drag origin across %s to start",
    (end) => {
      const pet = createPet(deps());
      pet.start();
      const first = FakeBrowserWindow.instances[0];
      Object.assign(first.bounds, { x: 100, y: 200 });
      const dragHandler = fakeIpcMain.handlers.get("phi:pet-drag-position");
      dragHandler?.({ sender: first.webContents }, dragMove({ screenX: 800 }));
      if (end === "stop") pet.stop();
      else first.destroy();
      pet.start();
      const second = FakeBrowserWindow.instances[1];
      Object.assign(second.bounds, { x: 300, y: 400 });
      const setPosition = vi.spyOn(second, "setPosition");
      dragHandler?.({ sender: second.webContents }, dragMove({ screenX: 900 }));
      dragHandler?.({ sender: second.webContents }, dragCancel());
      expect(setPosition).toHaveBeenLastCalledWith(300, 400);
    },
  );
});
