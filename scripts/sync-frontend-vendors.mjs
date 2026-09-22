import { createRequire } from 'node:module';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_VENDOR_DIR = path.join(DEFAULT_ROOT_DIR, 'web', 'vendor');

// Every entry is intentionally a package-relative path. This keeps checked-in
// browser files reproducible from the installed package rather than from a
// CDN download or a hand-copied working tree.
export const VENDOR_GROUPS = {
  xterm: [
    file('@xterm/xterm', 'lib/xterm.js', 'xterm.js'),
    file('@xterm/xterm', 'css/xterm.css', 'xterm.css'),
    file('@xterm/headless', 'lib-headless/xterm-headless.js', 'xterm-headless.js'),
    file('@xterm/addon-fit', 'lib/addon-fit.js', 'xterm-addon-fit.js'),
    file('@xterm/addon-search', 'lib/addon-search.js', 'xterm-addon-search.js'),
    file('@xterm/addon-webgl', 'lib/addon-webgl.js', 'xterm-addon-webgl.js'),
    file('@xterm/addon-unicode11', 'lib/addon-unicode11.js', 'xterm-addon-unicode11.js'),
    file('@xterm/addon-serialize', 'lib/addon-serialize.js', 'xterm-addon-serialize.js'),
    // The xterm distribution license covers the headless and serialize
    // packages too; those package tarballs carry license metadata but no
    // separate text file.
    license('@xterm/xterm', 'xterm.LICENSE'),
    license('@xterm/addon-fit', 'xterm-addon-fit.LICENSE'),
    license('@xterm/addon-search', 'xterm-addon-search.LICENSE'),
    license('@xterm/addon-webgl', 'xterm-addon-webgl.LICENSE'),
    license('@xterm/addon-unicode11', 'xterm-addon-unicode11.LICENSE'),
  ],
  content: [
    file('diff', 'dist/diff.min.js', 'jsdiff.min.js'),
    file('dompurify', 'dist/purify.min.js', 'purify.min.js'),
    file('@highlightjs/cdn-assets', 'highlight.min.js', 'highlight.min.js'),
    file(
      '@highlightjs/cdn-assets',
      'styles/github-dark.min.css',
      'highlight-github-dark.min.css',
    ),
    file('marked', 'lib/marked.umd.js', 'marked.min.js'),
    file('diff2html', 'bundles/js/diff2html.min.js', 'diff2html.min.js'),
    file('diff2html', 'bundles/css/diff2html.min.css', 'diff2html.min.css'),
    license('diff', 'jsdiff.LICENSE'),
    license('dompurify', 'purify.LICENSE'),
    license('@highlightjs/cdn-assets', 'highlight.LICENSE'),
    license('marked', 'marked.LICENSE'),
    license('diff2html', 'diff2html.LICENSE'),
  ],
  preview: [
    file('viewerjs', 'dist/viewer.min.js', 'viewerjs/viewer.min.js'),
    file('viewerjs', 'dist/viewer.min.css', 'viewerjs/viewer.min.css'),
    file('plyr', 'dist/plyr.polyfilled.min.js', 'plyr/plyr.polyfilled.js'),
    file('plyr', 'dist/plyr.css', 'plyr/plyr.css'),
    file('plyr', 'dist/plyr.svg', 'plyr/plyr.svg'),
    file(
      '@alenaksu/json-viewer',
      'dist/json-viewer.bundle.js',
      'json-viewer/json-viewer.bundle.js',
    ),
    file('pdfjs-dist', 'build/pdf.min.mjs', 'pdfjs/pdf.min.mjs'),
    file('pdfjs-dist', 'build/pdf.worker.min.mjs', 'pdfjs/pdf.worker.min.mjs'),
    file('pdfjs-dist', 'web/pdf_viewer.mjs', 'pdfjs/pdf_viewer.mjs'),
    file('pdfjs-dist', 'web/pdf_viewer.css', 'pdfjs/pdf_viewer.css'),
    directory('pdfjs-dist', 'cmaps', 'pdfjs/cmaps'),
    directory('pdfjs-dist', 'standard_fonts', 'pdfjs/standard_fonts'),
    directory('pdfjs-dist', 'image_decoders', 'pdfjs/image_decoders'),
    directory('pdfjs-dist', 'web/images', 'pdfjs/images'),
    license('viewerjs', 'viewerjs/LICENSE'),
    license('plyr', 'plyr/LICENSE'),
    license('@alenaksu/json-viewer', 'json-viewer/LICENSE'),
    license('pdfjs-dist', 'pdfjs/LICENSE'),
  ],
  kanban: [
    file('chart.js', 'dist/chart.umd.js', 'chart.umd.js'),
    file('sortablejs', 'Sortable.min.js', 'Sortable.min.js'),
    license('chart.js', 'chart.LICENSE'),
    license('sortablejs', 'Sortable.LICENSE'),
  ],
  auth: [
    file('@noble/hashes', '_md.js', 'noble-hashes/_md.js'),
    file('@noble/hashes', '_u64.js', 'noble-hashes/_u64.js'),
    file('@noble/hashes', 'hmac.js', 'noble-hashes/hmac.js'),
    file('@noble/hashes', 'pbkdf2.js', 'noble-hashes/pbkdf2.js'),
    file('@noble/hashes', 'sha2.js', 'noble-hashes/sha2.js'),
    file('@noble/hashes', 'utils.js', 'noble-hashes/utils.js'),
    license('@noble/hashes', 'noble-hashes/LICENSE'),
  ],
};

function file(packageName, source, destination) {
  return { kind: 'file', packageName, source, destination };
}

function directory(packageName, source, destination) {
  return { kind: 'directory', packageName, source, destination };
}

