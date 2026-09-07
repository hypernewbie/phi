// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { App } from '../web/app.js';

setupDomHarness();

describe('config import fallback', () => {
    it.each([
        ['models', 'PHIMODELS', '/api/config/import-models'],
        ['commands', 'PHICMDS', '/api/config/import-cmds'],
    ])(
        'uses an in-page paste dialog for %s when clipboard access is unavailable',
        async (_label, prefix, url) => {
            vi.stubGlobal('navigator', { clipboard: undefined });
            const prompt = vi.fn();
            vi.stubGlobal('prompt', prompt);
            const fetch = vi.fn(async () => ({
                ok: true,
                text: async () => '',
            }));
            vi.stubGlobal('fetch', fetch);

            const button = document.createElement('button');
            const context = {
                openConfigEditor: App.prototype.openConfigEditor,
            };
            const importing = App.prototype._doImportConfig.call(
                context,
                url,
                button,
                prefix,
            );

            const textarea = document.getElementById('config-editor-config');
            expect(textarea).toBeTruthy();
            textarea.value = `${prefix}:example`;
            document.querySelector('.config-editor-footer .btn-accent').click();

            await importing;

            expect(prompt).not.toHaveBeenCalled();
            expect(fetch).toHaveBeenCalledWith(
                url,
                expect.objectContaining({
                    body: JSON.stringify({ config: `${prefix}:example` }),
                }),
            );
        },
    );

    it('falls back to browser prompt when openConfigEditor is not available', async () => {
        vi.stubGlobal('navigator', { clipboard: undefined });
        const prompt = vi.fn(() => 'PHICONFIG:example');
        vi.stubGlobal('prompt', prompt);
        const fetch = vi.fn(async () => ({
            ok: true,
            text: async () => '',
        }));
        vi.stubGlobal('fetch', fetch);

        const button = document.createElement('button');
        await App.prototype._doImportConfig.call(
            {},
            '/api/config/import',
            button,
            'PHICONFIG',
        );

        expect(prompt).toHaveBeenCalledWith(
            'Paste your config string here (starts with PHICONFIG:):',
        );
        expect(fetch).toHaveBeenCalledWith(
            '/api/config/import',
            expect.objectContaining({
                body: JSON.stringify({ config: 'PHICONFIG:example' }),
            }),
        );
    });
});
