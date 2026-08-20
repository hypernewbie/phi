// @vitest-environment node
/**
 * Unit tests for src/pet-window.ts (cell math + window flags + re-clamp)
 * with a recording-fake BrowserWindow/screen. The 'electron' module is
 * stubbed with vi.mock so no real window is ever constructed.
 */
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeScreen, FakeBrowserWindow } = vi.hoisted(() => {
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = [];
    opts: Record<string, unknown> = {};
    loadArgs: unknown[] = [];
    destroyed = false;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      FakeBrowserWindow.instances.push(this);
    }
    setAlwaysOnTop(_flag: boolean, _level?: string): void {}
    setVisibleOnAllWorkspaces(_flag: boolean): void {}
    setIgnoreMouseEvents(_ignore: boolean, _opts?: unknown): void {}
    loadFile(...args: unknown[]): Promise<void> {
      this.loadArgs = args;
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
    fakeScreen: {
      getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })),
      getDisplayMatching: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })),
    },
    FakeBrowserWindow,
  };
});

vi.mock('electron', () => ({
  BrowserWindow: FakeBrowserWindow,
  screen: fakeScreen,
}));

import { clampBounds, computeDefaultCell, createPetWindow } from '../src/pet-window.js';

beforeEach(() => {
  vi.clearAllMocks();
  FakeBrowserWindow.instances.length = 0;
  fakeScreen.getPrimaryDisplay.mockReturnValue({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } });
  fakeScreen.getDisplayMatching.mockReturnValue({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } });
});

describe('computeDefaultCell', () => {
  it('computes the bottom-right cell of a 4×2 grid (1920×1080 → 480×540 at x=1440,y=540)', () => {
    expect(computeDefaultCell({ x: 0, y: 0, width: 1920, height: 1080 })).toEqual({
      x: 1440,
      y: 540,
      width: 480,
      height: 540,
    });
  });
});

describe('clampBounds', () => {
  it('clamps an out-of-bounds rectangle fully inside the workArea', () => {
    expect(clampBounds({ x: 2000, y: 600, width: 480, height: 540 }, { x: 0, y: 0, width: 1920, height: 1080 })).toEqual({
      x: 1440,
      y: 540,
    });
  });
  it('leaves an in-bounds rectangle unchanged', () => {
    expect(clampBounds({ x: 100, y: 100, width: 480, height: 540 }, { x: 0, y: 0, width: 1920, height: 1080 })).toEqual({
      x: 100,
      y: 100,
    });
  });
});

describe('createPetWindow', () => {
  it('creates a transparent frameless non-resizable window with the security flags and loads dist/pet.html with the pet preload', () => {
    const returned = createPetWindow({ root: '/tmp/pet', log: () => {} });
    const win = FakeBrowserWindow.instances.at(-1) as unknown as {
      opts: Record<string, unknown>;
      loadArgs: unknown[];
    };
    expect(returned).toBe(win);
    expect(win.opts.transparent).toBe(true);
    expect(win.opts.frame).toBe(false);
    expect(win.opts.resizable).toBe(false);
    expect(win.opts.focusable).toBe(false);
    expect(win.opts.skipTaskbar).toBe(true);
    expect(win.opts.show).toBe(false);
    expect(win.opts.backgroundColor).toBe('#00000000');
    const wp = win.opts.webPreferences as Record<string, unknown>;
    expect(wp.nodeIntegration).toBe(false);
    expect(wp.contextIsolation).toBe(true);
    expect(wp.sandbox).toBe(true);
    expect(wp.webSecurity).toBe(true);
    expect(wp.backgroundThrottling).toBe(false);
    expect(wp.preload).toBe(path.join('/tmp/pet', 'dist', 'pet-preload.js'));
    expect(win.loadArgs[0]).toBe(path.join('/tmp/pet', 'dist', 'pet.html'));
  });
});