import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const launcher = readFileSync('npm/bin/phi-cmd', 'utf8');
const pkg = JSON.parse(readFileSync('npm/package.json', 'utf8'));

describe('npm phi-cmd command client distribution', () => {
    it('is published as a package binary', () => {
        expect(pkg.bin['phi-cmd']).toBe('./bin/phi-cmd');
    });

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
                argv: ['node', 'phi-cmd', 'status', '--json'],
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
                '/package/bin/phi-cmd-native',
                ['status', '--json'],
                { stdio: 'inherit' },
            ],
        ]);
        signals.get('SIGTERM')();
        expect(kills).toEqual(['SIGTERM']);
        child.emit('close', 17);
        expect(exits).toEqual([17]);
    });

    it('runs the Windows binary under its own name', () => {
        const child = new EventEmitter();
        child.kill = () => {};
        const launches = [];
        vm.runInNewContext(launcher, {
            __dirname: '/package/bin',
            process: {
                platform: 'win32',
                argv: ['node', 'phi-cmd'],
                on: () => {},
                exit: () => {},
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
        expect(launches[0][0]).toBe('/package/bin/phi-cmd-native.exe');
    });
});
