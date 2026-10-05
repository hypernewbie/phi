const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { execSync, execFileSync } = require('node:child_process');
const { tmpdir } = require('node:os');

const version = require('../package.json').version;
const repo = 'hypernewbie/phi';

const platformMap = {
  darwin: 'darwin',
  linux: 'linux',
  win32: 'windows',
};

const archMap = {
  x64: 'amd64',
  arm64: 'arm64',
};

const os = platformMap[process.platform];
const arch = archMap[process.arch];

if (!os || !arch) {
  console.error(
    `Unsupported platform/architecture: ${process.platform}/${process.arch}`,
  );
  process.exit(1);
}

const isWindows = process.platform === 'win32';
const ext = isWindows ? '.zip' : '.tar.gz';
const binaryName = isWindows ? 'phi.exe' : 'phi';

const assetName = `phi_${version}_${os}_${arch}${ext}`;
const downloadUrl = `https://github.com/${repo}/releases/download/v${version}/${assetName}`;

const binDir = path.join(__dirname, '../bin');
if (!fs.existsSync(binDir)) fs.mkdirSync(binDir);

const tempFile = path.join(binDir, `temp-${assetName}`);

console.log(`Downloading precompiled Phi binary from ${downloadUrl}...`);

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https
      .get(url, (res) => {
        res.on('error', reject);
        res.on('aborted', () =>
          reject(new Error('Binary download interrupted')),
        );
        if (res.statusCode === 302 || res.statusCode === 301) {
          res.resume();
          if (redirects >= 5 || !res.headers.location) {
            reject(new Error('Invalid binary download redirect'));
            return;
          }
          let target;
          try {
            target = new URL(res.headers.location, url);
          } catch (err) {
            reject(err);
            return;
          }
          if (target.protocol !== 'https:') {
            reject(new Error('Refusing an insecure binary download redirect'));
            return;
          }
          download(target.href, dest, redirects + 1)
            .then(resolve)
            .catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(
            new Error(
              `Failed to download binary: status code ${res.statusCode}`,
            ),
          );
          return;
        }
        const file = fs.createWriteStream(dest);
        file.on('error', reject);
        file.on('finish', () => {
          file.close((err) => (err ? reject(err) : resolve()));
        });
        res.pipe(file);
      })
      .on('error', reject);
    request.setTimeout(30000, () =>
      request.destroy(new Error('Binary download timed out')),
    );
  });
}

// Extract the separate client archive away from npm/bin/phic, which is the
// cross-platform launcher. Windows keeps that launcher's clear unsupported
// message and continues installing the unchanged phi server archive.
async function installClient() {
  if (isWindows) return;
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'phic-install-'));
  const asset = `phi_${version}_${os}_${arch}_phic.tar.gz`;
  const archive = path.join(dir, asset);
  try {
    const url = `https://github.com/${repo}/releases/download/v${version}/${asset}`;
    console.log(`Downloading precompiled phic binary from ${url}...`);
    await download(url, archive);
    execFileSync('tar', ['-xzf', archive, '-C', dir, 'phic']);
    const source = path.join(dir, 'phic');
    fs.chmodSync(source, 0o755);
    fs.copyFileSync(source, path.join(binDir, 'phic-native'));
    fs.chmodSync(path.join(binDir, 'phic-native'), 0o755);
    console.log('phic binary successfully installed!');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

download(downloadUrl, tempFile)
  .then(() => {
    console.log('Extracting archive...');
    const destBinaryPath = path.join(binDir, binaryName);

    if (isWindows) {
      execSync(
        `powershell -Command "Expand-Archive -Path '${tempFile}' -DestinationPath '${binDir}' -Force"`,
      );
    } else {
      execSync(`tar -xzf "${tempFile}" -C "${binDir}"`);
      fs.chmodSync(destBinaryPath, 0o755);
    }

    fs.unlinkSync(tempFile);
    console.log('Phi binary successfully installed!');
    return installClient();
  })
  .catch((err) => {
    console.error('Failed to install Phi binary:', err);
    process.exit(1);
  });
