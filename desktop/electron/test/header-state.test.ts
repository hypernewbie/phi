// @vitest-environment jsdom
/**
 * Brand-state header helpers tests (vitest + jsdom). The desktop main
 * view runs the same `web/header-state.js` helpers the browser Phi
 * page calls from `web/terminal.js`, so the dynamic brand-state
 * (CPU tier glow on the Φ glyph, terminal-activity `▍`/`—` toggle)
 * works identically in both contexts (shared source of truth).
 *
 * This file pins the helpers' behavior directly. The vendored copy at
 * `desktop/electron/web/vendor/header-state.js` is exercised by the
 * main view's mainview.js via the `phi:header-state` IPC push from the
 * host; this test exercises the same DOM mutations in isolation.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeEach } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(here, '..', '..', '..', 'web');
const desktopElectronRoot = path.join(here, '..');
const webHeaderStatePath = path.join(webRoot, 'header-state.js');
const vendoredHeaderStatePath = path.join(
  desktopElectronRoot,
  'web',
  'vendor',
  'header-state.js',
);

let applyBrandCpuTier: (cpuPercent: number) => void;
let applyTerminalActivityIndicator: (
  hasActivity: boolean,
  hostnameKnown: boolean,
) => void;

beforeEach(async () => {
  // Load the vendored copy (which is byte-identical to web/). The
  // vendored copy is inside the project root so vitest's default
  // `server.fs.allow` accepts the import.
  const mod = await import(pathToFileURLLocal(vendoredHeaderStatePath).href);
  applyBrandCpuTier = mod.applyBrandCpuTier;
  applyTerminalActivityIndicator = mod.applyTerminalActivityIndicator;
  // Reset DOM to a fresh header block.
  document.body.innerHTML = `
    <header class="app-header">
      <div class="brand">
        <span class="logo">Φ</span>
        <span class="brand-name">phi</span>
        <div class="hostname-wrapper">
          <span id="terminal-activity-indicator" class="terminal-activity-indicator">—</span>
          <span id="hostname-display"></span>
        </div>
      </div>
    </header>
  `;
});

function pathToFileURLLocal(p: string): URL {
  const url = new URL(`file:///${p.replace(/\\/g, '/')}`);
  return url;
}

describe('applyBrandCpuTier', () => {
  it('applies cpu-idle at 0%', () => {
    applyBrandCpuTier(0);
    const logo = document.querySelector<HTMLElement>('.brand .logo');
    expect(logo?.classList.contains('cpu-idle')).toBe(true);
    expect(logo?.dataset.cpuLevel).toBe('cpu-idle');
  });

  it('applies cpu-moderate at 50%', () => {
    applyBrandCpuTier(50);
    const logo = document.querySelector<HTMLElement>('.brand .logo');
    expect(logo?.classList.contains('cpu-moderate')).toBe(true);
    expect(logo?.classList.contains('cpu-idle')).toBe(false);
  });

  it('applies cpu-high at 80%', () => {
    applyBrandCpuTier(80);
    const logo = document.querySelector('.brand .logo');
    expect(logo?.classList.contains('cpu-high')).toBe(true);
  });

  it('applies cpu-critical at 95%', () => {
    applyBrandCpuTier(95);
    const logo = document.querySelector('.brand .logo');
    expect(logo?.classList.contains('cpu-critical')).toBe(true);
  });

  it('clamps out-of-range values to 0..100', () => {
    applyBrandCpuTier(150);
    const logo = document.querySelector<HTMLElement>('.brand .logo');
    expect(logo?.dataset.cpuPct).toBe('100');
    expect(logo?.classList.contains('cpu-critical')).toBe(true);

    applyBrandCpuTier(-50);
    expect(logo?.dataset.cpuPct).toBe('0');
    expect(logo?.classList.contains('cpu-idle')).toBe(true);
  });

  it('keeps dataset.cpuPct fresh on every call (used by the self-state HUD on hover)', () => {
    applyBrandCpuTier(15);
    applyBrandCpuTier(45);
    applyBrandCpuTier(75);
    const logo = document.querySelector<HTMLElement>('.brand .logo');
    expect(logo?.dataset.cpuPct).toBe('75');
  });

  it('is a no-op when the indicator element is missing', () => {
    document.body.innerHTML = '';
    // Must not throw.
    expect(() => applyBrandCpuTier(50)).not.toThrow();
  });

  it('also applies the tier class to .brand-name so the spelled-out text glows', () => {
    applyBrandCpuTier(95);
    const brandName = document.querySelector('.brand .brand-name');
    expect(brandName?.classList.contains('cpu-critical')).toBe(true);
  });
});

describe('applyTerminalActivityIndicator', () => {
  it('shows the em-dash and is-active=false when hostnameKnown=true, hasActivity=false', () => {
    applyTerminalActivityIndicator(false, true);
    const indicator = document.getElementById('terminal-activity-indicator');
    expect(indicator?.classList.contains('is-active')).toBe(false);
    expect(indicator?.classList.contains('hidden')).toBe(false);
    expect(indicator?.textContent).toBe('—');
    expect(indicator?.getAttribute('aria-label')).toBe(
      'All terminal tabs are quiet',
    );
  });

  it('shows the block-pipe and is-active=true when hasActivity=true', () => {
    applyTerminalActivityIndicator(true, true);
    const indicator = document.getElementById('terminal-activity-indicator');
    expect(indicator?.classList.contains('is-active')).toBe(true);
    expect(indicator?.textContent).toBe('▍');
    expect(indicator?.getAttribute('aria-label')).toBe(
      'Terminal output on one or more tabs',
    );
  });

  it('hides the indicator when hostnameKnown=false regardless of hasActivity', () => {
    applyTerminalActivityIndicator(true, false);
    const indicator = document.getElementById('terminal-activity-indicator');
    expect(indicator?.classList.contains('hidden')).toBe(true);
  });

  it('is a no-op when the indicator element is missing', () => {
    document.body.innerHTML = '';
    expect(() => applyTerminalActivityIndicator(true, true)).not.toThrow();
  });
});

describe('TBAR pipeline: header-state module', () => {
  it('web/header-state.js is vendored byte-identical into desktop/electron/web/vendor/header-state.js', () => {
    if (!existsSync(vendoredHeaderStatePath)) {
      throw new Error(
        'vendor: header-state.js missing — run `pnpm run build` first',
      );
    }
    expect(readFileSync(vendoredHeaderStatePath, 'utf8')).toBe(
      readFileSync(webHeaderStatePath, 'utf8'),
    );
  });

  it('mainview.js drives the same helpers via the IPC header-state push', () => {
    // The desktop main view imports the helpers from the vendored copy
    // and applies them on every `phi:header-state` push from the host.
    // The browser Phi page calls the same helpers from web/terminal.js,
    // so both contexts run the same code (shared source of truth).
    // The desktop TBAR's brand cluster reads the same DOM
    // mutations as the browser Phi header.
    const mainviewSource = readFileSync(
      path.join(desktopElectronRoot, 'web', 'mainview.js'),
      'utf8',
    );
    expect(mainviewSource).toContain("from './vendor/header-state.js'");
    expect(mainviewSource).toContain('applyBrandCpuTier');
    expect(mainviewSource).toContain('applyTerminalActivityIndicator');
    expect(mainviewSource).toContain('onHeaderState');
    expect(mainviewSource).toContain('state.workspace');
    expect(mainviewSource).toContain('workspaceSelect.value = state.workspace');
  });
});
