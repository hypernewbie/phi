// @vitest-environment jsdom
/**
 * Window-icon resolver tests. Asserts the accent -> icon path mapping
 * used by the dynamic window icon: the resolver lazily reads a manifest
 * (build-generated from web/app.js ACCENT_COLORS by scripts/gen-icon.mjs)
 * and falls back to the white brand icon for unknown accents or a missing
 * generated set. The resolver is constructed with a fixture manifest so
 * the tests never depend on a build having run.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIconResolver } from '../src/appicon.js';

const FALLBACK = '/assets/icon.png';

function fixtureManifest(entries: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'phi-icon-test-'));
  const manifestPath = path.join(dir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(entries));
  return manifestPath;
}

describe('createIconResolver', () => {
  it('resolves an observed accent hex to its generated icon path', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'phi-icon-test-'));
    const manifestPath = path.join(dir, 'manifest.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({ '#7c6af7': 'icon-purple.png' }),
    );
    const resolver = createIconResolver(manifestPath, FALLBACK);
    expect(resolver.resolve('#7c6af7')).toBe(path.join(dir, 'icon-purple.png'));
  });

  it('falls back to the brand icon for an unknown accent hex', () => {
    const resolver = createIconResolver(
      fixtureManifest({ '#7c6af7': 'icon-purple.png' }),
      FALLBACK,
    );
    expect(resolver.resolve('#000000')).toBe(FALLBACK);
  });

  it('falls back to the brand icon for an empty accent (unobserved server)', () => {
    const resolver = createIconResolver(fixtureManifest({}), FALLBACK);
    expect(resolver.resolve('')).toBe(FALLBACK);
  });

  it('falls back to the brand icon when the manifest is missing or unreadable', () => {
    const resolver = createIconResolver(
      path.join(os.tmpdir(), 'phi-no-such-manifest.json'),
      FALLBACK,
    );
    expect(resolver.resolve('#7c6af7')).toBe(FALLBACK);
  });

  it('reads the manifest only once (lazy, cached)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'phi-icon-cache-'));
    const manifestPath = path.join(dir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify({ '#38bdf8': 'icon-blue.png' }));
    const resolver = createIconResolver(manifestPath, FALLBACK);
    expect(resolver.resolve('#38bdf8')).toBe(path.join(dir, 'icon-blue.png'));
    expect(resolver.resolve('#38bdf8')).toBe(path.join(dir, 'icon-blue.png'));
  });
});
