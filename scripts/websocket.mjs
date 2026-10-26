#!/usr/bin/env node
// Generate, bundle, or check Phi-owned WebSocket protobuf assets locally.
import { execFileSync } from 'node:child_process';
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { build as esbuild } from 'esbuild';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const protoDir = join(root, 'proto', 'websocket');
const toolsDir = join(root, '.tools', 'websocket');
const goPlugin = join(toolsDir, 'protoc-gen-go');
const bufBin = join(root, 'node_modules', '.bin', 'buf');
const tscBin = join(
    root,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
);
const outputs = [
    { name: 'pkg/ws/pb', path: join(root, 'pkg', 'ws', 'pb') },
    {
        name: 'proto/websocket/gen-ts',
        path: join(protoDir, 'gen-ts'),
    },
    { name: 'web-src/proto', path: join(root, 'web-src', 'proto') },
    { name: 'web/proto', path: join(root, 'web', 'proto') },
];
// Codec entries, one per migrated endpoint.
const codecEntries = ['terminal', 'events', 'control'];

function run(command, args, options = {}) {
    execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
}

function requireFile(path, message) {
    if (!existsSync(path)) throw new Error(message);
}

function toolEnvironment() {
    const pathEntries = [
        toolsDir,
        join(root, 'node_modules', '.bin'),
        process.env.PATH ?? '',
    ];
    return {
        ...process.env,
        PATH: pathEntries.join(process.platform === 'win32' ? ';' : ':'),
    };
}

function ensureGoPlugin() {
    mkdirSync(toolsDir, { recursive: true });
    run('go', [
        'build',
        '-o',
        goPlugin,
        'google.golang.org/protobuf/cmd/protoc-gen-go',
    ]);
}

function templateFor(outputs, file) {
    let outputIndex = 0;
    let inputCount = 0;
    const config = readFileSync(join(protoDir, 'buf.gen.yaml'), 'utf8')
        .replace(/^(\s*-\s+directory:\s*).*$/gm, (_line, prefix) => {
            inputCount++;
            return `${prefix}${JSON.stringify(protoDir)}`;
        })
        .replace(/^(\s+out:\s*).*$/gm, (_line, prefix) => {
            if (outputIndex >= outputs.length) {
                throw new Error(
                    'unexpected output in proto/websocket/buf.gen.yaml',
                );
            }
            return `${prefix}${JSON.stringify(outputs[outputIndex++])}`;
        });
    if (inputCount !== 1) {
        throw new Error(
            'Buf input count does not match the WebSocket pipeline',
        );
    }
    if (outputIndex !== outputs.length) {
        throw new Error(
            'Buf output count does not match the WebSocket pipeline',
        );
    }
    writeFileSync(file, config);
    return file;
}

function generateBindings(goDir, tsDir, templateFile) {
    requireFile(
        bufBin,
        'Buf is missing; install the root dependencies offline first',
    );
    requireFile(
        join(root, 'node_modules', '.bin', 'protoc-gen-ts_proto'),
        'ts-proto is missing; install the root dependencies offline first',
    );
    const config = templateFor([goDir, tsDir], templateFile);
    run(bufBin, ['generate', '--template', config], {
        cwd: protoDir,
        env: toolEnvironment(),
    });
}

function declarationsConfig(genDir, declarationDir, configPath) {
    const config = JSON.parse(
        readFileSync(join(protoDir, 'tsconfig.declarations.json'), 'utf8'),
    );
    config.compilerOptions.rootDir = genDir;
    config.compilerOptions.outDir = declarationDir;
    config.include = [join(genDir, '**', '*.ts')];
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    return configPath;
}

function generateDeclarations(genDir, declarationDir, tempDir = null) {
    requireFile(
        tscBin,
        'TypeScript is missing; install the root dependencies offline first',
    );
    mkdirSync(declarationDir, { recursive: true });
    if (tempDir === null) {
        run(tscBin, ['-p', join(protoDir, 'tsconfig.declarations.json')]);
        return;
    }
    const configPath = declarationsConfig(
        genDir,
        declarationDir,
        join(tempDir, 'tsconfig.declarations.json'),
    );
    run(tscBin, ['-p', configPath]);
}

function protobufRuntimeNotice() {
    const packagePath = join(
        root,
        'node_modules',
        '@bufbuild',
        'protobuf',
        'package.json',
    );
    requireFile(
        packagePath,
        'The root @bufbuild/protobuf dependency is missing; install dependencies offline first',
    );
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
    const marker = `== @bufbuild/protobuf@${manifest.version} (${manifest.license}) ==`;
    const notices = readFileSync(
        join(root, 'bonus', 'pi-phi', 'dist', 'NOTICES.txt'),
        'utf8',
    );
    const start = notices.indexOf(marker);
    if (start < 0) {
        throw new Error(
            `missing matching protobuf runtime license text for ${manifest.version}`,
        );
    }
    const next = notices.indexOf('\n== ', start + marker.length);
    const section = notices.slice(start, next < 0 ? undefined : next).trimEnd();
    return `Phi WebSocket browser codec runtime notices.\n\n${section}\n`;
}

