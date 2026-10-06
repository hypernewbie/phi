// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  Controller,
  parseEndpoint,
  type ProfileMeta,
} from '../src/controller.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
let build: string;
let binary: string;
let home: string;
let file: string;
type GoProfile = ProfileMeta & { lastUsed?: string };
function go(
  operation: string,
  extra: { URL?: string; ID?: string; Name?: string; BeforeID?: string } = {},
  target = file,
) {
  const output = execFileSync(
    binary,
    ['-test.run=^TestDesktopProfileInteropHelper$'],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        APPDATA: path.join(home, '.config'),
        XDG_CONFIG_HOME: path.join(home, '.config'),
        PHIC_PROFILE_INTEROP: JSON.stringify({
          Path: target,
          Operation: operation,
          ...extra,
        }),
      },
      encoding: 'utf8',
      timeout: 15000,
    },
  );
  return JSON.parse(output) as { Path: string; Profiles: GoProfile[] };
}
function disk() {
  return JSON.parse(readFileSync(file, 'utf8'));
}
function prefs(data: Record<string, unknown>) {
  const { profiles: _, ...rest } = data;
  return rest;
}

beforeAll(() => {
  build = mkdtempSync(path.join(os.tmpdir(), 'phic-interop-build-'));
  binary = path.join(
    build,
    process.platform === 'win32' ? 'profiles.test.exe' : 'profiles.test',
  );
  execFileSync('go', ['test', '-c', '-o', binary, './internal/phic'], {
    cwd: root,
    timeout: 120000,
  });
});
afterAll(() => rmSync(build, { recursive: true, force: true }));
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'phic-interop-'));
  file = path.join(home, 'profiles.json');
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const origins = [
  'http://EXAMPLE.com:7070',
  'https://example.com:7070/',
  'http://example.com:80',
  'https://example.com:443/',
  'http://[0:0:0:0:0:0:0:1]:7070/',
  'http://my_server.local:07070/',
  'https://tést.example/',
];

