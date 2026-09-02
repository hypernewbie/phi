/**
 * Guards the macOS protocol-registration packaging config. On macOS the
 * phi:// registration is the app bundle's Info.plist, baked at packaging
 * time via electron-builder `mac.extendInfo.CFBundleURLTypes` — the
 * runtime writes nothing. tsc does not parse JSON, so this test parses
 * electron-builder.json itself and asserts the CFBundleURLTypes entry
 * declares the phi scheme.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const builder = JSON.parse(
  readFileSync(path.join(here, '..', 'electron-builder.json'), 'utf8'),
) as {
  appId: string;
  directories: { output: string };
  mac?: {
    extendInfo?: {
      CFBundleURLTypes?: Array<{
        CFBundleURLName?: string;
        CFBundleURLSchemes?: string[];
      }>;
    };
  };
};

describe('electron-builder.json (macOS protocol bundle config)', () => {
  it('declares a CFBundleURLTypes entry whose schemes include phi under mac.extendInfo', () => {
    const types = builder.mac?.extendInfo?.CFBundleURLTypes;
    expect(types).toBeDefined();
    expect(Array.isArray(types)).toBe(true);
    expect(types?.some((t) => t.CFBundleURLSchemes?.includes('phi'))).toBe(
      true,
    );
  });

  it('keeps the existing packaging fields intact', () => {
    expect(builder.appId).toBe('dev.phi.desktop');
    expect(builder.directories.output).toBe('out');
  });
});
