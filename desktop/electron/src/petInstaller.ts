/** Pure-Node installer for the optional desktop pet package. */
import { createGunzip } from 'node:zlib';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  MANIFEST_SCHEMA_VERSION,
  PET_PUBLIC_KEY_PEM,
  parseManifest,
  verifyArchiveDigest,
  verifyExtractedArchive,
  verifyInstalledRoot,
  verifyManifestSignature,
} from './petPackageTrust.js';

/** Hard installer-side bounds (production callers may not override). */
export const PET_INSTALL_LIMITS = {
  manifestBytes: 64 * 1024,
  archiveBytes: 64 * 1024 * 1024,
  decompressedArchiveBytes: 128 * 1024 * 1024,
  archiveEntries: 256,
  singleFileBytes: 16 * 1024 * 1024,
  fetchTimeoutMs: 30_000,
} as const;

/** Dependencies injected by the Electron host and tests. */
export interface PetInstallerDeps {
  userDataPath: string;
  appVersion: string;
  repo: string;
  /** Fetch a single bounded payload; the installer rejects oversize results. */
  fetchBytes(url: string, maxBytes: number): Promise<Uint8Array>;
  log: (msg: string) => void;
  /** Optional injected public key for tests. Production uses the embedded PEM. */
  publicKeyPem?: string;
}

export interface PetInstallResult {
  root: string;
}

const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;
const VERSION_DIR_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z._+-]+)?$/;
const REPO_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REQUIRED_FILES = [
  'dist/pet-bridge.js',
  'dist/pet-main.js',
  'dist/pet-preload.js',
  'dist/pet-settings-preload.js',
  'dist/pet-settings-view.js',
  'dist/pet-view.js',
  'dist/pet-window.js',
  'dist/pet.html',
  'dist/pet-settings.html',
  'dist/pet-settings.css',
  'package.json',
  'LICENSE-dsh-pet.txt',
] as const;
const PET_DIR = 'pet';
const STAGING_PREFIX = '.staging-';

function decodeField(bytes: Uint8Array): string {
  let end = bytes.indexOf(0);
  if (end < 0) end = bytes.length;
  for (let i = end + 1; i < bytes.length; i += 1) {
    if (bytes[i] !== 0)
      throw new Error('pet archive contains malformed NUL padding');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(0, end),
    );
  } catch {
    throw new Error('pet archive contains invalid UTF-8');
  }
}

function parseSize(bytes: Uint8Array): number {
  const text = new TextDecoder().decode(bytes).replace(/\0/g, '').trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text))
    throw new Error('pet archive contains an invalid file size');
  const size = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(size))
    throw new Error('pet archive file is too large');
  if (size > PET_INSTALL_LIMITS.singleFileBytes)
    throw new Error('pet archive contains an oversized file entry');
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
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`pet archive contains a traversal entry: ${combined}`);
  }
  if (segments.some((segment) => segment === '')) {
    // A single trailing slash is the conventional directory spelling.
    if (
      segments.length === 0 ||
      segments[segments.length - 1] !== '' ||
      segments.slice(0, -1).some((segment) => segment === '')
    ) {
      throw new Error(`pet archive contains an invalid entry: ${combined}`);
    }
  }
  return combined.endsWith('/') ? combined.slice(0, -1) : combined;
}