describe('the desktop and phic use the same profiles.json', () => {
  it('desktop writes → Go loads exact IDs, names, origins, aliases, rail order and MRU', () => {
    const desktop = new Controller({ persistPath: file });
    const first = desktop.add(origins[0]);
    const second = desktop.add(origins[1]);
    desktop.rename(first.id, '東京 custom desktop name');
    desktop.reorder(second.id, first.id);
    desktop.setActive(first.id);
    desktop.setCloseToTray(false);
    desktop.setSyncAlerts(false);
    desktop.setLowMemoryMode(true);
    desktop.setPetEnabled(true);
    desktop.setPetZoomPercent(175);
    desktop.setContentZoomPercent(125);
    desktop.setPetIdleDwellSeconds(42);
    // Legacy aliases and optional-field fallbacks are retained by desktop's reader.
    const data = disk();
    data.profiles.push({
      id: 'legacy-alias',
      name: null,
      origin: first.origin,
      lastUsed: 123,
    });
    writeFileSync(file, JSON.stringify(data));
    const expected = new Controller({ persistPath: file });
    const loaded = go('load').Profiles;
    expect(loaded.map(({ lastUsed: _, ...p }) => p)).toEqual(
      expected.state().profiles,
    );
    expect(loaded).toEqual(
      data.profiles.map((p: GoProfile) => ({
        ...p,
        name: p.name || p.origin,
        ...(typeof p.lastUsed === 'string' ? {} : { lastUsed: undefined }),
      })),
    );
    expect(disk()).toEqual(data); // Reading a valid document does not rewrite it.
  });

  it.each(origins)(
    'Go writes → desktop loads and re-adds %s without a duplicate or different ID',
    (url) => {
      const expectedFile = path.join(home, 'expected.json');
      const expected = new Controller({ persistPath: expectedFile }).add(url);
      const saved = go('add', { URL: url }).Profiles;
      const desktop = new Controller({ persistPath: file });
      expect(saved).toEqual([expected]);
      expect(desktop.state().profiles).toEqual([expected]);
      expect(desktop.add(url)).toEqual(expected);
      expect(desktop.state().profiles).toHaveLength(1);
      const before = prefs(disk());
      go('used', { ID: expected.id });
      expect(new Controller({ persistPath: file }).mostRecent()).toEqual(
        expected,
      );
      expect(disk().profiles[0].lastUsed).toMatch(
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
      );
      expect(prefs(disk())).toEqual(before);
    },
  );

  it('alternating writes preserve desktop preferences, edits, order and origin-collision IDs', () => {
    const desktop = new Controller({ persistPath: file });
    const first = desktop.add('http://same.example:7070/');
    desktop.setCloseToTray(false);
    desktop.setSyncAlerts(false);
    desktop.setLowMemoryMode(true);
    desktop.setPetEnabled(true);
    desktop.setPetZoomPercent(200);
    desktop.setContentZoomPercent(150);
    desktop.setPetIdleDwellSeconds(33);
    const before = prefs(disk());
    const second = go('add', { URL: 'https://same.example:7070/' }).Profiles[1];
    const expected = new Controller({
      persistPath: path.join(home, 'expected.json'),
    });
    expected.add(first.origin);
    expect(second).toEqual(expected.add(second.origin));
    expect(prefs(disk())).toEqual(before);
    // This is the SAME still-running desktop controller, not a fresh surrogate.
    desktop.rename(second.id, 'Added from phic');
    desktop.reorder(second.id, first.id);
    desktop.remove(first.id);
    expect(go('load').Profiles).toEqual([
      { ...second, name: 'Added from phic' },
    ]);
    go('add', { URL: 'http://third.example:7070/' });
    desktop.setPetEnabled(false); // Must not erase phic's addition with stale rows.
    const final = go('load').Profiles;
    expect(final.map((p) => p.id)).toEqual([second.id, 'third-example-7070']);
    expect(new Controller({ persistPath: file }).state().profiles).toEqual(
      final,
    );
    expect(prefs(disk())).toEqual({ ...before, petEnabled: false });
  });

  it('Go preserves unknown preferences and row extensions; backups remain desktop-readable', () => {
    const desktop = new Controller({ persistPath: file });
    const first = desktop.add('http://a.example/');
    const data = disk();
    data.futurePreference = { version: 12, list: ['do not discard'] };
    data.profiles[0].futureRow = { value: 'keep' };
    writeFileSync(file, JSON.stringify(data));
    go('add', { URL: 'http://b.example/' });
    expect(prefs(disk())).toEqual(prefs(data));
    expect(disk().profiles[0]).toEqual(data.profiles[0]);
    expect(JSON.parse(readFileSync(file + '.bak', 'utf8'))).toEqual(data);
    writeFileSync(file, '{partial');
    expect(go('load').Profiles).toEqual([first]);
    expect(new Controller({ persistPath: file }).state().profiles).toEqual([
      first,
    ]);
    expect(prefs(disk())).toEqual(prefs(data));
  });

  it('Go rename, reorder and remove round-trip through the same desktop sidebar', () => {
    const desktop = new Controller({ persistPath: file });
    const a = desktop.add('http://a.example/');
    const b = desktop.add('http://b.example/');
    const c = desktop.add('http://c.example/');
    desktop.setPetEnabled(true);
    const before = prefs(disk());
    go('rename', { ID: b.id, Name: '東京 Phi' });
    go('reorder', { ID: c.id, BeforeID: a.id });
    go('remove', { ID: a.id });
    expect(new Controller({ persistPath: file }).state().profiles).toEqual([
      c,
      { ...b, name: '東京 Phi' },
    ]);
    expect(prefs(disk())).toEqual(before);
    desktop.reorder(b.id, c.id); // still-running desktop adopts native edits
    expect(go('load').Profiles).toEqual([{ ...b, name: '東京 Phi' }, c]);
    go('reorder', { ID: b.id }); // move to end
    expect(new Controller({ persistPath: file }).state().profiles).toEqual([
      c,
      { ...b, name: '東京 Phi' },
    ]);
  });

  it('desktop recovers a missing Go-written primary from the shared backup', () => {
    const first = go('add', { URL: 'http://first.example/' }).Profiles[0];
    go('add', { URL: 'http://second.example/' });
    rmSync(file);
    expect(new Controller({ persistPath: file }).state().profiles).toEqual([
      first,
    ]);
    expect(go('load').Profiles).toEqual([first]);
    expect(new Controller({ persistPath: file }).state().profiles).toEqual([
      first,
    ]);
  });

  it('the default Go path is desktop userData/phi-client, not a native-only store', () => {
    const result = go('add', { URL: 'http://shared.example:7070/' }, '');
    const config =
      process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : path.join(home, '.config');
    expect(result.Path).toBe(path.join(config, 'phi-client', 'profiles.json'));
    expect(
      new Controller({ persistPath: result.Path }).state().profiles,
    ).toEqual(result.Profiles);
    expect(result.Profiles[0].origin).toBe(
      parseEndpoint('http://shared.example:7070').origin,
    );
  });
});
