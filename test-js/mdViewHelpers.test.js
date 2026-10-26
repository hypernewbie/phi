import { describe, it, expect } from 'vitest';
import { decodeNotificationDir, mdEventMatchesPath } from '../web/md-view.js';
import { Notification } from '../web/proto/events.js';

// Pure helpers of the standalone markdown viewer (web-src/md-view.ts).
// No DOM needed: importing md-view.js is side-effect-free by design
// (initMdView is only called from md.html).

function encodeNotification(kind) {
    return Notification.encode(
        Notification.fromPartial(kind === undefined ? {} : { kind }),
    ).finish();
}

describe('decodeNotificationDir', () => {
    it('returns the dir of a markdown notification (round-trip)', () => {
        const bytes = encodeNotification({
            $case: 'markdownChanged',
            value: { dir: '/tmp/docs' },
        });
        expect(decodeNotificationDir(bytes)).toBe('/tmp/docs');
    });

    it('returns null for other notification kinds', () => {
        const sync = encodeNotification({
            $case: 'syncChanged',
            value: { action: 'upsert', key: 'k' },
        });
        expect(decodeNotificationDir(sync)).toBeNull();
        const shutdown = encodeNotification({
            $case: 'shutdown',
            value: { reason: 'restart' },
        });
        expect(decodeNotificationDir(shutdown)).toBeNull();
    });

    it('decodes and ignores a large sync notification', () => {
        // Sync values can exceed the server's inbound 4 KiB events cap. The
        // viewer must keep ignoring them without treating the frame as fatal.
        const sync = encodeNotification({
            $case: 'syncChanged',
            value: { action: 'upsert', key: 'k'.repeat(8 * 1024) },
        });
        expect(sync.byteLength).toBeGreaterThan(4096);
        expect(decodeNotificationDir(sync)).toBeNull();
    });

    it('returns null for empty and undecodable payloads', () => {
        expect(decodeNotificationDir(encodeNotification(undefined))).toBeNull();
        expect(decodeNotificationDir(new Uint8Array([0x82, 0xff]))).toBeNull();
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
