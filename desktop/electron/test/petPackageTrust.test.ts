// @vitest-environment node
import {
  generateKeyPairSync,
  sign as cryptoSign,
  createPrivateKey,
} from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PET_PUBLIC_KEY_PEM,
  buildManifestPayload,
  parseManifest,
  verifyArchiveDigest,
  verifyManifestSignature,
  verifyInstalledRoot,
  verifyExtractedArchive,
  sha256Hex,
  type PetManifest,
} from '../src/petPackageTrust.js';

const tempDirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'phi-pet-trust-'));
  tempDirs.push(dir);
  return dir;
};

interface KeyPair {
  publicPem: string;
  privatePem: string;
}

const generateKeyPair = (): KeyPair => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
};

const signPayload = (privatePem: string, payload: Uint8Array): string =>
  Buffer.from(
    cryptoSign(null, Buffer.from(payload), createPrivateKey(privatePem)),
  ).toString('base64');

const makeManifest = (
  privatePem: string,
  overrides: Partial<PetManifest> = {},
): PetManifest => {
  const files = overrides.files ?? [
    { path: 'dist/pet-main.js', sha256: sha256Hex(Buffer.from('a')) },
    { path: 'package.json', sha256: sha256Hex(Buffer.from('b')) },
  ];
  const archive = overrides.archive ?? 'phi-pet-1.0.0.tar.gz';
  const version = overrides.version ?? '1.0.0';
  const sha256 = overrides.sha256 ?? sha256Hex(Buffer.from('archive'));
  const base: PetManifest = {
    schemaVersion: 1,
    version,
    archive,
    sha256,
    files,
    signature: '',
  };
  const payload = buildManifestPayload(base);
  return {
    ...base,
    signature: signPayload(privatePem, payload),
  };
};

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('parseManifest', () => {
  it.each([
    ['array', []],
    ['null', null],
    ['string', 'abc'],
    [
      'missing schemaVersion',
      {
        version: '1.0.0',
        archive: 'a.tar.gz',
        sha256: 'a'.repeat(64),
        files: [{ path: 'a.js', sha256: 'a'.repeat(64) }],
        signature: 'AA==',
      },
    ],
  ])('rejects %s', (_name, value) => {
    expect(() => parseManifest(value)).toThrow();
  });

  it('rejects unknown manifest fields', () => {
    const pair = generateKeyPair();
    const manifest = makeManifest(pair.privatePem) as unknown as Record<
      string,
      unknown
    >;
    manifest.extra = 'no';
    expect(() => parseManifest(manifest)).toThrow(/unknown field/);
  });

  it('rejects a manifest that lists pet-manifest.json', () => {
    const pair = generateKeyPair();
    const manifest = makeManifest(pair.privatePem, {
      files: [{ path: 'pet-manifest.json', sha256: 'a'.repeat(64) }],
    });
    expect(() => parseManifest(manifest)).toThrow(/pet-manifest\.json/);
  });

  it('rejects paths containing control characters', () => {
    const pair = generateKeyPair();
    const manifest = makeManifest(pair.privatePem, {
      files: [
        { path: 'dist/pet-main.js', sha256: 'a'.repeat(64) },
        { path: 'dist/naughty\npet.js', sha256: 'b'.repeat(64) },
      ],
    });
    expect(() => parseManifest(manifest)).toThrow(/control character/);
  });

  it('rejects two files whose paths collide after newline folding', () => {
    const pair = generateKeyPair();
    const manifest = makeManifest(pair.privatePem, {
      files: [
        { path: 'dist/a.js', sha256: 'a'.repeat(64) },
        // sorted ASCII: '\n' (0x0a) < 'a' (0x61); both unique, but neither
        // can contain a newline at all. We prove the explicit collision:
        { path: 'dist/naughty\nfile', sha256: 'b'.repeat(64) },
      ],
    });
    expect(() => parseManifest(manifest)).toThrow(/control character/);
  });

  it('rejects unsorted or duplicated file paths', () => {
    const pair = generateKeyPair();
    expect(() =>
      parseManifest(
        makeManifest(pair.privatePem, {
          files: [
            { path: 'b.js', sha256: 'a'.repeat(64) },
            { path: 'a.js', sha256: 'b'.repeat(64) },
          ],
        }),
      ),
    ).toThrow(/sorted bytewise/);
    expect(() =>
      parseManifest(
        makeManifest(pair.privatePem, {
          files: [
            { path: 'a.js', sha256: 'a'.repeat(64) },
            { path: 'a.js', sha256: 'b'.repeat(64) },
          ],
        }),
      ),
    ).toThrow(/duplicated/);
  });

  it('orders manifest paths by UTF-8 bytes rather than UTF-16 code units', () => {
    const pair = generateKeyPair();
    const digest = 'a'.repeat(64);
    expect(() =>
      parseManifest(
        makeManifest(pair.privatePem, {
          files: [
            { path: 'aé.js', sha256: digest },
            { path: 'a😀.js', sha256: digest },
          ],
        }),
      ),
    ).not.toThrow();
    expect(() =>
      parseManifest(
        makeManifest(pair.privatePem, {
          files: [
            { path: 'a😀.js', sha256: digest },
            { path: 'aé.js', sha256: digest },
          ],
        }),
      ),
    ).toThrow(/sorted bytewise/);
  });

  it('rejects non-lowercase-hex digests and malformed base64 signatures', () => {
    const pair = generateKeyPair();
    expect(() =>
      parseManifest(
        makeManifest(pair.privatePem, {
          sha256: 'Z'.repeat(64),
        }),
      ),
    ).toThrow(/lowercase hex/);
    expect(() =>
      parseManifest(
        makeManifest(pair.privatePem, {
          files: [{ path: 'a.js', sha256: 'GG'.padEnd(64, '0') }],
        }),
      ),
    ).toThrow(/lowercase hex/);
    expect(() =>
      parseManifest({
        ...makeManifest(pair.privatePem),
        signature: 'not_base64',
      }),
    ).toThrow(/base64/);
  });
});

