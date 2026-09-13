// @vitest-environment node
/**
 * Behavioral tests for the global content-zoom shortcuts (src/zoom.ts).
 * Pure TypeScript (type-only 'electron' imports), tested with recording
 * fakes for webContents.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  applyContentZoom,
  installZoomShortcuts,
  nextContentZoomPercent,
  resolveZoomAction,
  type ZoomAction,
  type ZoomChordInput,
} from '../src/zoom.js';

interface FakeWebContents {
  on: (
    name: string,
    cb: (event: unknown, input: ZoomChordInput) => void,
  ) => void;
  setZoomMode: (mode: string) => void;
  setZoomFactor: (factor: number) => void;
  isDestroyed: () => boolean;
}

function makeHarness(onAction: (action: ZoomAction) => void = vi.fn()) {
  const zoomModes: string[] = [];
  const zoomFactors: number[] = [];
  const event = { preventDefault: vi.fn() };
  const listeners: Array<
    (event: { preventDefault: () => void }, input: ZoomChordInput) => void
  > = [];
  let destroyed = false;

  const contents: FakeWebContents = {
    on: (name: string, cb: (event: unknown, input: ZoomChordInput) => void) => {
      if (name === 'before-input-event') listeners.push(cb);
    },
    setZoomMode: (mode: string) => {
      zoomModes.push(mode);
    },
    setZoomFactor: (factor: number) => {
      zoomFactors.push(factor);
    },
    isDestroyed: () => destroyed,
  };

  installZoomShortcuts(contents as never, onAction);

  const fire = (input: ZoomChordInput): { preventDefault: () => void } => {
    event.preventDefault.mockClear();
    for (const cb of listeners) cb(event, input);
    return event;
  };

  return {
    fire,
    onAction,
    zoomModes,
    zoomFactors,
    setDestroyed: (d: boolean) => {
      destroyed = d;
    },
  };
}

describe('resolveZoomAction', () => {
  it('resolves Ctrl and Cmd zoom-in chords (+, =, Add, NumpadAdd)', () => {
    for (const key of ['+', '=', 'Add', 'NumpadAdd']) {
      expect(resolveZoomAction({ type: 'keyDown', key, control: true })).toBe(
        'in',
      );
      expect(resolveZoomAction({ type: 'keyDown', key, meta: true })).toBe(
        'in',
      );
      expect(
        resolveZoomAction({ type: 'keyDown', key, control: true, shift: true }),
      ).toBe('in');
      expect(
        resolveZoomAction({ type: 'keyDown', key, meta: true, shift: true }),
      ).toBe('in');
    }
  });

  it('resolves Ctrl and Cmd zoom-out chords (-, _, Subtract, NumpadSubtract)', () => {
    for (const key of ['-', '_', 'Subtract', 'NumpadSubtract']) {
      expect(resolveZoomAction({ type: 'keyDown', key, control: true })).toBe(
        'out',
      );
      expect(resolveZoomAction({ type: 'keyDown', key, meta: true })).toBe(
        'out',
      );
      expect(
        resolveZoomAction({ type: 'keyDown', key, control: true, shift: true }),
      ).toBe('out');
      expect(
        resolveZoomAction({ type: 'keyDown', key, meta: true, shift: true }),
      ).toBe('out');
    }
  });

  it('resolves Ctrl and Cmd reset-zoom chords (0, Numpad0)', () => {
    for (const key of ['0', 'Numpad0']) {
      expect(resolveZoomAction({ type: 'keyDown', key, control: true })).toBe(
        'reset',
      );
      expect(resolveZoomAction({ type: 'keyDown', key, meta: true })).toBe(
        'reset',
      );
    }
  });

  it('rejects Alt chords and keyUp events', () => {
    expect(
      resolveZoomAction({
        type: 'keyDown',
        key: '+',
        control: true,
        alt: true,
      }),
    ).toBeNull();
    expect(
      resolveZoomAction({ type: 'keyDown', key: '-', meta: true, alt: true }),
    ).toBeNull();
    expect(
      resolveZoomAction({ type: 'keyUp', key: '+', control: true }),
    ).toBeNull();
    expect(
      resolveZoomAction({ type: 'keyDown', key: 'a', control: true }),
    ).toBeNull();
    expect(
      resolveZoomAction({ type: 'keyDown', key: 'F5', control: true }),
    ).toBeNull();
  });
});

describe('nextContentZoomPercent', () => {
  it('moves through the canonical browser percentages from 100%', () => {
    expect(nextContentZoomPercent(100, 'in')).toBe(110);
    expect(nextContentZoomPercent(100, 'out')).toBe(90);
    expect(nextContentZoomPercent(125, 'reset')).toBe(100);
  });

  it('clamps at the ends of the zoom range', () => {
    expect(nextContentZoomPercent(50, 'out')).toBe(50);
    expect(nextContentZoomPercent(300, 'in')).toBe(300);
  });

  it('steps from an off-list value to the adjacent canonical level', () => {
    expect(nextContentZoomPercent(120, 'in')).toBe(125);
    expect(nextContentZoomPercent(120, 'out')).toBe(110);
    expect(nextContentZoomPercent(20, 'out')).toBe(50);
    expect(nextContentZoomPercent(400, 'in')).toBe(300);
  });
});

describe('applyContentZoom', () => {
  it('uses manual mode and converts the persisted percentage to a factor', () => {
    const target = {
      setZoomMode: vi.fn(),
      setZoomFactor: vi.fn(),
      isDestroyed: () => false,
    };
    applyContentZoom(target as never, 125);
    expect(target.setZoomMode).toHaveBeenCalledWith('manual');
    expect(target.setZoomFactor).toHaveBeenCalledWith(1.25);
  });

  it('skips a destroyed target safely', () => {
    const target = {
      setZoomMode: vi.fn(),
      setZoomFactor: vi.fn(),
      isDestroyed: () => true,
    };
    applyContentZoom(target as never, 125);
    expect(target.setZoomMode).not.toHaveBeenCalled();
    expect(target.setZoomFactor).not.toHaveBeenCalled();
  });
});

describe('installZoomShortcuts', () => {
  it('routes zoom chords to the global action without mutating the focused contents', () => {
    const actions: ZoomAction[] = [];
    const { fire, zoomModes, zoomFactors } = makeHarness((action) => {
      actions.push(action);
    });
    const ev = fire({ type: 'keyDown', key: '=', control: true });
    expect(ev.preventDefault).toHaveBeenCalled();
    fire({ type: 'keyDown', key: '-', control: true });
    fire({ type: 'keyDown', key: '0', control: true });
    expect(actions).toEqual(['in', 'out', 'reset']);
    expect(zoomModes).toEqual([]);
    expect(zoomFactors).toEqual([]);
  });

  it('leaves Alt chords and other keys untouched', () => {
    const onAction = vi.fn();
    const { fire } = makeHarness(onAction);
    const ev1 = fire({ type: 'keyDown', key: '+', control: true, alt: true });
    expect(ev1.preventDefault).not.toHaveBeenCalled();

    const ev2 = fire({ type: 'keyDown', key: 'Enter' });
    expect(ev2.preventDefault).not.toHaveBeenCalled();

    expect(onAction).not.toHaveBeenCalled();
  });
});
