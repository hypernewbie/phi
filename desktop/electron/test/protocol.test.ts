/**
 * Unit tests for phi:// OS protocol registration (src/protocol.ts) —
 * parity with the Wails registry package, implemented with the public
 * Electron `app.setAsDefaultProtocolClient(protocol, execPath, args)` API.
 *
 * NO real registry or desktop-file writes (same convention as the Wails
 * registry tests): every test drives a recording fake Platform whose call
 * log pins the exact behavior, and the Linux desktop-file writer/eraser is
 * exercised against a mkdtempSync temp dir only — nothing outside the temp
 * dir is ever touched. The real Electron setAsDefaultProtocolClient is
 * reachable only through realPlatform, which only the production CLI path
 * (src/main.ts) uses, so no test exercises it.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LINUX_DESKTOP_FILE,
  installProtocol,
  linuxDesktopFileContents,
  linuxDesktopFilePath,
  macBundlePath,
  protocolArgs,
  uninstallProtocol,
  writeLinuxDesktopFile,
  type Platform,
} from '../src/protocol.js';

type RecordingPlatform = Platform & {
  /** Exact ordered call log, e.g. 'setAsDefaultProtocolClient(phi,...)'. */
  calls: string[];
  /** Mutable behavior knobs the tests flip between calls. */
  state: {
    alreadyDefault: boolean;
    setOk: boolean;
    removedOk: boolean;
    exe: string;
  };
};

/** Builds a recording fake Platform; every method appends to the call log. */
function recordingPlatform(
  overrides: Partial<Platform> = {},
): RecordingPlatform {
  const calls: string[] = [];
  const state = {
    alreadyDefault: false,
    setOk: true,
    removedOk: true,
    exe: '/fake/Phi.exe',
  };
  const platform: Platform = {
    isWindows: false,
    isMac: false,
    isLinux: false,
    execPath: '/fake/electron',
    getConfig: () => {
      calls.push('getConfig');
      return { exe: state.exe, appPath: '/fake/app' };
    },
    setAsDefaultProtocolClient: (protocol, execPath, args) => {
      calls.push(
        `setAsDefaultProtocolClient(${protocol},${execPath},${JSON.stringify(args)})`,
      );
      return state.setOk;
    },
    isDefaultProtocolClient: (protocol, execPath, args) => {
      calls.push(
        `isDefaultProtocolClient(${protocol},${execPath},${JSON.stringify(args)})`,
      );
      return state.alreadyDefault;
    },
    removeAsDefaultProtocolClient: (protocol, execPath, args) => {
      calls.push(
        `removeAsDefaultProtocolClient(${protocol},${execPath},${JSON.stringify(args)})`,
      );
      return state.removedOk;
    },
    ...overrides,
  };
  return Object.assign(platform, { calls, state });
}

describe('protocolArgs (the argv builder)', () => {
  it('builds [<appPath>/dist/main.js, --] with the trailing -- last', () => {
    const args = protocolArgs('/fake/app');
    expect(args).toEqual([path.join('/fake/app', 'dist', 'main.js'), '--']);
    expect(args[args.length - 1]).toBe('--');
  });

  it('puts the main entry before the -- separator (Electron argv order)', () => {
    const args = protocolArgs('/fake/app');
    expect(args[0]).toBe(path.join('/fake/app', 'dist', 'main.js'));
    expect(args[1]).toBe('--');
  });

  it('keeps the entry absolute and under the app root', () => {
    const args = protocolArgs('/fake/app');
    expect(path.isAbsolute(args[0])).toBe(true);
    expect(args[0]).toContain(path.join('dist', 'main.js'));
  });
});

describe('installProtocol (Windows: the documented Electron path)', () => {
  it('checks then registers phi with the default [main.js, --] args', async () => {
    const p = recordingPlatform({ isWindows: true });
    const result = await installProtocol(p);
    expect(result).toEqual({
      alreadyRegistered: false,
      path: '/fake/electron',
      exe: '/fake/electron',
    });
    const expectedArgs = JSON.stringify([
      path.join('/fake/app', 'dist', 'main.js'),
      '--',
    ]);
    expect(p.calls).toEqual([
      'getConfig',
      `isDefaultProtocolClient(phi,/fake/electron,${expectedArgs})`,
      `setAsDefaultProtocolClient(phi,/fake/electron,${expectedArgs})`,
    ]);
  });

  it('registers with the explicit extraArgs the CLI passes ([main.js, --])', async () => {
    const p = recordingPlatform({ isWindows: true });
    const result = await installProtocol(p, ['/custom/dist/main.js', '--']);
    const expectedArgs = JSON.stringify(['/custom/dist/main.js', '--']);
    expect(p.calls[1]).toBe(
      `isDefaultProtocolClient(phi,/fake/electron,${expectedArgs})`,
    );
    expect(p.calls[2]).toBe(
      `setAsDefaultProtocolClient(phi,/fake/electron,${expectedArgs})`,
    );
    expect(result).toEqual({
      alreadyRegistered: false,
      path: '/fake/electron',
      exe: '/fake/electron',
    });
  });

  it('reports alreadyRegistered when the handler was already the default', async () => {
    const p = recordingPlatform({ isWindows: true });
    p.state.alreadyDefault = true;
    const result = await installProtocol(p);
    expect(result.alreadyRegistered).toBe(true);
    expect(p.calls.some((c) => c.startsWith('isDefaultProtocolClient'))).toBe(
      true,
    );
    expect(
      p.calls.some((c) => c.startsWith('setAsDefaultProtocolClient')),
    ).toBe(true);
  });
});

