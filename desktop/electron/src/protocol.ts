/**
 * phi:// OS protocol registration for the Electron main process — parity
 * with the Wails `desktop/internal/registry` package, implemented with the
 * public Electron `app.setAsDefaultProtocolClient(protocol, execPath,
 * args)` API only (no native registry calls, no advapi32).
 *
 * Platform behavior (documented contract):
 *   - Windows: `app.setAsDefaultProtocolClient('phi', process.execPath,
 *     [<appPath>/dist/main.js, '--'])` — the documented Electron path. The
 *     trailing `--` is required so phi:// URL values that begin with '-'
 *     are never parsed as Electron flags. `alreadyRegistered` reflects
 *     `app.isDefaultProtocolClient('phi', ...)` taken before the call;
 *     unregistration uses `app.removeAsDefaultProtocolClient('phi', ...)`
 *     with the same path/args (idempotent per Electron).
 *   - macOS: registration is the app bundle's responsibility —
 *     `CFBundleURLTypes` is baked into `Info.plist` at packaging time via
 *     electron-builder `mac.extendInfo` (see electron-builder.json).
 *     installProtocol writes nothing at runtime and reports the bundle
 *     path (`app.getPath('exe')` three levels up: Contents/MacOS/<bin> ->
 *     the .app root) with `exe: 'app'`; uninstall reports `removed: false`
 *     — only a re-packaged bundle changes the registration.
 *   - Linux: writes the XDG desktop file
 *     `~/.local/share/applications/phi-desktop.desktop` with
 *     `MimeType=x-scheme-handler/phi;` (written directly, no shelling
 *     out), then calls setAsDefaultProtocolClient so the handler is made
 *     the default. Removal is an idempotent file delete. Result `path` is
 *     the desktop-file path.
 *
 * Testability: all environment access goes through the Platform interface.
 * Production uses the exported `realPlatform` (bound to the real Electron
 * app); tests inject a fake Platform whose methods record calls so tests
 * assert the exact behavior. The real Electron setAsDefaultProtocolClient
 * is reachable only through realPlatform, which only the production CLI
 * path (src/main.ts --register-protocol / --unregister-protocol) uses — no
 * test exercises it, and no test ever writes a real registry key or
 * desktop file (the Linux writer is exercised against a temp dir only).
 */
import { app } from 'electron';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The protocol scheme registered on every platform. */
export const PROTOCOL = 'phi';

/** The desktop-file basename registered on Linux (XDG applications dir). */
export const LINUX_DESKTOP_FILE = 'phi-desktop.desktop';

/**
 * The app facts registration needs, injected so tests never touch the real
 * Electron app: `exe` is `app.getPath('exe')` (the current executable —
 * equal to process.execPath in Electron) and `appPath` is
 * `app.getAppPath()` (the app root; the main bundle lives at
 * `<appPath>/dist/main.js`).
 */
export interface ElectronAppConfig {
  /** The current executable (production: app.getPath('exe')). */
  exe: string;
  /** The app root directory (production: app.getAppPath()). */
  appPath: string;
}

/** Result of a successful protocol install. */
export interface ProtocolRegistration {
  /** True when the handler was already the default before this call. */
  alreadyRegistered: boolean;
  /** The registered target: the executable (Windows), bundle (macOS) or desktop file (Linux). */
  path: string;
  /** The registered executable; 'app' on macOS (the bundle's executable). */
  exe: string;
}

/** Result of a protocol uninstall. */
export interface ProtocolUnregistration {
  /** True when a handler/file was actually removed. */
  removed: boolean;
  /** The target that was (or would have been) removed. */
  path: string;
  /** The registered executable; 'app' on macOS. */
  exe: string;
}

/**
 * The environment surface registration runs against. Production uses
 * `realPlatform`; tests inject a recording fake. The app-API methods are
 * part of the interface (not imported directly) so tests can pin the exact
 * call sequence without ever reaching the real Electron app.
 */
export interface Platform {
  isWindows: boolean;
  isMac: boolean;
  isLinux: boolean;
  /** The Electron binary path the OS should launch (production: process.execPath). */
  execPath: string;
  /** Resolves the app config at call time (production: app.getPath('exe') + app.getAppPath()). */
  getConfig: () => ElectronAppConfig;
  /** Production: app.setAsDefaultProtocolClient. */
  setAsDefaultProtocolClient(protocol: string, execPath: string, args: string[]): boolean;
  /** Production: app.isDefaultProtocolClient. */
  isDefaultProtocolClient(protocol: string, execPath: string, args: string[]): boolean;
  /** Production: app.removeAsDefaultProtocolClient. */
  removeAsDefaultProtocolClient(protocol: string, execPath: string, args: string[]): boolean;
}

/**
 * The production platform: the real Electron app, bound at module load.
 * The methods are only invoked by the CLI flag path — nothing at module
 * load touches the app, so importing this module is inert outside a real
 * Electron runtime (as with src/single-instance.ts).
 */
export const realPlatform: Platform = {
  isWindows: process.platform === 'win32',
  isMac: process.platform === 'darwin',
  isLinux: process.platform === 'linux',
  execPath: process.execPath,
  getConfig: () => ({ exe: app.getPath('exe'), appPath: app.getAppPath() }),
  setAsDefaultProtocolClient: (protocol, execPath, args) =>
    app.setAsDefaultProtocolClient(protocol, execPath, args),
  isDefaultProtocolClient: (protocol, execPath, args) =>
    app.isDefaultProtocolClient(protocol, execPath, args),
  removeAsDefaultProtocolClient: (protocol, execPath, args) =>
    app.removeAsDefaultProtocolClient(protocol, execPath, args),
};