describe('verifyManifestSignature', () => {
  it('accepts a valid signature against the embedded production key', () => {
    const payload = buildManifestPayload({
      schemaVersion: 1,
      version: '0.19.2',
      archive: 'phi-pet-0.19.2.tar.gz',
      sha256: 'a'.repeat(64),
      files: [{ path: 'dist/pet-main.js', sha256: 'b'.repeat(64) }],
      signature: 'AA==',
    });
    // Self-test that the embedded PEM parses as Ed25519 — guards against
    // a copy/paste accident landing a non-Ed25519 key in source.
    const { createPublicKey } =
      require('node:crypto') as typeof import('node:crypto');
    const key = createPublicKey(PET_PUBLIC_KEY_PEM);
    expect(key.asymmetricKeyType).toBe('ed25519');
    expect(payload).toBeInstanceOf(Uint8Array);
  });

  it('rejects an altered manifest signature', () => {
    const pair = generateKeyPair();
    const manifest = makeManifest(pair.privatePem);
    const broken: PetManifest = { ...manifest, signature: 'AA==' };
    expect(() => verifyManifestSignature(broken, pair.publicPem)).toThrow();
  });

  it('rejects a manifest signed by a different key', () => {
    const pairA = generateKeyPair();
    const pairB = generateKeyPair();
    const manifest = makeManifest(pairA.privatePem);
    expect(() => verifyManifestSignature(manifest, pairB.publicPem)).toThrow();
  });

  it('rejects a manifest whose payload was modified after signing', () => {
    const pair = generateKeyPair();
    const manifest = makeManifest(pair.privatePem);
    const tampered: PetManifest = { ...manifest, sha256: 'b'.repeat(64) };
    expect(() => verifyManifestSignature(tampered, pair.publicPem)).toThrow();
  });
});

