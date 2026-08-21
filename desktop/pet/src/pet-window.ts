/** Native stage-window construction and visible-stage geometry helpers. */
import { BrowserWindow } from "electron";
import path from "node:path";

const PET_HTML_FILE = "pet.html";
const PET_PRELOAD_FILE = "pet-preload.js";
const SETTINGS_HTML_FILE = "pet-settings.html";
const SETTINGS_PRELOAD_FILE = "pet-settings-preload.js";

export interface PetBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function defaultStageBounds(
  workArea: WorkArea,
  stageWidth: number,
  stageHeight: number,
): PetBounds {
  return {
    x: workArea.x + workArea.width - stageWidth,
    y: workArea.y + workArea.height - stageHeight,
    width: stageWidth,
    height: stageHeight,
  };
}

export interface PetWindowOptions {
  root: string;
  log: (msg: string) => void;
  bounds: PetBounds;
  query?: Record<string, string>;
}

export interface PetSettingsWindowOptions {
  root: string;
  log: (msg: string) => void;
  parent: BrowserWindow;
  dwellSeconds: number;
  onClosed: (win: BrowserWindow) => void;
}

export function createPetSettingsWindow(opts: PetSettingsWindowOptions): BrowserWindow {
  const file = path.join(opts.root, "dist", SETTINGS_HTML_FILE);
  const win = new BrowserWindow({
    width: 400,
    height: 240,
    parent: opts.parent,
    show: false,
    resizable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: path.join(opts.root, "dist", SETTINGS_PRELOAD_FILE),
    },
  });
  const allowedPath = path.resolve(file);
  const expected = new URL(`file://${allowedPath}`);
  expected.searchParams.set("petIdleDwellSeconds", String(opts.dwellSeconds));
  const allowed = (url: string): boolean => {
    try {
      const parsed = new URL(url);
      return parsed.href === expected.href;
    } catch {
      return false;
    }
  };
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-redirect", (event, url) => {
    if (!allowed(url)) event.preventDefault();
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!allowed(url)) event.preventDefault();
  });
  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) win.show();
  });
  win.once("closed", () => opts.onClosed(win));
  void win.loadFile(file, { query: { petIdleDwellSeconds: String(opts.dwellSeconds) } }).catch((err: unknown) => {
    opts.log(`settings loadFile failed: ${String(err)}`);
    if (!win.isDestroyed()) win.destroy();
  });
  return win;
}

export function createPetWindow(opts: PetWindowOptions): BrowserWindow {
  const { bounds } = opts;
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
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
  void win
    .loadFile(
      path.join(opts.root, "dist", PET_HTML_FILE),
      opts.query ? { query: opts.query } : undefined,
    )
    .catch((err: unknown) => {
      opts.log(`loadFile failed: ${String(err)}`);
      if (!win.isDestroyed()) win.destroy();
    });
  return win;
}
