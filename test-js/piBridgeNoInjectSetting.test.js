// @vitest-environment jsdom
// The pi bridge no-inject checkbox mirrors the pi_offline checkbox:
// one POST to a config endpoint, applied on the next spawn.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { openSettingsModal } from '../web/settings.js';

setupDomHarness();

const ACCENTS = { purple: { accent: '#7c6af7' } };

function buildApp(config = {}) {
    return {
        versionInfo: {
            version: '0.12.1',
            commit: 'deadbeef1234567',
            date: '2026-07-19T16:00:00Z',
            buildSource: 'npm',
        },
        hostname: 'hammond',
        accessAuthEnabled: false,
        useExistingTerminalTab: false,
        config: {
            auto_reconnect: 'visible',
            fast_mode: false,
            pi_offline: false,
            pi_bridge_no_inject: false,
            ...config,
        },
        uiFontFamily: '',
        uiFontSize: 0,
        terminalFontFamily: '',
        terminalFontSize: 0,
        customFontName: '',
        sessionsManager: { workspaces: ['/proj/a'] },
        tabManager: {},
    };
}

function checkbox() {
    return document.getElementById('settings-pi-bridge-no-inject');
}

afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

describe('pi bridge no-inject checkbox', () => {
    it('renders the current server state', () => {
        openSettingsModal(buildApp({ pi_bridge_no_inject: true }), ACCENTS);
        const input = checkbox();
        expect(input).not.toBeNull();
        expect(input.checked).toBe(true);
    });

    it('persists the new state through the config endpoint', async () => {
        const fetchMock = vi.fn(async () => ({ ok: true }));
        vi.stubGlobal('fetch', fetchMock);
        const app = buildApp();
        openSettingsModal(app, ACCENTS);
        const input = checkbox();
        expect(input.checked).toBe(false);

        input.checked = true;
        input.dispatchEvent(new Event('change'));

        expect(app.config.pi_bridge_no_inject).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/config/pi-bridge-no-inject');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ enabled: true });
    });

    it('keeps the page usable when the server refuses the change', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new Error('offline');
            }),
        );
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const app = buildApp();
        openSettingsModal(app, ACCENTS);
        const input = checkbox();
        input.checked = true;
        input.dispatchEvent(new Event('change'));
        await Promise.resolve();
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});