async function bundleBrowser(genDir, webDir) {
    const entryPoints = codecEntries.map((name) => {
        const entry = join(genDir, `${name}.ts`);
        requireFile(
            entry,
            `generated ${name}.ts is missing; run pnpm gen:websocket first`,
        );
        return entry;
    });
    mkdirSync(webDir, { recursive: true });
    const result = await esbuild({
        entryPoints,
        outdir: webDir,
        outbase: genDir,
        entryNames: '[name]',
        // Shared chunks need a hash in their name, and esbuild folds the
        // per-run staging path into that hash, which breaks the drift
        // check. Each entry therefore bundles its own runtime so output
        // names stay deterministic; replaceDirectory wipes stale chunks.
        bundle: true,
        splitting: false,
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
        minify: true,
        legalComments: 'none',
        sourcemap: false,
        metafile: true,
        logLevel: 'silent',
    });
    for (const [output, info] of Object.entries(result.metafile.outputs)) {
        if (!output.endsWith('.js')) {
            throw new Error(
                `unexpected non-JavaScript browser output: ${output}`,
            );
        }
        for (const item of info.imports ?? []) {
            if (item.external) {
                throw new Error(
                    `external browser import in ${output}: ${item.path}`,
                );
            }
        }
    }
    for (const input of Object.keys(result.metafile.inputs)) {
        if (input.includes('@grpc/') || input.startsWith('node:')) {
            throw new Error(`forbidden browser codec input: ${input}`);
        }
    }
    writeFileSync(join(webDir, 'NOTICES.txt'), protobufRuntimeNotice());
}

function listFiles(directory) {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return listFiles(path);
        if (!entry.isFile())
            throw new Error(`unexpected non-file generated artifact: ${path}`);
        return [path];
    });
}

function assertGenerated(directory, name) {
    if (listFiles(directory).length === 0) {
        throw new Error(`${name} generation produced no files`);
    }
}

function compareDirectory(expectedDir, actualDir, name) {
    const expected = new Map(
        listFiles(expectedDir).map((file) => [
            relative(expectedDir, file),
            readFileSync(file),
        ]),
    );
    const actual = new Map(
        listFiles(actualDir).map((file) => [
            relative(actualDir, file),
            readFileSync(file),
        ]),
    );
    const missing = [...expected.keys()].filter((path) => !actual.has(path));
    const extra = [...actual.keys()].filter((path) => !expected.has(path));
    const modified = [...expected.keys()].filter(
        (path) =>
            actual.has(path) && !expected.get(path).equals(actual.get(path)),
    );
    if (missing.length || extra.length || modified.length) {
        const details = [
            ...missing.map((path) => `missing ${path}`),
            ...extra.map((path) => `extra ${path}`),
            ...modified.map((path) => `modified ${path}`),
        ];
        throw new Error(`generated drift in ${name}:\n${details.join('\n')}`);
    }
}

function replaceDirectory(source, destination) {
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true });
}

function createStage() {
    mkdirSync(toolsDir, { recursive: true });
    const directory = mkdtempSync(join(toolsDir, 'stage-'));
    const paths = {
        directory,
        go: join(directory, 'pkg-ws-pb'),
        ts: join(directory, 'gen-ts'),
        declarations: join(directory, 'web-src-proto'),
        web: join(directory, 'web-proto'),
    };
    for (const path of [paths.go, paths.ts, paths.declarations, paths.web]) {
        mkdirSync(path, { recursive: true });
    }
    return paths;
}

async function generate(mode) {
    for (const name of codecEntries) {
        requireFile(
            join(protoDir, `${name}.proto`),
            `${name}.proto is missing`,
        );
    }
    ensureGoPlugin();
    const stage = createStage();
    try {
        generateBindings(
            stage.go,
            stage.ts,
            join(stage.directory, 'buf.gen.yaml'),
        );
        generateDeclarations(stage.ts, stage.declarations, stage.directory);
        await bundleBrowser(stage.ts, stage.web);
        const generated = [stage.go, stage.ts, stage.declarations, stage.web];
        for (let i = 0; i < outputs.length; i++) {
            assertGenerated(generated[i], outputs[i].name);
        }
        if (mode === 'check') {
            for (let i = 0; i < outputs.length; i++) {
                compareDirectory(
                    generated[i],
                    outputs[i].path,
                    outputs[i].name,
                );
            }
            console.log('websocket generated assets: no drift');
            return;
        }
        for (let i = 0; i < outputs.length; i++) {
            replaceDirectory(generated[i], outputs[i].path);
        }
        console.log('websocket bindings and browser codecs generated');
    } finally {
        rmSync(stage.directory, { recursive: true, force: true });
    }
}

async function build() {
    const generatedTs = outputs[1].path;
    for (const name of codecEntries) {
        requireFile(
            join(generatedTs, `${name}.ts`),
            `generated ${name}.ts is missing; run pnpm gen:websocket first`,
        );
    }
    const stage = createStage();
    try {
        await bundleBrowser(generatedTs, stage.web);
        assertGenerated(stage.web, 'web/proto');
        replaceDirectory(stage.web, outputs[3].path);
        console.log('websocket browser codecs bundled');
    } finally {
        rmSync(stage.directory, { recursive: true, force: true });
    }
}

async function main() {
    const mode = process.argv[2];
    if (
        !['generate', 'build', 'check'].includes(mode) ||
        process.argv.length !== 3
    ) {
        throw new Error(
            'usage: node scripts/websocket.mjs <generate|build|check>',
        );
    }
    if (mode === 'build') {
        await build();
    } else {
        await generate(mode);
    }
}

main().catch((error) => {
    console.error(`websocket generator failed: ${error.message}`);
    process.exitCode = 1;
});
