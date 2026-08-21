// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const scratch: string[] = [];
const fixture = (): string => { const dir = mkdtempSync(path.join(os.tmpdir(), 'phi-pet-package-')); scratch.push(dir); return dir; };
const verify = (out: string, expectMode: 'present' | 'absent') => spawnSync(process.execPath, ['scripts/verify-pet-package.mjs', '--expect', expectMode, '--out', out], { cwd: path.join(process.cwd()), encoding: 'utf8' });
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('verify-pet-package', () => {
  it('accepts one complete resource pet and rejects it in absent mode', () => {
    const out = fixture(); const pet = path.join(out, 'Phi.app', 'Contents', 'Resources', 'pet');
    mkdirSync(path.join(pet, 'dist'), { recursive: true }); mkdirSync(path.join(pet, 'assets'));
    for (const file of ['dist/pet-main.js', 'dist/pet-settings.html', 'dist/pet-settings-view.js', 'dist/pet-settings-preload.js', 'package.json', 'LICENSE-dsh-pet.txt']) writeFileSync(path.join(pet, file), 'x');
    expect(verify(out, 'present').status).toBe(0);
    expect(verify(out, 'absent').status).toBe(1);
  });

  it.each(['dist/pet-settings.html', 'dist/pet-settings-view.js', 'dist/pet-settings-preload.js'])('rejects a package missing only %s', (missing) => {
    const out = fixture(); const pet = path.join(out, 'Phi.app', 'Contents', 'Resources', 'pet');
    mkdirSync(path.join(pet, 'dist'), { recursive: true }); mkdirSync(path.join(pet, 'assets'));
    for (const file of ['dist/pet-main.js', 'dist/pet-settings.html', 'dist/pet-settings-view.js', 'dist/pet-settings-preload.js', 'package.json', 'LICENSE-dsh-pet.txt']) writeFileSync(path.join(pet, file), 'x');
    rmSync(path.join(pet, missing));
    expect(verify(out, 'present').status).toBe(1);
  });
  it('rejects a present package whose assets path is a file', () => {
    const out = fixture(); const pet = path.join(out, 'Phi.app', 'Contents', 'Resources', 'pet');
    mkdirSync(path.join(pet, 'dist'), { recursive: true });
    for (const file of ['dist/pet-main.js', 'assets', 'package.json', 'LICENSE-dsh-pet.txt']) writeFileSync(path.join(pet, file), 'x');
    expect(verify(out, 'present').status).toBe(1);
  });

  it('accepts output with no pet resource', () => {
    expect(verify(fixture(), 'absent').status).toBe(0);
  });
});
