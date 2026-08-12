// @vitest-environment node
/**
 * Phase-2 end-to-end smoke test: spawns the real Electron binary in smoke
 * mode (PHI_DESKTOP_SMOKE=1) and asserts the main window was created as a
 * BrowserWindow, its title is "Phi", the local main view page rendered
 * the vendored header (a draggable .app-header), the local caption
 * controls and the empty #body-area placeholder, and the harness's phi://
 * test arg was argv-routed (classified + parsed + dispatched) by the
 * single-instance gate path. Later slices extended the payload: the
 * harness must never exercise the protocol-registration path
 * (registrationNotExercised), the tray (trayNotExercised) or the global
 * hotkey (hotkeyNotExercised), and must prove the controller store
 * persists (controllerPersisted — a scratch controller under the OS temp
 * dir, never the real userData profiles.json). The retained-view payload
 * (viewsCreated/activeViewId) proves the ProfileViewManager wiring: it is
 * built in the smoke path with recording-fake window/view factories (no
 * real WebContentsView or Session is ever constructed — the no-real-GUI
 * convention), one probe profile is activated, and the rail renderer's
 * loadFile is a no-op there. The geometry payload reports the new
 * composition literals (railWidth/bodyLeftOffset/bodyTopOffset/
 * railTopOffset/headerHeight).
 *
 * Skip preconditions (documented, matching the desktop Go native-test
 * convention: skip only on a known environmental precondition, FAIL on any
 * other error):
 *   1. dist/main.js missing        -> run `pnpm run build` first (CI and
 *      the package README order build before test).
 *   2. electron binary not installed (node_modules/electron/path.txt or
 *      dist/<binary> missing)      -> run `pnpm install`.
 *   3. Headless Linux with no DISPLAY/WAYLAND_DISPLAY (no X server).
 *   4. The spawned Electron cannot start for a documented environmental
 *      reason (missing display, SUID/namespace sandbox unavailable, missing
 *      system libraries on Linux CI) -> skip with the reason.
 *
 * Everything else is a failure: non-zero exit without a PHI_SMOKE_RESULT
 * line, a smoke result whose assertions fail, a hang (90s timeout), or an
 * unexpected spawn error.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, '..');
const distMain = path.join(packageRoot, 'dist', 'main.js');

const SMOKE_TIMEOUT_MS = 90_000;

// Patterns identifying a documented environmental launch failure rather
// than a defect in the app (mirrors the Go native-test skip contract).
const ENVIRONMENTAL_STDERR_PATTERNS = [
  /Missing X server|DISPLAY/i,
  /cannot open display/i,
  /SUID sandbox helper binary/i,
  /Failed to move to new namespace/i,
  /error while loading shared libraries/i,
  /libnss3|libatk|libgtk-3|libgbm|libasound|libxkbcommon/i,
];

function environmentalReason(stderr: string): string | null {
  const hit = ENVIRONMENTAL_STDERR_PATTERNS.find((re) => re.test(stderr));
  return hit ? hit.source : null;
}

/** Resolves the installed Electron binary, or null when the install is incomplete. */
function electronBinary(): string | null {
  const electronDir = path.join(packageRoot, 'node_modules', 'electron');
  const pathTxt = path.join(electronDir, 'path.txt');
  if (!existsSync(pathTxt)) return null;
  const bin = readFileSync(pathTxt, 'utf8').trim();
  if (!bin) return null;
  const full = path.join(electronDir, 'dist', bin);
  return existsSync(full) ? full : null;
}

