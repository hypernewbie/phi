// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeIpcMain, fakeScreen, FakeBrowserWindow } = vi.hoisted(() => {
  const handlers = new Map<string, (event: { sender: unknown }, payload: unknown) => void>();
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = [];
    destroyed = false;
    bounds = { x: 10, y: 20, width: 480, height: 540 };
    webContents = { send: vi.fn() };
    constructor() { FakeBrowserWindow.instances.push(this); }
    getBounds() { return this.bounds; }
    setPosition(x: number, y: number): void { this.bounds.x = x; this.bounds.y = y; }
    setIgnoreMouseEvents(): void {} setAlwaysOnTop(): void {} setVisibleOnAllWorkspaces(): void {}
    loadFile(): Promise<void> { return Promise.resolve(); }
    once(): void {} show(): void {} isDestroyed(): boolean { return this.destroyed; }
    destroy(): void { this.destroyed = true; }
  }
  return {
    fakeIpcMain: { on: vi.fn((channel: string, handler: (event: { sender: unknown }, payload: unknown) => void) => handlers.set(channel, handler)), handlers },
    fakeScreen: { getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })), getDisplayNearestPoint: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })) },
    FakeBrowserWindow,
  };
});
vi.mock('electron', () => ({ BrowserWindow: FakeBrowserWindow, ipcMain: fakeIpcMain, screen: fakeScreen }));
import { createPet } from '../src/pet-main.js';

const stage = { x: 30, y: 40, width: 100, height: 50 };
const move = { dx: .6, dy: -2.4, screenX: 2500, screenY: 100, stage };
beforeEach(() => { vi.clearAllMocks(); fakeIpcMain.handlers.clear(); FakeBrowserWindow.instances.length = 0; });
const started = () => { const pet = createPet({ root: '/tmp/pet', log: () => {} }); pet.start(); return FakeBrowserWindow.instances[0]; };

describe('createPet validated placement', () => {
  it('keeps named lifecycle start/stop behavior', () => {
    const pet = createPet({ root: '/tmp/pet', log: () => {} });
    pet.start(); expect(pet.isRunning()).toBe(true); pet.stop(); expect(pet.isRunning()).toBe(false);
  });
  it('rejects bad senders and invalid move/layout numbers without native movement', () => {
    const win = started(); const setPosition = vi.spyOn(win, 'setPosition');
    fakeIpcMain.handlers.get('phi:pet-window-move')?.({ sender: {} }, move);
    fakeIpcMain.handlers.get('phi:pet-window-move')?.({ sender: win.webContents }, { ...move, dx: NaN });
    fakeIpcMain.handlers.get('phi:pet-window-move')?.({ sender: win.webContents }, { ...move, stage: { ...stage, width: 0 } });
    fakeIpcMain.handlers.get('phi:pet-stage-layout')?.({ sender: win.webContents }, { stage: { ...stage, height: Infinity } });
    expect(setPosition).not.toHaveBeenCalled();
  });
  it('uses release display and rounds only final cell coordinates', () => {
    fakeScreen.getDisplayNearestPoint.mockReturnValue({ workArea: { x: 2000, y: -100, width: 500, height: 400 } });
    const win = started(); const setPosition = vi.spyOn(win, 'setPosition');
    fakeIpcMain.handlers.get('phi:pet-window-move')?.({ sender: win.webContents }, move);
    expect(fakeScreen.getDisplayNearestPoint).toHaveBeenCalledWith({ x: 2500, y: 100 });
    expect(setPosition).toHaveBeenCalledWith(1970, 18);
    expect(win.webContents.send).toHaveBeenCalledWith('phi:pet-territory-bounds', expect.objectContaining({ minStageX: 30, maxStageX: 430 }));
  });
  it('initial layout sends bounds then shows once; later layout and move do not re-show', () => {
    const win = started(); const show = vi.spyOn(win, 'show');
    const layout = fakeIpcMain.handlers.get('phi:pet-stage-layout');
    layout?.({ sender: win.webContents }, { stage });
    expect(win.webContents.send).toHaveBeenCalledWith('phi:pet-territory-bounds', expect.any(Object));
    expect(show).toHaveBeenCalledTimes(1);
    layout?.({ sender: win.webContents }, { stage });
    fakeIpcMain.handlers.get('phi:pet-window-move')?.({ sender: win.webContents }, move);
    expect(show).toHaveBeenCalledTimes(1);
  });
});
