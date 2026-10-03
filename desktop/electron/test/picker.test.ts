/** Add-server picker tests (vitest + jsdom): pins the picker's add-only contract. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const htmlSource = readFileSync(path.join(srcDir, 'picker.html'), 'utf8');

describe('picker.html (the add-server picker)', () => {
  it('is add-only: the add form renders and no saved-server management remains', () => {
    const doc = new JSDOM(htmlSource).window.document;
    expect(doc.getElementById('server-url')).not.toBeNull();
    expect(doc.getElementById('add')).not.toBeNull();
    expect(doc.getElementById('cancel')).not.toBeNull();
    expect(doc.getElementById('servers')).toBeNull();
    expect(doc.querySelector('.server-actions')).toBeNull();
    expect(doc.querySelector('.rename-form')).toBeNull();
    expect(htmlSource).not.toContain('onPickerProfiles');
    expect(htmlSource).not.toContain('postRenameProfile');
    expect(htmlSource).not.toContain('postRemoveProfile');
  });

  it('posts the normalized server URL through postAddServer on Add', () => {
    const sent: string[] = [];
    const dom = new JSDOM(htmlSource, {
      url: 'file:///picker.html',
      runScripts: 'dangerously',
      beforeParse(window) {
        (window as { electron?: unknown }).electron = {
          postAddServer: (url: string) => sent.push(url),
          onAddServerResult: () => () => {},
        };
      },
    });
    const doc = dom.window.document;
    const input = doc.getElementById('server-url') as HTMLInputElement;
    input.value = 'https://server.example.com';
    (doc.getElementById('add') as HTMLButtonElement).click();
    // The default Phi port is applied when the URL carries none.
    expect(sent).toEqual(['https://server.example.com:7070/']);
    // Enter submits too; a scheme-less input gets http://.
    input.value = 'example.com';
    input.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    expect(sent).toEqual([
      'https://server.example.com:7070/',
      'http://example.com:7070/',
    ]);
  });

  it('triggers postCopyAllServers when Copy All is clicked', async () => {
    let copyCalled = false;
    const dom = new JSDOM(htmlSource, {
      url: 'file:///picker.html',
      runScripts: 'dangerously',
      beforeParse(window) {
        (window as { electron?: unknown }).electron = {
          postAddServer: () => {},
          onAddServerResult: () => () => {},
          postCopyAllServers: () => {
            copyCalled = true;
            return Promise.resolve({ ok: true, count: 3 });
          },
        };
      },
    });
    const doc = dom.window.document;
    const copyBtn = doc.getElementById('copy-all') as HTMLButtonElement;
    expect(copyBtn).not.toBeNull();
    copyBtn.click();
    expect(copyCalled).toBe(true);
  });

  it('submits multiple URLs via postAddServers when pasted or entered', async () => {
    let bulkAdded: string[] = [];
    const dom = new JSDOM(htmlSource, {
      url: 'file:///picker.html',
      runScripts: 'dangerously',
      beforeParse(window) {
        (window as { electron?: unknown }).electron = {
          postAddServer: () => {},
          onAddServerResult: () => () => {},
          postAddServers: (urls: string[]) => {
            bulkAdded = urls;
            return Promise.resolve({ ok: true, added: urls.length, errors: [] });
          },
        };
      },
    });
    const doc = dom.window.document;
    const input = doc.getElementById('server-url') as HTMLInputElement;
    const addBtn = doc.getElementById('add') as HTMLButtonElement;

    input.value = 'http://srv1:7070 http://srv2:8080 srv3.local';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(addBtn.textContent).toBe('Add 3 servers');

    addBtn.click();
    await Promise.resolve();
    expect(bulkAdded).toEqual([
      'http://srv1:7070/',
      'http://srv2:8080/',
      'http://srv3.local:7070/',
    ]);
  });
});