async function parseArchive(bytes: Uint8Array, staging: string): Promise<void> {
  let offset = 0;
  const seen = new Set<string>();
  let ended = false;
  let entryCount = 0;
  let totalBytes = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      if (
        offset + 512 > bytes.length ||
        !bytes.subarray(offset, offset + 512).every((byte) => byte === 0)
      ) {
        throw new Error('pet archive is truncated');
      }
      ended = true;
      break;
    }
    entryCount += 1;
    if (entryCount > PET_INSTALL_LIMITS.archiveEntries) {
      throw new Error('pet archive exceeds entry-count limit');
    }
    const magic = new TextDecoder().decode(header.subarray(257, 263));
    if (magic !== 'ustar\0' && magic !== 'ustar ')
      throw new Error('pet archive is not a ustar archive');
    const name = archiveName(header);
    if (seen.has(name))
      throw new Error(`pet archive contains a duplicate entry: ${name}`);
    seen.add(name);
    const size = parseSize(header.subarray(124, 136));
    const type = header[156];
    if (type === 49 || type === 50)
      throw new Error(`pet archive contains a link entry: ${name}`);
    if (type !== 0 && type !== 48 && type !== 53)
      throw new Error(`pet archive contains an unsupported entry: ${name}`);
    const payloadBlocks = Math.ceil(size / 512);
    if (offset + payloadBlocks * 512 > bytes.length)
      throw new Error('pet archive is truncated');
    const target = path.join(staging, ...name.split('/'));
    if (type === 53) {
      if (size !== 0)
        throw new Error(`pet archive directory has contents: ${name}`);
      await mkdir(target, { recursive: true });
    } else {
      if (name === 'pet-manifest.json') {
        // The installer writes the canonical signed manifest itself; the
        // archive must not include one.
        offset += payloadBlocks * 512;
        continue;
      }
      totalBytes += size;
      if (totalBytes > PET_INSTALL_LIMITS.decompressedArchiveBytes) {
        throw new Error('pet archive exceeds cumulative extracted size');
      }
      await mkdir(path.dirname(target), { recursive: true });
      const payload = bytes.subarray(offset, offset + size);
      await writeFile(target, Buffer.from(payload));
    }
    offset += payloadBlocks * 512;
  }
  if (
    !ended ||
    (offset !== bytes.length &&
      bytes.subarray(offset).some((byte) => byte !== 0))
  ) {
    throw new Error('pet archive is truncated');
  }
}

async function removeBestEffort(
  target: string,
  log: (msg: string) => void,
): Promise<void> {
  try {
    await rm(target, { recursive: true, force: true });
  } catch (err) {
    log(`pet installer: could not remove ${target}: ${String(err)}`);
  }
}

async function prunePetSiblings(
  parent: string,
  version: string,
  log: (msg: string) => void,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(parent);
  } catch (err) {
    log(`pet installer: could not list ${parent}: ${String(err)}`);
    return;
  }
  for (const entry of entries) {
    if (entry === version) continue;
    if (!VERSION_DIR_RE.test(entry) && !entry.startsWith(STAGING_PREFIX)) {
      // Preserve unknown directories/files (the user may store unrelated
      // metadata here). Only real version directories and installer
      // staging directories are removed.
      continue;
    }
    await removeBestEffort(path.join(parent, entry), log);
  }
}

async function completePetRootAsync(root: string): Promise<boolean> {
  try {
    for (const file of REQUIRED_FILES) {
      const stats = await stat(path.join(root, file));
      if (!stats.isFile()) return false;
    }
    const assets = path.join(root, 'assets');
    const assetsStats = await stat(assets);
    return assetsStats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Decompress a gzipped archive, respecting the configured byte limit.
 * Uses `zlib.maxOutputLength` so the stream self-aborts when output
 * exceeds the bound; the post-decompression length is also re-checked.
 */
function gunzipAsync(
  bytes: Uint8Array,
  opts: { maxOutputLength: number },
): Promise<Uint8Array> {
  const real = createGunzip();
  // node 22 supports maxOutputLength on Gunzip; cast through unknown to
  // keep @types/node@20.19.43 happy until the project upgrades.
  (real as unknown as { maxOutputLength: number }).maxOutputLength =
    opts.maxOutputLength;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;
    let rejected = false;
    real.on('data', (chunk: Buffer) => {
      totalLength += chunk.length;
      if (totalLength > opts.maxOutputLength) {
        rejected = true;
        real.destroy(new Error('pet archive exceeds decompressed size limit'));
        return;
      }
      chunks.push(chunk);
    });
    real.on('end', () => {
      if (rejected) return;
      const total = Buffer.concat(chunks);
      resolve(new Uint8Array(total.buffer, total.byteOffset, total.byteLength));
    });
    real.on('error', reject);
    real.write(Buffer.from(bytes));
    real.end();
  });
}