/**
 * Builds the argv appended after the executable when the OS launches a
 * phi:// URL: `[<appPath>/dist/main.js, '--']` — the app's main entry
 * followed by the trailing `--` that guarantees URL values starting with
 * '-' are not parsed as Electron flags. The main entry is the packaged
 * bundle relative to the app root (the same path `electron .` loads).
 */
export function protocolArgs(appPath: string): string[] {
  return [path.join(appPath, 'dist', 'main.js'), '--'];
}

/**
 * Derives the .app bundle root from the bundle's executable path
 * (`app.getPath('exe')` = `<bundle>/Contents/MacOS/<binary>`, three levels
 * below the bundle root).
 */
export function macBundlePath(exe: string): string {
  return path.dirname(path.dirname(path.dirname(exe)));
}

/** The XDG applications directory for the given home (defaults to os.homedir()). */
export function linuxApplicationsDir(home: string = os.homedir()): string {
  return path.join(home, '.local', 'share', 'applications');
}

/** The documented Linux desktop-file path (~/.local/share/applications/phi-desktop.desktop). */
export function linuxDesktopFilePath(home: string = os.homedir()): string {
  return path.join(linuxApplicationsDir(home), LINUX_DESKTOP_FILE);
}

/** Desktop-entry Exec quoting: wrap in double quotes, escape embedded quotes/backslashes. */
function quoteExecArg(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Renders the Linux desktop-entry contents that register the phi://
 * scheme: `MimeType=x-scheme-handler/phi;` (the mandatory scheme-handler
 * marker), with the Exec line launching the Electron binary, the app main
 * entry, the `--` separator and the `%u` URL placeholder (the field code
 * xdg substitutes the phi:// URI for).
 */
export function linuxDesktopFileContents(exe: string, entry: string): string {
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Phi Desktop',
    `Exec=${quoteExecArg(exe)} ${quoteExecArg(entry)} -- %u`,
    'MimeType=x-scheme-handler/phi;',
    'NoDisplay=true',
    'Terminal=false',
    'Categories=Network;',
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Creates (install=true) or removes (install=false) the Linux desktop file
 * at filePath. The production caller passes the documented XDG path
 * (linuxDesktopFilePath()); tests pass a temp-dir path so nothing outside
 * it is ever touched. No shelling out: the file (and its parent
 * directory) is written directly; removal is an idempotent delete
 * (contents is ignored on removal).
 */
export function writeLinuxDesktopFile(
  install: boolean,
  filePath: string,
  contents = '',
): void {
  if (install) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents, 'utf8');
  } else {
    rmSync(filePath, { force: true });
  }
}

/**
 * Installs the phi:// protocol handler. extraArgs defaults to
 * protocolArgs(appPath) when omitted; the CLI passes them explicitly
 * (`[<dist>/main.js, '--']`).
 */
export async function installProtocol(
  platform: Platform,
  extraArgs?: string[],
): Promise<ProtocolRegistration> {
  const config = platform.getConfig();
  if (platform.isMac) {
    // The bundle's Info.plist CFBundleURLTypes (set at packaging time via
    // electron-builder mac.extendInfo) is the registration; the runtime
    // writes nothing. alreadyRegistered is false because no runtime
    // action happened — the bundle responsibility is documented.
    return { alreadyRegistered: false, path: macBundlePath(config.exe), exe: 'app' };
  }
  const args = extraArgs ?? protocolArgs(config.appPath);
  if (platform.isLinux) {
    // The desktop file is what makes phi:// openable on Linux; the
    // setAsDefaultProtocolClient call then asks xdg to make it the
    // default handler.
    const filePath = linuxDesktopFilePath();
    writeLinuxDesktopFile(true, filePath, linuxDesktopFileContents(platform.execPath, args[0]));
    platform.setAsDefaultProtocolClient(PROTOCOL, platform.execPath, args);
    return { alreadyRegistered: false, path: filePath, exe: platform.execPath };
  }
  // Windows (the documented Electron path). The platform booleans are
  // mutually exclusive; anything non-mac/non-linux behaves like Windows.
  const alreadyRegistered = platform.isDefaultProtocolClient(PROTOCOL, platform.execPath, args);
  platform.setAsDefaultProtocolClient(PROTOCOL, platform.execPath, args);
  return { alreadyRegistered, path: platform.execPath, exe: platform.execPath };
}

/**
 * Removes the phi:// protocol handler. macOS reports removed:false (the
 * bundle is the registration; only re-packaging changes it). Linux
 * removes the desktop file (idempotent; removed reports whether the file
 * existed). Windows calls app.removeAsDefaultProtocolClient with the same
 * path/args used at install time (idempotent per Electron).
 */
export async function uninstallProtocol(
  platform: Platform,
): Promise<ProtocolUnregistration> {
  const config = platform.getConfig();
  if (platform.isMac) {
    return { removed: false, path: macBundlePath(config.exe), exe: 'app' };
  }
  const args = protocolArgs(config.appPath);
  if (platform.isLinux) {
    const filePath = linuxDesktopFilePath();
    const existed = existsSync(filePath);
    writeLinuxDesktopFile(false, filePath);
    return { removed: existed, path: filePath, exe: platform.execPath };
  }
  const removed = platform.removeAsDefaultProtocolClient(PROTOCOL, platform.execPath, args);
  return { removed, path: platform.execPath, exe: platform.execPath };
}
