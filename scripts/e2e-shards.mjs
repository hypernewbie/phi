#!/usr/bin/env node
// Duration-balanced e2e shards for CI.
//
// `check` proves the manifests still describe every test in the suite, exactly
// once. Playwright's `--test-list` silently ignores ids it cannot find, so this
// check is the only thing that keeps a renamed test from dropping out of CI.
// `update` rebalances the manifests from a Playwright JSON report.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shardDir = join(root, 'e2e', 'shards');
const SHARDS = 5;
const REGENERATE = 'node scripts/e2e-shards.mjs update <playwright-json-report>';

// `playwright test --list` prints:
//   Listing tests:
//     path/to.spec.ts:25:1 › suite › test
//   Total: N tests in M files
// The stable id keeps the path and the full title path, and drops line:column
// so ordinary edits do not invalidate every manifest.
export function parseListedEntries(output) {
    const entries = [];
    for (const raw of output.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('Listing tests:') || line.startsWith('Total:'))
            continue;
        const match = /^(.+?):(\d+):(\d+) › (.+)$/.exec(line);
        if (!match)
            throw new Error(`unrecognized --list line: ${line}`);
        entries.push({
            key: `${match[1]}:${match[2]}:${match[3]}`,
            file: match[1],
            id: `${match[1]} › ${match[4]}`,
        });
    }
    return entries;
}

export function parseListedIds(output) {
    return parseListedEntries(output).map((entry) => entry.id);
}

function walkSpecs(report) {
    const specs = [];
    const visit = (suite) => {
        for (const spec of suite.specs ?? []) specs.push(spec);
        for (const child of suite.suites ?? []) visit(child);
    };
    for (const suite of report.suites ?? []) visit(suite);
    return specs;
}

// A JSON report carries no describe path in `spec.title`, and loop-generated
// tests share one line. Key by file:line:column, sum the observed durations for
// that key, and let the caller split it across the ids that share it.
export function durationByKey(report) {
    const byKey = new Map();
    for (const spec of walkSpecs(report)) {
        const key = `${spec.file}:${spec.line}:${spec.column}`;
        let total = 0;
        for (const test of spec.tests ?? [])
            for (const result of test.results ?? [])
                total += result.duration ?? 0;
        byKey.set(key, (byKey.get(key) ?? 0) + total);
    }
    return byKey;
}

export function balancedEntries(listed, durations) {
    const counts = new Map();
    for (const entry of listed)
        counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1);
    return listed.map((entry) => ({
        id: entry.id,
        file: entry.file,
        duration: (durations.get(entry.key) ?? 0) / (counts.get(entry.key) ?? 1),
    }));
}

// Shard whole files, never individual tests: a file may own a beforeAll
// fixture or a serial describe, so splitting it across shards changes what the
// tests mean. Playwright's own --shard also keeps a file on one shard.
// Greedy longest-first, ties by file name, so the output is reproducible.
export function assignShards(entries, shards = SHARDS) {
    const files = new Map();
    for (const entry of entries) {
        const file = files.get(entry.file) ?? { load: 0, ids: [] };
        file.load += entry.duration;
        file.ids.push(entry.id);
        files.set(entry.file, file);
    }
    const buckets = Array.from({ length: shards }, () => ({ load: 0, ids: [] }));
    const ordered = [...files.entries()].sort(
        ([nameA, a], [nameB, b]) => b.load - a.load || nameA.localeCompare(nameB),
    );
    for (const [, file] of ordered) {
        let target = buckets[0];
        for (const bucket of buckets)
            if (bucket.load < target.load) target = bucket;
        target.load += file.load;
        target.ids.push(...file.ids);
    }
    return buckets.map((bucket) => [...bucket.ids].sort());
}

export function checkManifests(manifests, listed) {
    const listedSet = new Set(listed);
    const occurrences = new Map();
    const unknown = [];
    for (const ids of manifests) {
        for (const id of ids) {
            occurrences.set(id, (occurrences.get(id) ?? 0) + 1);
            if (!listedSet.has(id)) unknown.push(id);
        }
    }
    const duplicates = [...occurrences]
        .filter(([, count]) => count > 1)
        .map(([id]) => id);
    const missing = listed.filter((id) => !occurrences.has(id));
    return { missing, unknown, duplicates };
}

function listShipped() {
    const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    return execFileSync(pnpm, ['exec', 'playwright', 'test', '--list'], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
    });
}

function readManifests(shards = SHARDS) {
    return Array.from({ length: shards }, (_, index) => {
        const path = join(shardDir, `shard-${index + 1}.txt`);
        return readFileSync(path, 'utf8')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
    });
}

function reportCoverage(result) {
    const detail = [
        ['missing from every shard', result.missing],
        ['unknown to the suite', result.unknown],
        ['listed more than once', result.duplicates],
    ];
    const problems = detail.filter(([, ids]) => ids.length > 0);
    if (problems.length === 0) return false;
    for (const [label, ids] of problems) {
        console.error(`${label} (${ids.length}):`);
        for (const id of ids.slice(0, 20)) console.error(`  ${id}`);
        if (ids.length > 20) console.error(`  …and ${ids.length - 20} more`);
    }
    return true;
}

function check() {
    const listed = parseListedIds(listShipped());
    const manifests = readManifests();
    const perShard = manifests
        .map((ids, index) => `shard ${index + 1}: ${ids.length}`)
        .join(', ');
    if (reportCoverage(checkManifests(manifests, listed))) {
        console.error(`\ne2e shard manifests are stale. ${perShard}.`);
        console.error(`Regenerate: ${REGENERATE}`);
        process.exitCode = 1;
        return;
    }
    console.log(`e2e shard manifests cover ${listed.length} tests (${perShard})`);
}

function update(reportPath) {
    if (!reportPath) throw new Error(`usage: ${REGENERATE}`);
    const report = JSON.parse(readFileSync(resolve(reportPath), 'utf8'));
    const listed = parseListedEntries(listShipped());
    const ids = new Set(listed.map((entry) => entry.id));
    if (ids.size !== listed.length)
        throw new Error('the suite contains duplicate test ids; cannot shard');
    const entries = balancedEntries(listed, durationByKey(report));
    const buckets = assignShards(entries);
    mkdirSync(shardDir, { recursive: true });
    const loads = buckets.map((bucket, index) => {
        const path = join(shardDir, `shard-${index + 1}.txt`);
        writeFileSync(path, `${bucket.join('\n')}\n`);
        const total = entries
            .filter((entry) => bucket.includes(entry.id))
            .reduce((sum, entry) => sum + entry.duration, 0);
        return total / 60_000;
    });
    const worst = Math.max(...loads);
    const best = Math.min(...loads);
    console.log(
        `wrote ${SHARDS} shards: ${loads.map((load) => `${load.toFixed(1)} min`).join(', ')}`,
    );
    console.log(
        `balance: worst ${worst.toFixed(1)} min, best ${best.toFixed(1)} min, ratio ${(worst / Math.max(best, 0.001)).toFixed(2)}`,
    );
}

function main() {
    const mode = process.argv[2];
    if (mode === 'check') {
        check();
        return;
    }
    if (mode === 'update') {
        update(process.argv[3]);
        return;
    }
    throw new Error(
        `usage: node scripts/e2e-shards.mjs <check|update <playwright-json-report>>`,
    );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    main();
