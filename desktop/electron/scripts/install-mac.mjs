#!/usr/bin/env node
// Install the built macOS app into /Applications and keep macOS from
// showing the app twice.
//
// Replacing the bundle gives it a new inode. The Dock tracks the recent
// apps it shows on the right by file reference, so a replaced bundle gets
// a second tile instead of the old one being updated. The user then sees
// two icons for one app. This script installs the build in place and
// prunes the stale tile.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const electronRoot = resolve(here, '..');

function parseArgs(argv) {
  const opts = {
    app: join(electronRoot, 'out', 'mac-arm64', 'phi-client.app'),
    target: '/Applications/phi-client.app',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--app') opts.app = resolve(argv[++i]);
    else if (arg === '--target') opts.target = resolve(argv[++i]);
    else if (arg === '--keep-build') opts.keepBuild = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'usage: install-mac.mjs [--app <bundle>] [--target <path>] [--keep-build]\n',
      );
      process.exit(0);
    } else {
      process.stderr.write(`unknown argument: ${arg}\n`);
      process.exit(2);
    }
  }
  return opts;
}

function bundleId(appPath) {
  const plist = join(appPath, 'Contents', 'Info.plist');
  if (!existsSync(plist)) {
    throw new Error(
      `no Info.plist in ${appPath}. Run the package build first.`,
    );
  }
  const out = execFileSync(
    '/usr/libexec/PlistBuddy',
    ['-c', 'Print :CFBundleIdentifier', plist],
    {
      encoding: 'utf8',
    },
  );
  return out.trim();
}

function install(source, target) {
  if (!existsSync(source)) {
    throw new Error(`no build at ${source}. Run the package build first.`);
  }
  // ditto copies an app bundle the way macOS expects: the framework
  // symlinks keep working because they are rewritten to point into the
  // new location. A plain file copy leaves them aimed at the build
  // directory, and the app then fails to start.
  //
  // The old bundle goes to a staging path first so a failed copy never
  // leaves the machine without an app.
  const staging = `${target}.new`;
  rmSync(staging, { recursive: true, force: true });
  execFileSync('/usr/bin/ditto', [source, staging]);
  rmSync(target, { recursive: true, force: true });
  execFileSync('/usr/bin/ditto', [staging, target]);
  rmSync(staging, { recursive: true, force: true });
}

/** Fail loudly when the copied bundle cannot start. */
function verify(target) {
  const executable = join(target, 'Contents', 'MacOS', 'phi-client');
  if (!existsSync(executable)) {
    throw new Error(`installed bundle has no executable at ${executable}`);
  }
  const frameworks = join(target, 'Contents', 'Frameworks');
  if (!existsSync(frameworks)) {
    throw new Error(`installed bundle has no Frameworks directory`);
  }
  for (const entry of readdirSync(frameworks)) {
    const path = join(frameworks, entry);
    if (lstatSync(path).isSymbolicLink() && !existsSync(path)) {
      throw new Error(`installed bundle has a dangling link: ${entry}`);
    }
  }
}

/**
 * Keep exactly one Dock tile for the app.
 *
 * The Dock shows a running app in its app section, and it also keeps
 * the app in its recent apps. An app that is not pinned therefore shows
 * up twice: once as the running app and once as a recent app. Replacing
 * the bundle makes it worse, because the Dock tracks recent apps by file
 * reference and adds a second entry instead of updating the old one.
 *
 * The fix is to pin the app and clear its recent app entries. A pinned
 * app has one tile whether it runs or not.
 */