describe('installProtocol (macOS: the bundle is the registration)', () => {
  it('writes nothing and reports the bundle path with exe app', async () => {
    const p = recordingPlatform({ isMac: true });
    p.state.exe = '/Applications/Phi.app/Contents/MacOS/Phi';
    const result = await installProtocol(p);
    expect(result).toEqual({
      alreadyRegistered: false,
      path: '/Applications/Phi.app',
      exe: 'app',
    });
    // Only the config was resolved: no set/is/remove call, nothing written.
    expect(p.calls).toEqual(['getConfig']);
  });
});

describe('macBundlePath', () => {
  it('derives the .app bundle root three levels above the executable', () => {
    expect(macBundlePath('/Applications/Phi.app/Contents/MacOS/Phi')).toBe(
      '/Applications/Phi.app',
    );
  });
});

describe('uninstallProtocol', () => {
  it('removes the Windows handler with the same path/args used at install', async () => {
    const p = recordingPlatform({ isWindows: true });
    const result = await uninstallProtocol(p);
    const expectedArgs = JSON.stringify([
      path.join('/fake/app', 'dist', 'main.js'),
      '--',
    ]);
    expect(p.calls).toEqual([
      'getConfig',
      `removeAsDefaultProtocolClient(phi,/fake/electron,${expectedArgs})`,
    ]);
    expect(result).toEqual({
      removed: true,
      path: '/fake/electron',
      exe: '/fake/electron',
    });
  });

  it('reports removed false on macOS (bundle-only registration)', async () => {
    const p = recordingPlatform({ isMac: true });
    p.state.exe = '/Applications/Phi.app/Contents/MacOS/Phi';
    const result = await uninstallProtocol(p);
    expect(result).toEqual({
      removed: false,
      path: '/Applications/Phi.app',
      exe: 'app',
    });
    expect(p.calls).toEqual(['getConfig']);
  });
});

describe('Linux desktop file', () => {
  it('computes the documented XDG path', () => {
    expect(linuxDesktopFilePath('/home/phi')).toBe(
      path.join(
        '/home/phi',
        '.local',
        'share',
        'applications',
        LINUX_DESKTOP_FILE,
      ),
    );
  });

  it('renders the desktop entry with MimeType=x-scheme-handler/phi;', () => {
    const contents = linuxDesktopFileContents(
      '/opt/phi/phi-desktop',
      '/opt/phi/app/dist/main.js',
    );
    expect(contents).toContain('[Desktop Entry]');
    expect(contents).toContain('Type=Application');
    expect(contents).toContain('MimeType=x-scheme-handler/phi;');
    expect(contents).toContain(
      'Exec="/opt/phi/phi-desktop" "/opt/phi/app/dist/main.js" -- %u',
    );
    expect(contents.endsWith('\n')).toBe(true);
  });

  it('round-trips write/remove in a temp dir only (never outside it)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'phi-protocol-'));
    try {
      // The parent directory is created on demand (mkdirSync recursive).
      const nested = path.join(dir, 'applications');
      const filePath = path.join(nested, 'phi-desktop.desktop');
      const contents = linuxDesktopFileContents(
        '/opt/phi/phi-desktop',
        '/opt/phi/app/dist/main.js',
      );
      writeLinuxDesktopFile(true, filePath, contents);
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, 'utf8')).toBe(contents);
      // Removal is idempotent.
      writeLinuxDesktopFile(false, filePath);
      expect(existsSync(filePath)).toBe(false);
      writeLinuxDesktopFile(false, filePath);
      expect(existsSync(filePath)).toBe(false);
      // Nothing else was created inside the temp dir (the file delete
      // leaves the empty parent the test created; the test removes it).
      rmSync(nested, { recursive: true, force: true });
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
