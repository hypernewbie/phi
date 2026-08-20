/**
 * Window-icon resolver for the desktop host.
 *
 * The window icon follows the active server's highlight accent: the build
 * (scripts/gen-icon.mjs) renders one Φ icon per ACCENT_COLORS theme
 * (assets/icons/icon-<theme>.png, regenerated from web/app.js) plus a
 * manifest mapping accent hex -> file. This module lazily reads that
 * manifest once and resolves an observed accent hex to the matching icon
 * path, falling back to the white brand icon (assets/icon.png) when the
 * accent is unknown or the generated set is absent. Resolvers are
 * constructed with explicit paths so tests can point at a fixture
 * manifest.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface IconResolver {
  resolve(accentHex: string): string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = path.join(here, '..', 'assets', 'icons');
const MANIFEST_PATH = path.join(ICONS_DIR, 'manifest.json');
const FALLBACK_ICON = path.join(here, '..', 'assets', 'icon.png');

export function createIconResolver(
  manifestPath: string,
  fallbackIcon: string,
): IconResolver {
  let manifest: Record<string, string> | null = null;
  let read = false;
  return {
    resolve(accentHex: string): string {
      if (!accentHex) return fallbackIcon;
      if (!read) {
        read = true;
        try {
          manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<
            string,
            string
          >;
        } catch {
          manifest = null;
        }
      }
      const rel = manifest?.[accentHex];
      return rel ? path.join(path.dirname(manifestPath), rel) : fallbackIcon;
    },
  };
}

/** Default resolver for the packaged icon set (build-generated). */
export const iconResolver = createIconResolver(MANIFEST_PATH, FALLBACK_ICON);