describe('phase-1 e2e smoke (spawns the real Electron binary)', () => {
  it('creates a BrowserWindow titled "Phi" and renders the main view page', async (ctx) => {
    // ---- documented skip preconditions ----
    // (ctx.skip returns void in vitest's types, so an explicit `return`
    // is needed for narrowing; at runtime skip throws and aborts.)
    if (!existsSync(distMain)) {
      ctx.skip('dist/main.js missing — run `pnpm run build` first (CI and the README order build before test)');
      return;
    }
    if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      ctx.skip('headless Linux with no DISPLAY/WAYLAND_DISPLAY (no X server; use xvfb-run to provide one)');
      return;
    }
    const bin = electronBinary();
    if (!bin) {
      ctx.skip('electron binary not installed (node_modules/electron/path.txt or dist/ missing) — run `pnpm install`');
      return;
    }

    const child = spawn(bin, ['.', 'phi://profile/home'], {
      cwd: packageRoot,
      env: {
        ...process.env,
        PHI_DESKTOP_SMOKE: '1',
        // Headless/CI environments cannot start Chromium's OS-level sandbox
        // (no setuid helper, no display). The app code keeps its renderer
        // security defaults (sandbox: true, contextIsolation: true, ...);
        // this only relaxes the OS sandbox for the smoke harness run.
        ELECTRON_DISABLE_SANDBOX: '1',
      },
      // Mutable literal tuple so TS picks the spawn overload returning
      // ChildProcessByStdio<null, Readable, Readable> (stdout/stderr are
      // then non-null Readables).
      stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
    });

    const outcome = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (value: { code: number | null; error?: Error }) => {
        if (!settled) {
          settled = true;
          if (timer) clearTimeout(timer);
          resolve(value);
        }
      };
      timer = setTimeout(() => {
        child.kill();
        done({ code: null, error: new Error(`smoke run timed out after ${SMOKE_TIMEOUT_MS}ms`) });
      }, SMOKE_TIMEOUT_MS);
      child.on('close', (exitCode) => done({ code: exitCode }));
      child.on('error', (err) => done({ code: null, error: err }));
    });

    const resultLine = stdout.split('\n').find((line) => line.startsWith('PHI_SMOKE_RESULT '));
    if (outcome.error || outcome.code !== 0 || !resultLine) {
      const reason = environmentalReason(stderr);
      if (reason) {
        ctx.skip(
          `Electron could not start in this environment (${reason}); stderr tail: ${stderr
            .trim()
            .slice(-400)}`,
        );
      }
      expect.fail(
        `smoke run failed (${outcome.error ? `error: ${outcome.error.message}` : `exit ${outcome.code}`})\n` +
          `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      );
    }

    const payload = JSON.parse(resultLine.slice('PHI_SMOKE_RESULT '.length)) as Record<string, unknown>;
    expect(payload.isBrowserWindow).toBe(true);
    expect(payload.title).toBe('Phi');
    expect(payload.header).toBe(true);
    expect(payload.headerDrag).toBe('drag');
    expect(payload.captionControls).toBe(true);
    expect(payload.bodyArea).toBe(true);
    expect(payload.bodyAreaHasDesktopClass).toBe(true);
    // The harness passes 'phi://profile/home'; the app must report that the
    // positional arg was classified and the deep link parsed+dispatched.
    expect(payload.argvRouted).toBe(true);
    expect(payload.argvDeepLinkParsed).toBe(true);
    // The harness runs with the normal argv (no --register-protocol /
    // --unregister-protocol), so the protocol-registration path must never
    // be exercised: the CLI flags exit before any window, and this run has
    // none.
    expect(payload.registrationNotExercised).toBe(true);
    // The tray is never built in smoke mode (the smoke path returns before
    // startTray()), so the harness never instantiates a real Tray.
    expect(payload.trayNotExercised).toBe(true);
    // The smoke harness never registers the real global hotkey: the ready
    // callback returns before the hotkey registration (gated by
    // PHI_DESKTOP_SMOKE the same way the protocol-registration flags are).
    expect(payload.hotkeyNotExercised).toBe(true);
    // The smoke run builds a scratch controller (under the OS temp dir —
    // never the real userData profiles.json), adds one probe profile and
    // reports the store file exists on disk.
    expect(payload.controllerPersisted).toBe(true);
    // The view manager (built in the smoke path with recording fakes)
    // reports one retained view and the new-composition geometry.
    expect(payload.viewsCreated).toBe(1);
    expect(payload.activeViewId).toBe('127-0-0-1-7070');
    expect(payload.railWidth).toBe(72);
    expect(payload.bodyLeftOffset).toBe(72);
    expect(payload.bodyTopOffset).toBe(48);
    expect(payload.railTopOffset).toBe(48);
    expect(payload.headerHeight).toBe(48);
  });
});