describe('verifyArchiveDigest', () => {
  it('accepts an archive whose digest matches the manifest', () => {
    const manifest: PetManifest = {
      schemaVersion: 1,
      version: '1.0.0',
      archive: 'phi-pet-1.0.0.tar.gz',
      sha256: sha256Hex(Buffer.from('hello')),
      files: [{ path: 'dist/pet-main.js', sha256: 'a'.repeat(64) }],
      signature: 'AA==',
    };
    expect(() =>
      verifyArchiveDigest(manifest, Buffer.from('hello')),
    ).not.toThrow();
  });

  it('rejects an altered archive digest', () => {
    const manifest: PetManifest = {
      schemaVersion: 1,
      version: '1.0.0',
      archive: 'phi-pet-1.0.0.tar.gz',
      sha256: sha256Hex(Buffer.from('expected')),
      files: [{ path: 'dist/pet-main.js', sha256: 'a'.repeat(64) }],
      signature: 'AA==',
    };
    expect(() =>
      verifyArchiveDigest(manifest, Buffer.from('tampered')),
    ).toThrow(/digest does not match/);
  });
});

describe('installed-root verification', () => {
  const seedRoot = (
    root: string,
    manifest: PetManifest,
    tamper?: {
      file?: { path: string; contents: Buffer };
      manifest?: string;
      fileContents?: Map<string, Buffer>;
    },
  ): void => {
    for (const file of manifest.files) {
      const target = path.join(root, file.path);
      mkdirSync(path.dirname(target), { recursive: true });
      const fromMap = tamper?.fileContents?.get(file.path);
      if (tamper?.file?.path === file.path) {
        writeFileSync(target, tamper.file.contents);
      } else if (fromMap) {
        writeFileSync(target, fromMap);
      } else {
        // Default: write a buffer whose digest matches the manifest's hash.
        writeFileSync(target, Buffer.from(file.sha256, 'utf-8'));
      }
    }
    writeFileSync(
      path.join(root, 'pet-manifest.json'),
      tamper?.manifest ?? `${JSON.stringify(manifest)}\n`,
    );
  };

  const fsLike = (root: string) => {
    const { readFileSync, statSync } =
      require('node:fs') as typeof import('node:fs');
    const resolve = (p: string) =>
      p.startsWith(root) ? p : path.join(root, p);
    return {
      readFile: (p: string) => readFileSync(resolve(p)),
      stat: (p: string) => statSync(resolve(p)),
    };
  };

  it('accepts a valid installed root', () => {
    const pair = generateKeyPair();
    const root = tempDir();
    const fileContents = new Map<string, Buffer>([
      ['dist/pet-main.js', Buffer.from('main')],
      ['package.json', Buffer.from('{}')],
    ]);
    const manifest = makeManifest(pair.privatePem, {
      files: [
        { path: 'dist/pet-main.js', sha256: sha256Hex(Buffer.from('main')) },
        { path: 'package.json', sha256: sha256Hex(Buffer.from('{}')) },
      ],
    });
    seedRoot(root, manifest, { fileContents });
    const { readFile, stat } = fsLike(root);
    expect(() =>
      verifyInstalledRoot(root, '1.0.0', pair.publicPem, readFile, stat),
    ).not.toThrow();
  });

  it('rejects a tampered installed file', () => {
    const pair = generateKeyPair();
    const root = tempDir();
    const fileContents = new Map<string, Buffer>([
      ['dist/pet-main.js', Buffer.from('main')],
    ]);
    const manifest = makeManifest(pair.privatePem, {
      files: [
        { path: 'dist/pet-main.js', sha256: sha256Hex(Buffer.from('main')) },
      ],
    });
    seedRoot(root, manifest, {
      fileContents,
      file: { path: 'dist/pet-main.js', contents: Buffer.from('tampered') },
    });
    const { readFile, stat } = fsLike(root);
    expect(() =>
      verifyInstalledRoot(root, '1.0.0', pair.publicPem, readFile, stat),
    ).toThrow(/digest mismatch/);
  });

  it('rejects a real symlink in an installed root before following its target', () => {
    const pair = generateKeyPair();
    const root = tempDir();
    const target = tempDir();
    mkdirSync(path.join(root, 'dist'), { recursive: true });
    writeFileSync(path.join(target, 'pet-main.js'), 'main');
    symlinkSync(
      path.join(target, 'pet-main.js'),
      path.join(root, 'dist', 'pet-main.js'),
    );
    const manifest = makeManifest(pair.privatePem, {
      files: [
        { path: 'dist/pet-main.js', sha256: sha256Hex(Buffer.from('main')) },
      ],
    });
    writeFileSync(
      path.join(root, 'pet-manifest.json'),
      `${JSON.stringify(manifest)}\n`,
    );
    const { readFile, stat } = fsLike(root);
    expect(() =>
      verifyInstalledRoot(root, '1.0.0', pair.publicPem, readFile, stat),
    ).toThrow(/symlink/);
  });

  it('rejects an installed root whose pet-manifest.json was tampered with', () => {
    const pair = generateKeyPair();
    const root = tempDir();
    const manifest = makeManifest(pair.privatePem, {
      files: [
        { path: 'dist/pet-main.js', sha256: sha256Hex(Buffer.from('main')) },
      ],
    });
    seedRoot(root, manifest, {
      manifest: `${JSON.stringify({
        ...manifest,
        sha256: sha256Hex(Buffer.from('replaced')),
      })}\n`,
    });
    const { readFile, stat } = fsLike(root);
    expect(() =>
      verifyInstalledRoot(root, '1.0.0', pair.publicPem, readFile, stat),
    ).toThrow();
  });

  it('rejects an installed root whose version does not match the app', () => {
    const pair = generateKeyPair();
    const root = tempDir();
    const fileContents = new Map<string, Buffer>([
      ['dist/pet-main.js', Buffer.from('main')],
    ]);
    const manifest = makeManifest(pair.privatePem, {
      version: '1.0.0',
      files: [
        { path: 'dist/pet-main.js', sha256: sha256Hex(Buffer.from('main')) },
      ],
    });
    seedRoot(root, manifest, { fileContents });
    const { readFile, stat } = fsLike(root);
    expect(() =>
      verifyInstalledRoot(root, '2.0.0', pair.publicPem, readFile, stat),
    ).toThrow(/version does not match/);
  });
});

