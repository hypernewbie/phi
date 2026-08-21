/**
 * Authenticated pet package trust primitives.
 *
 * The desktop host imports a version-bound package from a GitHub Release
 * asset. A signed manifest binds the archive digest and the per-file
 * digests of every regular member; before any download is decompressed,
 * staged, or imported, the runtime verifier must confirm the Ed25519
 * signature with the public key embedded in this file. The same verifier
 * runs again against the on-disk installed root to catch tampering
 * between sessions.
 *
 * No production private-key material lives here. The signer script
 * reads `PHI_PET_ED25519_PRIVATE_KEY` from the environment; tests
 * generate ephemeral key pairs in memory.
 */
import {
  createHash,
  createPublicKey,
  verify as cryptoVerify,
} from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';

/** Public SPKI PEM embedded in the desktop source. */
export const PET_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAUgLVihGqQqVrV8V3SV1RVHDjjeMie8sGU785JQlGw+c=
-----END PUBLIC KEY-----
`;

/** Manifest schema version supported by this runtime. */
export const MANIFEST_SCHEMA_VERSION = 1;

/** Canonical payload header / version. */
export const MANIFEST_PAYLOAD_PREFIX = 'phi-pet-manifest-v1';

/** One manifest file entry. */
export interface PetManifestFile {
  readonly path: string;
  readonly sha256: string;
}

/** The signed manifest. */
export interface PetManifest {
  readonly schemaVersion: number;
  readonly version: string;
  readonly archive: string;
  readonly sha256: string;
  readonly files: readonly PetManifestFile[];
  readonly signature: string;
}

/** The constant-length lowercase-hex digest. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Manifest version characters. */
const MANIFEST_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;

const compareUtf8 = (a: string, b: string): number =>
  Buffer.from(a, 'utf8').compare(Buffer.from(b, 'utf8'));

/** True for CR, LF, NUL and every other ASCII control character. */
const isControlChar = (code: number): boolean =>
  (code >= 0 && code <= 0x1f) || code === 0x7f;

const INVALID_KEY_MATERIAL = new Error(
  'pet manifest public key is not a valid Ed25519 SPKI PEM',
);

const ensureNoControl = (value: string, field: string): void => {
  for (let i = 0; i < value.length; i += 1) {
    if (isControlChar(value.charCodeAt(i))) {
      throw new Error(`pet manifest ${field} contains a control character`);
    }
  }
};

/** Validates an unsigned manifest shape (used before signature check). */
export function parseManifest(value: unknown): PetManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('pet manifest must be a JSON object');
  const record = value as Record<string, unknown>;
  const expectedFields = [
    'schemaVersion',
    'version',
    'archive',
    'sha256',
    'files',
    'signature',
  ];
  for (const field of expectedFields) {
    if (!Object.hasOwn(record, field)) {
      throw new Error(`pet manifest is missing field: ${field}`);
    }
  }
  for (const key of Object.keys(record)) {
    if (!expectedFields.includes(key)) {
      throw new Error(`pet manifest contains an unknown field: ${key}`);
    }
  }
  const { schemaVersion, version, archive, sha256, files, signature } = record;
  if (
    !Number.isInteger(schemaVersion) ||
    schemaVersion !== MANIFEST_SCHEMA_VERSION
  ) {
    throw new Error('pet manifest schemaVersion is not supported');
  }
  if (typeof version !== 'string' || !MANIFEST_VERSION_RE.test(version)) {
    throw new Error('pet manifest version is invalid');
  }
  ensureNoControl(version, 'version');
  if (typeof archive !== 'string' || archive === '') {
    throw new Error('pet manifest archive is invalid');
  }
  ensureNoControl(archive, 'archive');
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
    throw new Error('pet manifest sha256 must be 64 lowercase hex characters');
  }
  if (!Array.isArray(files))
    throw new Error('pet manifest files must be an array');
  if (files.length === 0)
    throw new Error('pet manifest files must not be empty');
  const seen = new Set<string>();
  const parsedFiles: PetManifestFile[] = [];
  let previous = '';
  for (const entry of files) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('pet manifest file entry must be an object');
    const file = entry as Record<string, unknown>;
    const keys = Object.keys(file);
    if (keys.length !== 2 || !('path' in file) || !('sha256' in file)) {
      throw new Error('pet manifest file entry has unexpected fields');
    }
    const { path, sha256: fileHash } = file;
    if (typeof path !== 'string' || path === '') {
      throw new Error('pet manifest file path is invalid');
    }
    ensureNoControl(path, 'file path');
    if (path === 'pet-manifest.json') {
      throw new Error('pet manifest must not list pet-manifest.json');
    }
    if (typeof fileHash !== 'string' || !SHA256_HEX.test(fileHash)) {
      throw new Error(
        `pet manifest file ${path} sha256 must be 64 lowercase hex characters`,
      );
    }
    if (seen.has(path)) {
      throw new Error(`pet manifest file path is duplicated: ${path}`);
    }
    if (previous !== '' && compareUtf8(previous, path) >= 0) {
      throw new Error('pet manifest files must be sorted bytewise by path');
    }
    seen.add(path);
    previous = path;
    parsedFiles.push({ path, sha256: fileHash });
  }
  if (typeof signature !== 'string' || signature === '') {
    throw new Error('pet manifest signature is invalid');
  }
  // base64 length is 4n, padded with '='; Ed25519 signatures are 64 bytes
  // => 86 chars (88 - 2 '=='). Reject any other base64 length outright.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || signature.length % 4 !== 0) {
    throw new Error('pet manifest signature is not valid base64');
  }
  return {
    schemaVersion: schemaVersion as number,
    version,
    archive,
    sha256,
    files: parsedFiles,
    signature,
  };
}

/** Canonical UTF-8 payload covered by the Ed25519 signature. */
export function buildManifestPayload(manifest: PetManifest): Uint8Array {
  const parts: string[] = [MANIFEST_PAYLOAD_PREFIX, '1', manifest.version];
  parts.push(manifest.archive, manifest.sha256);
  for (const file of manifest.files) {
    parts.push(file.path, file.sha256);
  }
  const text = `${parts.join('\n')}\n`;
  return new TextEncoder().encode(text);
}

/** SHA-256 lowercase hex digest of an arbitrary byte sequence. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Verifies the archive bytes match the manifest digest. */
export function verifyArchiveDigest(
  manifest: PetManifest,
  archive: Uint8Array,
): void {
  const digest = sha256Hex(archive);
  if (digest !== manifest.sha256) {
    throw new Error('pet archive digest does not match signed manifest');
  }
}

/** Parses the supplied PEM into a usable public key object. */
function parsePublicKey(pem: string): ReturnType<typeof createPublicKey> {
  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey(pem);
  } catch {
    throw INVALID_KEY_MATERIAL;
  }
  if (key.asymmetricKeyType !== 'ed25519') throw INVALID_KEY_MATERIAL;
  return key;
}

function decodeSignature(signature: string): Buffer {
  const buffer = Buffer.from(signature, 'base64');
  if (buffer.length !== 64) {
    throw new Error('pet manifest signature is not a valid Ed25519 signature');
  }
  return buffer;
}

/** Verifies the Ed25519 signature over the canonical manifest payload. */
export function verifyManifestSignature(
  manifest: PetManifest,
  publicKeyPem: string = PET_PUBLIC_KEY_PEM,
): void {
  const key = parsePublicKey(publicKeyPem);
  const payload = buildManifestPayload(manifest);
  const signature = decodeSignature(manifest.signature);
  const ok = cryptoVerify(null, payload, key, signature);
  if (!ok) throw new Error('pet manifest signature verification failed');
}

/**
 * Validates the on-disk installed root: manifest signature, every file
 * digest, and the runtime-required file set.
 */
export function verifyInstalledRoot(
  root: string,
  expectedVersion: string,
  publicKeyPem: string = PET_PUBLIC_KEY_PEM,
  readFileSync: (path: string) => Uint8Array,
  statSync: (path: string) => {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  },
): PetManifest {
  const manifestPath = `${root}/pet-manifest.json`;
  let manifestBytes: Uint8Array;
  try {
    manifestBytes = readFileSync(manifestPath);
  } catch {
    throw new Error('pet installed root is missing pet-manifest.json');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes),
    );
  } catch {
    throw new Error('pet installed manifest is not valid UTF-8 JSON');
  }
  const manifest = parseManifest(parsed);
  if (manifest.version !== expectedVersion) {
    throw new Error('pet installed manifest version does not match app');
  }
  verifyManifestSignature(manifest, publicKeyPem);
  const expected = new Set<string>();
  for (const file of manifest.files) expected.add(file.path);
  const seen = new Set<string>();
  const listedPaths = collectRelativePaths(root, statSync, (sub) => {
    seen.add(sub);
    return sub === 'pet-manifest.json';
  });
  for (const path of listedPaths) {
    if (!expected.has(path)) {
      throw new Error(`pet installed root has unexpected entry: ${path}`);
    }
  }
  for (const path of expected) {
    if (!seen.has(path)) {
      throw new Error(`pet installed root is missing signed file: ${path}`);
    }
    const data = readFileSync(`${root}/${path}`);
    const digest = sha256Hex(data);
    if (digest !== manifest.files.find((file) => file.path === path)?.sha256) {
      throw new Error(`pet installed file digest mismatch: ${path}`);
    }
  }
  return manifest;
}

/**
 * Walks the staged root and returns the sorted POSIX relative paths of
 * every regular file (excluding `pet-manifest.json` which the installer
 * writes itself). Symlinks and non-regular entries cause a hard failure.
 */
function collectRelativePaths(
  root: string,
  statSync: (path: string) => {
    isFile(): boolean;
    isDirectory(): boolean;
  },
  shouldSkip: (relative: string) => boolean,
): string[] {
  const result: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const relativeBase = current === root ? '' : current.slice(root.length + 1);
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      const childRelative =
        relativeBase === '' ? entry.name : `${relativeBase}/${entry.name}`;
      // Dirent metadata is from lstat semantics; checking it before stat
      // prevents a symlink from being mistaken for its regular target.
      if (entry.isSymbolicLink()) {
        throw new Error(`pet installed root has a symlink: ${childRelative}`);
      }
      const stats = statSync(child);
      if (stats.isDirectory()) {
        stack.push(child);
        continue;
      }
      if (!stats.isFile()) {
        throw new Error(
          `pet installed root has a non-regular entry: ${childRelative}`,
        );
      }
      if (shouldSkip(childRelative)) continue;
      result.push(childRelative);
    }
  }
  result.sort();
  return result;
}

/**
 * Verifies a freshly-extracted archive against a signed manifest: every
 * manifest-listed file must exist with the matching digest, no extra or
 * symlinked files are tolerated, and `pet-manifest.json` (which the
 * installer writes itself) is excluded from the staged comparison.
 */
export function verifyExtractedArchive(
  root: string,
  manifest: PetManifest,
  readFileSync: (path: string) => Uint8Array,
  statSync: (path: string) => {
    isFile(): boolean;
    isDirectory(): boolean;
  },
): void {
  const expected = new Set<string>();
  for (const file of manifest.files) {
    if (file.path === 'pet-manifest.json') {
      throw new Error('signed manifest must not list pet-manifest.json');
    }
    expected.add(file.path);
  }
  const seen = new Set<string>();
  const listedPaths = collectRelativePaths(root, statSync, () => false);
  for (const path of listedPaths) {
    if (!expected.has(path)) {
      throw new Error(`staged pet archive has unexpected entry: ${path}`);
    }
    seen.add(path);
  }
  for (const path of expected) {
    if (!seen.has(path)) {
      throw new Error(`staged pet archive is missing signed file: ${path}`);
    }
    const data = readFileSync(`${root}/${path}`);
    const digest = sha256Hex(data);
    const file = manifest.files.find((f) => f.path === path);
    if (!file || file.sha256 !== digest) {
      throw new Error(`staged pet archive digest mismatch: ${path}`);
    }
  }
}
