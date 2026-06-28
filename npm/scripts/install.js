const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const version = require('../package.json').version;
const repo = 'hypernewbie/phi';

const platformMap = {
  darwin: 'darwin',
  linux: 'linux',
  win32: 'windows'
};

const archMap = {
  x64: 'amd64',
  arm64: 'arm64'
};

const os = platformMap[process.platform];
const arch = archMap[process.arch];

if (!os || !arch) {
  console.error(`Unsupported platform/architecture: ${process.platform}/${process.arch}`);
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

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        download(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to download binary: status code ${res.statusCode}`));
        return;
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

download(downloadUrl, tempFile)
  .then(() => {
    console.log('Extracting archive...');
    const destBinaryPath = path.join(binDir, binaryName);

    if (isWindows) {
      execSync(`powershell -Command "Expand-Archive -Path '${tempFile}' -DestinationPath '${binDir}' -Force"`);
    } else {
      execSync(`tar -xzf "${tempFile}" -C "${binDir}"`);
      fs.chmodSync(destBinaryPath, 0o755);
    }
    
    fs.unlinkSync(tempFile);
    console.log('Phi binary successfully installed!');
  })
  .catch((err) => {
    console.error('Failed to install Phi binary:', err);
    process.exit(1);
  });
