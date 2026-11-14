#!/usr/bin/env node
// Build or check the curated valibot facade that ships to the browser.
//
// `web-src/` imports `./valibot.js`, which the browser resolves to
// `web/valibot.js` and TypeScript resolves to `web-src/valibot.d.ts`. Both are
// generated here from one source, `scripts/valibot-facade.ts`, so the runtime
// and the types cannot drift apart.
import { execFileSync } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { build as esbuild } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const facadeSource = join(root, 'scripts', 'valibot-facade.ts');
const declarationsConfig = join(root, 'scripts', 'valibot.declarations.json');
const toolsDir = join(root, '.tools', 'valibot');
const tscBin = join(
    root,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
);
const bundleOutput = join(root, 'web', 'valibot.js');
const licenseOutput = join(root, 'web', 'valibot.LICENSE');
const declarationOutput = join(root, 'web-src', 'valibot.d.ts');
const valibotLicense = join(root, 'node_modules', 'valibot', 'LICENSE.md');

function run(command, args) {
    execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

function requireFile(path, message) {
    if (!existsSync(path)) throw new Error(message);
}

const regenerateHint = 'run `pnpm build:web` and commit the result';

function compareBytes(expected, actualPath, name) {
    if (!existsSync(actualPath)) {
        throw new Error(`${name} is missing; ${regenerateHint}`);
    }
    if (!expected.equals(readFileSync(actualPath))) {
        throw new Error(`${name} is stale; ${regenerateHint}`);
    }
}

function createStage() {
    mkdirSync(toolsDir, { recursive: true });
    const directory = mkdtempSync(join(toolsDir, 'stage-'));
    const paths = {
        directory,
        bundle: join(directory, 'valibot.js'),
        license: join(directory, 'valibot.LICENSE'),
        declaration: join(directory, 'valibot.d.ts'),
        types: join(directory, 'types'),
    };
    mkdirSync(paths.types, { recursive: true });
    return paths;
}

// Bundles the facade and writes all three artifacts into `stage`.
async function generate(stage) {
    requireFile(
        valibotLicense,
        'valibot is not installed; run pnpm install --frozen-lockfile',
    );
    const result = await esbuild({
        entryPoints: [facadeSource],
        outfile: stage.bundle,
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
    writeFileSync(stage.license, readFileSync(valibotLicense));
    // The generated file is named after its source, so emit into the stage and
    // rename on copy; emitting into web-src/ would leave a stray duplicate.
    run(tscBin, [
        '-p',
        declarationsConfig,
        '--outDir',
        stage.types,
        '--emitDeclarationOnly',
        '--declaration',
    ]);
    const emitted = join(stage.types, 'valibot-facade.d.ts');
    requireFile(emitted, 'valibot facade declaration was not emitted');
    writeFileSync(stage.declaration, readFileSync(emitted));
}

async function generateAll() {
    const stage = createStage();
    try {
        await generate(stage);
        const bundle = readFileSync(stage.bundle);
        const license = readFileSync(stage.license);
        const declaration = readFileSync(stage.declaration);
        return { bundle, license, declaration };
    } finally {
        rmSync(stage.directory, { recursive: true, force: true });
    }
}

async function build() {
    const { bundle, license, declaration } = await generateAll();
    mkdirSync(dirname(bundleOutput), { recursive: true });
    writeFileSync(bundleOutput, bundle);
    writeFileSync(licenseOutput, license);
    writeFileSync(declarationOutput, declaration);
    console.log('valibot facade built');
}

async function check() {
    const { bundle, license, declaration } = await generateAll();
    compareBytes(bundle, bundleOutput, 'web/valibot.js');
    compareBytes(license, licenseOutput, 'web/valibot.LICENSE');
    compareBytes(declaration, declarationOutput, 'web-src/valibot.d.ts');
    console.log('valibot generated assets: no drift');
}

async function main() {
    const mode = process.argv[2];
    if (!['build', 'check'].includes(mode) || process.argv.length !== 3) {
        throw new Error('usage: node scripts/valibot.mjs <build|check>');
    }
    if (mode === 'build') {
        await build();
    } else {
        await check();
    }
}

main().catch((error) => {
    console.error(`valibot generator failed: ${error.message}`);
    process.exitCode = 1;
});
