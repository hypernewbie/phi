import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const installer = readFileSync('npm/scripts/install.js', 'utf8');
const launcher = readFileSync('npm/bin/phic', 'utf8');
const pkg = JSON.parse(readFileSync('npm/package.json', 'utf8'));

async function install(
    platform,
    arch,
    failClient = false,
    redirectClient = '',
) {
    const calls = {
        urls: [],
        shell: [],
        exec: [],
        copied: [],
        removed: [],
        errors: [],
        exit: [],
    };
    const fs = {
        existsSync: () => true,
        mkdirSync: () => {},
        mkdtempSync: () => '/tmp/phic-staging',
        chmodSync: () => {},
        unlinkSync: (file) => calls.removed.push(file),
        rmSync: (file) => calls.removed.push(file),
        copyFileSync: (...args) => calls.copied.push(args),
        createWriteStream: () => {
            const file = new EventEmitter();
            file.close = (callback) => callback();
            return file;
        },
    };
    const https = {
        get(url, callback) {
            calls.urls.push(url);
            const response = new EventEmitter();
            response.statusCode =
                failClient && url.includes('_phic.') ? 404 : 200;
            if (redirectClient && url.includes('_phic.')) {
                response.statusCode = 302;
                response.headers = {
                    location:
                        redirectClient === 'loop'
                            ? url
                            : 'http://insecure.invalid/client',
                };
            }
            response.resume = () => {};
            response.pipe = (file) => queueMicrotask(() => file.emit('finish'));
            queueMicrotask(() => callback(response));
            const request = new EventEmitter();
            request.setTimeout = () => {};
            return request;
        },
    };
    const context = {
        URL,
        __dirname: '/package/scripts',
        process: { platform, arch, exit: (code) => calls.exit.push(code) },
        console: { log: () => {}, error: (...args) => calls.errors.push(args) },
        require(name) {
            if (name === 'node:fs') return fs;
            if (name === 'node:path') return path;
            if (name === 'node:https') return https;
            if (name === 'node:os') return { tmpdir: () => '/tmp' };
            if (name === 'node:child_process')
                return {
                    execSync: (command) => calls.shell.push(command),
                    execFileSync: (...args) => calls.exec.push(args),
                };
            if (name === '../package.json') return pkg;
            throw new Error(`unexpected import ${name}`);
        },
    };
    vm.runInNewContext(installer, context);
    // Complete actual promise/microtask work; no elapsed-time assertion.
    await new Promise((resolve) => setImmediate(resolve));
    return calls;
}

describe('npm native Phi client distribution', () => {
    it.each([
        ['darwin', 'arm64', 'darwin', 'arm64'],
        ['linux', 'x64', 'linux', 'amd64'],
    ])(
        'installs isolated server/client archives on %s/%s',
        async (platform, arch, os, goarch) => {
            const calls = await install(platform, arch);
            expect(calls.urls.map((url) => url.split('/').at(-1))).toEqual([
                `phi_${pkg.version}_${os}_${goarch}.tar.gz`,
                `phi_${pkg.version}_${os}_${goarch}_phic.tar.gz`,
            ]);
            expect(calls.exec).toEqual([
                [
                    'tar',
                    [
                        '-xzf',
                        `/tmp/phic-staging/phi_${pkg.version}_${os}_${goarch}_phic.tar.gz`,
                        '-C',
                        '/tmp/phic-staging',
                        'phic',
                    ],
                ],
            ]);
            expect(calls.copied).toEqual([
                ['/tmp/phic-staging/phic', '/package/bin/phic-native'],
            ]);
            expect(calls.removed).toContain('/tmp/phic-staging');
            expect(calls.exit).toEqual([]);
            expect(pkg.bin).toEqual({ phi: './bin/phi', phic: './bin/phic' });
        },
    );

    it('does not request a nonexistent Windows client or alter the server asset', async () => {
        const calls = await install('win32', 'x64');
        expect(calls.urls).toHaveLength(1);
        expect(calls.urls[0]).toContain(`phi_${pkg.version}_windows_amd64.zip`);
        expect(calls.exec).toEqual([]);
        expect(calls.copied).toEqual([]);
        expect(calls.exit).toEqual([]);
    });

    it('fails clearly and cleans staging when the client asset is unavailable', async () => {
        const calls = await install('linux', 'x64', true);
        expect(calls.exit).toEqual([1]);
        expect(calls.removed).toContain('/tmp/phic-staging');
        expect(calls.copied).toEqual([]);
        expect(calls.errors).toHaveLength(1);
    });

    it.each(['insecure', 'loop'])(
        'bounds and rejects %s client download redirects',
        async (kind) => {
            const calls = await install('linux', 'x64', false, kind);
            expect(calls.exit).toEqual([1]);
            expect(calls.urls.length).toBeLessThanOrEqual(7);
            expect(calls.urls.some((url) => url.startsWith('http:'))).toBe(
                false,
            );
            expect(calls.removed).toContain('/tmp/phic-staging');
        },
    );

    it('passes arguments, streams, exit status and signals to the native client', () => {
        const child = new EventEmitter();
        const kills = [];
        child.kill = (signal) => kills.push(signal);
        const signals = new Map();
        const launches = [];
        const exits = [];
        vm.runInNewContext(launcher, {
            __dirname: '/package/bin',
            process: {
                platform: 'linux',
                argv: ['node', 'phic', '--pane', 'exact-id'],
                on: (name, fn) => signals.set(name, fn),
                exit: (code) => exits.push(code),
            },
            console,
            require(name) {
                if (name === 'node:path') return path;
                if (name === 'node:child_process')
                    return {
                        spawn: (...args) => {
                            launches.push(args);
                            return child;
                        },
                    };
                throw new Error(name);
            },
        });
        expect(launches).toEqual([
            [
                '/package/bin/phic-native',
                ['--pane', 'exact-id'],
                { stdio: 'inherit' },
            ],
        ]);
        signals.get('SIGTERM')();
        expect(kills).toEqual(['SIGTERM']);
        child.emit('close', 17);
        expect(exits).toEqual([17]);
    });

    it('reports unsupported Windows operation without spawning anything', () => {
        const exits = [];
        const errors = [];
        vm.runInNewContext(launcher, {
            process: { platform: 'win32', exit: (code) => exits.push(code) },
            console: { error: (text) => errors.push(text) },
            require: (name) =>
                name === 'node:path'
                    ? path
                    : {
                          spawn: () => {
                              throw new Error('must not spawn');
                          },
                      },
        });
        expect(exits).toEqual([1]);
        expect(errors[0]).toContain('macOS and Linux');
    });
});
