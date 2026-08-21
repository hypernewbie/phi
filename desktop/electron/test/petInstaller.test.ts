// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
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
const depsFor = (root: string, bytes: Uint8Array, version = '1.2.3', repo = 'hypernewbie/phi') => ({
 userDataPath: root,
 appVersion: version,
 repo,
 fetchBytes: vi.fn(async () => bytes),
 log: vi.fn(),
});

/** Hand-built ustar blocks keep this suite portable and pin UTF-8 decoding. */
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
const tar = (...entries: Uint8Array[]): Uint8Array => Buffer.concat([
 ...entries.map((entry) => Buffer.from(entry)),
 Buffer.alloc(1024),
]);
const fileEntry = (name: string, contents = ''): Uint8Array => {
 const data = Buffer.from(contents);
 const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
 data.copy(padded);
 return Buffer.concat([block(name, '0', data.length), padded]);
};
const validArchive = (includeLicense = true): Uint8Array => gzipSync(tar(
 fileEntry('dist/pet-main.js'),
 fileEntry('dist/pet-settings.html'),
 fileEntry('dist/pet-settings-view.js'),
 fileEntry('dist/pet-settings-preload.js'),
 fileEntry('assets/thumb/点击回应 - 傲娇生气（侧身展示）.webm', 'pet'),
 fileEntry('package.json', '{}'),
 ...(includeLicense ? [fileEntry('LICENSE-dsh-pet.txt')] : []),
));

afterEach(() => {
 for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('installPet', () => {
 it('installs a hand-built ustar fixture including a CJK asset at the versioned root', async () => {
  const root = tempDir();
  const deps = depsFor(root, validArchive());
  await expect(installPet(deps)).resolves.toEqual({ root: path.join(root, 'pet', '1.2.3') });
  expect(deps.fetchBytes).toHaveBeenCalledWith(
   'https://github.com/hypernewbie/phi/releases/download/v1.2.3/phi-pet-1.2.3.tar.gz',
  );
  expect(existsSync(path.join(root, 'pet', '1.2.3', 'dist', 'pet-main.js'))).toBe(true);
  expect(existsSync(path.join(root, 'pet', '1.2.3', 'assets', 'thumb', '点击回应 - 傲娇生气（侧身展示）.webm'))).toBe(true);
 });

 it.each([
  ['traversal', tar(fileEntry('../evil'))],
  ['absolute', tar(fileEntry('/evil'))],
  ['dot-segment duplicate', tar(fileEntry('dist/./pet-main.js'), fileEntry('dist/pet-main.js'))],
  ['symlink', tar(block('dist/link', '2'))],
  ['duplicate', tar(fileEntry('dist/one'), fileEntry('dist/one'))],
  // Raw incomplete tar data: this test gzips exactly once below.
  ['truncated', Buffer.concat([block('dist/one', '0', 10), Buffer.from('x')])],
 ])('rejects malformed %s archive entries', async (_name, archive) => {
  const root = tempDir();
  await expect(installPet(depsFor(root, gzipSync(archive)))).rejects.toThrow();
  expect(readdirSync(path.join(root, 'pet'))).toEqual([]);
 });

 it('rejects an incomplete package and cleans staging', async () => {
  const root = tempDir();
  await expect(installPet(depsFor(root, validArchive(false)))).rejects.toThrow('incomplete');
  expect(readdirSync(path.join(root, 'pet'))).toEqual([]);
 });

 it('short-circuits an idempotent install without fetching or rewriting', async () => {
  const root = tempDir();
  const first = depsFor(root, validArchive());
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
  await installPet(depsFor(root, validArchive()));
  expect(existsSync(path.join(root, 'pet', '0.9.0'))).toBe(false);
  expect(existsSync(path.join(root, 'pet', '.staging-old-123'))).toBe(false);
 });

 it('rejects a bad version or repository before fetching', async () => {
  const badVersion = depsFor(tempDir(), validArchive(), '../bad');
  await expect(installPet(badVersion)).rejects.toThrow('invalid pet app version');
  expect(badVersion.fetchBytes).not.toHaveBeenCalled();
  const badRepo = depsFor(tempDir(), validArchive(), '1.2.3', 'hypernewbie/phi/releases');
  await expect(installPet(badRepo)).rejects.toThrow('invalid pet release repository');
  expect(badRepo.fetchBytes).not.toHaveBeenCalled();
 });

 it('propagates fetch errors and cleans staging', async () => {
  const root = tempDir();
  const error = new Error('network unavailable');
  const deps = { ...depsFor(root, validArchive()), fetchBytes: vi.fn(async () => { throw error; }) };
  await expect(installPet(deps)).rejects.toBe(error);
  expect(readdirSync(path.join(root, 'pet'))).toEqual([]);
 });
});
