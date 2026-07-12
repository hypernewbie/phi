// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { App } from '../web/app.js';

// Fleet panel rendering tests (Phase 6 / plan §3.4).
// Pure DOM-level: renderFleetPanel() takes a status array and updates the
// sidebar widget. Hidden when no peers, color-coded by reachability,
// click-to-open on reachable rows, disabled on unreachable.

setupDomHarness();

function fixture() {
    document.body.innerHTML = `
        <div id="fleet-panel" class="fleet-panel" style="display:none">
            <div class="fleet-panel-header">
                <span class="fleet-panel-title">FLEET</span>
                <span id="fleet-stale-badge" class="fleet-stale-badge" style="display:none">!</span>
            </div>
            <div id="fleet-peer-list" class="fleet-peer-list"></div>
        </div>
    `;
}

function makeApp() {
    const a = Object.create(App.prototype);
    return a;
}

describe('App.renderFleetPanel', () => {
    beforeEach(fixture);

    it('hides the panel when statuses is empty', () => {
        const a = makeApp();
        a.renderFleetPanel([]);
        expect(document.getElementById('fleet-panel').style.display).toBe('none');
    });

    it('hides the panel when statuses is null', () => {
        const a = makeApp();
        a.renderFleetPanel(null);
        expect(document.getElementById('fleet-panel').style.display).toBe('none');
    });

    it('shows the panel and renders a reachable row', () => {
        const a = makeApp();
        a.renderFleetPanel([
            { name: 'zen', url: 'http://zen:7777', reachable: true, stale: false,
              tab_count: 3, busy_count: 1, idle_min: 14, version: '0.8.0' }
        ]);
        const panel = document.getElementById('fleet-panel');
        expect(panel.style.display).not.toBe('none');

        const row = document.querySelector('.fleet-peer-row');
        expect(row).toBeTruthy();
        expect(row.classList.contains('reachable')).toBe(true);
        expect(row.classList.contains('unreachable')).toBe(false);
        expect(row.querySelector('.fleet-peer-name').textContent).toBe('zen');

        const meta = row.querySelector('.fleet-peer-meta').textContent;
        expect(meta).toContain('3t');
        expect(meta).toContain('1b');
        expect(meta).toContain('14m');
        expect(meta).toContain('0.8.0');
    });

    it('marks rows unreachable when peer is not reachable, disables click', () => {
        const a = makeApp();
        a.renderFleetPanel([
            { name: 'down', url: 'http://down:1', reachable: false, stale: false,
              tab_count: 0, busy_count: 0, idle_min: -1, error: 'connection refused' }
        ]);
        const row = document.querySelector('.fleet-peer-row');
        expect(row.classList.contains('unreachable')).toBe(true);
        expect(row.disabled).toBe(true);
        // Offline marker is shown instead of tab counts
        expect(row.querySelector('.fleet-peer-meta').textContent).toBe('offline');
        // Stale badge appears because there is an unreachable peer
        expect(document.getElementById('fleet-stale-badge').style.display).not.toBe('none');
    });

    it('marks rows stale when peer was reachable but stale', () => {
        const a = makeApp();
        a.renderFleetPanel([
            { name: 'wobbly', url: 'http://wobbly:7777', reachable: true, stale: true,
              tab_count: 0, busy_count: 0, idle_min: -1 }
        ]);
        const row = document.querySelector('.fleet-peer-row');
        expect(row.classList.contains('stale')).toBe(true);
        expect(row.disabled).toBe(false); // still clickable (URL known good)
    });

    it('click on reachable row opens peer.url in a new tab', () => {
        const a = makeApp();
        const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
        a.renderFleetPanel([
            { name: 'zen', url: 'http://zen:7777', reachable: true, stale: false,
              tab_count: 1, busy_count: 0, idle_min: 0 }
        ]);
        document.querySelector('.fleet-peer-row').click();
        expect(openSpy).toHaveBeenCalledWith('http://zen:7777', '_blank', 'noopener');
        openSpy.mockRestore();
    });

    it('renders multiple rows and clears stale badge when all reachable', () => {
        const a = makeApp();
        a.renderFleetPanel([
            { name: 'a', url: 'http://a', reachable: true, stale: false, tab_count: 1, busy_count: 0, idle_min: 0 },
            { name: 'b', url: 'http://b', reachable: true, stale: false, tab_count: 1, busy_count: 0, idle_min: 0 }
        ]);
        expect(document.querySelectorAll('.fleet-peer-row').length).toBe(2);
        expect(document.getElementById('fleet-stale-badge').style.display).toBe('none');
    });

    it('escapes peer.version HTML in the meta line (no XSS via /api/version)', () => {
        const a = makeApp();
        a.renderFleetPanel([
            { name: 'evil', url: 'http://evil', reachable: true, stale: false,
              tab_count: 0, busy_count: 0, idle_min: 0,
              version: '<img src=x onerror=alert(1)>' }
        ]);
        // The version span should contain escaped text, not raw HTML
        const verSpan = document.querySelector('.fleet-peer-version');
        expect(verSpan).toBeTruthy();
        expect(verSpan.innerHTML).not.toContain('<img');
        expect(verSpan.textContent).toContain('<img'); // text content is literal
    });

    it('renders idle_min=-1 as ? (unknown)', () => {
        const a = makeApp();
        a.renderFleetPanel([
            { name: 'cold', url: 'http://cold', reachable: true, stale: false,
              tab_count: 0, busy_count: 0, idle_min: -1 }
        ]);
        const meta = document.querySelector('.fleet-peer-meta').textContent;
        // Just verify the meta is present; exact format can evolve.
        expect(meta).toContain('0t');
        expect(meta).toContain('?');
    });
});

describe('App.startFleetPolling', () => {
    beforeEach(() => {
        fixture();
        document.getElementById('sidebar-panel')?.remove(); // no sidebar => visible-by-default
    });

    it('is idempotent (multiple calls do not stack intervals)', () => {
        const a = makeApp();
        vi.spyOn(window, 'fetch').mockResolvedValue({ ok: true, json: async () => [] });
        a.startFleetPolling();
        const first = a._fleetPollTimer;
        a.startFleetPolling();
        expect(a._fleetPollTimer).toBe(first);
    });
});