// @vitest-environment node
/**
 * Unit tests for src/pet-main.ts (createPet lifecycle + the two IPC
 * receivers) with a stubbed 'electron' module (recording ipcMain,
 * BrowserWindow, screen).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeIpcMain, fakeScreen, FakeBrowserWindow } = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => void>();
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = [];
    destroyed = false;
    webContents = { isDestroyed: () => false };
    constructor() {
      FakeBrowserWindow.instances.push(this);
    }
    getBounds() {
      return { x: 10, y: 20, width: 480, height: 540 };
    }
    setPosition(_x: number, _y: number): void {}
    setIgnoreMouseEvents(_ignore: boolean, _opts?: unknown): void {}
    setAlwaysOnTop(): void {}
    setVisibleOnAllWorkspaces(): void {}
    loadFile(): Promise<void> {
      return Promise.resolve();
    }
    on(): void {}
    once(): void {}
    show(): void {}
    isDestroyed(): boolean {
      return this.destroyed;
    }
    destroy(): void {
      this.destroyed = true;
    }
  }
  return {
    fakeIpcMain: {
      on: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => void) => {
        handlers.set(channel, handler);
      }),
      handlers,
    },
    fakeScreen: {
      getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })),
      getDisplayMatching: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })),
    },
    FakeBrowserWindow,
  };
});

vi.mock('electron', () => ({
  BrowserWindow: FakeBrowserWindow,
  ipcMain: fakeIpcMain,
  screen: fakeScreen,
}));

import { createPet } from '../src/pet-main.js';

beforeEach(() => {
  vi.clearAllMocks();
  fakeIpcMain.handlers.clear();
  FakeBrowserWindow.instances.length = 0;
  fakeScreen.getPrimaryDisplay.mockReturnValue({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } });
  fakeScreen.getDisplayMatching.mockReturnValue({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } });
});

describe('createPet lifecycle', () => {
  it('start() creates a window and stop() destroys it', () => {
    const pet = createPet({ root: '/tmp/pet', log: () => {} });
    expect(pet.isRunning()).toBe(false);
    pet.start();
    expect(pet.isRunning()).toBe(true);
    const win = FakeBrowserWindow.instances.at(-1) as unknown as { destroyed: boolean };
    pet.stop();
    expect(pet.isRunning()).toBe(false);
    expect(win.destroyed).toBe(true);
  });

  it('start() re-shows an existing window instead of creating a duplicate', () => {
    const pet = createPet({ root: '/tmp/pet', log: () => {} });
    pet.start();
    const count = FakeBrowserWindow.instances.length;
    pet.start();
    expect(FakeBrowserWindow.instances.length).toBe(count);
  });
});

describe('phi:pet-hit receiver', () => {
  it('toggles setIgnoreMouseEvents based on the inside boolean, forwarding while ignoring', () => {
    const pet = createPet({ root: '/tmp/pet', log: () => {} });
    pet.start();
    const win = FakeBrowserWindow.instances.at(-1) as unknown as {
      setIgnoreMouseEvents: (ignore: boolean, opts?: unknown) => void;
      webContents: unknown;
    };
    const spy = vi.spyOn(win, 'setIgnoreMouseEvents');
    const handler = fakeIpcMain.handlers.get('phi:pet-hit');
    expect(handler).toBeTypeOf('function');
    handler?.({ sender: win.webContents }, true);
    expect(spy).toHaveBeenCalledWith(false, { forward: false });
    handler?.({ sender: win.webContents }, false);
    expect(spy).toHaveBeenCalledWith(true, { forward: true });
  });

  it('rejects a sender that is not the pet window', () => {
    const pet = createPet({ root: '/tmp/pet', log: () => {} });
    pet.start();
    const win = FakeBrowserWindow.instances.at(-1) as unknown as {
      setIgnoreMouseEvents: (ignore: boolean, opts?: unknown) => void;
    };
    const spy = vi.spyOn(win, 'setIgnoreMouseEvents');
    const handler = fakeIpcMain.handlers.get('phi:pet-hit');
    handler?.({ sender: {} }, true);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('phi:pet-window-move receiver', () => {
  it('moves the window by the delta', () => {
    const pet = createPet({ root: '/tmp/pet', log: () => {} });
    pet.start();
    const win = FakeBrowserWindow.instances.at(-1) as unknown as {
      setPosition: (x: number, y: number) => void;
      webContents: unknown;
    };
    const setPosition = vi.spyOn(win, 'setPosition');
    const handler = fakeIpcMain.handlers.get('phi:pet-window-move');
    handler?.({ sender: win.webContents }, { dx: 5, dy: -3 });
    expect(setPosition).toHaveBeenCalledWith(15, 17); // (10+5, 20-3)
  });

  it('rejects non-pet senders', () => {
    const pet = createPet({ root: '/tmp/pet', log: () => {} });
    pet.start();
    const win = FakeBrowserWindow.instances.at(-1) as unknown as {
      setPosition: (x: number, y: number) => void;
      webContents: unknown;
    };
    const setPosition = vi.spyOn(win, 'setPosition');
    const handler = fakeIpcMain.handlers.get('phi:pet-window-move');
    handler?.({ sender: {} }, { dx: 5, dy: 5 });
    expect(setPosition).not.toHaveBeenCalled();
  });

  it('defaults non-numeric deltas to a no-op move for the pet sender', () => {
    const pet = createPet({ root: '/tmp/pet', log: () => {} });
    pet.start();
    const win = FakeBrowserWindow.instances.at(-1) as unknown as {
      setPosition: (x: number, y: number) => void;
      webContents: unknown;
    };
    const setPosition = vi.spyOn(win, 'setPosition');
    const handler = fakeIpcMain.handlers.get('phi:pet-window-move');
    handler?.({ sender: win.webContents }, { dx: 'x', dy: null });
    // §5.13: invalid dx/dy default to 0 → one setPosition at the current bounds.
    expect(setPosition).toHaveBeenCalledTimes(1);
    expect(setPosition).toHaveBeenCalledWith(10, 20);
  });
});