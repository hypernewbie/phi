import { describe, it, expect } from 'vitest';
import {
    displayHostname,
    formatTerminalActivityTitle,
    buildSelfHud,
} from '../web/util.js';

// macOS reports its hostname with the mDNS/Bonjour suffix attached
// ("studio.local"), which showed up verbatim in the header, the empty state,
// the browser title, and -- uppercased to a shouty ".LOCAL" -- in Settings ▸
// About. phi labels one machine, so the suffix carries no information.

describe('displayHostname', () => {
    it('drops the macOS .local suffix', () => {
        expect(displayHostname('studio.local')).toBe('studio');
    });

    it('drops it regardless of case', () => {
        expect(displayHostname('Studio.LOCAL')).toBe('Studio');
        expect(displayHostname('studio.Local')).toBe('studio');
    });

    it('handles the fully-qualified trailing dot', () => {
        expect(displayHostname('studio.local.')).toBe('studio');
    });

    it('preserves the rest of a dotted name', () => {
        expect(displayHostname('my.studio.local')).toBe('my.studio');
    });

    it('leaves non-.local hostnames alone', () => {
        expect(displayHostname('hora')).toBe('hora');
        expect(displayHostname('box.lan')).toBe('box.lan');
        expect(displayHostname('host.localdomain')).toBe('host.localdomain');
        // Only a trailing segment counts -- not ".local" appearing mid-name.
        expect(displayHostname('local.example.com')).toBe('local.example.com');
        expect(displayHostname('localhost')).toBe('localhost');
    });

    it('never strips itself down to nothing', () => {
        // Degenerate, but returning '' here would blank the header.
        expect(displayHostname('.local')).toBe('.local');
    });

    it('tolerates missing input', () => {
        expect(displayHostname(null)).toBe('');
        expect(displayHostname(undefined)).toBe('');
        expect(displayHostname('')).toBe('');
        expect(displayHostname('   ')).toBe('');
    });
});

describe('surfaces that render a hostname', () => {
    it('keeps it out of the browser title', () => {
        const quiet = { hasActivity: false, hasAttention: false };
        expect(formatTerminalActivityTitle('studio.local', quiet)).toBe(
            'Φ studio',
        );
        expect(
            formatTerminalActivityTitle('studio.local', {
                hasActivity: true,
                hasAttention: true,
            }),
        ).toBe('● ϕ studio');
    });

    it('falls back to phi when there is no hostname', () => {
        const quiet = { hasActivity: false, hasAttention: false };
        expect(formatTerminalActivityTitle('', quiet)).toBe('Φ phi');
        expect(formatTerminalActivityTitle(null, quiet)).toBe('Φ phi');
        // A hostname that is only the suffix must not collapse to the fallback.
        expect(formatTerminalActivityTitle('.local', quiet)).toBe('Φ .local');
    });

    it('keeps it out of the self HUD', () => {
        const hud = buildSelfHud({
            hostname: 'studio.local',
            version: '0.15.3',
            cpuPercent: null,
            tabs: [],
        });
        expect(hud.hostname).toBe('studio');
    });
});