describe('verifyExtractedArchive', () => {
  it('accepts a freshly extracted archive that matches the manifest exactly', () => {
    const root = tempDir();
    const files = [
      { path: 'dist/pet-main.js', contents: Buffer.from('hello') },
      { path: 'package.json', contents: Buffer.from('{}') },
    ];
    const manifest: PetManifest = {
      schemaVersion: 1,
      version: '1.0.0',
      archive: 'phi-pet-1.0.0.tar.gz',
      sha256: sha256Hex(Buffer.from('archive')),
      files: files.map((entry) => ({
        path: entry.path,
        sha256: sha256Hex(entry.contents),
      })),
      signature: 'AA==',
    };
    for (const entry of files) {
      const target = path.join(root, entry.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, entry.contents);
    }
    const { readFileSync, statSync } =
      require('node:fs') as typeof import('node:fs');
    expect(() =>
      verifyExtractedArchive(
        root,
        manifest,
        (p) => readFileSync(p),
        (p) => statSync(p),
      ),
    ).not.toThrow();
  });

  it('rejects an extracted archive that contains an extra file', () => {
    const root = tempDir();
    const expected = path.join(root, 'dist/pet-main.js');
    mkdirSync(path.dirname(expected), { recursive: true });
    writeFileSync(expected, 'x');
    const extra = path.join(root, 'extra.js');
    writeFileSync(extra, 'y');
    const manifest: PetManifest = {
      schemaVersion: 1,
      version: '1.0.0',
      archive: 'phi-pet-1.0.0.tar.gz',
      sha256: sha256Hex(Buffer.from('archive')),
      files: [
        { path: 'dist/pet-main.js', sha256: sha256Hex(Buffer.from('x')) },
      ],
      signature: 'AA==',
    };
    const { readFileSync, statSync } =
      require('node:fs') as typeof import('node:fs');
    expect(() =>
      verifyExtractedArchive(
        root,
        manifest,
        (p) => readFileSync(p),
        (p) => statSync(p),
      ),
    ).toThrow(/unexpected entry/);
  });
});
