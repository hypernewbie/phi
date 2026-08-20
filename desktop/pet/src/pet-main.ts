/**
 * Pet package main-process entry. createPet(deps) is the factory the phi
 * shell imports dynamically (via a file:// URL); it owns the pet
 * BrowserWindow lifecycle (create/show/destroy), the two phi:pet-* IPC
 * receivers, and the click-through toggle. Electron surfaces are touched
 * only inside createPet (DI-style, mirroring tray.ts), so unit tests stub
 * 'electron' with vi.mock.
 */
import { type BrowserWindow, ipcMain } from "electron";
import { createPetWindow, reclampPetWindow } from "./pet-window.js";

/** The shell-provided dependencies (the discovered package root + a logger). */
export interface PetDeps {
  /** Absolute path of the pet package root (holds dist/ + assets/). */
  root: string;
  /** Diagnostics logger (production: console.log). */
  log: (msg: string) => void;
}

/** The surface createPet returns to the shell. */
export interface PetHandle {
  /** Creates (or re-shows) the pet window. Ignored while creating. */
  start(): void;
  /** Destroys the pet window (toggle-off). No-op when not running. */
  stop(): void;
  /** True while a pet window exists and is not destroyed. */
  isRunning(): boolean;
}

export function createPet(deps: PetDeps): PetHandle {
  let win: BrowserWindow | null = null;
  let petCreating = false;

  const isPetSender = (sender: unknown): boolean =>
    win !== null && !win.isDestroyed() && sender === win.webContents;

  ipcMain.on("phi:pet-hit", (event, inside: unknown) => {
    if (!isPetSender(event.sender)) return;
    const isInside = inside === true;
    // Click-through: ignore mouse events outside the pet; forward keeps
    // mousemove flowing to the renderer so it can hit-test re-entry.
    win?.setIgnoreMouseEvents(!isInside, { forward: !isInside });
  });

  ipcMain.on("phi:pet-window-move", (event, payload: unknown) => {
    if (!isPetSender(event.sender)) return;
    if (!win || win.isDestroyed()) return;
    const delta = (payload ?? {}) as { dx?: unknown; dy?: unknown };
    const dx =
      typeof delta.dx === "number" && Number.isFinite(delta.dx) ? delta.dx : 0;
    const dy =
      typeof delta.dy === "number" && Number.isFinite(delta.dy) ? delta.dy : 0;
    const bounds = win.getBounds();
    win.setPosition(bounds.x + dx, bounds.y + dy);
    reclampPetWindow(win);
  });

  return {
    start(): void {
      if (petCreating) return; // a toggle during creation is ignored
      if (win && !win.isDestroyed()) {
        win.show();
        return;
      }
      petCreating = true;
      try {
        const created = createPetWindow({ root: deps.root, log: deps.log });
        win = created;
        created.once("closed", () => {
          if (win === created) win = null;
        });
      } finally {
        petCreating = false;
      }
    },
    stop(): void {
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
    },
    isRunning(): boolean {
      return win !== null && !win.isDestroyed();
    },
  };
}
