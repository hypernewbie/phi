#!/usr/bin/env node
/**
 * Sign a packaged pet archive with the Ed25519 key in
 * PHI_PET_ED25519_PRIVATE_KEY (PKCS#8 PEM, multiline). Writes the public
 * manifest next to the archive and exits non-zero on any failure. Never
 * prints private-key material.
 *
 * Usage: sign-pet-package.mjs --archive <phi-pet-V.tar.gz> --out <phi-pet-V.manifest.json>
 */
import { createPrivateKey, sign as cryptoSign, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import path from 'node:path';

const gunzipAsync = promisify(gunzip);

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  if (index < 0) return null;
  return args[index + 1] ?? null;
};

const archivePath = value('--archive');
const outPath = value('--out');
if (!archivePath || !outPath) {
  console.error(
    'usage: sign-pet-package.mjs --archive <phi-pet-V.tar.gz> --out <phi-pet-V.manifest.json>',
  );
  process.exit(2);
}

const archiveBase = path.basename(archivePath);
if (!/^phi-pet-[0-9A-Za-z][0-9A-Za-z._+-]*\.tar\.gz$/.test(archiveBase)) {
  console.error(
    `signer: archive name must match phi-pet-V.tar.gz: ${archiveBase}`,
  );
  process.exit(1);
}
const version = archiveBase.slice('phi-pet-'.length, -'.tar.gz'.length);

const secret = process.env.PHI_PET_ED25519_PRIVATE_KEY;
if (
  !secret?.includes('BEGIN PRIVATE KEY') ||
  !secret.includes('END PRIVATE KEY')
) {
  console.error(
    'signer: PHI_PET_ED25519_PRIVATE_KEY is missing or not a PKCS#8 PEM',
  );
  process.exit(1);
}

let key;
try {
  key = createPrivateKey(secret);
} catch (err) {
  console.error(`signer: failed to parse private key: ${String(err)}`);
  process.exit(1);
}
if (key.asymmetricKeyType !== 'ed25519') {
  console.error('signer: private key is not an Ed25519 key');
  process.exit(1);
}

let archiveBytes;
try {
  archiveBytes = readFileSync(archivePath);
} catch (err) {
  console.error(`signer: cannot read archive ${archivePath}: ${String(err)}`);
  process.exit(1);
}
if (archiveBytes.length === 0) {
  console.error('signer: archive is empty');
  process.exit(1);
}

let decompressed;
try {
  decompressed = await gunzipAsync(archiveBytes);
} catch (err) {
  console.error(`signer: archive is not a valid gzip stream: ${String(err)}`);
  process.exit(1);
}

const archiveDigest = createHash('sha256').update(archiveBytes).digest('hex');

const BLOCK = 512;
const fileEntries = [];
let offset = 0;
let ended = false;
const seen = new Set();
while (offset + BLOCK <= decompressed.length) {
  const header = decompressed.subarray(offset, offset + BLOCK);
  offset += BLOCK;
  if (header.every((byte) => byte === 0)) {
    ended = true;
    break;
  }
  const magic = new TextDecoder().decode(header.subarray(257, 263));
  if (magic !== 'ustar\0' && magic !== 'ustar ') {
    console.error('signer: archive is not a ustar archive');
    process.exit(1);
  }
  const nameRaw = header.subarray(0, 100);
  let nameEnd = nameRaw.indexOf(0);
  if (nameEnd < 0) nameEnd = 100;
  const name = new TextDecoder('utf-8', { fatal: true }).decode(
    nameRaw.subarray(0, nameEnd),
  );
  const prefixRaw = header.subarray(345, 500);
  let prefixEnd = prefixRaw.indexOf(0);
  if (prefixEnd < 0) prefixEnd = prefixRaw.length;
  const prefix = new TextDecoder('utf-8', { fatal: true }).decode(
    prefixRaw.subarray(0, prefixEnd),
  );
  const combined = prefix === '' ? name : `${prefix}/${name}`;
  if (combined === '' || combined.includes('\0') || combined.includes('\\')) {
    console.error(
      `signer: archive contains an invalid entry name: ${combined}`,
    );
    process.exit(1);
  }
  if (combined.startsWith('/') || /^[A-Za-z]:\//.test(combined)) {
    console.error(`signer: archive contains an absolute entry: ${combined}`);
    process.exit(1);
  }
  const segments = combined.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    console.error(`signer: archive contains a traversal entry: ${combined}`);
    process.exit(1);
  }
  const sizeText = new TextDecoder()
    .decode(header.subarray(124, 136))
    .replace(/\0/g, '')
    .trim();
  if (!/^[0-7]+$/.test(sizeText)) {
    console.error(`signer: archive contains an invalid file size: ${combined}`);
    process.exit(1);
  }
  const size = Number.parseInt(sizeText, 8);
  if (!Number.isSafeInteger(size)) {
    console.error(`signer: archive file is too large: ${combined}`);
    process.exit(1);
  }
  const type = header[156];
  if (type === 49 || type === 50) {
    console.error(`signer: archive contains a link entry: ${combined}`);
    process.exit(1);
  }
  if (type !== 0 && type !== 48 && type !== 53) {
    console.error(`signer: archive contains an unsupported entry: ${combined}`);
    process.exit(1);
  }
  const padded = Math.ceil(size / BLOCK) * BLOCK;
  if (offset + padded > decompressed.length) {
    console.error('signer: archive is truncated');
    process.exit(1);
  }
  const entryName = combined.endsWith('/') ? combined.slice(0, -1) : combined;
  if (type === 53 || entryName === '') {
    offset += padded;
    continue;
  }
  if (seen.has(entryName)) {
    console.error(`signer: archive contains a duplicate entry: ${entryName}`);
    process.exit(1);
  }
  if (entryName === 'pet-manifest.json') {
    console.error('signer: archive must not include pet-manifest.json');
    process.exit(1);
  }
  seen.add(entryName);
  const payload = decompressed.subarray(offset, offset + size);
  fileEntries.push({
    path: entryName,
    sha256: createHash('sha256').update(payload).digest('hex'),
  });
  offset += padded;
}
if (
  !ended ||
  (offset !== decompressed.length &&
    decompressed.subarray(offset).some((byte) => byte !== 0))
) {
  console.error('signer: archive is truncated');
  process.exit(1);
}

fileEntries.sort((a, b) =>
  Buffer.from(a.path, 'utf8').compare(Buffer.from(b.path, 'utf8')),
);

const canonical = [
  'phi-pet-manifest-v1',
  '1',
  version,
  archiveBase,
  archiveDigest,
  ...fileEntries.flatMap((entry) => [entry.path, entry.sha256]),
  '',
].join('\n');
const signature = cryptoSign(
  null,
  Buffer.from(canonical, 'utf-8'),
  key,
).toString('base64');

const manifest = {
  schemaVersion: 1,
  version,
  archive: archiveBase,
  sha256: archiveDigest,
  files: fileEntries,
  signature,
};
try {
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
} catch (err) {
  console.error(`signer: cannot write manifest ${outPath}: ${String(err)}`);
  process.exit(1);
}
console.log(`pet manifest written: ${outPath} (${fileEntries.length} files)`);
