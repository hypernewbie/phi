// @vitest-environment node
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeScreen, FakeBrowserWindow } = vi.hoisted(() => {
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = [];
    opts: Record<string, unknown> = {}; loadArgs: unknown[] = []; destroyed = false;
    constructor(opts: Record<string, unknown>) { this.opts = opts; FakeBrowserWindow.instances.push(this); }
    setAlwaysOnTop(): void {} setVisibleOnAllWorkspaces(): void {} setIgnoreMouseEvents(): void {}
    loadFile(...args: unknown[]): Promise<void> { this.loadArgs = args; return Promise.resolve(); }
    isDestroyed(): boolean { return this.destroyed; }
  }
  return { fakeScreen: { getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })) }, FakeBrowserWindow };
});
vi.mock('electron', () => ({ BrowserWindow: FakeBrowserWindow, screen: fakeScreen }));
import { candidateMoveStage, clampStage, computeDefaultCell, createPetWindow, deriveTerritoryBounds, finalCellOrigin, nearestDisplayForStage } from '../src/pet-window.js';

beforeEach(() => { vi.clearAllMocks(); FakeBrowserWindow.instances.length = 0; });

describe('visible stage geometry', () => {
  it('computes candidate and final cell arithmetic without clamping the transparent cell', () => {
    const stage = candidateMoveStage({ x: 10, y: 20 }, { dx: .5, dy: -2.5, screenX: 0, screenY: 0, stage: { x: 30, y: 40, width: 100, height: 50 } });
    expect(stage).toEqual({ x: 40.5, y: 57.5, width: 100, height: 50 });
    expect(finalCellOrigin({ x: 0, y: 0, width: 100, height: 50 }, { x: 30, y: 40 })).toEqual({ x: -30, y: -40 });
  });
  it('clamps visible stages in positive, negative, and oversize work areas', () => {
    expect(clampStage({ x: 2000, y: 600, width: 100, height: 50 }, { x: 0, y: 0, width: 1920, height: 1080 })).toMatchObject({ x: 1820, y: 600 });
    expect(clampStage({ x: -900, y: -900, width: 300, height: 200 }, { x: -800, y: -600, width: 800, height: 600 })).toMatchObject({ x: -800, y: -600 });
    expect(clampStage({ x: 2, y: 2, width: 900, height: 700 }, { x: 0, y: 0, width: 800, height: 600 })).toMatchObject({ x: 0, y: 0 });
  });
  it('chooses a layout display by stage center, including a gap', () => {
    const displays = [{ workArea: { x: -1000, y: 0, width: 1000, height: 800 } }, { workArea: { x: 200, y: 0, width: 800, height: 800 } }];
    expect(nearestDisplayForStage({ x: 400, y: 100, width: 20, height: 20 }, displays)).toBe(displays[1]);
    expect(nearestDisplayForStage({ x: 150, y: 100, width: 20, height: 20 }, displays)).toBe(displays[1]);
  });
  it('derives finite non-inverted local territory bounds', () => {
    expect(deriveTerritoryBounds({ x: -30, y: -40 }, { x: 30, y: 40, width: 100, height: 50 }, { x: 0, y: 0, width: 800, height: 600 })).toEqual({ minStageX: 30, maxStageX: 730, minStageY: 40, maxStageY: 590 });
    expect(deriveTerritoryBounds({ x: 0, y: 0 }, { x: 0, y: 0, width: 900, height: 700 }, { x: 0, y: 0, width: 800, height: 600 })).toEqual({ minStageX: 0, maxStageX: 0, minStageY: 0, maxStageY: 0 });
  });
});

describe('createPetWindow', () => {
  it('keeps the hidden transparent secure cell and has no moved or ready-to-show auto-show hooks', () => {
    expect(computeDefaultCell({ x: 0, y: 0, width: 1920, height: 1080 })).toMatchObject({ x: 1440, y: 540, width: 480, height: 540 });
    createPetWindow({ root: '/tmp/pet', log: () => {} });
    const win = FakeBrowserWindow.instances[0];
    expect(win.opts.show).toBe(false);
    expect((win.opts.webPreferences as Record<string, unknown>).preload).toBe(path.join('/tmp/pet', 'dist', 'pet-preload.js'));
    expect(win.loadArgs[0]).toBe(path.join('/tmp/pet', 'dist', 'pet.html'));
  });
});
