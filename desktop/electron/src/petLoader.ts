/**
 * Pet package loader seam — discovers the optional desktop/pet package
 * and exposes the structural types the shell uses. Pure TypeScript (no
 * Electron import): the shell passes the real `app` in, mirroring the
 * tray.ts DI convention (Electron surfaces only inside functions).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyInstalledRoot } from './petPackageTrust.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The built pet package entry (relative to the pet package root). */
const PET_MAIN_ENTRY = path.join('dist', 'pet-main.js');

/** The minimal Electron surface discoverPetRoot reads. */
export interface PetAppLike {
  isPackaged: boolean;
  getPath(name: string): string;
  getVersion(): string;
}

/** Injectable filesystem seam for discovery tests. */
export type PetPathExists = (path: string) => boolean;
export type PetRootValidator = (root: string, version: string) => boolean;

const validateInstalledRoot: PetRootValidator = (root, version) => {
  try {
    verifyInstalledRoot(root, version, undefined, readFileSync, statSync);
    return true;
  } catch {
    return false;
  }
};

/** Result returned by a controller-backed zoom request. */
export type ZoomResult = { percent: number; accepted: boolean };

/** Zoom configuration passed to the renderer through the pet factory. */
export type PetZoomConfig = {
  minPercent: number;
  maxPercent: number;
  defaultPercent: number;
  stepPercent: number;
  baseVisualWidth: number;
};

/** The pet window surface the dynamically-imported factory returns. */
export interface PetHandle {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  setZoomPercent(percent: number): void;
  setIdleDwellSeconds?(dwellSeconds: number): void;
  openSettings?(): void;
  onRunningChanged(listener: (running: boolean) => void): () => void;
}

/** The deps the pet factory receives (discovered root + logger). */
export interface PetDeps {
  root: string;
  log: (msg: string) => void;
  zoom: PetZoomConfig;
  getZoomPercent(): number;
  requestZoomPercent(percent: number): ZoomResult;
  getIdleDwellSeconds(): number;
  requestIdleDwellSeconds(dwellSeconds: number): {
    dwellSeconds: number;
    accepted: boolean;
    error?: string;
  };
  getParentWindow(): unknown;
}

/**
 * Discovers the optional desktop/pet package root, or null when absent
 * or in smoke mode. Packaged: userData/pet/<version>, with its signed
 * manifest and files revalidated before returning. Dev: <dist>/../../pet =
 * desktop/pet, local-source-only.
 */
export function discoverPetRoot(
  app: PetAppLike,
  smoke: boolean,
  pathExists: PetPathExists = existsSync,
  validateRoot: PetRootValidator = validateInstalledRoot,
): string | null {
  if (smoke) return null;
  if (app.isPackaged) {
    const userDataCandidate = path.join(
      app.getPath('userData'),
      'pet',
      app.getVersion(),
    );
    if (
      pathExists(path.join(userDataCandidate, PET_MAIN_ENTRY)) &&
      validateRoot(userDataCandidate, app.getVersion())
    )
      return userDataCandidate;
    return null;
  }
  const devCandidate = path.join(here, '..', '..', 'pet');
  if (pathExists(path.join(devCandidate, PET_MAIN_ENTRY))) return devCandidate;
  return null;
}
