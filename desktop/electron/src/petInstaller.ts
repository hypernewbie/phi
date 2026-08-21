/** Pure-Node installer for the optional desktop pet package. */
import { gunzipSync } from 'node:zlib';
import {
 existsSync,
 mkdirSync,
 readdirSync,
 renameSync,
 rmSync,
 statSync,
 writeFileSync,
} from 'node:fs';
import path from 'node:path';

/** Dependencies injected by the Electron host and tests. */
export interface PetInstallerDeps {
 userDataPath: string;
 appVersion: string;
 repo: string;
 fetchBytes(url: string): Promise<Uint8Array>;
 log: (msg: string) => void;
}

/** The installed pet root. */
export interface PetInstallResult {
 root: string;
}

const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;
const REQUIRED_FILES = [
 'dist/pet-main.js',
 'dist/pet-settings.html',
 'dist/pet-settings-view.js',
 'dist/pet-settings-preload.js',
 'package.json',
 'LICENSE-dsh-pet.txt',
] as const;
const PET_DIR = 'pet';
const STAGING_PREFIX = '.staging-';
const BLOCK_SIZE = 512;

function completePetRoot(root: string): boolean {
 try {
  if (!REQUIRED_FILES.every((file) => statSync(path.join(root, file)).isFile())) return false;
  const assets = path.join(root, 'assets');
  return statSync(assets).isDirectory() && readdirSync(assets).length > 0;
 } catch {
  return false;
 }
}

function decodeField(bytes: Uint8Array): string {
 let end = bytes.indexOf(0);
 if (end < 0) end = bytes.length;
 for (let i = end + 1; i < bytes.length; i += 1) {
  if (bytes[i] !== 0) throw new Error('pet archive contains malformed NUL padding');
 }
 try {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
 } catch {
  throw new Error('pet archive contains invalid UTF-8');
 }
}

function parseSize(bytes: Uint8Array): number {
 const text = new TextDecoder().decode(bytes).replace(/\0/g, '').trim();
 if (text === '') return 0;
 if (!/^[0-7]+$/.test(text)) throw new Error('pet archive contains an invalid file size');
 const size = Number.parseInt(text, 8);
 if (!Number.isSafeInteger(size)) throw new Error('pet archive file is too large');
 return size;
}

function archiveName(header: Uint8Array): string {
 const name = decodeField(header.subarray(0, 100));
 const prefix = decodeField(header.subarray(345, 500));
 const combined = prefix === '' ? name : `${prefix}/${name}`;
 if (combined === '' || combined.includes('\\') || combined.includes('\0')) {
  throw new Error('pet archive contains an invalid entry name');
 }
 if (combined.startsWith('/') || /^[A-Za-z]:\//.test(combined)) {
  throw new Error(`pet archive contains an absolute entry: ${combined}`);
 }
 const segments = combined.split('/');
 if (segments.some((segment) => segment === '..')) {
  throw new Error(`pet archive contains a traversal entry: ${combined}`);
 }
 if (segments.some((segment) => segment === '')) {
  // A single trailing slash is the conventional directory spelling.
  if (segments.length === 0 || segments[segments.length - 1] !== '' || segments.slice(0, -1).some((segment) => segment === '')) {
   throw new Error(`pet archive contains an invalid entry: ${combined}`);
  }
 }
 return combined.endsWith('/') ? combined.slice(0, -1) : combined;
}

function parseArchive(bytes: Uint8Array, staging: string): void {
 let offset = 0;
 const seen = new Set<string>();
 let ended = false;
 while (offset + BLOCK_SIZE <= bytes.length) {
  const header = bytes.subarray(offset, offset + BLOCK_SIZE);
  offset += BLOCK_SIZE;
  if (header.every((byte) => byte === 0)) {
   if (offset + BLOCK_SIZE > bytes.length || !bytes.subarray(offset, offset + BLOCK_SIZE).every((byte) => byte === 0)) {
    throw new Error('pet archive is truncated');
   }
   ended = true;
   break;
  }
  const magic = new TextDecoder().decode(header.subarray(257, 263));
  if (magic !== 'ustar\0' && magic !== 'ustar ') throw new Error('pet archive is not a ustar archive');
  const name = archiveName(header);
  if (seen.has(name)) throw new Error(`pet archive contains a duplicate entry: ${name}`);
  seen.add(name);
  const size = parseSize(header.subarray(124, 136));
  const type = header[156];
  if (type === 49 || type === 50) throw new Error(`pet archive contains a link entry: ${name}`);
  if (type !== 0 && type !== 48 && type !== 53) throw new Error(`pet archive contains an unsupported entry: ${name}`);
  const payloadBlocks = Math.ceil(size / BLOCK_SIZE);
  if (offset + payloadBlocks * BLOCK_SIZE > bytes.length) throw new Error('pet archive is truncated');
  const target = path.join(staging, ...name.split('/'));
  if (type === 53) {
   if (size !== 0) throw new Error(`pet archive directory has contents: ${name}`);
   mkdirSync(target, { recursive: true });
  } else {
   mkdirSync(path.dirname(target), { recursive: true });
   writeFileSync(target, Buffer.from(bytes.subarray(offset, offset + size)));
  }
  offset += payloadBlocks * BLOCK_SIZE;
 }
 if (!ended || offset !== bytes.length && bytes.subarray(offset).some((byte) => byte !== 0)) {
  throw new Error('pet archive is truncated');
 }
}

function removeBestEffort(target: string, log: (msg: string) => void): void {
 try {
  rmSync(target, { recursive: true, force: true });
 } catch (err) {
  log(`pet installer: could not remove ${target}: ${String(err)}`);
 }
}

function prunePetSiblings(parent: string, version: string, log: (msg: string) => void): void {
 let entries: string[];
 try {
  entries = readdirSync(parent);
 } catch (err) {
  log(`pet installer: could not list ${parent}: ${String(err)}`);
  return;
 }
 for (const entry of entries) {
  if (entry === version) continue;
  removeBestEffort(path.join(parent, entry), log);
 }
}

/** Downloads, validates, extracts and atomically installs one versioned pet. */
export async function installPet(deps: PetInstallerDeps): Promise<PetInstallResult> {
 if (!VERSION_RE.test(deps.appVersion)) throw new Error('invalid pet app version');
 const petParent = path.join(deps.userDataPath, PET_DIR);
 const final = path.join(petParent, deps.appVersion);
 if (completePetRoot(final)) return { root: final };
 const staging = path.join(petParent, `${STAGING_PREFIX}${deps.appVersion}-${process.pid}-${Date.now()}`);
 mkdirSync(petParent, { recursive: true });
 mkdirSync(staging);
 try {
  const url = `https://${deps.repo}/releases/download/v${deps.appVersion}/phi-pet-${deps.appVersion}.tar.gz`;
  const archive = gunzipSync(await deps.fetchBytes(url));
  parseArchive(archive, staging);
  if (!completePetRoot(staging)) throw new Error('downloaded pet package is incomplete');
  if (existsSync(final)) rmSync(final, { recursive: true, force: true });
  renameSync(staging, final);
  prunePetSiblings(petParent, deps.appVersion, deps.log);
  return { root: final };
 } catch (err) {
  removeBestEffort(staging, deps.log);
  if (err instanceof Error) throw err;
  throw new Error(String(err));
 }
}

