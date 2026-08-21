// @vitest-environment node
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverPetRoot, type PetAppLike } from "../src/petLoader.js";

const tempDirs: string[] = [];
const tempDir = (): string => {
 const dir = path.join(
  os.tmpdir(),
  `phi-pet-loader-${process.pid}-${Date.now()}-${tempDirs.length}`,
 );
 mkdirSync(dir, { recursive: true });
 tempDirs.push(dir);
 return dir;
};
const app = (overrides: Partial<PetAppLike> = {}): PetAppLike => ({
 isPackaged: true,
 getPath: () => "/tmp/phi-user-data",
 getVersion: () => "1.2.3",
 ...overrides,
});
const markPet = (root: string): void => {
 mkdirSync(path.join(root, "dist"), { recursive: true });
 writeFileSync(path.join(root, "dist", "pet-main.js"), "");
};

afterEach(() => {
 for (const dir of tempDirs.splice(0))
  rmSync(dir, { recursive: true, force: true });
});

describe("discoverPetRoot", () => {
 it("prefers a complete current-version userData pet over resourcesPath", () => {
  const userData = tempDir();
  const resources = tempDir();
  markPet(path.join(userData, "pet", "1.2.3"));
  markPet(path.join(resources, "pet"));
  const prior = (process as { resourcesPath?: string }).resourcesPath;
  Object.defineProperty(process, "resourcesPath", {
   configurable: true,
   value: resources,
  });
  try {
   expect(discoverPetRoot(app({ getPath: () => userData }), false)).toBe(
    path.join(userData, "pet", "1.2.3"),
   );
  } finally {
   Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    value: prior,
   });
  }
 });

 it("falls through to resourcesPath when the current userData version is missing", () => {
  const userData = tempDir();
  const resources = tempDir();
  markPet(path.join(resources, "pet"));
  const prior = (process as { resourcesPath?: string }).resourcesPath;
  Object.defineProperty(process, "resourcesPath", {
   configurable: true,
   value: resources,
  });
  try {
   expect(discoverPetRoot(app({ getPath: () => userData }), false)).toBe(
    path.join(resources, "pet"),
   );
  } finally {
   Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    value: prior,
   });
  }
 });

 it("returns null when no packaged candidate exists", () => {
  const userData = tempDir();
  const prior = (process as { resourcesPath?: string }).resourcesPath;
  Object.defineProperty(process, "resourcesPath", {
   configurable: true,
   value: tempDir(),
  });
  try {
   expect(discoverPetRoot(app({ getPath: () => userData }), false)).toBeNull();
  } finally {
   Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    value: prior,
   });
  }
 });

 it("keeps dev discovery precedence and smoke null behavior", () => {
  expect(discoverPetRoot(app({ isPackaged: false }), false)).toBe(
   path.resolve(import.meta.dirname, "../../pet"),
  );
  expect(discoverPetRoot(app({ isPackaged: false }), true)).toBeNull();
 });
});
