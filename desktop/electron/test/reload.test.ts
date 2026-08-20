// @vitest-environment node
/**
 * Behavioural tests for the F5 reload shortcut (src/reload.ts).
 * Pure TypeScript (type-only 'electron' imports), tested with recording
 * fakes for webContents.
 */
import { describe, expect, it, vi } from 'vitest';
import { installReloadShortcut } from '../src/reload.js';

interface InputLike {
  type: string;
  key: string;
  code?: string;
  control?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

function makeHarness(targetGetter?: () => unknown, reloadAllServers?: (ignoringCache: boolean) => void) {
  const reloadCalls: number[] = [];
  const reloadIgnoringCacheCalls: number[] = [];
  const event = { preventDefault: vi.fn() };
  const listeners: Array<(event: { preventDefault: () => void }, input: InputLike) => void> = [];
  const contents = {
    on: (name: string, cb: (event: unknown, input: InputLike) => void) => {
      if (name === 'before-input-event') listeners.push(cb);
    },
    reload: () => {
      reloadCalls.push(Date.now());
    },
    reloadIgnoringCache: () => {
      reloadIgnoringCacheCalls.push(Date.now());
    },
    isDestroyed: () => false,
  };
  installReloadShortcut(contents as never, targetGetter as never, reloadAllServers as never);
  const fire = (input: InputLike): { preventDefault: () => void } => {
    event.preventDefault.mockClear();
    for (const cb of listeners) cb(event, input);
    return event;
  };
  return { fire, reloadCalls, reloadIgnoringCacheCalls, contents };
}

describe('installReloadShortcut (F5 reload)', () => {
  it('reloads on plain F5 keyDown and preventDefaults it', () => {
    const { fire, reloadCalls, reloadIgnoringCacheCalls } = makeHarness();
    const ev = fire({ type: 'keyDown', key: 'F5' });
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(reloadCalls).toHaveLength(1);
    expect(reloadIgnoringCacheCalls).toHaveLength(0);
  });

  it('reloads ignoring cache on Ctrl+F5 or Shift+F5', () => {
    const { fire, reloadCalls, reloadIgnoringCacheCalls } = makeHarness();
    const ev1 = fire({ type: 'keyDown', key: 'F5', control: true });
    expect(ev1.preventDefault).toHaveBeenCalled();
    expect(reloadIgnoringCacheCalls).toHaveLength(1);

    const ev2 = fire({ type: 'keyDown', key: 'F5', shift: true });
    expect(ev2.preventDefault).toHaveBeenCalled();
    expect(reloadIgnoringCacheCalls).toHaveLength(2);
    expect(reloadCalls).toHaveLength(0);
  });

  it('reloads all servers on Alt+F5 when callback is supplied', () => {
    const reloadAll = vi.fn();
    const { fire } = makeHarness(undefined, reloadAll);
    const ev1 = fire({ type: 'keyDown', key: 'F5', alt: true });
    expect(ev1.preventDefault).toHaveBeenCalled();
    expect(reloadAll).toHaveBeenCalledWith(false);

    const ev2 = fire({ type: 'keyDown', key: 'F5', alt: true, shift: true });
    expect(ev2.preventDefault).toHaveBeenCalled();
    expect(reloadAll).toHaveBeenCalledWith(true);
  });

  it('leaves Ctrl+R, Cmd+R, and other keys untouched so terminal reverse-search works', () => {
    const reloadAll = vi.fn();
    const { fire, reloadCalls, reloadIgnoringCacheCalls } = makeHarness(undefined, reloadAll);
    const ev1 = fire({ type: 'keyDown', key: 'r', control: true });
    expect(ev1.preventDefault).not.toHaveBeenCalled();
    const ev2 = fire({ type: 'keyDown', key: 'R', control: true, shift: true });
    expect(ev2.preventDefault).not.toHaveBeenCalled();
    const ev3 = fire({ type: 'keyDown', key: 'r', meta: true });
    expect(ev3.preventDefault).not.toHaveBeenCalled();
    const ev4 = fire({ type: 'keyDown', key: 'r', control: true, alt: true });
    expect(ev4.preventDefault).not.toHaveBeenCalled();
    expect(reloadCalls).toHaveLength(0);
    expect(reloadIgnoringCacheCalls).toHaveLength(0);
    expect(reloadAll).not.toHaveBeenCalled();
  });

  it('leaves Alt+F5 untouched when no reloadAllServers callback is supplied', () => {
    const { fire, reloadCalls, reloadIgnoringCacheCalls } = makeHarness();
    const ev = fire({ type: 'keyDown', key: 'F5', alt: true });
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(reloadCalls).toHaveLength(0);
    expect(reloadIgnoringCacheCalls).toHaveLength(0);
  });

  it('leaves other keys and keyUp events untouched', () => {
    const { fire, reloadCalls, reloadIgnoringCacheCalls } = makeHarness();
    fire({ type: 'keyDown', key: 'Escape' });
    fire({ type: 'keyUp', key: 'F5' });
    fire({ type: 'keyDown', key: 'Enter' });
    expect(reloadCalls).toHaveLength(0);
    expect(reloadIgnoringCacheCalls).toHaveLength(0);
  });

  it('reloads target from targetGetter when supplied', () => {
    const targetReload = vi.fn();
    const target = {
      reload: targetReload,
      reloadIgnoringCache: vi.fn(),
      isDestroyed: () => false,
    };
    const { fire } = makeHarness(() => target);
    fire({ type: 'keyDown', key: 'F5' });
    expect(targetReload).toHaveBeenCalledTimes(1);
  });

  it('safely skips destroyed webContents targets', () => {
    const targetReload = vi.fn();
    const target = {
      reload: targetReload,
      reloadIgnoringCache: vi.fn(),
      isDestroyed: () => true,
    };
    const { fire } = makeHarness(() => target);
    fire({ type: 'keyDown', key: 'F5' });
    expect(targetReload).not.toHaveBeenCalled();
  });
});
