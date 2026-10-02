// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { mountFileView } from '../web/file-viewer.js';

setupDomHarness();
afterEach(() => vi.unstubAllGlobals());

const source =
    '#include <iostream>\n\tconst char* value = "<tag>& text";  \n\n';

describe('source preview typography hook', () => {
    for (const extension of ['cpp', 'hpp', 'c', 'go', 'ts', 'txt']) {
        it(`scopes ${extension} typography to its source block and preserves source text`, async () => {
            vi.stubGlobal(
                'fetch',
                vi
                    .fn()
                    .mockResolvedValue({ ok: true, text: async () => source }),
            );
            const container = document.createElement('div');
            const handle = await mountFileView({
                path: `source.${extension}`,
                cwd: '/project',
                container,
            });
            const pre = container.querySelector('pre.file-viewer-code');
            expect(pre).not.toBeNull();
            expect(pre.querySelector('code').textContent).toBe(source);
            expect(container.querySelector('tag')).toBeNull();
            expect(handle.rawText).toBe(source);
            expect(handle.kind).toBe('code');
            handle.dispose();
            expect(container.childNodes).toHaveLength(0);
        });
    }
});
