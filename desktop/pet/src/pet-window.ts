/** Native stage-window construction and visible-stage geometry helpers. */
import { BrowserWindow } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

type LocalDocumentWindow = Pick<BrowserWindow, "webContents">;

function guardLocalDocument(
  win: LocalDocumentWindow,
  file: string,
  query?: Record<string, string>,
): void {
  const expected = pathToFileURL(file);
  for (const [key, value] of Object.entries(query ?? {}))
    expected.searchParams.set(key, value);
  const allowed = (url: string): boolean => url === expected.href;
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const on = win.webContents.on.bind(win.webContents) as unknown as (
    event: string,
    listener: (details: { preventDefault(): void }, url: string) => void,
  ) => void;
  for (const event of ["will-redirect", "will-navigate"])
    on(event, (details, url) => {
      if (!allowed(url)) details.preventDefault();
    });
}

export function createPetSettingsWindow(
  opts: PetSettingsWindowOptions,
): BrowserWindow {
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
  const query = { petIdleDwellSeconds: String(opts.dwellSeconds) };
  guardLocalDocument(win, file, query);
  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) win.show();
  });
  win.once("closed", () => opts.onClosed(win));
  void win
    .loadFile(file, {
      query: { petIdleDwellSeconds: String(opts.dwellSeconds) },
    })
    .catch((err: unknown) => {
      opts.log(`settings loadFile failed: ${String(err)}`);
      if (!win.isDestroyed()) win.destroy();
    });
  return win;
}

export function createPetWindow(opts: PetWindowOptions): BrowserWindow {
  const { bounds } = opts;
  const file = path.join(opts.root, "dist", PET_HTML_FILE);
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
  guardLocalDocument(win, file, opts.query);
  void win
    .loadFile(file, opts.query ? { query: opts.query } : undefined)
    .catch((err: unknown) => {
      opts.log(`loadFile failed: ${String(err)}`);
      if (!win.isDestroyed()) win.destroy();
    });
  return win;
}
