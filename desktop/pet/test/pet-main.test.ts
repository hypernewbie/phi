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
const move = { dx: 0.6, dy: -2.4, screenX: 1950, screenY: -50, stage };
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