function license(packageName, destination) {
  return { kind: 'license', packageName, destination };
}

function packageDirectoryFromRequire(packageName, rootDir) {
  const require = createRequire(path.join(rootDir, 'package.json'));
  let entry;
  try {
    entry = require.resolve(packageName);
  } catch (error) {
    // Some asset-only packages intentionally omit a JavaScript `main` and
    // therefore cannot be resolved as modules. They are still direct root
    // dependencies, so resolve their project-local node_modules symlink.
    const candidate = path.join(rootDir, 'node_modules', ...packageName.split('/'));
    if (!existsSync(path.join(candidate, 'package.json'))) throw error;
    entry = path.join(candidate, 'package.json');
  }
  let current = path.dirname(entry);
  while (true) {
    const packageJsonPath = path.join(current, 'package.json');
    if (existsSync(packageJsonPath)) {
      let packageJson;
      try {
        packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      } catch (error) {
        throw new Error(`Could not read package metadata for ${packageName}`, {
          cause: error,
        });
      }
      if (packageJson.name === packageName) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not locate package root for ${packageName}`);
}

function findLicense(packageDir, packageName) {
  const candidates = [
    'LICENSE',
    'LICENSE.md',
    'LICENSE.txt',
    'license',
    'license.md',
    'license.txt',
  ];
  for (const candidate of candidates) {
    const source = path.join(packageDir, candidate);
    if (existsSync(source) && statSync(source).isFile()) return source;
  }
  throw new Error(`Could not locate a license file in ${packageName}`);
}

function resolveSource(entry, options) {
  const packageDir = (options.resolvePackageDir ?? packageDirectoryFromRequire)(
    entry.packageName,
    options.rootDir,
  );
  if (entry.kind === 'license') return findLicense(packageDir, entry.packageName);
  return path.join(packageDir, entry.source);
}

function listFiles(root) {
  if (!existsSync(root)) return [];
  const stat = statSync(root);
  if (stat.isFile()) return [''];
  const files = [];
  for (const name of readdirSync(root).sort()) {
    const child = path.join(root, name);
    const childStat = statSync(child);
    if (childStat.isDirectory()) {
      for (const nested of listFiles(child)) {
        files.push(path.join(name, nested));
      }
    } else {
      files.push(name);
    }
  }
  return files;
}

function sameFile(left, right) {
  if (!existsSync(left) || !existsSync(right)) return false;
  if (!statSync(left).isFile() || !statSync(right).isFile()) return false;
  const a = readFileSync(left);
  const b = readFileSync(right);
  return a.length === b.length && a.equals(b);
}

function compareEntry(source, destination, stale) {
  if (!existsSync(source)) {
    stale.push(destination);
    return;
  }
  const sourceStat = statSync(source);
  if (sourceStat.isFile()) {
    if (!sameFile(source, destination)) stale.push(destination);
    return;
  }
  if (!existsSync(destination) || !statSync(destination).isDirectory()) {
    for (const nested of listFiles(source)) {
      stale.push(path.join(destination, nested));
    }
    return;
  }
  const sourceFiles = new Set(listFiles(source));
  const destinationFiles = new Set(listFiles(destination));
  for (const nested of sourceFiles) {
    if (!destinationFiles.has(nested) || !sameFile(path.join(source, nested), path.join(destination, nested))) {
      stale.push(path.join(destination, nested));
    }
  }
  for (const nested of destinationFiles) {
    if (!sourceFiles.has(nested)) stale.push(path.join(destination, nested));
  }
}

function copyEntry(source, destination) {
  if (!existsSync(source)) {
    throw new Error(`Vendor source does not exist: ${source}`);
  }
  const sourceStat = statSync(source);
  if (sourceStat.isDirectory()) {
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true });
    return;
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination);
}

/**
 * Synchronize one or more vendor groups. The optional resolver and groups are
 * intentionally injectable so tests can use temporary package fixtures and
 * never read the checked-in web/vendor tree as their source of truth.
 */
export function synchronize({
  rootDir = DEFAULT_ROOT_DIR,
  vendorDir = path.join(rootDir, 'web', 'vendor'),
  group,
  check = false,
  groups = VENDOR_GROUPS,
  resolvePackageDir,
} = {}) {
  const selectedGroups = group ? [group] : Object.keys(groups);
  for (const name of selectedGroups) {
    if (!Object.hasOwn(groups, name)) {
      throw new Error(
        `Unknown vendor group ${JSON.stringify(name)}. Expected one of: ${Object.keys(groups).join(', ')}`,
      );
    }
  }

  const stale = [];
  for (const name of selectedGroups) {
    for (const entry of groups[name]) {
      const source = resolveSource(entry, {
        rootDir,
        resolvePackageDir,
      });
      const destination = path.join(vendorDir, entry.destination);
      if (check) compareEntry(source, destination, stale);
      else copyEntry(source, destination);
    }
  }

  if (check && stale.length > 0) {
    const unique = [...new Set(stale)]
      .map((destination) => path.relative(vendorDir, destination))
      .sort();
    return { stale: unique };
  }
  return { stale: [] };
}

function parseArgs(argv) {
  let group;
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    }
    if (arg === '--check') {
      check = true;
    } else if (arg === '--group') {
      group = argv[index + 1];
      index += 1;
      if (!group) throw new Error('--group requires a vendor group name');
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { group, check };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = synchronize({ ...parseArgs(process.argv.slice(2)) });
    if (result.stale.length > 0) {
      process.stderr.write('Stale frontend vendor destinations:\n');
      for (const destination of result.stale) {
        process.stderr.write(`- ${destination}\n`);
      }
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
