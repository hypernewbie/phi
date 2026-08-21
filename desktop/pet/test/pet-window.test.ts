// @vitest-environment node
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { FakeBrowserWindow } = vi.hoisted(() => {
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = [];
    opts: Record<string, unknown>;
    loadArgs: unknown[] = [];
    destroyed = false;
    focused = vi.fn();
    show = vi.fn();
    listeners = new Map<string, () => void>();
    alwaysOnTopArgs: unknown[] = [];
    visibleOnAllWorkspacesArgs: unknown[] = [];
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    };

    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      FakeBrowserWindow.instances.push(this);
    }

    setAlwaysOnTop(...args: unknown[]): void {
      this.alwaysOnTopArgs = args;
    }

    setVisibleOnAllWorkspaces(...args: unknown[]): void {
      this.visibleOnAllWorkspacesArgs = args;
    }

    loadFile(...args: unknown[]): Promise<void> {
      this.loadArgs = args;
      return Promise.resolve();
    }

    once(event: string, listener: () => void): void {
      this.listeners.set(event, listener);
    }

    removeListener(event: string, listener: () => void): void {
      if (this.listeners.get(event) === listener) this.listeners.delete(event);
    }

    emit(event: string): void {
      const listener = this.listeners.get(event);
      this.listeners.delete(event);
      listener?.();
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }

    destroy(): void {
      this.destroyed = true;
      this.emit("closed");
    }
  }
  return { FakeBrowserWindow };
});

vi.mock("electron", () => ({ BrowserWindow: FakeBrowserWindow }));

import {
  defaultStageBounds,
  createPetSettingsWindow,
  createPetWindow,
} from "../src/pet-window.js";

beforeEach(() => {
  vi.clearAllMocks();
  FakeBrowserWindow.instances.length = 0;
});

describe("stage-sized native window", () => {
  it("places exact stage bounds at the work-area bottom right", () => {
    expect(
      defaultStageBounds(
        { x: -1200, y: 40, width: 1920, height: 1080 },
        192,
        108,
      ),
    ).toEqual({ x: 528, y: 1012, width: 192, height: 108 });
  });

  it("constructs a transparent secure always-on-top pet window", () => {
    const bounds = defaultStageBounds(
      { x: 0, y: 0, width: 1920, height: 1080 },
      192,
      108,
    );
    createPetWindow({ root: "/tmp/pet", log: () => {}, bounds });
    const win = FakeBrowserWindow.instances[0];

    expect(win.opts).toMatchObject({
      ...bounds,
      transparent: true,
      frame: false,
      resizable: false,
      focusable: false,
      skipTaskbar: true,
      show: false,
      backgroundColor: "#00000000",
    });
    expect(win.opts.webPreferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      preload: path.join("/tmp/pet", "dist", "pet-preload.js"),
    });
    expect(win.alwaysOnTopArgs).toEqual([true, "screen-saver"]);
    expect(win.visibleOnAllWorkspacesArgs).toEqual([true]);
    expect(win.loadArgs[0]).toBe(path.join("/tmp/pet", "dist", "pet.html"));
  });

  it("destroys a newly-created window after load failure", async () => {
    const log = vi.fn();
    const load = vi
      .spyOn(FakeBrowserWindow.prototype, "loadFile")
      .mockRejectedValueOnce(new Error("bad pet html"));
    createPetWindow({
      root: "/tmp/pet",
      log,
      bounds: { x: 1, y: 2, width: 192, height: 108 },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(FakeBrowserWindow.instances[0].destroyed).toBe(true);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("loadFile failed"),
    );
    load.mockRestore();
  });
});

describe("local pet settings window", () => {
  it("uses the exact local query, secure preload, and denies popup/redirect/remote navigation", () => {
    const parent = new FakeBrowserWindow({});
    createPetSettingsWindow({ root: "/tmp/pet", log: () => {}, parent: parent as unknown as import("electron").BrowserWindow, dwellSeconds: 60_000, onClosed: () => {} });
    const win = FakeBrowserWindow.instances[1];
    expect(win.opts).toMatchObject({ show: false, resizable: false, parent });
    expect(win.opts.webPreferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: path.join("/tmp/pet", "dist", "pet-settings-preload.js"),
    });
    expect(win.loadArgs).toEqual([
      path.join("/tmp/pet", "dist", "pet-settings.html"),
      { query: { petIdleDwellSeconds: "60000" } },
    ]);
    expect(win.webContents.setWindowOpenHandler).toHaveBeenCalledWith(expect.any(Function));
    expect(win.webContents.setWindowOpenHandler.mock.calls[0][0]("https://example.com")).toEqual({ action: "deny" });
    const guards = new Map<string, (event: { preventDefault(): void }, url: string) => void>();
    for (const [event, listener] of win.webContents.on.mock.calls) guards.set(event, listener);
    for (const event of ["will-redirect", "will-navigate"]) {
      const preventDefault = vi.fn();
      guards.get(event)?.({ preventDefault }, "https://example.com/");
      expect(preventDefault).toHaveBeenCalledTimes(1);
    }
    expect(win.webContents.on).toHaveBeenCalledWith("will-redirect", expect.any(Function));
    expect(win.webContents.on).toHaveBeenCalledWith("will-navigate", expect.any(Function));
  });

  it("shows on ready-to-show and reports close exactly once", () => {
    const parent = new FakeBrowserWindow({});
    const onClosed = vi.fn();
    createPetSettingsWindow({ root: "/tmp/pet", log: () => {}, parent: parent as unknown as import("electron").BrowserWindow, dwellSeconds: 10, onClosed });
    const win = FakeBrowserWindow.instances[1];
    win.emit("ready-to-show");
    expect(win.show).toHaveBeenCalledTimes(1);
    win.emit("closed");
    expect(onClosed).toHaveBeenCalledWith(win);
  });
});
