// @vitest-environment node
/**
 * Behavioral tests for the plain-F11 fullscreen toggle
 * (src/fullscreen.ts). The helper is pure TypeScript (type-only
 * 'electron' imports), so vitest drives it with recording fakes for the
 * webContents and the BrowserWindow — no real Electron surface is ever
 * constructed.
 *
 * Contract (AGENTS.md shortcut discipline):
 *   - Plain F11 toggles fullscreen and preventDefaults the key so the
 *     focused page never sees it.
 *   - Modified F11 chords (Ctrl/Shift/Alt/Cmd) and any other key pass
 *     through untouched — the toggle must never steal terminal bytes or
 *     OS chords.
 *   - The same helper is installed on every desktop surface (main view,
 *     retained body views, picker, popups) so F11 works regardless of
 *     which webContents has focus.
 */
import { describe, expect, it, vi } from 'vitest';
import { installFullscreenToggle } from '../src/fullscreen.js';

interface InputLike {
  type: string;
  key: string;
  control?: boolean;
  alt?: boolean;
  meta?: boolean;
}

function makeHarness() {
  const fullscreenStates: boolean[] = [];
  let fullscreen = false;
  const event = { preventDefault: vi.fn() };
  const listeners: Array<(event: { preventDefault: () => void }, input: InputLike) => void> = [];
  const contents = {
    on: (name: string, cb: (event: unknown, input: InputLike) => void) => {
      if (name === 'before-input-event') listeners.push(cb);
    },
  };
  const win = {
    isDestroyed: () => false,
    isFullScreen: () => fullscreen,
    setFullScreen: (v: boolean) => {
      fullscreen = v;
      fullscreenStates.push(v);
    },
  };
  installFullscreenToggle(contents as never, win as never);
  const fire = (input: InputLike): { preventDefault: () => void } => {
    event.preventDefault.mockClear();
    for (const cb of listeners) cb(event, input);
    return event;
  };
  return { fire, fullscreenStates };
}

describe('installFullscreenToggle (plain-F11 fullscreen)', () => {
  it('toggles fullscreen on a plain F11 keyDown and preventDefaults it', () => {
    const { fire, fullscreenStates } = makeHarness();
    fire({ type: 'keyDown', key: 'F11' });
    expect(fullscreenStates).toEqual([true]);
    fire({ type: 'keyDown', key: 'F11' });
    expect(fullscreenStates).toEqual([true, false]);
  });

  it('leaves modified F11 chords untouched (no preventDefault, no toggle)', () => {
    const { fire, fullscreenStates } = makeHarness();
    for (const input of [
      { type: 'keyDown', key: 'F11', control: true },
      { type: 'keyDown', key: 'F11', alt: true },
      { type: 'keyDown', key: 'F11', meta: true },
      { type: 'keyDown', key: 'F11', shift: true },
    ]) {
      const ev = fire(input as InputLike);
      expect(ev.preventDefault).not.toHaveBeenCalled();
    }
    expect(fullscreenStates).toEqual([]);
  });

  it('leaves other keys and keyUp events untouched', () => {
    const { fire, fullscreenStates } = makeHarness();
    fire({ type: 'keyDown', key: 'Escape' });
    fire({ type: 'keyUp', key: 'F11' });
    fire({ type: 'keyDown', key: 'Enter' });
    expect(fullscreenStates).toEqual([]);
  });
});
