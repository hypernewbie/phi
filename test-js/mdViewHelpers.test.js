import { describe, it, expect } from 'vitest';
import { decodeEventFrame, mdEventMatchesPath } from '../web/md-view.js';

// Pure helpers of the standalone markdown viewer (web-src/md-view.ts).
// No DOM needed: importing md-view.js is side-effect-free by design
// (initMdView is only called from md.html).

describe('decodeEventFrame', () => {
    it('splits a 0x07 frame into type and JSON payload (round-trip)', () => {
        const payload = JSON.stringify({ dir: '/tmp/docs' });
        const bytes = new Uint8Array([0x07, ...new TextEncoder().encode(payload)]);
        const frame = decodeEventFrame(bytes);
        expect(frame.type).toBe(0x07);
        expect(JSON.parse(frame.payload)).toEqual({ dir: '/tmp/docs' });
    });

    it('handles an empty payload', () => {
        const frame = decodeEventFrame(new Uint8Array([0x05]));
        expect(frame.type).toBe(0x05);
        expect(frame.payload).toBe('');
    });
});

describe('mdEventMatchesPath', () => {
    it('matches a file inside the event dir', () => {
        expect(mdEventMatchesPath('/a/docs', '/a/docs/x.md')).toBe(true);
    });

    it('does not match a sibling dir sharing a prefix', () => {
        expect(mdEventMatchesPath('/a/docs', '/a/docs2/x.md')).toBe(false);
    });

    it('matches (refreshes anyway) when dir is unknown', () => {
        expect(mdEventMatchesPath('', '/a/docs/x.md')).toBe(true);
        expect(mdEventMatchesPath(null, '/a/docs/x.md')).toBe(true);
    });

    it('handles a trailing-slash dir', () => {
        expect(mdEventMatchesPath('/a/docs/', '/a/docs/x.md')).toBe(true);
    });

    it('matches Windows backslash paths', () => {
        expect(mdEventMatchesPath('C:\\ws', 'C:\\ws\\x.md')).toBe(true);
    });
});
