#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const expectMode = value('--expect');
const out = value('--out');
if (!out || !['present', 'absent'].includes(expectMode)) {
  console.error('usage: verify-pet-package.mjs --expect present|absent --out <dir>');
  process.exit(2);
}

const walk = (dir) => {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    if (entry.name.toLowerCase() === 'resources') found.push(child);
    found.push(...walk(child));
  }
  return found;
};
const resources = walk(out);
const pets = resources.map((resource) => path.join(resource, 'pet')).filter((pet) => existsSync(pet) && statSync(pet).isDirectory());
const complete = pets.filter((pet) =>
  existsSync(path.join(pet, 'dist', 'pet-main.js')) &&
  existsSync(path.join(pet, 'assets')) &&
  existsSync(path.join(pet, 'package.json')) &&
  existsSync(path.join(pet, 'LICENSE-dsh-pet.txt')),
);
if (expectMode === 'present') {
  if (complete.length !== 1 || pets.length !== 1) {
    console.error(`expected exactly one complete packaged pet; found ${pets.length} pet directory(s), ${complete.length} complete: ${pets.join(', ') || '(none)'}`);
    process.exit(1);
  }
  console.log(`pet package verified: ${complete[0]}`);
} else {
  if (pets.length !== 0) {
    console.error(`expected no packaged pet resource; found: ${pets.join(', ')}`);
    process.exit(1);
  }
  console.log('pet package absence verified');
}
