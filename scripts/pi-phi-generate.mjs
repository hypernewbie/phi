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

const root = resolve(new URL('..', import.meta.url).pathname);
const pkgDir = resolve(root, 'bonus/pi-phi');
const toolsDir = resolve(pkgDir, '.tools/bin');

const run = (cmd, args, opts = {}) =>
    execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });

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
rmSync(resolve(pkgDir, 'src/gen'), { recursive: true, force: true });
run(bufBin, ['generate'], {
    cwd: pkgDir,
    env: { ...process.env, PATH: pathEntries },
});
run(bufBin, ['--version'], {
    cwd: pkgDir,
    env: { ...process.env, PATH: pathEntries },
});
console.log('pi-phi bindings generated');