function ensureSingleDockTile(bundle, target, label) {
  let exported;
  try {
    exported = execFileSync('defaults', ['export', 'com.apple.dock', '-'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return {
      removed: 0,
      pinned: false,
      reason: 'dock preferences unavailable',
    };
  }

  const work = mkdtempSync(join(tmpdir(), 'phi-dock-'));
  const source = join(work, 'dock.plist');
  try {
    writeFileSync(source, exported);

    // The dock preferences hold archived bookmarks, which cannot round
    // trip through JSON. Read the arrays as XML and edit the plist in
    // place instead.
    const entriesFor = (key) => {
      try {
        const fragment = execFileSync(
          '/usr/bin/plutil',
          ['-extract', key, 'xml1', '-o', '-', source],
          { encoding: 'utf8' },
        );
        return splitArrayEntries(fragment);
      } catch {
        return [];
      }
    };

    const isApp = (entry) =>
      entry.includes('<key>bundle-identifier</key>') &&
      entry.includes(`<string>${bundle}</string>`);

    // Clear every recent app entry for the app.
    const recents = entriesFor('recent-apps');
    const doomed = [];
    recents.forEach((entry, index) => {
      if (isApp(entry)) doomed.push(index);
    });
    // Delete from the end so the remaining indexes stay valid.
    for (const index of doomed.reverse()) {
      execFileSync('/usr/libexec/PlistBuddy', [
        '-c',
        `Delete :recent-apps:${index}`,
        source,
      ]);
    }

    // Keep a single pinned tile.
    const pinnedIndexes = [];
    entriesFor('persistent-apps').forEach((entry, index) => {
      if (isApp(entry)) pinnedIndexes.push(index);
    });
    for (const index of pinnedIndexes.slice(1).reverse()) {
      execFileSync('/usr/libexec/PlistBuddy', [
        '-c',
        `Delete :persistent-apps:${index}`,
        source,
      ]);
    }

    execFileSync('defaults', ['import', 'com.apple.dock', source]);

    let hasTile = pinnedIndexes.length > 0;
    if (!hasTile) {
      const tile = [
        '<dict>',
        '<key>tile-data</key>',
        '<dict>',
        '<key>bundle-identifier</key>',
        `<string>${bundle}</string>`,
        '<key>dock-extra</key>',
        '<integer>0</integer>',
        '<key>file-data</key>',
        '<dict>',
        '<key>_CFURLString</key>',
        `<string>file://${target}/</string>`,
        '<key>_CFURLStringType</key>',
        '<integer>15</integer>',
        '</dict>',
        '<key>file-label</key>',
        `<string>${label}</string>`,
        '<key>file-type</key>',
        '<integer>1</integer>',
        '</dict>',
        '<key>tile-type</key>',
        '<string>file-tile</string>',
        '</dict>',
      ].join('');
      execFileSync('defaults', [
        'write',
        'com.apple.dock',
        'persistent-apps',
        '-array-add',
        tile,
      ]);
      hasTile = true;
    }

    execFileSync('/usr/bin/killall', ['Dock']);
    return { removed: doomed.length, pinned: hasTile };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Split an XML array into its top level dictionary entries. */
function splitArrayEntries(xml) {
  const entries = [];
  const token = /<dict>|<\/dict>/g;
  let depth = 0;
  let start = -1;
  for (let match = token.exec(xml); match !== null; match = token.exec(xml)) {
    if (match[0] === '<dict>') {
      if (depth === 0) start = match.index;
      depth++;
    } else {
      depth--;
      if (depth === 0 && start >= 0) {
        entries.push(xml.slice(start, match.index + match[0].length));
        start = -1;
      }
    }
  }
  return entries;
}

const opts = parseArgs(process.argv.slice(2));
if (!existsSync(opts.app)) {
  throw new Error(`no build at ${opts.app}. Run the package build first.`);
}
const id = bundleId(opts.app);
install(opts.app, opts.target);
verify(opts.target);

if (!opts.keepBuild) {
  rmSync(opts.app, { recursive: true, force: true });
}

const pruned = ensureSingleDockTile(id, opts.target, 'phi-client');
process.stdout.write(
  `installed ${id} to ${opts.target}\n` +
    `dock tiles: ${pruned.pinned ? 'one pinned tile' : 'not pinned'}` +
    `${pruned.reason ? ` (${pruned.reason})` : ''}\n`,
);
if (!opts.keepBuild) {
  process.stdout.write(`removed the build copy at ${opts.app}\n`);
}
