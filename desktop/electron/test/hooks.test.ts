// @vitest-environment node
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DesktopHooksManager,
  findHookScript,
  writeAtomicStateFile,
  type DesktopHookState,
} from '../src/hooks.js';

describe('desktop hooks and state publishing', () => {
  let tempDir: string;
  let hooksDir: string;
  let statePath: string;

  beforeEach(() => {
    tempDir = path.join(
      os.tmpdir(),
      `phi-hooks-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    hooksDir = path.join(tempDir, 'hooks');
    statePath = path.join(tempDir, 'desktop-state.json');
    mkdirSync(hooksDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('findHookScript', () => {
    it('returns null if hooks directory is empty or missing', () => {
      expect(findHookScript(hooksDir)).toBeNull();
      expect(findHookScript(path.join(tempDir, 'nonexistent'))).toBeNull();
    });

    it('resolves an executable on-state-change script on Unix', () => {
      const scriptPath = path.join(hooksDir, 'on-state-change');
      writeFileSync(scriptPath, '#!/bin/sh\nexit 0', 'utf8');
      chmodSync(scriptPath, 0o755);

      const resolved = findHookScript(hooksDir, 'linux');
      expect(resolved).toEqual({ command: scriptPath, args: [] });
    });

    it('falls back to python3 for non-executable .py script on Unix', () => {
      const scriptPath = path.join(hooksDir, 'on-state-change.py');
      writeFileSync(scriptPath, 'print("hi")', 'utf8');
      chmodSync(scriptPath, 0o644);

      const resolved = findHookScript(hooksDir, 'linux');
      expect(resolved).toEqual({ command: 'python3', args: [scriptPath] });
    });

    it('falls back to /bin/sh for non-executable .sh script on Unix', () => {
      const scriptPath = path.join(hooksDir, 'on-state-change.sh');
      writeFileSync(scriptPath, 'echo hi', 'utf8');
      chmodSync(scriptPath, 0o644);

      const resolved = findHookScript(hooksDir, 'linux');
      expect(resolved).toEqual({ command: '/bin/sh', args: [scriptPath] });
    });

    it('resolves powershell for .ps1 script on Windows', () => {
      const scriptPath = path.join(hooksDir, 'on-state-change.ps1');
      writeFileSync(scriptPath, 'Write-Host hi', 'utf8');

      const resolved = findHookScript(hooksDir, 'win32');
      expect(resolved).toEqual({
        command: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      });
    });

    it('resolves .bat directly on Windows', () => {
      const scriptPath = path.join(hooksDir, 'on-state-change.bat');
      writeFileSync(scriptPath, '@echo off', 'utf8');

      const resolved = findHookScript(hooksDir, 'win32');
      expect(resolved).toEqual({ command: scriptPath, args: [] });
    });
  });

  describe('writeAtomicStateFile', () => {
    it('atomically creates the file and any missing parent directories', () => {
      const deepPath = path.join(tempDir, 'sub', 'dir', 'state.json');
      writeAtomicStateFile(deepPath, JSON.stringify({ hello: 'world' }));

      expect(existsSync(deepPath)).toBe(true);
      const content = JSON.parse(readFileSync(deepPath, 'utf8'));
      expect(content).toEqual({ hello: 'world' });
    });
  });

  describe('DesktopHooksManager', () => {
    function makeSampleState(
      event: string,
      overrides: Partial<DesktopHookState> = {},
    ): DesktopHookState {
      const now = Date.now();
      return {
        event,
        focused: true,
        fullscreen: false,
        maximized: false,
        minimized: false,
        active_id: '127-0-0-1-7070',
        activeId: '127-0-0-1-7070',
        server_name: 'charon',
        serverName: 'charon',
        origin: 'http://127.0.0.1:7070',
        accent: '#fbbf24',
        theme_color: 'amber',
        themeColor: 'amber',
        cpu: 12,
        unread: 3,
        timestamp: now,
        iso_time: new Date(now).toISOString(),
        isoTime: new Date(now).toISOString(),
        ...overrides,
      };
    }

    it('writes atomic state file and invokes spawner with rich state', () => {
      const scriptPath = path.join(hooksDir, 'on-state-change');
      writeFileSync(scriptPath, '#!/bin/sh\nexit 0', 'utf8');
      chmodSync(scriptPath, 0o755);

      const spawner = vi.fn();
      const manager = new DesktopHooksManager(
        (event) =>
          makeSampleState(event, { fullscreen: true, accent: '#a855f7' }),
        {
          hooksDir,
          statePath,
          spawner,
          debounceMs: 0,
        },
      );

      manager.trigger('fullscreen');

      expect(existsSync(statePath)).toBe(true);
      const savedState = JSON.parse(readFileSync(statePath, 'utf8'));
      expect(savedState.event).toBe('fullscreen');
      expect(savedState.fullscreen).toBe(true);
      expect(savedState.accent).toBe('#a855f7');
      expect(savedState.active_id).toBe('127-0-0-1-7070');

      expect(spawner).toHaveBeenCalledTimes(1);
      const [cmd, args, opts] = spawner.mock.calls[0];
      expect(cmd).toBe(scriptPath);
      expect(args).toContain('--event');
      expect(args).toContain('fullscreen');
      expect(args).toContain('--fullscreen');
      expect(args).toContain('true');
      expect(args).toContain('--accent');
      expect(args).toContain('#a855f7');
      expect(opts.env.PHI_EVENT).toBe('fullscreen');
      expect(opts.env.PHI_FULLSCREEN).toBe('true');
      expect(opts.env.PHI_ACCENT).toBe('#a855f7');
      expect(opts.env.PHI_SERVER).toBe('charon');

      manager.destroy();
    });

    it('debounces rapid triggers and settles on the latest event', async () => {
      const spawner = vi.fn();
      let lastEvent = '';
      const manager = new DesktopHooksManager(
        (event) => {
          lastEvent = event;
          return makeSampleState(event);
        },
        {
          hooksDir,
          statePath,
          spawner,
          debounceMs: 20,
        },
      );

      manager.trigger('focus');
      manager.trigger('switch');
      manager.trigger('fullscreen');

      expect(spawner).not.toHaveBeenCalled();

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(spawner).toHaveBeenCalledTimes(0); // no script was placed in hooksDir
      expect(lastEvent).toBe('fullscreen');
      const savedState = JSON.parse(readFileSync(statePath, 'utf8'));
      expect(savedState.event).toBe('fullscreen');

      manager.destroy();
    });

    it('immediate: true bypasses debounce timer', () => {
      const spawner = vi.fn();
      const manager = new DesktopHooksManager(
        (event) => makeSampleState(event),
        {
          hooksDir,
          statePath,
          spawner,
          debounceMs: 1000,
        },
      );

      manager.trigger('quit', true);

      expect(existsSync(statePath)).toBe(true);
      const savedState = JSON.parse(readFileSync(statePath, 'utf8'));
      expect(savedState.event).toBe('quit');

      manager.destroy();
    });
  });
});
