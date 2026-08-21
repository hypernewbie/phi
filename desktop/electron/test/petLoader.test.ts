// @vitest-environment node
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverPetRoot, type PetAppLike } from '../src/petLoader.js';

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
  getPath: () => '/tmp/phi-user-data',
  getVersion: () => '1.2.3',
  ...overrides,
});
const markPet = (root: string): void => {
  mkdirSync(path.join(root, 'dist'), { recursive: true });
  writeFileSync(path.join(root, 'dist', 'pet-main.js'), '');
};

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('discoverPetRoot', () => {
  it('returns the current-version userData pet when present', () => {
    const userData = tempDir();
    markPet(path.join(userData, 'pet', '1.2.3'));
    expect(
      discoverPetRoot(
        app({ getPath: () => userData }),
        false,
        undefined,
        () => true,
      ),
    ).toBe(path.join(userData, 'pet', '1.2.3'));
  });

  it('rejects a present packaged candidate when its signed root is invalid', () => {
    const userData = tempDir();
    markPet(path.join(userData, 'pet', '1.2.3'));
    expect(discoverPetRoot(app({ getPath: () => userData }), false)).toBeNull();
  });

  it('returns null when no packaged candidate exists', () => {
    const userData = tempDir();
    expect(discoverPetRoot(app({ getPath: () => userData }), false)).toBeNull();
  });

  it('keeps dev discovery filesystem-independent and smoke null', () => {
    const pathExists = vi.fn(() => true);
    expect(discoverPetRoot(app({ isPackaged: false }), false, pathExists)).toBe(
      path.resolve(import.meta.dirname, '../../pet'),
    );
    expect(pathExists).toHaveBeenCalledWith(
      path.join(
        path.resolve(import.meta.dirname, '../../pet'),
        'dist',
        'pet-main.js',
      ),
    );
    pathExists.mockClear();
    expect(
      discoverPetRoot(app({ isPackaged: false }), true, pathExists),
    ).toBeNull();
    expect(pathExists).not.toHaveBeenCalled();
  });
});
