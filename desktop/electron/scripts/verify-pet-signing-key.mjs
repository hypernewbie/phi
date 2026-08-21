#!/usr/bin/env node
/**
 * One-shot signing-pair check for CI: derives the public key from the
 * PHI_PET_ED25519_PRIVATE_KEY secret and compares it with the SPKI PEM
 * pinned in src/petPackageTrust.ts. Exits non-zero on any mismatch.
 * Never prints private-key material.
 *
 * Usage: verify-pet-signing-key.mjs [trust-source.ts]
 *   (defaults to ../src/petPackageTrust.ts; the positional path exists
 *    so tests can check both the match and mismatch paths locally.)
 */
import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const trustSource =
  process.argv[2] ?? path.join(here, '..', 'src', 'petPackageTrust.ts');
const PEM_RE = /-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/;
const normalize = (pem) => pem.replace(/\s+/g, '');

const secret = process.env.PHI_PET_ED25519_PRIVATE_KEY;
if (
  !secret ||
  !secret.includes('BEGIN PRIVATE KEY') ||
  !secret.includes('END PRIVATE KEY')
) {
  console.error(
    'verify: PHI_PET_ED25519_PRIVATE_KEY is missing or not a PKCS#8 PEM',
  );
  process.exit(1);
}

let derived;
try {
  const key = createPublicKey(secret);
  if (key.asymmetricKeyType !== 'ed25519') {
    console.error('verify: PHI_PET_ED25519_PRIVATE_KEY is not an Ed25519 key');
    process.exit(1);
  }
  derived = key.export({ type: 'spki', format: 'pem' }).toString();
} catch (err) {
  console.error(`verify: failed to parse private key: ${String(err)}`);
  process.exit(1);
}

const source = readFileSync(trustSource, 'utf8');
const pinned = source.match(PEM_RE);
if (!pinned) {
  console.error(`verify: no public key PEM found in ${trustSource}`);
  process.exit(1);
}

if (normalize(derived) !== normalize(pinned[0])) {
  console.error(
    'verify: PHI_PET_ED25519_PRIVATE_KEY does NOT match the pinned PET_PUBLIC_KEY_PEM',
  );
  console.error(
    'verify: rotate the secret or update the pinned key so the pair matches,',
  );
  console.error(
    'verify: otherwise every pet package install will fail verification.',
  );
  process.exit(1);
}
console.log('verify: signing secret matches the pinned pet public key');
