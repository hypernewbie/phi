// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fakeIpcMain, fakeScreen, FakeBrowserWindow } = vi.hoisted(() => {
  const primaryDisplay = {
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  };
  const handlers = new Map<
    string,
    (event: { sender: unknown }, payload: unknown) => void
  >();
  const invokeHandlers = new Map<
    string,
    (event: { sender: unknown }, payload: unknown) => unknown
  >();
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = [];
    destroyed = false;
    closedListener: (() => void) | null = null;
    eventListeners = new Map<string, Set<() => void>>();
    bounds: { x: number; y: number; width: number; height: number };
    webContents = {
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    };
    show = vi.fn();

    constructor(opts: {
      x: number;
      y: number;
      width: number;
      height: number;
    }) {
      this.bounds = {
        x: opts.x,
        y: opts.y,
        width: opts.width,
        height: opts.height,
      };
      FakeBrowserWindow.instances.push(this);
    }

    getBounds() {
      return { ...this.bounds };
    }

    setPosition(x: number, y: number): void {
      this.bounds.x = x;
      this.bounds.y = y;
    }

    setBounds(bounds: {
      x: number;
      y: number;
      width: number;
      height: number;
    }): void {
      this.bounds = { ...bounds };
    }

    setAlwaysOnTop(): void {}
    setVisibleOnAllWorkspaces(): void {}
    loadFile(): Promise<void> {
      return Promise.resolve();
    }
    once(event: string, listener: () => void): void {
      this.eventListeners.set(event, new Set([listener]));
      if (event === "closed") this.closedListener = listener;
    }
    removeListener(event: string, listener: () => void): void {
      if (event === "closed" && this.closedListener === listener) {
        this.closedListener = null;
      }
      this.eventListeners.get(event)?.delete(listener);
    }
    emit(event: string): void {
      const listeners = [...(this.eventListeners.get(event) ?? [])];
      this.eventListeners.delete(event);
      if (event === "closed") this.closedListener = null;
      for (const listener of listeners) listener();
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    destroy(): void {
      this.destroyed = true;
      this.emit("closed");
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
      handle: vi.fn(
        (
          channel: string,
          handler: (event: { sender: unknown }, payload: unknown) => unknown,
        ) => invokeHandlers.set(channel, handler),
      ),
      invoke: vi.fn(async (channel: string, payload: unknown) =>
        invokeHandlers.get(channel)?.(
          { sender: (fakeIpcMain as { invokeSender?: unknown }).invokeSender },
          payload,
        ),
      ),
      handlers,
      invokeHandlers,
      invokeSender: undefined as unknown,
    },
    fakeScreen: {
      getPrimaryDisplay: vi.fn(() => primaryDisplay),
      getDisplayNearestPoint: vi.fn(() => primaryDisplay),
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

const stage = { x: 0, y: 0, width: 192, height: 108 };
const layoutPayload = (overrides: Record<string, unknown> = {}) => ({
  stage,
  ...overrides,
});
const dragMove = (overrides: Record<string, unknown> = {}) => ({
  phase: "move" as const,
  screenX: 500,
  screenY: 400,
  anchorX: 40,
  anchorY: 30,
  stage,
  ...overrides,
});
const dragTerminal = (
  phase: "end" | "cancel",
  overrides: Record<string, unknown> = {},
) => ({
  phase,
  screenX: 500,
  screenY: 400,
  anchorX: 40,
  anchorY: 30,
  stage,
  ...overrides,
});
const deps = () => ({
  root: "/tmp/pet",
  log: () => {},
  zoom: {
    minPercent: 50,
    maxPercent: 300,
    defaultPercent: 100,
    stepPercent: 25,
    baseVisualWidth: 192,
  },
  getZoomPercent: () => 100,
  requestZoomPercent: (percent: number) => ({ percent, accepted: true }),
  getIdleDwellSeconds: () => 10,
  requestIdleDwellSeconds: (dwellSeconds: number) => ({ dwellSeconds, accepted: true }),
  getParentWindow: () => null,
});

beforeEach(() => {
  vi.clearAllMocks();
  fakeIpcMain.handlers.clear();
  fakeIpcMain.invokeHandlers.clear();
  fakeIpcMain.invokeSender = undefined;
  FakeBrowserWindow.instances.length = 0;
});

const started = () => {
  const pet = createPet(deps());
  pet.start();
  return { pet, win: FakeBrowserWindow.instances[0] };
};
const handler = (channel: string) => fakeIpcMain.handlers.get(channel);
const layoutHandler = () => handler("phi:pet-stage-layout");
const dragHandler = () => handler("phi:pet-drag-position");

describe("createPet stage layout", () => {
  it("creates a default bottom-right stage-sized native window", () => {
    const { win } = started();
    expect(win.bounds).toEqual({ x: 1728, y: 972, width: 192, height: 108 });
  });

  it("rejects a noncanonical initial layout before showing", () => {
    const { pet, win } = started();
    const setBounds = vi.spyOn(win, "setBounds");
    layoutHandler()?.(
      { sender: win.webContents },
      layoutPayload({ stage: { x: 0, y: 0, width: 240, height: 135 } }),
    );
    expect(setBounds).not.toHaveBeenCalled();
    expect(win.bounds).toEqual({ x: 1728, y: 972, width: 192, height: 108 });
    expect(win.show).not.toHaveBeenCalled();
    expect(win.webContents.send).not.toHaveBeenCalled();

    layoutHandler()?.({ sender: win.webContents }, layoutPayload());
    layoutHandler()?.({ sender: win.webContents }, layoutPayload());
    expect(setBounds).not.toHaveBeenCalled();
    expect(win.show).toHaveBeenCalledTimes(1);
    pet.stop();
  });

  it("relays a pre-ready zoom state before accepting the canonical layout", () => {
    const { pet, win } = started();
    const setBounds = vi.spyOn(win, "setBounds");
    pet.setZoomPercent(125);

    layoutHandler()?.({ sender: win.webContents }, layoutPayload());
    expect(setBounds).not.toHaveBeenCalled();
    expect(win.bounds).toEqual({ x: 1728, y: 972, width: 192, height: 108 });
    expect(win.show).not.toHaveBeenCalled();
    expect(win.webContents.send).toHaveBeenCalledWith("phi:pet-zoom-state", {
      percent: 125,
      accepted: true,
    });

    layoutHandler()?.(
      { sender: win.webContents },
      layoutPayload({ stage: { x: 0, y: 0, width: 240, height: 135 } }),
    );
    expect(win.show).toHaveBeenCalledTimes(1);
    pet.stop();
  });

  it("sizes a canonical zoom layout around the native bottom center", () => {
    const { pet, win } = started();
    layoutHandler()?.({ sender: win.webContents }, layoutPayload());
    pet.setZoomPercent(125);
    const setBounds = vi.spyOn(win, "setBounds");
    layoutHandler()?.({ sender: win.webContents }, layoutPayload());
    expect(setBounds).not.toHaveBeenCalled();
    layoutHandler()?.(
      { sender: win.webContents },
      layoutPayload({ stage: { x: 0, y: 0, width: 240, height: 135 } }),
    );
    expect(setBounds).toHaveBeenCalledWith({
      x: 1704,
      y: 945,
      width: 240,
      height: 135,
    });
    setBounds.mockClear();
    layoutHandler()?.(
      { sender: win.webContents },
      layoutPayload({ stage: { x: 0, y: 0, width: 240, height: 135 } }),
    );
    expect(setBounds).not.toHaveBeenCalled();
    pet.stop();
  });

  it("does not accept non-zero viewport origins or malformed layouts", () => {
    const { pet, win } = started();
    const setBounds = vi.spyOn(win, "setBounds");
    const show = win.show;
    const layout = layoutHandler();
    for (const payload of [
      layoutPayload({ stage: { ...stage, x: 1 } }),
      layoutPayload({ stage: { ...stage, y: -1 } }),
      layoutPayload({ stage: { ...stage, width: 0 } }),
      layoutPayload({ stage: { ...stage, height: 0 } }),
      layoutPayload({ stage: { ...stage, width: 12.5 } }),
      {},
    ]) {
      layout?.({ sender: win.webContents }, payload);
    }
    expect(setBounds).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
    pet.stop();
  });

  it("relays only the latest canonical zoom state before renderer readiness", () => {
    const pet = createPet(deps());
    pet.start();
    const win = FakeBrowserWindow.instances[0];
    pet.setZoomPercent(125);
    pet.setZoomPercent(150);
    layoutHandler()?.(
      { sender: win.webContents },
      layoutPayload({ stage: { x: 0, y: 0, width: 288, height: 162 } }),
    );
    expect(win.webContents.send).toHaveBeenCalledWith("phi:pet-zoom-state", {
      percent: 150,
      accepted: true,
    });
    pet.stop();
  });

  it("routes valid zoom requests after readiness", () => {
    const requestZoomPercent = vi.fn((percent: number) => ({
      percent: Math.min(percent, 125),
      accepted: percent <= 125,
    }));
    const pet = createPet({ ...deps(), requestZoomPercent });
    pet.start();
    const win = FakeBrowserWindow.instances[0];
    layoutHandler()?.({ sender: win.webContents }, layoutPayload());
    win.webContents.send.mockClear();
    handler("phi:pet-zoom-request")?.(
      { sender: win.webContents },
      { percent: 150 },
    );
    expect(requestZoomPercent).toHaveBeenCalledWith(150);
    expect(win.webContents.send).toHaveBeenCalledWith("phi:pet-zoom-state", {
      percent: 125,
      accepted: false,
    });
    pet.stop();
  });
});

describe("createPet drag phases", () => {
  it("rejects wrong senders, unknown phases, non-finite fields, and invalid dimensions", () => {
    const { pet, win } = started();
    const setPosition = vi.spyOn(win, "setPosition");
    const drag = dragHandler();
    drag?.({ sender: {} }, dragMove());
    drag?.({ sender: win.webContents }, dragMove({ phase: "unknown" }));
    drag?.({ sender: win.webContents }, dragMove({ screenX: NaN }));
    drag?.({ sender: win.webContents }, dragMove({ anchorY: Infinity }));
    drag?.(
      { sender: win.webContents },
      dragMove({ stage: { ...stage, height: 0 } }),
    );
    expect(setPosition).not.toHaveBeenCalled();
    pet.stop();
  });

  it("uses direct screen-minus-anchor coordinates at the top edge and on a negative display", () => {
    const { pet, win } = started();
    const setPosition = vi.spyOn(win, "setPosition");
    const drag = dragHandler();
    drag?.(
      { sender: win.webContents },
      dragMove({ screenX: 100, screenY: -30, anchorX: 20, anchorY: 0 }),
    );
    expect(setPosition).toHaveBeenLastCalledWith(80, -30);
    drag?.(
      { sender: win.webContents },
      dragMove({ screenX: -1820, screenY: -260, anchorX: 20, anchorY: 10 }),
    );
    expect(setPosition).toHaveBeenLastCalledWith(-1840, -270);
    pet.stop();
  });

  it("contains native conversion failures and continues with a later valid move", () => {
    const { pet, win } = started();
    const setPosition = vi
      .spyOn(win, "setPosition")
      .mockImplementationOnce(() => {
        throw new Error("native coordinate conversion failed");
      });
    const drag = dragHandler();
    expect(() =>
      drag?.(
        { sender: win.webContents },
        dragMove({ screenX: 100, screenY: -30, anchorX: 20, anchorY: 0 }),
      ),
    ).not.toThrow();
    expect(setPosition).toHaveBeenCalledWith(80, -30);
    drag?.(
      { sender: win.webContents },
      dragMove({ screenX: 800, screenY: 700 }),
    );
    expect(setPosition).toHaveBeenLastCalledWith(760, 670);
    pet.stop();
  });

  it("ends an in-bounds drag without native movement and ignores a stale end", () => {
    const { pet, win } = started();
    const setPosition = vi.spyOn(win, "setPosition");
    const drag = dragHandler();
    drag?.({ sender: win.webContents }, dragMove());
    const calls = setPosition.mock.calls.length;
    drag?.({ sender: win.webContents }, dragTerminal("end"));
    drag?.({ sender: win.webContents }, dragTerminal("end"));
    expect(setPosition.mock.calls).toHaveLength(calls);
    drag?.(
      { sender: win.webContents },
      dragMove({ screenX: 800, screenY: 700 }),
    );
    expect(setPosition).toHaveBeenLastCalledWith(760, 670);
    pet.stop();
  });

  it("clamps the release to the right and bottom of its selected display", () => {
    const { pet, win } = started();
    const setPosition = vi.spyOn(win, "setPosition");
    const drag = dragHandler();
    drag?.(
      { sender: win.webContents },
      dragMove({ screenX: 1200, screenY: 750, anchorX: 40, anchorY: 30 }),
    );
    expect(setPosition).toHaveBeenLastCalledWith(1160, 720);
    fakeScreen.getDisplayNearestPoint.mockReturnValueOnce({
      workArea: { x: 100, y: 50, width: 1000, height: 600 },
    });
    drag?.(
      { sender: win.webContents },
      dragTerminal("end", {
        screenX: 1200,
        screenY: 750,
        anchorX: 40,
        anchorY: 30,
      }),
    );
    expect(fakeScreen.getDisplayNearestPoint).toHaveBeenCalledWith({
      x: 1200,
      y: 750,
    });
    expect(setPosition).toHaveBeenLastCalledWith(908, 542);
    pet.stop();
  });

  it("clamps the release to a negative display's left and top", () => {
    const { pet, win } = started();
    const setPosition = vi.spyOn(win, "setPosition");
    const drag = dragHandler();
    drag?.(
      { sender: win.webContents },
      dragMove({ screenX: -2000, screenY: -1100, anchorX: 0, anchorY: 0 }),
    );
    fakeScreen.getDisplayNearestPoint.mockReturnValueOnce({
      workArea: { x: -1920, y: -1080, width: 1920, height: 1040 },
    });
    drag?.(
      { sender: win.webContents },
      dragTerminal("end", {
        screenX: -2000,
        screenY: -1100,
        anchorX: 0,
        anchorY: 0,
      }),
    );
    expect(setPosition).toHaveBeenLastCalledWith(-1920, -1080);
    pet.stop();
  });

  it("uses native bounds rather than the payload stage size at release", () => {
    const { pet, win } = started();
    win.setBounds({ x: 900, y: 600, width: 400, height: 300 });
    const setPosition = vi.spyOn(win, "setPosition");
    const drag = dragHandler();
    drag?.(
      { sender: win.webContents },
      dragMove({ screenX: 940, screenY: 630, anchorX: 40, anchorY: 30 }),
    );
    fakeScreen.getDisplayNearestPoint.mockReturnValueOnce({
      workArea: { x: 0, y: 0, width: 1000, height: 800 },
    });
    drag?.(
      { sender: win.webContents },
      dragTerminal("end", {
        screenX: 940,
        screenY: 630,
        anchorX: 40,
        anchorY: 30,
      }),
    );
    expect(setPosition).toHaveBeenLastCalledWith(600, 500);
    pet.stop();
  });

  it("anchors each axis at the work-area origin when native bounds are oversized", () => {
    const { pet, win } = started();
    win.setBounds({ x: 75, y: 80, width: 400, height: 600 });
    const setPosition = vi.spyOn(win, "setPosition");
    const drag = dragHandler();
    drag?.(
      { sender: win.webContents },
      dragMove({ screenX: 115, screenY: 110, anchorX: 40, anchorY: 30 }),
    );
    fakeScreen.getDisplayNearestPoint.mockReturnValueOnce({
      workArea: { x: 10, y: 20, width: 300, height: 500 },
    });
    drag?.(
      { sender: win.webContents },
      dragTerminal("end", {
        screenX: 115,
        screenY: 110,
        anchorX: 40,
        anchorY: 30,
      }),
    );
    expect(setPosition).toHaveBeenLastCalledWith(10, 20);
    pet.stop();
  });

  it("clears drag state after a terminal release failure", () => {
    const { pet, win } = started();
    const setPosition = vi.spyOn(win, "setPosition");
    const drag = dragHandler();
    drag?.(
      { sender: win.webContents },
      dragMove({ screenX: 2100, screenY: 500, anchorX: 40, anchorY: 30 }),
    );
    expect(setPosition).toHaveBeenLastCalledWith(2060, 470);
    setPosition.mockImplementationOnce(() => {
      throw new Error("native coordinate conversion failed");
    });
    expect(() =>
      drag?.(
        { sender: win.webContents },
        dragTerminal("end", {
          screenX: 2100,
          screenY: 500,
          anchorX: 40,
          anchorY: 30,
        }),
      ),
    ).not.toThrow();
    const callsAfterFailure = setPosition.mock.calls.length;
    drag?.(
      { sender: win.webContents },
      dragMove({ screenX: 2100, screenY: 500, anchorX: 40, anchorY: 30 }),
    );
    expect(setPosition.mock.calls.length).toBeGreaterThan(callsAfterFailure);
    expect(setPosition).toHaveBeenLastCalledWith(2060, 470);
    drag?.(
      { sender: win.webContents },
      dragTerminal("cancel", {
        screenX: 2100,
        screenY: 500,
        anchorX: 40,
        anchorY: 30,
      }),
    );
    expect(setPosition).toHaveBeenLastCalledWith(2060, 470);
    pet.stop();
  });

  it("restores the recorded native origin on cancel and ignores stale cancel", () => {
    const { pet, win } = started();
    const setPosition = vi.spyOn(win, "setPosition");
    const drag = dragHandler();
    drag?.(
      { sender: win.webContents },
      dragMove({ screenX: 800, screenY: 700 }),
    );
    const callsBeforeCancel = setPosition.mock.calls.length;
    drag?.({ sender: win.webContents }, dragTerminal("cancel"));
    expect(setPosition).toHaveBeenLastCalledWith(1728, 972);
    const callsAfterCancel = setPosition.mock.calls.length;
    expect(callsAfterCancel).toBe(callsBeforeCancel + 1);
    drag?.({ sender: win.webContents }, dragTerminal("cancel"));
    expect(setPosition.mock.calls).toHaveLength(callsAfterCancel);
    pet.stop();
  });

  it("clears transient drag state when the window stops or closes", () => {
    const pet = createPet(deps());
    pet.start();
    const first = FakeBrowserWindow.instances[0];
    dragHandler()?.({ sender: first.webContents }, dragMove({ screenX: 700 }));
    pet.stop();
    pet.start();
    const second = FakeBrowserWindow.instances[1];
    const setPosition = vi.spyOn(second, "setPosition");
    dragHandler()?.({ sender: second.webContents }, dragMove({ screenX: 700 }));
    first.destroy();
    dragHandler()?.({ sender: second.webContents }, dragTerminal("cancel"));
    expect(setPosition).toHaveBeenLastCalledWith(1728, 972);
    second.destroy();
    expect(pet.isRunning()).toBe(false);
  });
});

describe("settings IPC and parent lifecycle", () => {
  it("delivers a dwell update queued before overlay readiness once the canonical layout arrives", () => {
    const pet = createPet(deps());
    pet.setIdleDwellSeconds(180);
    pet.start();
    const win = FakeBrowserWindow.instances[0];
    layoutHandler()?.({ sender: win.webContents }, layoutPayload());
    expect(win.webContents.send).toHaveBeenCalledWith(
      "phi:pet-idle-dwell-state",
      { dwellSeconds: 180 },
    );
    pet.stop();
  });
  it("forwards an external dwell update to open settings before overlay readiness", () => {
    const parent = new FakeBrowserWindow({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
    const pet = createPet({ ...deps(), getParentWindow: () => parent });
    pet.openSettings();
    const settings = FakeBrowserWindow.instances[1];
    pet.setIdleDwellSeconds(180);
    expect(settings.webContents.send).toHaveBeenCalledTimes(1);
    expect(settings.webContents.send).toHaveBeenCalledWith(
      "phi:pet-idle-dwell-state",
      { dwellSeconds: 180 },
    );

    pet.start();
    const overlay = FakeBrowserWindow.instances[2];
    layoutHandler()?.({ sender: overlay.webContents }, layoutPayload());
    expect(overlay.webContents.send).toHaveBeenCalledWith(
      "phi:pet-idle-dwell-state",
      { dwellSeconds: 180 },
    );
    expect(settings.webContents.send).toHaveBeenCalledTimes(1);
    pet.stop();
  });

  it("invokes the bounded request handler with the live settings sender and payload", async () => {
    const parent = new FakeBrowserWindow({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
    const requestIdleDwellSeconds = vi.fn((dwellSeconds: number) => ({
      dwellSeconds,
      accepted: true,
    }));
    const pet = createPet({
      ...deps(),
      requestIdleDwellSeconds,
      getParentWindow: () => parent,
    });
    pet.openSettings();
    const settings = FakeBrowserWindow.instances[1];
    fakeIpcMain.invokeSender = settings.webContents;
    await expect(
      fakeIpcMain.invoke("phi:pet-settings-idle-dwell-request", {
        dwellSeconds: 60,
      }),
    ).resolves.toEqual({ dwellSeconds: 60, accepted: true });
    expect(requestIdleDwellSeconds).toHaveBeenCalledWith(60);
    await expect(
      fakeIpcMain.invoke("phi:pet-settings-idle-dwell-request", {
        dwellSeconds: 60,
        extra: true,
      }),
    ).resolves.toMatchObject({ accepted: false });
    fakeIpcMain.invokeSender = {};
    await expect(
      fakeIpcMain.invoke("phi:pet-settings-idle-dwell-request", {
        dwellSeconds: 60,
      }),
    ).resolves.toMatchObject({ accepted: false });
    pet.stop();
  });

  it("detaches the parent close listener after every settings close", () => {
    const parent = new FakeBrowserWindow({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
    const pet = createPet({ ...deps(), getParentWindow: () => parent });
    for (let i = 0; i < 2; i += 1) {
      pet.openSettings();
      const settings = FakeBrowserWindow.instances.at(-1);
      expect(parent.eventListeners.get("closed")?.size).toBe(1);
      settings?.destroy();
      expect(parent.eventListeners.get("closed")?.size ?? 0).toBe(0);
    }
    pet.openSettings();
    const settings = FakeBrowserWindow.instances.at(-1);
    parent.destroy();
    expect(settings?.destroyed).toBe(true);
    expect(parent.eventListeners.get("closed")?.size ?? 0).toBe(0);
  });
});
