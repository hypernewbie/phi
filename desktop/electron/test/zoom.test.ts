// @vitest-environment node
/**
 * Behavioral tests for the zoom shortcuts (src/zoom.ts).
 * Pure TypeScript (type-only 'electron' imports), tested with recording
 * fakes for webContents.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  applyZoomAction,
  installZoomShortcuts,
  resolveZoomAction,
  type ZoomChordInput,
} from '../src/zoom.js';

interface FakeWebContents {
  on: (name: string, cb: (event: unknown, input: ZoomChordInput) => void) => void;
  getZoomLevel: () => number;
  setZoomLevel: (level: number) => void;
  isDestroyed: () => boolean;
}

function makeHarness(targetGetter?: () => unknown) {
  let zoomLevel = 0;
  const zoomLevelHistory: number[] = [];
  const event = { preventDefault: vi.fn() };
  const listeners: Array<(event: { preventDefault: () => void }, input: ZoomChordInput) => void> =
    [];
  let destroyed = false;

  const contents: FakeWebContents = {
    on: (name: string, cb: (event: unknown, input: ZoomChordInput) => void) => {
      if (name === 'before-input-event') listeners.push(cb);
    },
    getZoomLevel: () => zoomLevel,
    setZoomLevel: (level: number) => {
      zoomLevel = level;
      zoomLevelHistory.push(level);
    },
    isDestroyed: () => destroyed,
  };

  installZoomShortcuts(contents as never, targetGetter as never);

  const fire = (input: ZoomChordInput): { preventDefault: () => void } => {
    event.preventDefault.mockClear();
    for (const cb of listeners) cb(event, input);
    return event;
  };

  return {
    fire,
    getZoomLevel: () => zoomLevel,
    setZoomLevel: (l: number) => {
      zoomLevel = l;
    },
    setDestroyed: (d: boolean) => {
      destroyed = d;
    },
    zoomLevelHistory,
    contents,
  };
}

describe('resolveZoomAction', () => {
  it('resolves Ctrl and Cmd zoom-in chords (+, =, Add, NumpadAdd)', () => {
    for (const key of ['+', '=', 'Add', 'NumpadAdd']) {
      expect(resolveZoomAction({ type: 'keyDown', key, control: true })).toBe('in');
      expect(resolveZoomAction({ type: 'keyDown', key, meta: true })).toBe('in');
      expect(resolveZoomAction({ type: 'keyDown', key, control: true, shift: true })).toBe('in');
      expect(resolveZoomAction({ type: 'keyDown', key, meta: true, shift: true })).toBe('in');
    }
  });

  it('resolves Ctrl and Cmd zoom-out chords (-, _, Subtract, NumpadSubtract)', () => {
    for (const key of ['-', '_', 'Subtract', 'NumpadSubtract']) {
      expect(resolveZoomAction({ type: 'keyDown', key, control: true })).toBe('out');
      expect(resolveZoomAction({ type: 'keyDown', key, meta: true })).toBe('out');
      expect(resolveZoomAction({ type: 'keyDown', key, control: true, shift: true })).toBe('out');
      expect(resolveZoomAction({ type: 'keyDown', key, meta: true, shift: true })).toBe('out');
    }
  });

  it('resolves Ctrl and Cmd reset-zoom chords (0, Numpad0)', () => {
    for (const key of ['0', 'Numpad0']) {
      expect(resolveZoomAction({ type: 'keyDown', key, control: true })).toBe('reset');
      expect(resolveZoomAction({ type: 'keyDown', key, meta: true })).toBe('reset');
    }
  });

  it('rejects Alt chords and keyUp events', () => {
    expect(resolveZoomAction({ type: 'keyDown', key: '+', control: true, alt: true })).toBeNull();
    expect(resolveZoomAction({ type: 'keyDown', key: '-', meta: true, alt: true })).toBeNull();
    expect(resolveZoomAction({ type: 'keyUp', key: '+', control: true })).toBeNull();
    expect(resolveZoomAction({ type: 'keyDown', key: 'a', control: true })).toBeNull();
    expect(resolveZoomAction({ type: 'keyDown', key: 'F5', control: true })).toBeNull();
  });
});

describe('installZoomShortcuts', () => {
  it('zooms in on Ctrl+= / Ctrl++ and preventDefaults', () => {
    const { fire, getZoomLevel, zoomLevelHistory } = makeHarness();
    const ev = fire({ type: 'keyDown', key: '=', control: true });
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(getZoomLevel()).toBeCloseTo(0.5);
    fire({ type: 'keyDown', key: '+', control: true, shift: true });
    expect(getZoomLevel()).toBeCloseTo(1.0);
    expect(zoomLevelHistory).toEqual([0.5, 1.0]);
  });

  it('zooms out on Ctrl+- and preventDefaults', () => {
    const { fire, getZoomLevel } = makeHarness();
    const ev = fire({ type: 'keyDown', key: '-', control: true });
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(getZoomLevel()).toBeCloseTo(-0.5);
  });

  it('resets zoom on Ctrl+0 and preventDefaults', () => {
    const { fire, setZoomLevel, getZoomLevel } = makeHarness();
    setZoomLevel(1.5);
    const ev = fire({ type: 'keyDown', key: '0', control: true });
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(getZoomLevel()).toBe(0);
  });

  it('leaves Alt chords and other keys untouched', () => {
    const { fire, zoomLevelHistory } = makeHarness();
    const ev1 = fire({ type: 'keyDown', key: '+', control: true, alt: true });
    expect(ev1.preventDefault).not.toHaveBeenCalled();

    const ev2 = fire({ type: 'keyDown', key: 'Enter' });
    expect(ev2.preventDefault).not.toHaveBeenCalled();

    expect(zoomLevelHistory).toEqual([]);
  });

  it('targets targetGetter when supplied', () => {
    let targetZoom = 0;
    const target = {
      getZoomLevel: () => targetZoom,
      setZoomLevel: (l: number) => {
        targetZoom = l;
      },
      isDestroyed: () => false,
    };
    const { fire } = makeHarness(() => target);
    fire({ type: 'keyDown', key: '=', control: true });
    expect(targetZoom).toBeCloseTo(0.5);
  });

  it('skips destroyed target safely', () => {
    let targetZoom = 0;
    const target = {
      getZoomLevel: () => targetZoom,
      setZoomLevel: (l: number) => {
        targetZoom = l;
      },
      isDestroyed: () => true,
    };
    const { fire } = makeHarness(() => target);
    fire({ type: 'keyDown', key: '=', control: true });
    expect(targetZoom).toBe(0);
  });
});

describe('applyZoomAction', () => {
  it('increments, decrements, and resets zoom on target', () => {
    let zoomLevel = 0;
    const target = {
      getZoomLevel: () => zoomLevel,
      setZoomLevel: (l: number) => {
        zoomLevel = l;
      },
      isDestroyed: () => false,
    };
    applyZoomAction(target as never, 'in');
    expect(zoomLevel).toBeCloseTo(0.5);
    applyZoomAction(target as never, 'out');
    expect(zoomLevel).toBeCloseTo(0);
    applyZoomAction(target as never, 'out');
    expect(zoomLevel).toBeCloseTo(-0.5);
    applyZoomAction(target as never, 'reset');
    expect(zoomLevel).toBe(0);
  });
});
