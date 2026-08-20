/**
 * Unit tests for the profile controller (src/controller.ts) — the
 * host-loop equivalent of the Wails desktop/internal/controller package
 * (profile store + endpoint.Parse validation + health/unread
 * scaffolding).
 *
 * Test isolation (documented convention): the controller is pure
 * TypeScript with zero Electron imports, so these tests run it directly
 * against real temp directories (mkdtemp) for the atomic-write and
 * corruption-recovery cases — no files outside the temp dir are ever
 * touched. The health slice is exercised with a recording fake checker:
 * no real HTTP anywhere in this slice (the real liveness checker is
 * deferred to step 8). No Electron runtime is involved.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Controller,
  ControllerError,
  PET_SCALE_DEFAULT_TICK,
  PET_SCALE_MAX_TICK,
  PET_SCALE_MIN_TICK,
  InvalidNameError,
  InvalidUrlError,
  UnknownProfileError,
  hostnameKey,
  parseEndpoint,
  unknownHealthChecker,
  type ControllerEvent,
  type HealthChecker,
  type HealthStatus,
} from '../src/controller.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'phi-controller-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function persistPath(): string {
  return path.join(dir, 'profiles.json');
}

function makeController(
  opts: { log?: (msg: string) => void } = {},
): Controller {
  return new Controller({ persistPath: persistPath(), log: opts.log });
}

function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to throw');
}

describe('parseEndpoint (endpoint.Parse parity)', () => {
  it('normalizes to the origin form with a lowercase host', () => {
    const p = parseEndpoint('http://EXAMPLE.com:7070');
    expect(p.origin).toBe('http://example.com:7070/');
    expect(p.host).toBe('example.com:7070');
    expect(p.scheme).toBe('http');
    expect(p.hostname).toBe('example.com');
    expect(p.port).toBe('7070');
  });

  it('accepts the trailing-root and no-path forms equivalently', () => {
    expect(parseEndpoint('http://example.com/').origin).toBe(
      'http://example.com/',
    );
    expect(parseEndpoint('http://example.com').origin).toBe(
      'http://example.com/',
    );
    expect(parseEndpoint('https://example.com:7070/').origin).toBe(
      'https://example.com:7070/',
    );
  });

  it('preserves an explicit default port (Go keeps it in u.Host)', () => {
    expect(parseEndpoint('http://example.com:80/').origin).toBe(
      'http://example.com:80/',
    );
    expect(parseEndpoint('https://example.com:443/').origin).toBe(
      'https://example.com:443/',
    );
  });

  it('accepts IPv6 literals and reports the bracket-stripped hostname key', () => {
    const p = parseEndpoint('http://[::1]:7070/');
    expect(p.origin).toBe('http://[::1]:7070/');
    expect(p.host).toBe('[::1]:7070');
    expect(p.hostname).toBe('::1');
  });

  it('accepts intranet-style underscore hostnames', () => {
    expect(parseEndpoint('http://my_server.local:7070/').hostname).toBe(
      'my_server.local',
    );
  });

  it('rejects userinfo, queries, fragments, non-root paths, bad schemes and hostless URLs', () => {
    const bad = [
      'ftp://example.com/',
      'javascript:alert(1)',
      'http://user:pass@example.com/',
      'http://example.com/?q=1',
      'http://example.com?',
      'http://example.com?q',
      'http://example.com#frag',
      'http://example.com#',
      'http://example.com/path',
      'http:///nohost',
      'http:example.com',
    ];
    for (const raw of bad) {
      expect(() => parseEndpoint(raw), raw).toThrowError(InvalidUrlError);
    }
  });

  it('rejects out-of-range, empty and non-numeric ports', () => {
    for (const raw of [
      'http://example.com:0/',
      'http://example.com:65536/',
      'http://example.com:99999/',
      'http://example.com:',
      'http://example.com:abc/',
    ]) {
      expect(() => parseEndpoint(raw), raw).toThrowError(InvalidUrlError);
    }
  });

  it('rejects invalid hostnames', () => {
    for (const raw of [
      'http://exa mple.com/',
      'http://-bad.com/',
      'http://bad-.com/',
      'http://a..b/',
      'http://_foo.com/',
    ]) {
      expect(() => parseEndpoint(raw), raw).toThrowError(InvalidUrlError);
    }
  });
});

describe('Controller: add', () => {
  it('adds a profile with the derived id, default name and normalized origin and persists it', () => {
    const c = makeController();
    const p = c.add('http://127.0.0.1:7070/');
    expect(p).toEqual({
      id: '127-0-0-1-7070',
      name: '127.0.0.1:7070',
      origin: 'http://127.0.0.1:7070/',
    });
    const st = c.state();
    expect(st.profiles).toEqual([p]);
    expect(st.activeId).toBe('');
    expect(st.health.get('127-0-0-1-7070')).toBe('unknown');
    expect(st.unread.get('127-0-0-1-7070')).toBe(0);
    // Persisted: the file exists, is valid JSON and carries the profile.
    const onDisk = JSON.parse(readFileSync(persistPath(), 'utf8')) as {
      profiles: Array<{ id: string; name: string; origin: string }>;
    };
    expect(onDisk.profiles).toEqual([
      {
        id: '127-0-0-1-7070',
        name: '127.0.0.1:7070',
        origin: 'http://127.0.0.1:7070/',
      },
    ]);
  });

  it('lowercases the hostname in the origin and the derived id', () => {
    const c = makeController();
    const p = c.add('http://EXAMPLE.com:7070/');
    expect(p.origin).toBe('http://example.com:7070/');
    expect(p.id).toBe('example-com-7070');
  });

  it('adds a different hostname', () => {
    const c = makeController();
    c.add('http://127.0.0.1:7070/');
    const second = c.add('http://10.0.0.5:7070/');
    expect(second.id).toBe('10-0-0-5-7070');
    expect(c.state().profiles).toHaveLength(2);
  });

  it('adds a second origin on the same host (different port — no same-host rule, Electron per-profile sessions)', () => {
    const c = makeController();
    c.add('http://127.0.0.1:7070/');
    const second = c.add('http://127.0.0.1:8080/');
    expect(second.origin).toBe('http://127.0.0.1:8080/');
    expect(second.id).toBe('127-0-0-1-8080');
    expect(c.state().profiles).toEqual([
      {
        id: '127-0-0-1-7070',
        name: '127.0.0.1:7070',
        origin: 'http://127.0.0.1:7070/',
      },
      {
        id: '127-0-0-1-8080',
        name: '127.0.0.1:8080',
        origin: 'http://127.0.0.1:8080/',
      },
    ]);
  });

  it('allows re-adding the exact same origin (returns the existing profile)', () => {
    const c = makeController();
    const first = c.add('http://127.0.0.1:7070/');
    const again = c.add('http://127.0.0.1:7070/');
    expect(again).toEqual(first);
    expect(c.state().profiles).toHaveLength(1);
  });

  it('rejects invalid URLs with a typed invalid-url error and persists nothing', () => {
    const c = makeController();
    for (const raw of [
      'ftp://x/',
      'http://user:pass@x/',
      'http://x/?q=1',
      'http://x#f',
      'http://x/path',
      'http://x:0/',
      'http://x:',
    ]) {
      const err = capture(() => c.add(raw));
      expect(err).toBeInstanceOf(InvalidUrlError);
      expect((err as InvalidUrlError).kind).toBe('invalid_url');
      expect((err as InvalidUrlError).message).toContain(raw);
    }
    expect(c.state().profiles).toHaveLength(0);
  });
});

describe('Controller: remove / rename / setLastUsed / setActive / setUnread', () => {
  it('removes a profile and persists the removal', () => {
    const c = makeController();
    const p = c.add('http://127.0.0.1:7070/');
    c.remove(p.id);
    expect(c.state().profiles).toHaveLength(0);
    const reloaded = new Controller({ persistPath: persistPath() });
    expect(reloaded.state().profiles).toHaveLength(0);
  });

  it('throws a typed error when removing an unknown profile', () => {
    const c = makeController();
    const err = capture(() => c.remove('ghost'));
    expect(err).toBeInstanceOf(UnknownProfileError);
    expect((err as UnknownProfileError).kind).toBe('unknown_profile');
  });

  it('removing the active profile falls back to the most recently used remaining profile', () => {
    const c = makeController();
    const a = c.add('http://127.0.0.1:7070/');
    const b = c.add('http://10.0.0.5:7070/');
    c.setActive(a.id);
    c.setLastUsed(b.id); // b becomes the MRU
    c.remove(a.id);
    expect(c.state().activeId).toBe(b.id);
  });

  it('removing the only profile clears the active id', () => {
    const c = makeController();
    const p = c.add('http://127.0.0.1:7070/');
    c.setActive(p.id);
    c.remove(p.id);
    expect(c.state().activeId).toBe('');
  });

  it('renames a profile and persists the new name', () => {
    const c = makeController();
    const p = c.add('http://127.0.0.1:7070/');
    c.rename(p.id, 'Home Phi');
    expect(c.state().profiles[0].name).toBe('Home Phi');
    const reloaded = new Controller({ persistPath: persistPath() });
    expect(reloaded.state().profiles[0].name).toBe('Home Phi');
  });

  it('validates names (empty, overlong, control characters) and unknown ids', () => {
    const c = makeController();
    const p = c.add('http://127.0.0.1:7070/');
    for (const bad of ['   ', 'x'.repeat(65), 'bad\u0007name']) {
      const err = capture(() => c.rename(p.id, bad));
      expect(err).toBeInstanceOf(InvalidNameError);
      expect((err as InvalidNameError).kind).toBe('invalid_name');
    }
    expect(() => c.rename('ghost', 'x')).toThrowError(UnknownProfileError);
  });

  it('setLastUsed stamps the profile and persists the stamp', () => {
    const c = makeController();
    const p = c.add('http://127.0.0.1:7070/');
    c.setLastUsed(p.id);
    const onDisk = JSON.parse(readFileSync(persistPath(), 'utf8')) as {
      profiles: Array<{ lastUsed?: string }>;
    };
    expect(typeof onDisk.profiles[0].lastUsed).toBe('string');
    expect(() => c.setLastUsed('ghost')).toThrowError(UnknownProfileError);
  });

  it('setActive activates, stamps last-used and emits active-changed', () => {
    const c = makeController();
    const p = c.add('http://127.0.0.1:7070/');
    const events: ControllerEvent[] = [];
    c.subscribe((e) => events.push(e));
    c.setActive(p.id);
    expect(c.state().activeId).toBe(p.id);
    expect(events).toContainEqual({ kind: 'active-changed', id: p.id });
    expect(() => c.setActive('ghost')).toThrowError(UnknownProfileError);
  });

  it('setUnread stores counts, clamps negatives to zero and emits unread-changed', () => {
    const c = makeController();
    const p = c.add('http://127.0.0.1:7070/');
    const events: ControllerEvent[] = [];
    c.subscribe((e) => events.push(e));
    c.setUnread(p.id, 3);
    expect(c.state().unread.get(p.id)).toBe(3);
    c.setUnread(p.id, -5);
    expect(c.state().unread.get(p.id)).toBe(0);
    expect(events).toContainEqual({ kind: 'unread-changed', id: p.id, n: 3 });
    expect(events).toContainEqual({ kind: 'unread-changed', id: p.id, n: 0 });
  });
});

describe('Controller: reorder (rail drag-and-drop order)', () => {
  it('moves a profile before a target and persists the new order', () => {
    const c = makeController();
    const a = c.add('http://127.0.0.1:7070/');
    const b = c.add('http://10.0.0.5:7070/');
    const d = c.add('http://10.0.0.9:7070/');
    c.reorder(d.id, a.id);
    expect(c.state().profiles.map((p) => p.id)).toEqual([d.id, a.id, b.id]);
    const reloaded = new Controller({ persistPath: persistPath() });
    expect(reloaded.state().profiles.map((p) => p.id)).toEqual([
      d.id,
      a.id,
      b.id,
    ]);
  });

  it('moves a profile to the end when the target is null', () => {
    const c = makeController();
    const a = c.add('http://127.0.0.1:7070/');
    const b = c.add('http://10.0.0.5:7070/');
    const d = c.add('http://10.0.0.9:7070/');
    c.reorder(a.id, null);
    expect(c.state().profiles.map((p) => p.id)).toEqual([b.id, d.id, a.id]);
  });

  it('ignores no-ops (already in place, target is itself, already last)', () => {
    const c = makeController();
    const a = c.add('http://127.0.0.1:7070/');
    const b = c.add('http://10.0.0.5:7070/');
    c.reorder(a.id, b.id);
    c.reorder(b.id, b.id);
    c.reorder(b.id, null);
    expect(c.state().profiles.map((p) => p.id)).toEqual([a.id, b.id]);
  });

  it('throws a typed error for unknown ids', () => {
    const c = makeController();
    const a = c.add('http://127.0.0.1:7070/');
    expect(() => c.reorder('ghost', null)).toThrowError(UnknownProfileError);
    expect(() => c.reorder(a.id, 'ghost')).toThrowError(UnknownProfileError);
  });

  it('emits profiles-changed on a real move and stays silent on a no-op', () => {
    const c = makeController();
    const a = c.add('http://127.0.0.1:7070/');
    const b = c.add('http://10.0.0.5:7070/');
    const events: ControllerEvent[] = [];
    c.subscribe((e) => events.push(e));
    c.reorder(b.id, a.id);
    c.reorder(b.id, a.id);
    expect(events).toEqual([{ kind: 'profiles-changed' }]);
  });

  it('rolls the in-memory order back when the write fails', () => {
    const c = makeController();
    const a = c.add('http://127.0.0.1:7070/');
    const b = c.add('http://10.0.0.5:7070/');
    // A directory at the persist path blocks the atomic rename.
    rmSync(persistPath());
    mkdirSync(persistPath());
    expect(() => c.reorder(b.id, a.id)).toThrowError(ControllerError);
    expect(c.state().profiles.map((p) => p.id)).toEqual([a.id, b.id]);
  });
});

describe('Controller: state snapshot + subscribe', () => {
  it('state() returns a deep copy (mutating it cannot change the controller)', () => {
    const c = makeController();
    const p = c.add('http://127.0.0.1:7070/');
    c.setActive(p.id);
    c.setUnread(p.id, 2);
    const st = c.state();
    st.profiles[0].name = 'mutated';
    st.profiles.push({ id: 'x', name: 'x', origin: 'http://x/' });
    st.activeId = 'x';
    st.health.set(p.id, 'down');
    st.unread.set(p.id, 99);
    const fresh = c.state();
    expect(fresh.profiles).toHaveLength(1);
    expect(fresh.profiles[0].name).toBe('127.0.0.1:7070');
    expect(fresh.activeId).toBe(p.id);
    expect(fresh.health.get(p.id)).toBe('unknown');
    expect(fresh.unread.get(p.id)).toBe(2);
  });

  it('subscribe notifies on every mutation and unsubscribe stops notifications', () => {
    const c = makeController();
    const p = c.add('http://127.0.0.1:7070/');
    const seen: ControllerEvent[] = [];
    const unsubscribe = c.subscribe((e) => seen.push(e));
    c.rename(p.id, 'New Name');
    c.remove(p.id);
    unsubscribe();
    c.add('http://10.0.0.5:7070/');
    expect(seen.map((e) => e.kind)).toEqual([
      'profiles-changed',
      'profiles-changed',
    ]);
  });

  it('a throwing subscriber does not break the mutation (fire-and-forget)', () => {
    const c = makeController({ log: vi.fn() });
    c.subscribe(() => {
      throw new Error('subscriber boom');
    });
    c.add('http://127.0.0.1:7070/');
    expect(c.state().profiles).toHaveLength(1);
  });
});

describe('Controller: persistence + corruption recovery', () => {
  it('writes atomically: no temp file is left behind and the backup appears on the second save', () => {
    const c = makeController();
    c.add('http://127.0.0.1:7070/');
    let files = readdirSync(dir);
    expect(files.filter((f) => f.includes('.tmp-'))).toHaveLength(0);
    expect(files).toContain('profiles.json');
    expect(files).not.toContain('profiles.json.bak');
    c.add('http://10.0.0.5:7070/');
    files = readdirSync(dir);
    expect(files).toContain('profiles.json.bak');
    expect(files.filter((f) => f.includes('.tmp-'))).toHaveLength(0);
    // The backup holds the previous good state.
    const backup = JSON.parse(
      readFileSync(path.join(dir, 'profiles.json.bak'), 'utf8'),
    ) as {
      profiles: Array<{ id: string }>;
    };
    expect(backup.profiles.map((p) => p.id)).toEqual(['127-0-0-1-7070']);
  });

  it('reloads profiles from the persisted file (insertion order preserved)', () => {
    const c = makeController();
    c.add('http://127.0.0.1:7070/');
    c.add('http://10.0.0.5:7070/');
    c.rename('127-0-0-1-7070', 'Home');
    const reloaded = new Controller({ persistPath: persistPath() });
    expect(reloaded.state().profiles).toEqual([
      { id: '127-0-0-1-7070', name: 'Home', origin: 'http://127.0.0.1:7070/' },
      {
        id: '10-0-0-5-7070',
        name: '10.0.0.5:7070',
        origin: 'http://10.0.0.5:7070/',
      },
    ]);
  });

  it('starts empty when the store file does not exist', () => {
    const c = makeController();
    expect(c.state().profiles).toHaveLength(0);
  });

  it('moves a corrupt store file aside and starts empty, logging the recovery', () => {
    writeFileSync(persistPath(), 'not json{{{', 'utf8');
    const log = vi.fn();
    const c = makeController({ log });
    expect(c.state().profiles).toHaveLength(0);
    const files = readdirSync(dir);
    expect(files.some((f) => f.startsWith('profiles.json.corrupt-'))).toBe(
      true,
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('corrupt'));
  });

  it('recovers from the backup when the main store is corrupt', () => {
    const c = makeController();
    c.add('http://127.0.0.1:7070/');
    c.add('http://10.0.0.5:7070/'); // second save creates the .bak
    writeFileSync(persistPath(), '{{{corrupt', 'utf8');
    const log = vi.fn();
    const reloaded = makeController({ log });
    // The .bak holds the previous good state (the state after the first
    // save), so recovery yields the pre-last-save profiles — Wails
    // Store.Save parity.
    expect(reloaded.state().profiles.map((p) => p.id)).toEqual([
      '127-0-0-1-7070',
    ]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('recovered'));
    // The corrupt main file was moved aside; the backup is untouched.
    const files = readdirSync(dir);
    expect(files.some((f) => f.startsWith('profiles.json.corrupt-'))).toBe(
      true,
    );
    expect(files).toContain('profiles.json.bak');
  });

  it('moves a corrupt backup aside too and starts empty', () => {
    const c = makeController();
    c.add('http://127.0.0.1:7070/');
    c.add('http://10.0.0.5:7070/'); // creates .bak
    writeFileSync(persistPath(), '{{{corrupt', 'utf8');
    writeFileSync(path.join(dir, 'profiles.json.bak'), 'also bad', 'utf8');
    const reloaded = makeController({ log: vi.fn() });
    expect(reloaded.state().profiles).toHaveLength(0);
    const files = readdirSync(dir);
    // Both the main file and the backup are moved aside (the backup's
    // aside is profiles.json.bak.corrupt-*).
    expect(files.filter((f) => f.includes('.corrupt-'))).toHaveLength(2);
  });

  it('skips invalid and duplicate entries with warnings', () => {
    writeFileSync(
      persistPath(),
      JSON.stringify({
        profiles: [
          { id: 'ok', name: 'Ok', origin: 'http://ok.example/' },
          { id: '', name: 'NoId', origin: 'http://noid.example/' },
          { id: 'dup', name: 'A', origin: 'http://a.example/' },
          { id: 'dup', name: 'B', origin: 'http://b.example/' },
        ],
      }),
      'utf8',
    );
    const log = vi.fn();
    const c = makeController({ log });
    expect(c.state().profiles.map((p) => p.id)).toEqual(['ok', 'dup']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('skipping'));
  });
});

describe('Controller: health slice (recording fake checker, no real HTTP)', () => {
  it('updateHealth runs the injected checker per profile and applies statuses', async () => {
    const c = makeController();
    const a = c.add('http://127.0.0.1:7070/');
    const b = c.add('http://10.0.0.5:8080/');
    const check = vi.fn((origin: string) =>
      origin.includes(':7070') ? 'up' : 'down',
    );
    const events: ControllerEvent[] = [];
    c.subscribe((e) => events.push(e));
    await c.updateHealth({ check });
    expect(check).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenCalledWith(a.origin);
    expect(check).toHaveBeenCalledWith(b.origin);
    expect(c.state().health.get(a.id)).toBe('up');
    expect(c.state().health.get(b.id)).toBe('down');
    expect(events).toContainEqual({ kind: 'health-changed' });
  });

  it('updateHealth without a checker uses the placeholder (all unknown, no HTTP)', async () => {
    const c = makeController();
    const p = c.add('http://127.0.0.1:7070/');
    await c.updateHealth();
    expect(c.state().health.get(p.id)).toBe('unknown');
  });

  it('normalizes non-up/down checker results to unknown', async () => {
    const c = makeController();
    const p = c.add('http://127.0.0.1:7070/');
    const junk: HealthChecker = { check: () => 'maybe' as HealthStatus };
    await c.updateHealth(junk);
    expect(c.state().health.get(p.id)).toBe('unknown');
  });

  it('exports the placeholder checker and the hostnameKey helper', () => {
    expect(unknownHealthChecker.check('http://x/')).toBe('unknown');
    expect(hostnameKey('http://127.0.0.1:7070/')).toBe('127.0.0.1');
    expect(hostnameKey('http://[::1]:7070/')).toBe('::1');
    expect(hostnameKey('not a url')).toBe('');
  });
});

describe('Controller: mostRecent (step-6 startup-restore input)', () => {
  it('returns null for an empty store', () => {
    expect(makeController().mostRecent()).toBeNull();
  });

  it('returns the profile with the newest last-used stamp (ties resolve to the first)', () => {
    const c = makeController();
    const a = c.add('http://127.0.0.1:7070/');
    const b = c.add('http://10.0.0.5:7070/');
    // No stamps yet: the first profile wins the tie.
    expect(c.mostRecent()?.id).toBe(a.id);
    c.setLastUsed(b.id);
    expect(c.mostRecent()?.id).toBe(b.id);
  });

  it('agrees with the removal fallback (the Wails MRU rule)', () => {
    const c = makeController();
    const a = c.add('http://127.0.0.1:7070/');
    const b = c.add('http://10.0.0.5:7070/');
    c.setActive(a.id);
    c.setLastUsed(b.id);
    c.remove(a.id);
    expect(c.state().activeId).toBe(b.id);
    expect(c.mostRecent()?.id).toBe(b.id);
  });

  it('returns the full profile meta (the host loop activates it by id)', () => {
    const c = makeController();
    const p = c.add('http://EXAMPLE.com:7070/');
    c.setLastUsed(p.id);
    expect(c.mostRecent()).toEqual({
      id: 'example-com-7070',
      name: 'example.com:7070',
      origin: 'http://example.com:7070/',
    });
  });
});

describe('Controller: close-to-tray preference', () => {
  it('defaults to true (empty store and legacy stores without the field)', () => {
    const c = makeController();
    expect(c.getCloseToTray()).toBe(true);
    expect(c.state().closeToTray).toBe(true);
    // A legacy store file (profiles only, no closeToTray) loads with the default.
    writeFileSync(
      persistPath(),
      JSON.stringify({
        profiles: [{ id: 'x', name: 'X', origin: 'http://x.example/' }],
      }),
      'utf8',
    );
    expect(makeController().getCloseToTray()).toBe(true);
  });

  it('persists a toggle through the store file (a fresh controller reads it back)', () => {
    const c = makeController();
    c.setCloseToTray(false);
    expect(c.getCloseToTray()).toBe(false);
    const onDisk = JSON.parse(readFileSync(persistPath(), 'utf8')) as {
      closeToTray?: boolean;
    };
    expect(onDisk.closeToTray).toBe(false);
    expect(
      new Controller({ persistPath: persistPath() }).getCloseToTray(),
    ).toBe(false);
    c.setCloseToTray(true);
    expect(
      new Controller({ persistPath: persistPath() }).getCloseToTray(),
    ).toBe(true);
  });

  it('emits close-to-tray-changed on a change and stays silent on a no-op', () => {
    const c = makeController();
    const events: ControllerEvent[] = [];
    c.subscribe((e) => events.push(e));
    c.setCloseToTray(false);
    c.setCloseToTray(false); // unchanged: no event, no extra save
    expect(events).toEqual([{ kind: 'close-to-tray-changed' }]);
    expect(c.getCloseToTray()).toBe(false);
  });

  it('survives profile mutations (add/remove/rename do not reset it)', () => {
    const c = makeController();
    c.setCloseToTray(false);
    const p = c.add('http://127.0.0.1:7070/');
    c.rename(p.id, 'Home');
    c.remove(p.id);
    expect(c.getCloseToTray()).toBe(false);
    expect(
      new Controller({ persistPath: persistPath() }).getCloseToTray(),
    ).toBe(false);
  });

  it('state() carries the preference and the deep copy protects it', () => {
    const c = makeController();
    c.setCloseToTray(false);
    const st = c.state();
    st.closeToTray = true;
    expect(c.state().closeToTray).toBe(false);
  });
});

describe('Controller: sync-alerts preference', () => {
  it('defaults to true (empty store and legacy stores without the field)', () => {
    const c = makeController();
    expect(c.getSyncAlerts()).toBe(true);
    expect(c.state().syncAlerts).toBe(true);
    // A legacy store file (profiles only, no syncAlerts) loads with the default.
    writeFileSync(
      persistPath(),
      JSON.stringify({
        profiles: [{ id: 'x', name: 'X', origin: 'http://x.example/' }],
      }),
      'utf8',
    );
    expect(makeController().getSyncAlerts()).toBe(true);
  });

  it('persists a toggle through the store file (a fresh controller reads it back)', () => {
    const c = makeController();
    c.setSyncAlerts(false); // flips the default (true)
    expect(c.getSyncAlerts()).toBe(false);
    const onDisk = JSON.parse(readFileSync(persistPath(), 'utf8')) as {
      syncAlerts?: boolean;
    };
    expect(onDisk.syncAlerts).toBe(false);
    expect(new Controller({ persistPath: persistPath() }).getSyncAlerts()).toBe(
      false,
    );
    c.setSyncAlerts(true);
    expect(new Controller({ persistPath: persistPath() }).getSyncAlerts()).toBe(
      true,
    );
  });

  it('emits sync-alerts-changed on a change and stays silent on a no-op', () => {
    const c = makeController();
    const events: ControllerEvent[] = [];
    c.subscribe((e) => events.push(e));
    c.setSyncAlerts(false); // flips the default (true)
    c.setSyncAlerts(false); // unchanged: no event, no extra save
    expect(events).toEqual([{ kind: 'sync-alerts-changed' }]);
    expect(c.getSyncAlerts()).toBe(false);
  });

  it('survives profile mutations (add/remove/rename do not reset it)', () => {
    const c = makeController();
    c.setSyncAlerts(true);
    const p = c.add('http://127.0.0.1:7070/');
    c.rename(p.id, 'Home');
    c.remove(p.id);
    expect(c.getSyncAlerts()).toBe(true);
    expect(new Controller({ persistPath: persistPath() }).getSyncAlerts()).toBe(
      true,
    );
  });

  it('state() carries the preference and the deep copy protects it', () => {
    const c = makeController();
    c.setSyncAlerts(true);
    const st = c.state();
    st.syncAlerts = false;
    expect(c.state().syncAlerts).toBe(true);
  });
});

describe('Controller: pet-scale preference', () => {
  it('defaults legacy, malformed, fractional, and out-of-range values to tick 2', () => {
    for (const value of [undefined, null, '2', 2.5, -1, PET_SCALE_MAX_TICK + 1]) {
      writeFileSync(
        persistPath(),
        JSON.stringify({ profiles: [], ...(value === undefined ? {} : { petScaleTick: value }) }),
        'utf8',
      );
      expect(makeController().getPetScaleTick()).toBe(PET_SCALE_DEFAULT_TICK);
    }
    expect(makeController().state().petScaleTick).toBe(PET_SCALE_DEFAULT_TICK);
  });

  it('round trips a valid integer tick and emits only for a changed tick', () => {
    const c = makeController();
    const events: ControllerEvent[] = [];
    c.subscribe((event) => events.push(event));
    expect(c.setPetScaleTick(PET_SCALE_DEFAULT_TICK)).toBe(true);
    expect(events).toEqual([]);
    expect(c.setPetScaleTick(PET_SCALE_MAX_TICK)).toBe(true);
    expect(events).toEqual([{ kind: 'pet-scale-changed' }]);
    expect(new Controller({ persistPath: persistPath() }).getPetScaleTick()).toBe(PET_SCALE_MAX_TICK);
    expect(c.setPetScaleTick(PET_SCALE_MIN_TICK - 1)).toBe(false);
    expect(c.getPetScaleTick()).toBe(PET_SCALE_MAX_TICK);
    expect(events).toHaveLength(1);
  });

  it('rolls back a changed tick when persistence fails without emitting an event', () => {
    const c = makeController();
    c.setPetScaleTick(3);
    const events: ControllerEvent[] = [];
    c.subscribe((event) => events.push(event));
    rmSync(persistPath());
    mkdirSync(persistPath());
    expect(() => c.setPetScaleTick(4)).toThrowError(ControllerError);
    expect(c.getPetScaleTick()).toBe(3);
    expect(events).toEqual([]);
  });

  it('preserves the tick through every unrelated preference and profile save path', () => {
    const c = makeController();
    c.setPetScaleTick(5);
    const p = c.add('http://127.0.0.1:7070/');
    const q = c.add('http://10.0.0.5:7070/');
    c.reorder(q.id, p.id);
    c.rename(p.id, 'Home');
    c.setLastUsed(p.id);
    c.setActive(p.id);
    c.setCloseToTray(false);
    c.setSyncAlerts(false);
    c.setPetEnabled(true);
    c.remove(q.id);
    const reloaded = new Controller({ persistPath: persistPath() });
    expect(reloaded.getPetScaleTick()).toBe(5);
    expect(reloaded.state().petScaleTick).toBe(5);
  });
});

describe('Controller: pet-enabled preference', () => {
  it('defaults to false (empty store and legacy stores without the field)', () => {
    const c = makeController();
    expect(c.getPetEnabled()).toBe(false);
    expect(c.state().petEnabled).toBe(false);
    // A legacy store file (profiles only, no petEnabled) loads with the default.
    writeFileSync(
      persistPath(),
      JSON.stringify({ profiles: [{ id: 'x', name: 'X', origin: 'http://x.example/' }] }),
      'utf8',
    );
    expect(makeController().getPetEnabled()).toBe(false);
  });

  it('persists a toggle through the store file (a fresh controller reads it back)', () => {
    const c = makeController();
    c.setPetEnabled(true);
    expect(c.getPetEnabled()).toBe(true);
    const onDisk = JSON.parse(readFileSync(persistPath(), 'utf8')) as { petEnabled?: boolean };
    expect(onDisk.petEnabled).toBe(true);
    expect(new Controller({ persistPath: persistPath() }).getPetEnabled()).toBe(true);
    c.setPetEnabled(false);
    expect(new Controller({ persistPath: persistPath() }).getPetEnabled()).toBe(false);
  });

  it('emits pet-enabled-changed on a change and stays silent on a no-op', () => {
    const c = makeController();
    const events: ControllerEvent[] = [];
    c.subscribe((e) => events.push(e));
    c.setPetEnabled(true);
    c.setPetEnabled(true); // unchanged: no event, no extra save
    expect(events).toEqual([{ kind: 'pet-enabled-changed' }]);
    expect(c.getPetEnabled()).toBe(true);
  });

  it('survives profile mutations (add/remove/rename do not reset it)', () => {
    const c = makeController();
    c.setPetEnabled(true);
    const p = c.add('http://127.0.0.1:7070/');
    c.rename(p.id, 'Home');
    c.remove(p.id);
    expect(c.getPetEnabled()).toBe(true);
    expect(new Controller({ persistPath: persistPath() }).getPetEnabled()).toBe(true);
  });

  it('state() carries the preference and the deep copy protects it', () => {
    const c = makeController();
    c.setPetEnabled(true);
    const st = c.state();
    st.petEnabled = false;
    expect(c.state().petEnabled).toBe(true);
  });
});