const isAllowedManifestPath = (path: string): boolean =>
  path.startsWith('dist/') ||
  path.startsWith('assets/') ||
  path === 'package.json' ||
  path === 'LICENSE-dsh-pet.txt';

/**
 * Downloads, validates, extracts and atomically installs one versioned
 * pet package. The signed manifest is verified before extraction; every
 * extracted file is hashed against the signed list; the exact signed
 * manifest persists alongside the installed root.
 */
export async function installPet(
  deps: PetInstallerDeps,
): Promise<PetInstallResult> {
  if (!VERSION_RE.test(deps.appVersion))
    throw new Error('invalid pet app version');
  if (!REPO_RE.test(deps.repo))
    throw new Error('invalid pet release repository');
  const publicKey = deps.publicKeyPem ?? PET_PUBLIC_KEY_PEM;
  const archiveName = `phi-pet-${deps.appVersion}.tar.gz`;
  const manifestName = `phi-pet-${deps.appVersion}.manifest.json`;
  const manifestUrl = `https://github.com/${deps.repo}/releases/download/v${deps.appVersion}/${manifestName}`;
  const archiveUrl = `https://github.com/${deps.repo}/releases/download/v${deps.appVersion}/${archiveName}`;
  const petParent = path.join(deps.userDataPath, PET_DIR);
  const final = path.join(petParent, deps.appVersion);
  if (
    existsSync(final) &&
    existsSync(path.join(final, 'pet-manifest.json')) &&
    (await completePetRootAsync(final))
  ) {
    try {
      verifyInstalledRoot(
        final,
        deps.appVersion,
        publicKey,
        (p) => readFileSync(p),
        (p) => statSync(p),
      );
      return { root: final };
    } catch {
      await removeBestEffort(final, deps.log);
    }
  }
  const staging = path.join(
    petParent,
    `${STAGING_PREFIX}${deps.appVersion}-${process.pid}-${Date.now()}`,
  );
  await mkdir(petParent, { recursive: true });
  try {
    const manifestBytes = await deps.fetchBytes(
      manifestUrl,
      PET_INSTALL_LIMITS.manifestBytes,
    );
    let manifestJson: unknown;
    try {
      manifestJson = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes),
      );
    } catch {
      throw new Error('pet manifest is not valid UTF-8 JSON');
    }
    const manifest = parseManifest(manifestJson);
    if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION)
      throw new Error('pet manifest schemaVersion is not supported');
    if (manifest.version !== deps.appVersion)
      throw new Error('pet manifest version does not match app version');
    if (manifest.archive !== archiveName)
      throw new Error('pet manifest archive name does not match expected');
    verifyManifestSignature(manifest, publicKey);
    for (const file of manifest.files) {
      if (!isAllowedManifestPath(file.path)) {
        throw new Error(`pet manifest file path is not allowed: ${file.path}`);
      }
    }

    const archive = await deps.fetchBytes(
      archiveUrl,
      PET_INSTALL_LIMITS.archiveBytes,
    );
    verifyArchiveDigest(manifest, archive);
    const decompressed = await gunzipAsync(archive, {
      maxOutputLength: PET_INSTALL_LIMITS.decompressedArchiveBytes,
    });
    if (decompressed.length > PET_INSTALL_LIMITS.decompressedArchiveBytes) {
      throw new Error('pet archive exceeds decompressed size limit');
    }
    await mkdir(staging, { recursive: true });
    await parseArchive(decompressed, staging);
    verifyExtractedArchive(
      staging,
      manifest,
      (p) => readFileSync(p),
      (p) => statSync(p),
    );
    await writeFile(
      path.join(staging, 'pet-manifest.json'),
      `${JSON.stringify(manifest)}\n`,
    );
    if (!(await completePetRootAsync(staging)))
      throw new Error('downloaded pet package is incomplete');
    if (existsSync(final)) await rm(final, { recursive: true, force: true });
    await rename(staging, final);
    await prunePetSiblings(petParent, deps.appVersion, deps.log);
    return { root: final };
  } catch (err) {
    await removeBestEffort(staging, deps.log);
    if (err instanceof Error) throw err;
    throw new Error(String(err));
  }
}
