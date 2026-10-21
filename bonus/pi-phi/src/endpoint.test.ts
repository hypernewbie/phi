import { describe, expect, it } from 'vitest';
import { parseTarget } from './endpoint.js';

describe('parseTarget', () => {
    it('accepts absolute unix paths with spaces', () => {
        expect(parseTarget('unix:/tmp/phi-pi-abc/bridge.sock')).toEqual({
            kind: 'unix',
            path: '/tmp/phi-pi-abc/bridge.sock',
        });
        expect(parseTarget('unix:/tmp/phi pi/bridge.sock').path).toBe(
            '/tmp/phi pi/bridge.sock',
        );
    });
    it('accepts literal local pipe names', () => {
        const target = String.raw`unix:\\.\pipe\phi-pi-` + 'ab'.repeat(16);
        expect(parseTarget(target).kind).toBe('windows-pipe');
    });
    it.each([
        ['tcp', '127.0.0.1:50051'],
        ['dns', 'dns:///localhost:50051'],
        ['triple-slash', 'unix:///tmp/bridge.sock'],
        ['relative', 'unix:bridge.sock'],
        ['empty', 'unix:'],
        ['no-scheme', '/tmp/bridge.sock'],
        ['nul', 'unix:/tmp/bad\x00.sock'],
        ['percent', 'unix:/tmp/%2e.sock'],
        ['credentials', 'unix://user@/tmp/bridge.sock'],
        ['authority', 'unix://authority/tmp/bridge.sock'],
        ['remote-pipe', String.raw`unix:\\.\pipe\other`],
        ['remote-host', String.raw`unix:\\host\pipe\phi-pi-` + 'a'.repeat(32)],
        ['short-pipe', String.raw`unix:\\.\pipe\phi-pi-abc`],
        ['nonhex-pipe', String.raw`unix:\\.\pipe\phi-pi-` + 'zz'.repeat(16)],
        ['passthrough', 'passthrough:///tmp/x'],
    ])('rejects %s', (_name, target) => {
        expect(() => parseTarget(target)).toThrow();
    });
});
