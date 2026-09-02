// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { SyncManager } from '../web/sync.js';

// Sync Board desktop-alert markers — desktop-gated transient title
// signal. These tests pin:
//   - PHI_NOTIF / PHI_ALARM markers are scanned from the message key
//     AND the message value after a refresh renders
//   - the marker title is written only under desktop detection (an
//     Electron user agent or ?desktop=1); a plain browser never sets it
//   - PHI_ALARM wins over PHI_NOTIF, and the title is truncated

setupDomHarness();

const ORIGINAL_HREF = window.location.href;

beforeEach(() => {
    document.title = '';
});

afterEach(() => {
    window.history.replaceState(null, '', ORIGINAL_HREF);
});

function bootstrapDom() {
    document.body.innerHTML = `
        <div id="sync-panel" class="sync-panel"></div>
    `;
}

function buildAppStub() {
    return {
        showToast: vi.fn(),
        sessionsManager: {
            config: { sync_coordinator: 'http://localhost:7070' },
            loadConfig: vi.fn().mockResolvedValue(undefined),
        },
        diffController: { isPanelOpen: true, activeTab: 'sync' },
    };
}

// Refreshes once with the given messages and returns the SyncManager
// (the constructor polls immediately, so the marker lands on the first
// refresh).
async function refreshWith(messages) {
    mockFetch((url) => {
        // buildProxyUrl wraps every coordinator request in
        // /api/proxy?url=<encoded>, so match on the decoded inner URL.
        const target = decodeURIComponent(
            String(url).match(/\/api\/proxy\?url=([^&]+)/)?.[1] ?? String(url),
        );
        if (target.endsWith('/api/sync/messages')) return messages;
        return [];
    });
    const manager = new SyncManager(buildAppStub());
    await new Promise((r) => setTimeout(r, 0));
    return manager;
}

function msg(key, value, updatedAt = '2026-07-22T00:00:00Z') {
    return { key, value, updated_at: updatedAt };
}

describe('SyncManager — desktop alert title marker', () => {
    it('sets the PHI_NOTIF marker title under an Electron user agent (marker in the value)', async () => {
        vi.stubGlobal('navigator', { userAgent: 'Electron/33.4.11' });
        bootstrapDom();
        await refreshWith([msg('status_check', 'all ok PHI_NOTIF')]);
        expect(document.title).toBe('PHI_NOTIF status_check');
    });

    it('scans the key as well as the value for PHI_NOTIF', async () => {
        vi.stubGlobal('navigator', { userAgent: 'Electron/33.4.11' });
        bootstrapDom();
        await refreshWith([msg('deploy PHI_NOTIF', 'plain value')]);
        expect(document.title).toBe('PHI_NOTIF deploy PHI_NOTIF');
    });

    it('sets the marker title under ?desktop=1 (the other desktop detection path)', async () => {
        window.history.replaceState(null, '', '/?desktop=1');
        bootstrapDom();
        await refreshWith([msg('status_check', 'ok PHI_NOTIF')]);
        expect(document.title).toBe('PHI_NOTIF status_check');
    });

    it('never sets the marker in a plain browser (no Electron, no ?desktop=1)', async () => {
        bootstrapDom();
        document.title = 'Φ phi — charon';
        await refreshWith([
            msg('status_check', 'ok PHI_NOTIF'),
            msg('alarm_key', 'boom PHI_ALARM'),
        ]);
        expect(document.title).toBe('Φ phi — charon');
    });

    it('sets the PHI_ALARM marker title from the key and from the value', async () => {
        vi.stubGlobal('navigator', { userAgent: 'Electron/33.4.11' });
        bootstrapDom();
        await refreshWith([msg('build PHI_ALARM', 'x')]);
        expect(document.title).toBe('PHI_ALARM build PHI_ALARM');
        document.title = '';
        await refreshWith([msg('build', 'failed PHI_ALARM')]);
        expect(document.title).toBe('PHI_ALARM build');
    });

    it('prefers PHI_ALARM over PHI_NOTIF when both markers are present', async () => {
        vi.stubGlobal('navigator', { userAgent: 'Electron/33.4.11' });
        bootstrapDom();
        await refreshWith([
            msg('quiet', 'info PHI_NOTIF', '2026-07-22T00:00:00Z'),
            msg('loud', 'boom PHI_ALARM', '2026-07-22T00:00:01Z'),
        ]);
        expect(document.title).toBe('PHI_ALARM loud');
    });

    it('truncates the marker title to a bounded length', async () => {
        vi.stubGlobal('navigator', { userAgent: 'Electron/33.4.11' });
        bootstrapDom();
        const longKey = `${'k'.repeat(300)} PHI_NOTIF`;
        await refreshWith([msg(longKey, 'x')]);
        expect(document.title.length).toBe(120);
        expect(document.title.startsWith('PHI_NOTIF ')).toBe(true);
    });

    it('leaves the title untouched when no message carries a marker', async () => {
        vi.stubGlobal('navigator', { userAgent: 'Electron/33.4.11' });
        bootstrapDom();
        document.title = 'ϕ phi — charon';
        await refreshWith([msg('status_check', 'all ok')]);
        expect(document.title).toBe('ϕ phi — charon');
    });
});
