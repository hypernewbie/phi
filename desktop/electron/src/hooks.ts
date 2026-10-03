/**
 * User hook script executor & state publisher for Phi Desktop.
 *
 * Exposes desktop lifecycle and server state to external scripts without
 * requiring background daemons or direct hardware access.
 *
 * Behavior:
 *   1. Writes ~/.phi/desktop-state.json atomically on state changes.
 *   2. Resolves and invokes ~/.phi/hooks/on-state-change (or .sh, .py, .bat, .ps1)
 *      with rich state passed via CLI flags, JSON argument, and PHI_* env vars.
 */
import { spawn, type SpawnOptions } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface DesktopHookState {
  event: string;
  focused: boolean;
  fullscreen: boolean;
  maximized: boolean;
  minimized: boolean;
  active_id: string;
  activeId: string;
  server_name: string;
  serverName: string;
  origin: string;
  accent: string;
  theme_color: string;
  themeColor: string;
  cpu: number | null;
  unread: number;
  timestamp: number;
  iso_time: string;
  isoTime: string;
}

export interface DesktopHooksOptions {
  hooksDir?: string;
  statePath?: string;
  spawner?: (command: string, args: string[], options: SpawnOptions) => void;
  debounceMs?: number;
  platform?: NodeJS.Platform;
  log?: (msg: string) => void;
}

export interface ResolvedHook {
  command: string;
  args: string[];
}

/**
 * Searches for a compatible on-state-change hook script in hooksDir.
 * Supports cross-platform execution (Linux, macOS, Windows).
 */
export function findHookScript(
  hooksDir: string,
  platform: NodeJS.Platform = process.platform,
): ResolvedHook | null {
  if (!existsSync(hooksDir)) return null;

  const candidates =
    platform === 'win32'
      ? [
          'on-state-change.bat',
          'on-state-change.cmd',
          'on-state-change.ps1',
          'on-state-change.exe',
          'on-state-change.py',
          'on-state-change',
        ]
      : [
          'on-state-change',
          'on-state-change.sh',
          'on-state-change.py',
          'on-state-change.js',
        ];

  for (const name of candidates) {
    const fullPath = path.join(hooksDir, name);
    if (!existsSync(fullPath)) continue;

    try {
      const stat = statSync(fullPath);
      if (!stat.isFile()) continue;

      if (platform === 'win32') {
        if (name.endsWith('.ps1')) {
          return {
            command: 'powershell.exe',
            args: [
              '-NoProfile',
              '-ExecutionPolicy',
              'Bypass',
              '-File',
              fullPath,
            ],
          };
        }
        return { command: fullPath, args: [] };
      }

      // Unix / macOS: check executable bit first
      try {
        accessSync(fullPath, constants.X_OK);
        return { command: fullPath, args: [] };
      } catch {
        // If not +x, fallback to interpreter if extension recognized
        if (name.endsWith('.py')) {
          return { command: 'python3', args: [fullPath] };
        }
        if (name.endsWith('.sh')) {
          return { command: '/bin/sh', args: [fullPath] };
        }
        if (name.endsWith('.js')) {
          return { command: 'node', args: [fullPath] };
        }
      }
    } catch {
      // Ignore stat/access errors
    }
  }

  return null;
}

/**
 * Atomically writes a file via temporary file + rename.
 */
export function writeAtomicStateFile(statePath: string, data: string): void {
  const dir = path.dirname(statePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, data, 'utf8');
  renameSync(tmpPath, statePath);
}

function defaultSpawner(
  command: string,
  args: string[],
  opts: SpawnOptions,
): void {
  try {
    const child = spawn(command, args, opts);
    child.unref();
    child.on('error', (err) => {
      console.warn(`phi-desktop: hook error: ${String(err)}`);
    });
  } catch (err) {
    console.warn(`phi-desktop: failed to spawn hook: ${String(err)}`);
  }
}

export class DesktopHooksManager {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latestEvent = 'init';
  private destroyed = false;

  constructor(
    private readonly getState: (event: string) => DesktopHookState,
    private readonly options: DesktopHooksOptions = {},
  ) {}

  trigger(event: string, immediate = false): void {
    if (this.destroyed) return;
    this.latestEvent = event;
    const debounceMs = this.options.debounceMs ?? 30;

    if (immediate || debounceMs <= 0) {
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.dispatch(event);
      return;
    }

    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.dispatch(this.latestEvent);
    }, debounceMs);
  }

  private dispatch(event: string): void {
    try {
      const state = this.getState(event);
      const json = JSON.stringify(state, null, 2);

      // 1. Write atomic state file
      const statePath =
        this.options.statePath ??
        path.join(os.homedir(), '.phi', 'desktop-state.json');
      try {
        writeAtomicStateFile(statePath, json);
      } catch (err) {
        this.options.log?.(`failed to write state file: ${String(err)}`);
      }

      // 2. Invoke hook if present
      const hooksDir =
        this.options.hooksDir ?? path.join(os.homedir(), '.phi', 'hooks');
      const hook = findHookScript(hooksDir, this.options.platform);
      if (hook) {
        const spawner = this.options.spawner ?? defaultSpawner;
        const envVars: Record<string, string> = {
          PHI_EVENT: state.event,
          PHI_FOCUSED: String(state.focused),
          PHI_FULLSCREEN: String(state.fullscreen),
          PHI_MAXIMIZED: String(state.maximized),
          PHI_MINIMIZED: String(state.minimized),
          PHI_ACTIVE_ID: state.activeId,
          PHI_SERVER: state.serverName,
          PHI_ORIGIN: state.origin,
          PHI_ACCENT: state.accent,
          PHI_THEME_COLOR: state.themeColor,
          PHI_UNREAD: String(state.unread),
          PHI_STATE_JSON: json,
        };

        const cliArgs = [
          ...hook.args,
          '--event',
          state.event,
          '--fullscreen',
          String(state.fullscreen),
          '--focused',
          String(state.focused),
          '--accent',
          state.accent,
          '--server',
          state.serverName,
          '--json',
          json,
        ];

        spawner(hook.command, cliArgs, {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, ...envVars },
        });
      }
    } catch (err) {
      this.options.log?.(`dispatch failed: ${String(err)}`);
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
