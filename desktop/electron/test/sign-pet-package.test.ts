// @vitest-environment node
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installPet } from '../src/petInstaller.js';

const scratch: string[] = [];
const fixture = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'phi-pet-signer-'));
  scratch.push(dir);
  return dir;
};

const block = (name: string, type = '0', size = 0): Uint8Array => {
  const header = Buffer.alloc(512);
  Buffer.from(name, 'utf8').copy(header, 0, 0, 100);
  Buffer.from('0000644\0').copy(header, 100);
  Buffer.from('0000000\0').copy(header, 108);
  Buffer.from('0000000\0').copy(header, 116);
  Buffer.from(`${size.toString(8).padStart(11, '0')}\0`).copy(header, 124);
  Buffer.from('00000000000\0').copy(header, 136);
  header[156] = type.charCodeAt(0);
  Buffer.from('ustar\0').copy(header, 257);
  return header;
};

const fileEntry = (name: string, contents = ''): Uint8Array => {
  const data = Buffer.from(contents);
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([block(name, '0', data.length), padded]);
};

const buildArchive = (...entries: Uint8Array[]): Buffer =>
  gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));

afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('sign-pet-package.mjs', () => {
  const scriptPath = path.join(
    path.resolve(import.meta.dirname, '..', 'scripts', 'sign-pet-package.mjs'),
  );
  const runner = (cwd: string, env: NodeJS.ProcessEnv = {}) =>
    spawnSync(
      process.execPath,
      [
        scriptPath,
        '--archive',
        'phi-pet-1.2.3.tar.gz',
        '--out',
        'phi-pet-1.2.3.manifest.json',
      ],
      { cwd, env, encoding: 'utf8' },
    );

  it('rejects a missing private key without printing key material', () => {
    const dir = fixture();
    const archive = buildArchive(fileEntry('dist/pet-main.js', 'main'));
    writeFileSync(path.join(dir, 'phi-pet-1.2.3.tar.gz'), archive);
    const result = runner(dir, {});
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/PHI_PET_ED25519_PRIVATE_KEY/);
    expect(result.stdout + result.stderr).not.toMatch(/BEGIN PRIVATE KEY/);
  });

  it('rejects a private key that is not Ed25519', () => {
    const dir = fixture();
    const archive = buildArchive(fileEntry('dist/pet-main.js', 'main'));
    writeFileSync(path.join(dir, 'phi-pet-1.2.3.tar.gz'), archive);
    // A syntactically valid PKCS#8 PEM whose algorithm is not Ed25519
    // (RSA-OAEP). The signer must reject it without signing anything.
    const rsaPem = [
      '-----BEGIN PRIVATE KEY-----',
      'MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDh0bPIVjQ1',
      'jbEU0lzZvd0lCr0qXhRrwG8cmYL5kDQiS0ZL5Qyc7cVkj1zh0Z2HF/vlp5gG',
      'dEWV5mEa9G7cmA9zP9QQGZE0vqYJ7o6sg+5kM0FwJMzM6kYZ6yJ7o3YZ',
      '-----END PRIVATE KEY-----',
    ].join('\n');
    const result = runner(dir, { PHI_PET_ED25519_PRIVATE_KEY: rsaPem });
    expect(result.status).not.toBe(0);
    // The signer must exit non-zero without writing the manifest.
    expect(existsSync(path.join(dir, 'phi-pet-1.2.3.manifest.json'))).toBe(
      false,
    );
    expect(result.stdout + result.stderr).not.toMatch(/BEGIN PRIVATE KEY/);
  });

  it('signs a valid archive and produces a manifest whose signature verifies through the runtime verifier', async () => {
    const { generateKeyPairSync, createPrivateKey } = await import(
      'node:crypto'
    );
    const { verifyManifestSignature, parseManifest } = await import(
      '../src/petPackageTrust.js'
    );
    const dir = fixture();
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const privatePem = privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    }) as string;
    const publicPem = publicKey.export({
      type: 'spki',
      format: 'pem',
    }) as string;
    const entries = [
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
      'assets/.keep',
    ].map((name) => fileEntry(name, name === 'package.json' ? '{}' : name));
    const archive = buildArchive(...entries);
    writeFileSync(path.join(dir, 'phi-pet-1.2.3.tar.gz'), archive);
    const result = runner(dir, { PHI_PET_ED25519_PRIVATE_KEY: privatePem });
    expect(result.status).toBe(0);
    const manifestPath = path.join(dir, 'phi-pet-1.2.3.manifest.json');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = parseManifest(
      JSON.parse(readFileSync(manifestPath, 'utf-8')),
    );
    expect(() => verifyManifestSignature(manifest, publicPem)).not.toThrow();
    // Private key never touches the script output.
    expect(result.stdout + result.stderr).not.toMatch(/BEGIN PRIVATE KEY/);
    expect(result.stdout + result.stderr).not.toMatch(
      privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    );

    const installed = await installPet({
      userDataPath: dir,
      appVersion: '1.2.3',
      repo: 'hypernewbie/phi',
      fetchBytes: async (url) =>
        url.endsWith('.manifest.json')
          ? readFileSync(manifestPath)
          : readFileSync(path.join(dir, 'phi-pet-1.2.3.tar.gz')),
      log: () => {},
      publicKeyPem: publicPem,
    });
    expect(installed.root).toBe(path.join(dir, 'pet', '1.2.3'));
    expect(
      readFileSync(path.join(installed.root, 'dist', 'pet-main.js'), 'utf8'),
    ).toBe('dist/pet-main.js');
    void createPrivateKey;
  });

  it('rejects an archive containing a duplicate file member', () => {
    const dir = fixture();
    const { generateKeyPairSync } =
      require('node:crypto') as typeof import('node:crypto');
    const { privateKey } = generateKeyPairSync('ed25519');
    const privatePem = privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    }) as string;
    const archive = buildArchive(
      fileEntry('dist/pet-main.js', 'main'),
      fileEntry('dist/pet-main.js', 'duplicate'),
    );
    writeFileSync(path.join(dir, 'phi-pet-1.2.3.tar.gz'), archive);
    const result = runner(dir, { PHI_PET_ED25519_PRIVATE_KEY: privatePem });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/duplicate entry/);
  });

  it('rejects an archive containing a symlink tar member', () => {
    const dir = fixture();
    const { generateKeyPairSync } =
      require('node:crypto') as typeof import('node:crypto');
    const { privateKey } = generateKeyPairSync('ed25519');
    const privatePem = privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    }) as string;
    // type '2' = symbolic link in ustar
    const archive = buildArchive(
      block('evil-link', '2', 0),
      fileEntry('dist/pet-main.js', 'main'),
    );
    writeFileSync(path.join(dir, 'phi-pet-1.2.3.tar.gz'), archive);
    const result = runner(dir, { PHI_PET_ED25519_PRIVATE_KEY: privatePem });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/link entry/);
  });

  it('rejects an archive whose name lists pet-manifest.json', () => {
    const dir = fixture();
    const { generateKeyPairSync } =
      require('node:crypto') as typeof import('node:crypto');
    const { privateKey } = generateKeyPairSync('ed25519');
    const privatePem = privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    }) as string;
    const archive = buildArchive(fileEntry('pet-manifest.json', '{}'));
    writeFileSync(path.join(dir, 'phi-pet-1.2.3.tar.gz'), archive);
    const result = runner(dir, { PHI_PET_ED25519_PRIVATE_KEY: privatePem });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/pet-manifest\.json/);
  });
});
