/**
 * Tray-receiver wiring tests (migration step 5): the controller event ->
 * tray method contract that src/main.ts implements. The host loop wires
 * `controller.subscribe` events to the TrayHandle — active-changed ->
 * `setActiveProfile` with the matching profile object, unread-changed ->
 * `setUnread`, profiles-changed -> `rebuildMenu` (the step-6 tray menu
 * rebuild hook) — and this file replicates that small wiring exactly
 * (main.ts is the Electron entry and is not importable under vitest;
 * test/main.test.ts guards the source instead) to assert the behavior
 * with a real Controller (temp dir) and a recording-fake tray handle.
 *
 * Test isolation (documented convention): no Electron runtime is touched
 * (the fake tray handle is a plain object), the controller runs against
 * a real temp directory, and the health slice is never exercised (the
 * recording fake health checker lives in controller.test.ts) — no real
 * HTTP anywhere.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Controller,
  type ControllerEvent,
  type ProfileMeta,
} from '../src/controller.js';

interface FakeTrayHandle {
  setActiveProfile(p: ProfileMeta): void;
  setUnread(id: string, n: number): void;
  rebuildMenu(): void;
}

/**
 * The step-5 host-loop wiring, replicated from src/main.ts: active-changed
 * looks the profile up in the controller and hands the matching profile
 * object to the tray; unread-changed forwards the clamped count;
 * profiles-changed rebuilds the tray menu (the step-6 rebuild hook).
 */
function wire(controller: Controller, tray: FakeTrayHandle): () => void {
  return controller.subscribe((event: ControllerEvent) => {
    if (event.kind === 'active-changed') {
      const profile =
        controller.state().profiles.find((p) => p.id === event.id) ?? null;
      if (profile) tray.setActiveProfile(profile);
    } else if (event.kind === 'unread-changed') {
      tray.setUnread(event.id, event.n);
    } else if (event.kind === 'profiles-changed') {
      tray.rebuildMenu();
    }
  });
}

describe('controller -> tray wiring (step 5 receiver)', () => {
  let dir: string;
  let controller: Controller;
  let tray: FakeTrayHandle;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'phi-tray-receiver-'));
    controller = new Controller({
      persistPath: path.join(dir, 'profiles.json'),
    });
    tray = {
      setActiveProfile: vi.fn(),
      setUnread: vi.fn(),
      rebuildMenu: vi.fn(),
    };
    wire(controller, tray);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('calls setActiveProfile with the matching profile object on active-changed', () => {
    const profile = controller.add('http://127.0.0.1:7070/');
    controller.setActive(profile.id);
    expect(tray.setActiveProfile).toHaveBeenCalledTimes(1);
    expect(tray.setActiveProfile).toHaveBeenCalledWith(profile);
  });

  it('does not call setActiveProfile when the active id no longer matches a profile', () => {
    const profile = controller.add('http://127.0.0.1:7070/');
    controller.setActive(profile.id);
    vi.mocked(tray.setActiveProfile).mockClear();
    controller.remove(profile.id); // only profile removed -> active id ''
    expect(tray.setActiveProfile).not.toHaveBeenCalled();
  });

  it('calls setUnread with the clamped count on unread-changed', () => {
    controller.setUnread('any-id', 3);
    expect(tray.setUnread).toHaveBeenCalledWith('any-id', 3);
    controller.setUnread('any-id', -2);
    expect(tray.setUnread).toHaveBeenCalledWith('any-id', 0);
  });

  it('rebuilds the tray menu on profiles-changed (add / rename / remove)', () => {
    const p = controller.add('http://127.0.0.1:7070/');
    expect(tray.rebuildMenu).toHaveBeenCalledTimes(1);
    controller.rename(p.id, 'Renamed');
    expect(tray.rebuildMenu).toHaveBeenCalledTimes(2);
    controller.remove(p.id);
    expect(tray.rebuildMenu).toHaveBeenCalledTimes(3);
    // Menu rebuilding never touches the tooltip surface (no active/unread
    // side effects from a pure menu refresh).
    expect(tray.setActiveProfile).not.toHaveBeenCalled();
    expect(tray.setUnread).not.toHaveBeenCalled();
  });

  it('ignores events the tray does not consume (health-changed)', async () => {
    controller.add('http://127.0.0.1:7070/');
    vi.mocked(tray.setActiveProfile).mockClear();
    vi.mocked(tray.setUnread).mockClear();
    vi.mocked(tray.rebuildMenu).mockClear();
    await controller.updateHealth(); // health-changed only
    expect(tray.rebuildMenu).not.toHaveBeenCalled();
    expect(tray.setActiveProfile).not.toHaveBeenCalled();
    expect(tray.setUnread).not.toHaveBeenCalled();
  });

  it('the profile object handed to the tray carries the controller origin', () => {
    const profile: ProfileMeta = controller.add('http://127.0.0.1:7070/');
    controller.setActive(profile.id);
    const handed = vi.mocked(tray.setActiveProfile).mock
      .calls[0][0] as ProfileMeta;
    expect(handed).toEqual({
      id: profile.id,
      name: profile.name,
      origin: 'http://127.0.0.1:7070/',
    });
  });
});
