// The committed application/window icon and the tray icon set are
// generated (scripts/gen-icon.mjs) and must stay valid: the main
// window's BrowserWindow icon and electron-builder win.icon point at
// assets/icon.png; the tray resolves assets/tray.ico on Windows and
// assets/tray.png elsewhere.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TRAY_ICON_PATH } from '../src/tray.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(here, '..', 'assets');
const iconPath = path.join(assetsDir, 'icon.png');
const trayPngPath = path.join(assetsDir, 'tray.png');
const trayIcoPath = path.join(assetsDir, 'tray.ico');

describe('assets/icon.png (generated Phi window icon)', () => {
  it('exists and starts with the PNG signature', () => {
    const head = [...readFileSync(iconPath).subarray(0, 8)];
    expect(head).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('is a 256x256 8-bit RGBA image (IHDR)', () => {
    const ihdr = readFileSync(iconPath).subarray(16, 29);
    expect(ihdr.readUInt32BE(0)).toBe(256); // width
    expect(ihdr.readUInt32BE(4)).toBe(256); // height
    expect(ihdr[8]).toBe(8); // bit depth
    expect(ihdr[9]).toBe(6); // color type: RGBA
  });
});

describe('assets/tray.png (generated Phi tray fallback icon)', () => {
  it('exists and is a 256x256 8-bit RGBA image (IHDR)', () => {
    const ihdr = readFileSync(trayPngPath).subarray(16, 29);
    expect(ihdr.readUInt32BE(0)).toBe(256); // width
    expect(ihdr.readUInt32BE(4)).toBe(256); // height
    expect(ihdr[8]).toBe(8); // bit depth
    expect(ihdr[9]).toBe(6); // color type: RGBA
  });
});

describe('assets/tray.ico (generated Phi tray icon set)', () => {
  it('exists, starts with the ICO header and carries one entry per size', () => {
    const ico = readFileSync(trayIcoPath);
    // ICONDIR: reserved 0, type 1 (icon), count 7 (16/24/32/48/64/128/256).
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(7);
    // Every entry: PNG-compressed image data at its declared offset.
    const count = ico.readUInt16LE(4);
    const sizes: number[] = [];
    for (let i = 0; i < count; i++) {
      const o = 6 + i * 16;
      const w = ico[o];
      const h = ico[o + 1];
      sizes.push(w === 0 ? 256 : w);
      expect(h).toBe(w); // square entries
      const len = ico.readUInt32LE(o + 8);
      const off = ico.readUInt32LE(o + 12);
      expect([...ico.subarray(off, off + 8)]).toEqual([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      expect(len).toBeGreaterThan(0);
    }
    expect(sizes).toEqual([16, 24, 32, 48, 64, 128, 256]);
  });
});

describe('TRAY_ICON_PATH (the production tray asset resolution)', () => {
  it('resolves to an existing, non-empty file', () => {
    expect(TRAY_ICON_PATH).toBe(path.join(assetsDir, 'tray.ico'));
    expect(existsSync(TRAY_ICON_PATH)).toBe(true);
    expect(statSync(TRAY_ICON_PATH).size).toBeGreaterThan(0);
  });
});

describe('scripts/gen-icon.mjs (the committed generator)', () => {
  it('emits the window icon, the tray PNG and the tray ICO', () => {
    const source = readFileSync(
      path.join(here, '..', 'scripts', 'gen-icon.mjs'),
      'utf8',
    );
    expect(source).toContain("'icon.png'");
    expect(source).toContain("'tray.png'");
    expect(source).toContain("'tray.ico'");
  });

  it('uses the committed generated assets on non-Windows packaging hosts', () => {
    const source = readFileSync(
      path.join(here, '..', 'scripts', 'gen-icon.mjs'),
      'utf8',
    );
    expect(source).toContain("process.platform !== 'win32'");
    expect(source).toContain('using committed icon assets');
  });
});
