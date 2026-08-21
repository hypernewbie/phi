// @vitest-environment node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  generateKeyPairSync,
  sign as cryptoSign,
  createPrivateKey,
} from 'node:crypto';
import { gzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installPet, PET_INSTALL_LIMITS } from '../src/petInstaller.js';
import {
  buildManifestPayload,
  sha256Hex,
  type PetManifest,
} from '../src/petPackageTrust.js';

const tempDirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'phi-pet-installer-'));
  tempDirs.push(dir);
  return dir;
};

const generateKeyPair = () => {
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

/** Hand-built ustar blocks keep this suite portable and pin UTF-8 decoding. */
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
const tar = (...entries: Uint8Array[]): Uint8Array =>
  Buffer.concat([...entries, Buffer.alloc(1024)]);
const fileEntry = (
  name: string,
  contents: Uint8Array | string = '',
): Uint8Array => {
  const data: Buffer = Buffer.isBuffer(contents)
    ? contents
    : Buffer.from(contents);
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([block(name, '0', data.length), padded]);
};

interface FixtureEntry {
  readonly name: string;
  readonly contents: Buffer;
}

const REQUIRED_DIST = [
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
];

const allRequired = (): FixtureEntry[] => [
  ...REQUIRED_DIST.map((p) => ({ name: p, contents: Buffer.from(p) })),
  { name: 'package.json', contents: Buffer.from('{}') },
  { name: 'LICENSE-dsh-pet.txt', contents: Buffer.from('license') },
  { name: 'assets/thumb/maid-static.png', contents: Buffer.from('static') },
  {
    name: 'assets/thumb/点击回应 - 傲娇生气（侧身展示）.webm',
    contents: Buffer.from('media'),
  },
];

const buildArchive = (entries: FixtureEntry[]): Buffer => {
  const tarEntries = entries.map((entry) =>
    fileEntry(entry.name, entry.contents),
  );
  const tarBytes = Buffer.concat([...tarEntries, Buffer.alloc(1024)]);
  return gzipSync(tarBytes);
};

interface SignedFixture {
  manifest: PetManifest;
  archive: Buffer;
  manifestBytes: Buffer;
  privatePem: string;
}

const signFixture = (
  version: string,
  entries: FixtureEntry[],
  archive: Buffer,
  privatePem: string,
): SignedFixture => {
  const sorted = [...entries].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const manifestFiles = sorted.map((entry) => ({
    path: entry.name,
    sha256: sha256Hex(entry.contents),
  }));
  // The signed archive digest covers the exact downloadable gzip bytes.
  const unsigned: PetManifest = {
    schemaVersion: 1,
    version,
    archive: `phi-pet-${version}.tar.gz`,
    sha256: sha256Hex(archive),
    files: manifestFiles,
    signature: 'pending',
  };
  const signature = signPayload(
    privatePem,
    buildManifestPayload({ ...unsigned, signature: '' }),
  );
  const manifest: PetManifest = { ...unsigned, signature };
  return {
    manifest,
    archive,
    manifestBytes: Buffer.from(`${JSON.stringify(manifest)}\n`),
    privatePem,
  };
};

interface DepsOptions {
  root: string;
  fixture: SignedFixture;
  version?: string;
  repo?: string;
  manifestBytes?: Buffer;
  archiveBytes?: Buffer;
}

const depsFor = ({
  root,
  fixture,
  version = '1.2.3',
  repo = 'hypernewbie/phi',
  manifestBytes,
  archiveBytes,
}: DepsOptions) => {
  const calls: Array<{ url: string; maxBytes: number }> = [];
  return {
    calls,
    deps: {
      userDataPath: root,
      appVersion: version,
      repo,
      fetchBytes: vi.fn(async (url: string, maxBytes: number) => {
        calls.push({ url, maxBytes });
        if (url.endsWith('manifest.json'))
          return manifestBytes ?? fixture.manifestBytes;
        return archiveBytes ?? fixture.archive;
      }),
      log: vi.fn(),
      publicKeyPem: undefined as string | undefined,
    },
  };
};

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('installPet', () => {
  it('installs a signed package at the versioned root', async () => {
    const pair = generateKeyPair();
    const archive = buildArchive(allRequired());
    const fixture = signFixture(
      '1.2.3',
      allRequired(),
      archive,
      pair.privatePem,
    );
    const root = tempDir();
    const { deps, calls } = depsFor({ root, fixture });
    deps.publicKeyPem = pair.publicPem;
    await expect(installPet(deps)).resolves.toEqual({
      root: path.join(root, 'pet', '1.2.3'),
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      url: 'https://github.com/hypernewbie/phi/releases/download/v1.2.3/phi-pet-1.2.3.manifest.json',
      maxBytes: PET_INSTALL_LIMITS.manifestBytes,
    });
    expect(calls[1]).toEqual({
      url: 'https://github.com/hypernewbie/phi/releases/download/v1.2.3/phi-pet-1.2.3.tar.gz',
      maxBytes: PET_INSTALL_LIMITS.archiveBytes,
    });
    expect(
      existsSync(path.join(root, 'pet', '1.2.3', 'dist', 'pet-main.js')),
    ).toBe(true);
    expect(
      existsSync(
        path.join(
          root,
          'pet',
          '1.2.3',
          'assets',
          'thumb',
          '点击回应 - 傲娇生气（侧身展示）.webm',
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(path.join(root, 'pet', '1.2.3', 'pet-manifest.json')),
    ).toBe(true);
  });

  it('rejects a tampered archive before any extraction', async () => {
    const pair = generateKeyPair();
    const archive = buildArchive(allRequired());
    const fixture = signFixture(
      '1.2.3',
      allRequired(),
      archive,
      pair.privatePem,
    );
    const root = tempDir();
    // Tamper with the gzip header so the stream is still decodable but
    // yields a different decompressed tar than the signed manifest.
    const tamperedArchive = Buffer.from(fixture.archive);
    tamperedArchive[0] ^= 0xff;
    const { deps } = depsFor({
      root,
      fixture,
      archiveBytes: tamperedArchive,
    });
    deps.publicKeyPem = pair.publicPem;
    // Either the gunzip layer or the archive-digest check may catch the
    // tamper first; both happen before any filesystem write.
    await expect(installPet(deps)).rejects.toThrow(
      /digest does not match|not a valid gzip|incorrect header check/,
    );
    expect(readdirSync(path.join(root, 'pet'))).toEqual([]);
  });

  it('rejects an archive digest that differs from the signed manifest', async () => {
    const pair = generateKeyPair();
    const archive = buildArchive(allRequired());
    const fixture = signFixture(
      '1.2.3',
      allRequired(),
      archive,
      pair.privatePem,
    );
    // Mutate the manifest's archive digest so signature still verifies but
    // the archive digest check fails.
    const brokenManifest: PetManifest = {
      ...fixture.manifest,
      sha256: sha256Hex(Buffer.from('replaced')),
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(brokenManifest)}\n`);
    const root = tempDir();
    const { deps } = depsFor({
      root,
      fixture,
      manifestBytes,
    });
    deps.publicKeyPem = pair.publicPem;
    await expect(installPet(deps)).rejects.toThrow();
    expect(readdirSync(path.join(root, 'pet'))).toEqual([]);
  });

  it('rejects a manifest signed by a different key before extraction', async () => {
    const pair = generateKeyPair();
    const archive = buildArchive(allRequired());
    const fixture = signFixture(
      '1.2.3',
      allRequired(),
      archive,
      pair.privatePem,
    );
    const root = tempDir();
    const { deps } = depsFor({ root, fixture });
    deps.publicKeyPem = generateKeyPair().publicPem;
    await expect(installPet(deps)).rejects.toThrow(/signature/);
    expect(readdirSync(path.join(root, 'pet'))).toEqual([]);
  });

  it('rejects a malformed base64 signature before extraction', async () => {
    const pair = generateKeyPair();
    const archive = buildArchive(allRequired());
    const fixture = signFixture(
      '1.2.3',
      allRequired(),
      archive,
      pair.privatePem,
    );
    const broken: PetManifest = {
      ...fixture.manifest,
      signature: 'not_base64!!',
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(broken)}\n`);
    const root = tempDir();
    const { deps } = depsFor({
      root,
      fixture,
      manifestBytes,
    });
    deps.publicKeyPem = pair.publicPem;
    await expect(installPet(deps)).rejects.toThrow(/base64/);
    expect(readdirSync(path.join(root, 'pet'))).toEqual([]);
  });

  it('rejects a manifest with an unknown field', async () => {
    const pair = generateKeyPair();
    const archive = buildArchive(allRequired());
    const fixture = signFixture(
      '1.2.3',
      allRequired(),
      archive,
      pair.privatePem,
    );
    const broken = { ...fixture.manifest, extra: 'no' };
    const manifestBytes = Buffer.from(`${JSON.stringify(broken)}\n`);
    const root = tempDir();
    const { deps } = depsFor({
      root,
      fixture,
      manifestBytes,
    });
    deps.publicKeyPem = pair.publicPem;
    await expect(installPet(deps)).rejects.toThrow(/unknown field/);
  });

  it('rejects a manifest whose version does not match the app', async () => {
    const pair = generateKeyPair();
    const archive = buildArchive(allRequired());
    const fixture = signFixture(
      '1.2.3',
      allRequired(),
      archive,
      pair.privatePem,
    );
    const broken: PetManifest = { ...fixture.manifest, version: '2.0.0' };
    const manifestBytes = Buffer.from(`${JSON.stringify(broken)}\n`);
    const root = tempDir();
    const { deps } = depsFor({
      root,
      fixture,
      manifestBytes,
    });
    deps.publicKeyPem = pair.publicPem;
    await expect(installPet(deps)).rejects.toThrow(/version/);
  });

  it('rejects a manifest whose archive name does not match the expected pattern', async () => {
    const pair = generateKeyPair();
    const archive = buildArchive(allRequired());
    const fixture = signFixture(
      '1.2.3',
      allRequired(),
      archive,
      pair.privatePem,
    );
    const broken: PetManifest = {
      ...fixture.manifest,
      archive: 'evil-archive.tar.gz',
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(broken)}\n`);
    const root = tempDir();
    const { deps } = depsFor({
      root,
      fixture,
      manifestBytes,
    });
    deps.publicKeyPem = pair.publicPem;
    await expect(installPet(deps)).rejects.toThrow(/archive name/);
  });

  it('rejects an archive missing one of the signed files', async () => {
    const pair = generateKeyPair();
    const entries = allRequired();
    const archive = buildArchive(entries);
    const fixture = signFixture('1.2.3', entries, archive, pair.privatePem);
    const reduced = entries.filter(
      (entry) => entry.name !== 'dist/pet-preload.js',
    );
    const reducedArchive = buildArchive(reduced);
    const root = tempDir();
    const { deps } = depsFor({
      root,
      fixture,
      archiveBytes: reducedArchive,
    });
    deps.publicKeyPem = pair.publicPem;
    await expect(installPet(deps)).rejects.toThrow();
    expect(readdirSync(path.join(root, 'pet'))).toEqual([]);
  });

  it('rejects an archive that adds an extra file not in the manifest', async () => {
    const pair = generateKeyPair();
    const entries = allRequired();
    const manifestEntries = entries;
    const archiveEntries = [
      ...entries,
      { name: 'extra.js', contents: Buffer.from('not signed') },
    ];
    const archive = buildArchive(archiveEntries);
    const fixture = signFixture(
      '1.2.3',
      manifestEntries,
      archive,
      pair.privatePem,
    );
    const root = tempDir();
    const { deps } = depsFor({ root, fixture });
    deps.publicKeyPem = pair.publicPem;
    await expect(installPet(deps)).rejects.toThrow();
  });

  it('rejects a manifest whose files entry contains a symlink', async () => {
    const pair = generateKeyPair();
    const entries = allRequired();
    const archive = buildArchive(entries);
    const fixture = signFixture('1.2.3', entries, archive, pair.privatePem);
    const brokenFiles = [
      ...fixture.manifest.files,
      { path: 'evil-link', sha256: sha256Hex(Buffer.from('whatever')) },
    ];
    const broken: PetManifest = { ...fixture.manifest, files: brokenFiles };
    const manifestBytes = Buffer.from(`${JSON.stringify(broken)}\n`);
    const root = tempDir();
    const { deps } = depsFor({
      root,
      fixture,
      manifestBytes,
    });
    deps.publicKeyPem = pair.publicPem;
    await expect(installPet(deps)).rejects.toThrow();
  });

  it('rejects an archive whose decompressed bytes exceed the limit', async () => {
    const pair = generateKeyPair();
    const entries = allRequired();
    const huge = Buffer.alloc(
      PET_INSTALL_LIMITS.decompressedArchiveBytes + 1,
      0,
    );
    const archiveEntries = [...entries, { name: 'huge.bin', contents: huge }];
    const tarBytes = Buffer.concat([
      ...archiveEntries.map((entry) => fileEntry(entry.name, entry.contents)),
      Buffer.alloc(1024),
    ]);
    const archive = Buffer.from(gzipSync(tarBytes));
    // Manifest signed with this archive and matching digests (size limit
    // catches us before the digest comparison because we compare bytes).
    const fixture = signFixture(
      '1.2.3',
      archiveEntries,
      archive,
      pair.privatePem,
    );
    const root = tempDir();
    const { deps } = depsFor({ root, fixture });
    deps.publicKeyPem = pair.publicPem;
    await expect(installPet(deps)).rejects.toThrow();
    expect(readdirSync(path.join(root, 'pet'))).toEqual([]);
  });

  it.each([
    ['traversal', tar(fileEntry('../evil'))],
    ['absolute', tar(fileEntry('/evil'))],
    [
      'dot-segment duplicate',
      tar(fileEntry('dist/./pet-main.js'), fileEntry('dist/pet-main.js')),
    ],
    ['symlink', tar(block('dist/link', '2'))],
    ['duplicate', tar(fileEntry('dist/one'), fileEntry('dist/one'))],
    [
      'truncated',
      Buffer.concat([block('dist/one', '0', 10), Buffer.from('x')]),
    ],
  ])(
    'rejects malformed %s archive entries before extraction',
    async (_name, archive) => {
      const pair = generateKeyPair();
      const entries = allRequired();
      // Sign the malformed archive so we get past the signature gate and
      // exercise the archive-shape checks.
      const fixture = signFixture(
        '1.2.3',
        entries,
        gzipSync(archive),
        pair.privatePem,
      );
      const root = tempDir();
      const { deps } = depsFor({ root, fixture });
      deps.publicKeyPem = pair.publicPem;
      await expect(installPet(deps)).rejects.toThrow();
      expect(readdirSync(path.join(root, 'pet'))).toEqual([]);
    },
  );

  it('rejects an incomplete package and cleans staging', async () => {
    const pair = generateKeyPair();
    const entries = allRequired().slice(0, 3); // missing most files
    const archive = buildArchive(entries);
    const fixture = signFixture('1.2.3', entries, archive, pair.privatePem);
    const root = tempDir();
    const { deps } = depsFor({ root, fixture });
    deps.publicKeyPem = pair.publicPem;
    await expect(installPet(deps)).rejects.toThrow();
    expect(readdirSync(path.join(root, 'pet'))).toEqual([]);
  });

  it('short-circuits an idempotent install without fetching or rewriting', async () => {
    const pair = generateKeyPair();
    const archive = buildArchive(allRequired());
    const fixture = signFixture(
      '1.2.3',
      allRequired(),
      archive,
      pair.privatePem,
    );
    const root = tempDir();
    const first = depsFor({ root, fixture });
    first.deps.publicKeyPem = pair.publicPem;
    await installPet(first.deps);
    const target = path.join(root, 'pet', '1.2.3', 'dist', 'pet-main.js');
    const before = statSync(target).mtimeMs;
    const second = depsFor({
      root,
      fixture: {
        ...fixture,
        archive: gzipSync(Buffer.from('not fetched')),
        manifestBytes: Buffer.from('not fetched'),
      },
    });
    second.deps.publicKeyPem = pair.publicPem;
    await expect(installPet(second.deps)).resolves.toEqual({
      root: path.join(root, 'pet', '1.2.3'),
    });
    expect(second.deps.fetchBytes).not.toHaveBeenCalled();
    expect(statSync(target).mtimeMs).toBe(before);
  });

  it('prunes only real version directories and staging directories after install', async () => {
    const pair = generateKeyPair();
    const archive = buildArchive(allRequired());
    const fixture = signFixture(
      '1.2.3',
      allRequired(),
      archive,
      pair.privatePem,
    );
    const root = tempDir();
    // Real version directory
    mkdirSync(path.join(root, 'pet', '0.9.0', 'dist'), { recursive: true });
    // Old staging
    mkdirSync(path.join(root, 'pet', '.staging-old-123'), { recursive: true });
    // Unknown directory that should be preserved
    mkdirSync(path.join(root, 'pet', 'user-metadata'), { recursive: true });
    writeFileSync(
      path.join(root, 'pet', 'user-metadata', 'notes.txt'),
      'preserved',
    );
    const { deps } = depsFor({ root, fixture });
    deps.publicKeyPem = pair.publicPem;
    await installPet(deps);
    expect(existsSync(path.join(root, 'pet', '0.9.0'))).toBe(false);
    expect(existsSync(path.join(root, 'pet', '.staging-old-123'))).toBe(false);
    expect(
      existsSync(path.join(root, 'pet', 'user-metadata', 'notes.txt')),
    ).toBe(true);
  });

  it('rejects a bad version or repository before fetching', async () => {
    const pair = generateKeyPair();
    const archive = buildArchive(allRequired());
    const fixture = signFixture(
      '1.2.3',
      allRequired(),
      archive,
      pair.privatePem,
    );
    const badVersion = depsFor({
      root: tempDir(),
      fixture,
      version: '../bad',
    });
    badVersion.deps.publicKeyPem = pair.publicPem;
    await expect(installPet(badVersion.deps)).rejects.toThrow(
      'invalid pet app version',
    );
    expect(badVersion.deps.fetchBytes).not.toHaveBeenCalled();
    const badRepo = depsFor({
      root: tempDir(),
      fixture,
      repo: 'hypernewbie/phi/releases',
    });
    badRepo.deps.publicKeyPem = pair.publicPem;
    await expect(installPet(badRepo.deps)).rejects.toThrow(
      'invalid pet release repository',
    );
    expect(badRepo.deps.fetchBytes).not.toHaveBeenCalled();
  });

  it('propagates fetch errors and cleans staging', async () => {
    const pair = generateKeyPair();
    const archive = buildArchive(allRequired());
    const fixture = signFixture(
      '1.2.3',
      allRequired(),
      archive,
      pair.privatePem,
    );
    const root = tempDir();
    const error = new Error('network unavailable');
    const base = depsFor({ root, fixture });
    base.deps.publicKeyPem = pair.publicPem;
    const deps = {
      ...base.deps,
      fetchBytes: vi.fn(async (_url: string, _max: number) => {
        throw error;
      }),
    };
    await expect(installPet(deps)).rejects.toBe(error);
    expect(readdirSync(path.join(root, 'pet'))).toEqual([]);
  });

  it('rejects a manifest whose payload exceeds the manifest fetch limit', async () => {
    const pair = generateKeyPair();
    const archive = buildArchive(allRequired());
    const fixture = signFixture(
      '1.2.3',
      allRequired(),
      archive,
      pair.privatePem,
    );
    const root = tempDir();
    const base = depsFor({ root, fixture });
    base.deps.publicKeyPem = pair.publicPem;
    const huge = Buffer.alloc(PET_INSTALL_LIMITS.manifestBytes + 1, 0x20);
    base.deps.fetchBytes = vi.fn(async (url: string, max: number) => {
      base.calls.push({ url, maxBytes: max });
      if (url.endsWith('manifest.json')) return huge;
      return fixture.archive;
    });
    await expect(installPet(base.deps)).rejects.toThrow(/manifest/i);
  });
});
