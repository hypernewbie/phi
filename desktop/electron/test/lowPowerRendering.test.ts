import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installLowPowerRendering } from '../src/lowPowerRendering.js';

function controller(): { dispose(): void } | undefined {
  return (window as unknown as { __phiDesktopPower?: { dispose(): void } })
    .__phiDesktopPower;
}

describe('desktop low-power rendering (terminal output, not just CSS)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 16),
    );
    vi.stubGlobal('cancelAnimationFrame', (id: number) =>
      window.clearTimeout(id),
    );
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    document.body.className = '';
  });

  afterEach(() => {
    controller()?.dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.className = '';
  });

  function startLoop(): () => number {
    let frames = 0;
    const tick = (): void => {
      frames++;
      window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
    return () => frames;
  }

  it('does not poll or schedule any rendering when idle', () => {
    installLowPowerRendering(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(document.documentElement.dataset.phiDesktopLowPower).toBe('true');
  });

  it('paces focused rAF redraws to at most 10fps and immediately restores normal rendering when off', () => {
    installLowPowerRendering(true);
    const count = startLoop();
    vi.advanceTimersByTime(1000);
    expect(count()).toBeGreaterThanOrEqual(8);
    expect(count()).toBeLessThanOrEqual(10);
    const before = count();
    installLowPowerRendering(false);
    vi.advanceTimersByTime(1000);
    expect(count() - before).toBeGreaterThanOrEqual(60);
  });

  it('paces unfocused and hidden views to at most 1fps; focus wakes pending rendering promptly', () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    installLowPowerRendering(true);
    const count = startLoop();
    vi.advanceTimersByTime(2500);
    expect(count()).toBe(3);
    vi.mocked(document.hasFocus).mockReturnValue(true);
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(20);
    expect(count()).toBe(4);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    const before = count();
    vi.advanceTimersByTime(2000);
    expect(count() - before).toBeLessThanOrEqual(2);
  });

  it('batches multiple terminals into one native frame and preserves cancellation during a batch', () => {
    installLowPowerRendering(true);
    const calls: number[] = [];
    let canceled = 0;
    window.requestAnimationFrame((time) => {
      calls.push(time);
      window.cancelAnimationFrame(canceled);
      window.requestAnimationFrame((nextTime) => calls.push(nextTime));
    });
    canceled = window.requestAnimationFrame(() => {
      throw new Error('canceled callback ran');
    });
    window.requestAnimationFrame((time) => calls.push(time));
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(16);
    expect(calls).toEqual([16, 16]);
    vi.advanceTimersByTime(116);
    expect(calls).toEqual([16, 16, 132]);
  });

  it('can cancel native requests made before installation and cancels timers when the queue empties', () => {
    const callback = vi.fn();
    const nativeId = window.requestAnimationFrame(callback);
    installLowPowerRendering(true);
    window.cancelAnimationFrame(nativeId);
    const id = window.requestAnimationFrame(callback);
    window.cancelAnimationFrame(id);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(2000);
    expect(callback).not.toHaveBeenCalled();
  });

  it('is idempotent across repeated application and prevents a late legacy config class overwrite', async () => {
    installLowPowerRendering(true);
    const request = window.requestAnimationFrame;
    installLowPowerRendering(true);
    expect(window.requestAnimationFrame).toBe(request);
    expect(
      document.querySelectorAll('#phi-desktop-low-power-style'),
    ).toHaveLength(1);
    document.body.classList.remove('fast-mode');
    await Promise.resolve();
    expect(document.body.classList.contains('fast-mode')).toBe(true);
    installLowPowerRendering(false);
    document.body.classList.add('fast-mode');
    await Promise.resolve();
    expect(document.body.classList.contains('fast-mode')).toBe(false);
  });

  it('does not mistake the narrow local desktop rail for a mobile body view', () => {
    vi.stubGlobal('location', { protocol: 'file:' });
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    installLowPowerRendering(false);
    expect(document.body.classList.contains('fast-mode')).toBe(false);
    expect(document.documentElement.dataset.phiDesktopLowPower).toBe('false');
  });

  it('preserves the forced compact/mobile profile even with the desktop checkbox off', () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    installLowPowerRendering(false);
    expect(document.body.classList.contains('fast-mode')).toBe(true);
    expect(document.documentElement.dataset.phiDesktopLowPower).toBe('true');
  });
});
