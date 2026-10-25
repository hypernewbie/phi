#!/usr/bin/env node
// Generate the Phi↔Pi bridge bindings from bonus/pi-phi/proto/bridge.proto.
//
// Pipeline (all pinned, all local):
//   1. Build protoc-gen-go / protoc-gen-go-grpc from the Go modules pinned
//      in the repository go.mod (versions recorded in go.mod, not here).
//   2. Run buf generate (pinned @bufbuild/buf) with buf.gen.yaml, which
//      uses those plugin binaries plus this package's pinned ts-proto.
//
// Output is deterministic and committed:
//   - Go:    internal/pibridge/pb/*.pb.go
//   - TS:    bonus/pi-phi/src/gen/*.ts
// Never upload the schema to a hosted generator.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(new URL('..', import.meta.url).pathname);
const pkgDir = resolve(root, 'bonus/pi-phi');
const toolsDir = resolve(pkgDir, '.tools/bin');

// Generated binding outputs, relative to the repository root. Both
// trees are cleared before buf runs so every regeneration is
// genuinely fresh: a stray file in either tree must surface as
// drift instead of surviving the comparison. Importing this module
// is side-effect free; generation runs only when executed.
export const GENERATED_OUTPUT_DIRS = [
    'internal/pibridge/pb',
    'bonus/pi-phi/src/gen',
];

/**
 * Remove every generated output tree under repoRoot. Exported so
 * the isolated drift regression exercises the real fresh-generation
 * file-set behavior against fixture trees.
 */
export function clearGeneratedOutputs(repoRoot = root) {
    for (const dir of GENERATED_OUTPUT_DIRS) {
        rmSync(resolve(repoRoot, dir), { recursive: true, force: true });
    }
}

const run = (cmd, args, opts = {}) =>
    execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });

function main() {
    mkdirSync(toolsDir, { recursive: true });

    // 1. Go plugin binaries from pinned modules.
    run('go', [
        'build',
        '-o',
        resolve(toolsDir, 'protoc-gen-go'),
        'google.golang.org/protobuf/cmd/protoc-gen-go',
    ]);
    run('go', [
        'build',
        '-o',
        resolve(toolsDir, 'protoc-gen-go-grpc'),
        'google.golang.org/grpc/cmd/protoc-gen-go-grpc',
    ]);

    // 2. buf generate with the pinned plugins on PATH.
    const pathEntries = [
        toolsDir,
        resolve(pkgDir, 'node_modules/.bin'),
        process.env.PATH ?? '',
    ].join(process.platform === 'win32' ? ';' : ':');

    const bufBin = resolve(pkgDir, 'node_modules/.bin/buf');
    if (!existsSync(bufBin)) {
        console.error(
            'buf not found: run pnpm install first (pinned @bufbuild/buf devDependency)',
        );
        process.exit(1);
    }
    clearGeneratedOutputs(root);
    run(bufBin, ['generate'], {
        cwd: pkgDir,
        env: { ...process.env, PATH: pathEntries },
    });
    run(bufBin, ['--version'], {
        cwd: pkgDir,
        env: { ...process.env, PATH: pathEntries },
    });
    console.log('pi-phi bindings generated');
}

const invokedDirectly =
    typeof process.argv[1] === 'string' &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
