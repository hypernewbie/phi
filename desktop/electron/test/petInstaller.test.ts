// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import {
 existsSync,
 mkdirSync,
 mkdtempSync,
 readFileSync,
 readdirSync,
 rmSync,
 statSync,
 writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installPet } from '../src/petInstaller.js';

const tempDirs: string[] = [];
const tempDir = (): string => {
 const dir = mkdtempSync(path.join(os.tmpdir(), 'phi-pet-installer-'));
 tempDirs.push(dir);
 return dir;
};
const required = (root: string, includeLicense = true): void => {
 for (const file of [
  'dist/pet-main.js',
  'dist/pet-settings.html',
  'dist/pet-settings-view.js',
  'dist/pet-settings-preload.js',
  'package.json',
 ]) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), file);
 }
 mkdirSync(path.join(root, 'assets', 'thumb'), { recursive: true });
 writeFileSync(path.join(root, 'assets', 'thumb', '点击回应 - 傲娇生气（侧身展示）.webm'), 'pet');
 if (includeLicense) writeFileSync(path.join(root, 'LICENSE-dsh-pet.txt'), 'license');
};
const archiveFor = (includeLicense = true): Uint8Array => {
 const source = tempDir();
 required(source, includeLicense);
 const tarPath = path.join(tempDir(), 'pet.tar');
 execFileSync('tar', ['-cf', tarPath, '--format=ustar', '-C', source, 'dist', 'assets', 'package.json', ...(includeLicense ? ['LICENSE-dsh-pet.txt'] : [])]);
 return gzipSync(readFileSync(tarPath));
};
const depsFor = (root: string, bytes: Uint8Array, version = '1.2.3') => ({
 userDataPath: root,
 appVersion: version,
 repo: 'example/repo',
 fetchBytes: vi.fn(async () => bytes),
 log: vi.fn(),
});
const block = (name: string, type = '0', size = 0): Uint8Array => {
 const header = Buffer.alloc(512);
 Buffer.from(name, 'utf8').copy(header, 0, 0, 100);
 Buffer.from('0000644\0').copy(header, 100);
 Buffer.from('0000000\0').copy(header, 108);
 Buffer.from('0000000\0').copy(header, 116);
 Buffer.from(size.toString(8).padStart(11, '0') + '\0').copy(header, 124);
 Buffer.from('00000000000\0').copy(header, 136);
 header[156] = type.charCodeAt(0);
 Buffer.from('ustar\0').copy(header, 257);
 return header;
};
const tar = (...entries: Uint8Array[]): Uint8Array => {
 const end = Buffer.alloc(1024);
 return Buffer.concat([...entries.map((entry) => Buffer.from(entry)), end]);
};
const fileEntry = (name: string, contents = ''): Uint8Array => {
 const data = Buffer.from(contents);
 const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
 data.copy(padded);
 return Buffer.concat([block(name, '0', data.length), padded]);
};
const completeArchive = (): Uint8Array => gzipSync(tar(
 fileEntry('dist/pet-main.js'),
 fileEntry('dist/pet-settings.html'),
 fileEntry('dist/pet-settings-view.js'),
 fileEntry('dist/pet-settings-preload.js'),
 fileEntry('assets/.keep'),
 fileEntry('package.json', '{}'),
 fileEntry('LICENSE-dsh-pet.txt'),
));

afterEach(() => {
 for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('installPet', () => {
 it('installs a system-tar ustar fixture including a CJK asset at the versioned root', async () => {
  const root = tempDir();
  const deps = depsFor(root, archiveFor());
  await expect(installPet(deps)).resolves.toEqual({ root: path.join(root, 'pet', '1.2.3') });
  expect(existsSync(path.join(root, 'pet', '1.2.3', 'dist', 'pet-main.js'))).toBe(true);
  expect(existsSync(path.join(root, 'pet', '1.2.3', 'assets', 'thumb', '点击回应 - 傲娇生气（侧身展示）.webm'))).toBe(true);
 });

 it.each([
  ['traversal', tar(fileEntry('../evil'))],
  ['absolute', tar(fileEntry('/evil'))],
  ['symlink', tar(block('dist/link', '2'))],
  ['duplicate', tar(fileEntry('dist/one'), fileEntry('dist/one'))],
  ['truncated', gzipSync(Buffer.concat([block('dist/one', '0', 10), Buffer.from('x')]))],
 ])('rejects malformed %s archive entries', async (_name, bytes) => {
  const root = tempDir();
  await expect(installPet(depsFor(root, gzipSync(bytes)))).rejects.toThrow();
  expect(readdirSync(path.join(root, 'pet'))).toEqual([]);
 });

 it('rejects an incomplete package and cleans staging', async () => {
  const root = tempDir();
  await expect(installPet(depsFor(root, archiveFor(false)))).rejects.toThrow('incomplete');
  expect(readdirSync(path.join(root, 'pet'))).toEqual([]);
 });

 it('short-circuits an idempotent install without fetching or rewriting', async () => {
  const root = tempDir();
  const first = depsFor(root, completeArchive());
  await installPet(first);
  const target = path.join(root, 'pet', '1.2.3', 'dist', 'pet-main.js');
  const before = statSync(target).mtimeMs;
  const second = depsFor(root, gzipSync(Buffer.from('not fetched')));
  await expect(installPet(second)).resolves.toEqual({ root: path.join(root, 'pet', '1.2.3') });
  expect(second.fetchBytes).not.toHaveBeenCalled();
  expect(statSync(target).mtimeMs).toBe(before);
 });

 it('prunes old versions and stale staging after a successful install', async () => {
  const root = tempDir();
  mkdirSync(path.join(root, 'pet', '0.9.0', 'dist'), { recursive: true });
  mkdirSync(path.join(root, 'pet', '.staging-old-123'), { recursive: true });
  await installPet(depsFor(root, completeArchive()));
  expect(existsSync(path.join(root, 'pet', '0.9.0'))).toBe(false);
  expect(existsSync(path.join(root, 'pet', '.staging-old-123'))).toBe(false);
 });

 it('rejects a bad version before fetching', async () => {
  const deps = depsFor(tempDir(), completeArchive(), '../bad');
  await expect(installPet(deps)).rejects.toThrow('invalid pet app version');
  expect(deps.fetchBytes).not.toHaveBeenCalled();
 });

 it('propagates fetch errors and cleans staging', async () => {
  const root = tempDir();
  const error = new Error('network unavailable');
  const deps = { ...depsFor(root, completeArchive()), fetchBytes: vi.fn(async () => { throw error; }) };
  await expect(installPet(deps)).rejects.toBe(error);
  expect(readdirSync(path.join(root, 'pet'))).toEqual([]);
 });
});
