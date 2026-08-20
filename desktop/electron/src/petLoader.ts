/**
 * Pet package loader seam — discovers the optional desktop/pet package
 * and exposes the structural types the shell uses. Pure TypeScript (no
 * Electron import): the shell passes the real `app` in, mirroring the
 * tray.ts DI convention (Electron surfaces only inside functions).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The pet package directory name under the packaged resourcesPath. */
const PACKAGED_PET_DIR = "pet";

/** The built pet package entry (relative to the pet package root). */
const PET_MAIN_ENTRY = path.join("dist", "pet-main.js");

/** The minimal Electron surface discoverPetRoot reads. */
export interface PetAppLike {
 isPackaged: boolean;
}

/** Result returned by a controller-backed scale request. */
export type ScaleResult = { tick: number; accepted: boolean };

/** Scale configuration passed to the renderer through the pet factory. */
export type PetScaleConfig = {
 minTick: number;
 maxTick: number;
 defaultTick: number;
 minFactor: number;
 stepFactor: number;
};

/** The pet window surface the dynamically-imported factory returns. */
export interface PetHandle {
 start(): void;
 stop(): void;
 isRunning(): boolean;
 setScaleTick(tick: number): void;
 resetPosition(): void;
 onRunningChanged(listener: (running: boolean) => void): () => void;
}

/** The deps the pet factory receives (discovered root + logger). */
export interface PetDeps {
 root: string;
 log: (msg: string) => void;
 scale: PetScaleConfig;
 getScaleTick(): number;
 requestScaleTick(tick: number): ScaleResult;
}

/**
 * Discovers the optional desktop/pet package root, or null when absent
 * or in smoke mode. Packaged: <resourcesPath>/pet. Dev:
 * <dist>/../../pet = desktop/pet. Presence is the flag: the directory
 * must contain dist/pet-main.js (the built entry).
 */
export function discoverPetRoot(
 app: PetAppLike,
 smoke: boolean,
): string | null {
 if (smoke) return null;
 const resourcesPath: string | undefined = (
  process as { resourcesPath?: string }
 ).resourcesPath;
 if (app.isPackaged && !resourcesPath) return null;
 const candidate = app.isPackaged
  ? path.join(resourcesPath as string, PACKAGED_PET_DIR)
  : path.join(here, "..", "..", "pet");
 if (existsSync(path.join(candidate, PET_MAIN_ENTRY))) return candidate;
 return null;
}
