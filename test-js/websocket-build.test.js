import { spawnSync } from 'node:child_process';
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirs = [
    'pkg/ws/pb',
    'proto/websocket/gen-ts',
    'web-src/proto',
    'web/proto',
];
const fixtureFiles = [
    'scripts/websocket.mjs',
    'go.mod',
    'go.sum',
    'proto/websocket/terminal.proto',
    'proto/websocket/events.proto',
    'proto/websocket/control.proto',
    'proto/websocket/buf.yaml',
    'proto/websocket/buf.gen.yaml',
    'proto/websocket/tsconfig.declarations.json',
    'bonus/pi-phi/dist/NOTICES.txt',
];

function createFixture() {
    const fixture = mkdtempSync(join(tmpdir(), 'phi-websocket-build-test-'));
    for (const path of fixtureFiles) {
        const destination = join(fixture, path);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(join(root, path), destination);
    }
    symlinkSync(
        join(root, 'node_modules'),
        join(fixture, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
    );
    return fixture;
}

function filesUnder(directory) {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return filesUnder(path);
        return [{ path, bytes: readFileSync(path) }];
    });
}

function snapshot(fixture) {
    const result = {};
    for (const directory of outputDirs) {
        for (const file of filesUnder(join(fixture, directory))) {
            result[relative(fixture, file.path)] =
                file.bytes.toString('base64');
        }
    }
    return result;
}

function run(fixture, mode) {
    const child = spawnSync(
        process.execPath,
        [join(fixture, 'scripts', 'websocket.mjs'), mode],
        { cwd: fixture, encoding: 'utf8', env: process.env },
    );
    if (child.error) throw child.error;
    return {
        status: child.status,
        output: `${child.stdout ?? ''}${child.stderr ?? ''}`,
    };
}

function checkFailsWith(fixture, path) {
    const result = run(fixture, 'check');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(path);
}

function writeTempFile(path, content) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
}

function withFixture(callback) {
    const fixture = createFixture();
    try {
        callback(fixture);
    } finally {
        rmSync(fixture, { recursive: true, force: true });
    }
}

describe('WebSocket protobuf generation', () => {
    it(
        'generates deterministic bytes and checks clean output',
        () =>
            withFixture((fixture) => {
                expect(run(fixture, 'generate').status).toBe(0);
                const before = snapshot(fixture);
                expect(Object.keys(before).length).toBeGreaterThan(0);
                expect(run(fixture, 'generate').status).toBe(0);
                expect(snapshot(fixture)).toEqual(before);
                expect(run(fixture, 'build').status).toBe(0);
                expect(snapshot(fixture)).toEqual(before);
                expect(run(fixture, 'check').status).toBe(0);
                expect(snapshot(fixture)).toEqual(before);
            }),
        240_000,
    );

    it(
        'detects modified, missing, and extra files without rewriting artifacts',
        () =>
            withFixture((fixture) => {
                expect(run(fixture, 'generate').status).toBe(0);
                const path = join(fixture, 'web/proto/terminal.js');
                const original = readFileSync(path);
                try {
                    writeFileSync(
                        path,
                        Buffer.concat([original, Buffer.from('\n// drift\n')]),
                    );
                    checkFailsWith(fixture, 'modified terminal.js');
                    expect(readFileSync(path).toString()).toContain('// drift');

                    writeFileSync(path, original);
                    rmSync(path);
                    checkFailsWith(fixture, 'missing terminal.js');
                    expect(() => readFileSync(path)).toThrow();

                    writeFileSync(path, original);
                    const extra = join(fixture, 'web/proto/websocket-extra.js');
                    writeFileSync(extra, 'extra');
                    try {
                        checkFailsWith(fixture, 'extra websocket-extra.js');
                        expect(readFileSync(extra, 'utf8')).toBe('extra');
                    } finally {
                        rmSync(extra, { force: true });
                    }
                } finally {
                    writeFileSync(path, original);
                }
            }),
        240_000,
    );

    it(
        'cleans stale files only from the four owned output directories',
        () =>
            withFixture((fixture) => {
                expect(run(fixture, 'generate').status).toBe(0);
                const stale = outputDirs.map((directory) =>
                    join(fixture, directory, '.websocket-build-test-stale'),
                );
                const outside = join(
                    fixture,
                    'web',
                    '.websocket-build-test-preserved',
                );
                const sentinel = 'leave the rest of web untouched';
                for (const path of stale) writeTempFile(path, 'stale');
                writeTempFile(outside, sentinel);
                expect(run(fixture, 'generate').status).toBe(0);
                for (const path of stale)
                    expect(() => readFileSync(path)).toThrow();
                expect(readFileSync(outside, 'utf8')).toBe(sentinel);
            }),
        240_000,
    );
});
