// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { App } from '../web/app.js';

setupDomHarness();

describe('browser config import fallback', () => {
    it.each([
        ['models', 'PHIMODELS', '/api/config/import-models'],
        ['commands', 'PHICMDS', '/api/config/import-cmds'],
    ])(
        'uses the browser prompt for %s when clipboard access is unavailable',
        async (_label, prefix, url) => {
            vi.stubGlobal('navigator', { clipboard: undefined });
            const prompt = vi.fn(() => `${prefix}:example`);
            vi.stubGlobal('prompt', prompt);
            const fetch = vi.fn(async () => ({
                ok: true,
                text: async () => '',
            }));
            vi.stubGlobal('fetch', fetch);

            const button = document.createElement('button');
            await App.prototype._doImportConfig.call({}, url, button, prefix);

            expect(prompt).toHaveBeenCalledWith(
                `Paste your config string here (starts with ${prefix}:):`,
            );
            expect(fetch).toHaveBeenCalledWith(
                url,
                expect.objectContaining({
                    body: JSON.stringify({ config: `${prefix}:example` }),
                }),
            );
        },
    );
});
