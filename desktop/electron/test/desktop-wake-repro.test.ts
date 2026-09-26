// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const desktopSource = readFileSync(
  fileURLToPath(new URL('../src/desktop.ts', import.meta.url)),
  'utf8',
);
const viewsSource = readFileSync(
  fileURLToPath(new URL('../src/views.ts', import.meta.url)),
  'utf8',
);

describe('Desktop host and view wake / reconnect reproduction', () => {
  it('listens to powerMonitor resume to revive dead tabs on system wake', () => {
    // When laptop wakes from sleep, network drops. Desktop must wake active view.
    expect(desktopSource).toContain('powerMonitor');
    expect(desktopSource).toMatch(
      /powerMonitor(?:\.|\?\.)on\(\s*['"]resume['"]/,
    );
  });

  it('ProfileViewManager signals wake/reconnect on setActive to revive tabs that died in background', () => {
    // When switching profiles, window focus does not fire. The retained view must be woken/signaled.
    const setActiveIdx = viewsSource.indexOf('setActive(id: string | null)');
    expect(setActiveIdx).toBeGreaterThan(-1);
    const setActiveRegion = viewsSource.slice(
      setActiveIdx,
      viewsSource.indexOf('onWindowResize()', setActiveIdx),
    );
    expect(setActiveRegion).toContain('WAKE_PAGE_SCRIPT');
  });

  it('DesktopHost dispatches an explicit wake/focus signal to the active view on window focus', () => {
    const focusIdx = desktopSource.indexOf("win.on('focus'");
    expect(focusIdx).toBeGreaterThan(-1);
    const focusRegion = desktopSource.slice(focusIdx, focusIdx + 800);
    expect(focusRegion).toContain('WAKE_PAGE_SCRIPT');
  });
});
