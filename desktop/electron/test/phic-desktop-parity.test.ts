// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import {
  canonicalHostname,
  greekGlyphForHostname,
  identityLabel,
} from '../src/renderer.js';
import { renderState as renderRailMenu } from '../src/rail-menu.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEndpoint } from '../src/controller.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const picker = readFileSync(
  path.join(root, 'desktop/electron/src/picker.html'),
  'utf8',
);
let dir: string, binary: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'phic-desktop-parity-'));
  binary = path.join(
    dir,
    process.platform === 'win32' ? 'parity.exe' : 'parity',
  );
  execFileSync('go', ['test', '-c', '-o', binary, './internal/phic'], {
    cwd: root,
    timeout: 120000,
  });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function oracle(inputs: string[]) {
  const dom = new JSDOM(picker, {
    url: 'file:///picker.html',
    runScripts: 'dangerously',
    beforeParse(w) {
      (w as { electron?: unknown }).electron = {
        onAddServerResult: () => () => {},
      };
    },
  });
  try {
    return inputs.map((raw) => {
      const URLs = (
        dom.window as unknown as { parseUrls: (raw: string) => string[] }
      ).parseUrls(raw);
      const Origins: string[] = [],
        Hosts: string[] = [],
        Errors: string[] = [];
      for (const url of URLs) {
        try {
          const p = parseEndpoint(url);
          Origins.push(p.origin);
          Hosts.push(p.host);
        } catch (e) {
          Errors.push((e as Error).message);
        }
      }
      return { URLs, Origins, Hosts, Errors };
    });
  } finally {
    dom.window.close();
  }
}
function native(inputs: string[]) {
  return JSON.parse(
    execFileSync(binary, ['-test.run=^TestDesktopParityHelper$'], {
      cwd: root,
      env: { ...process.env, PHIC_DESKTOP_PARITY: '1' },
      input: JSON.stringify({ Inputs: inputs }),
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 16 * 1024 * 1024,
    }),
  );
}

describe('phic is desktop lite, including the actual desktop input form', () => {
  it('identity, glyph collisions, context status and theme materials match desktop', () => {
    const names = [
      'charon.local',
      'https://charon:7070',
      '[::1]',
      '東京',
      'faß.local',
      '',
      ...Array(10).fill('same-host'),
    ];
    const themes = [
      '',
      'purple',
      'blue',
      'green',
      'amber',
      'red',
      'white',
      'not-a-theme',
    ];
    const UI = names.flatMap((Hostname, i) =>
      themes.flatMap((Theme) =>
        ['up', 'down', 'unknown'].map((Health) => ({
          Hostname,
          Theme,
          Health,
          Name: i % 2 ? 'User-owned label' : 'Fallback',
        })),
      ),
    );
    const actual = JSON.parse(
      execFileSync(binary, ['-test.run=^TestDesktopParityHelper$'], {
        cwd: root,
        env: {
          ...process.env,
          PHIC_DESKTOP_PARITY: '1',
          TERM: 'xterm-256color',
          NO_COLOR: '',
        },
        input: JSON.stringify({ UI }),
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      }),
    );
    const used = new Set<string>();
    const dom = new JSDOM('<div id="rail-menu-root"></div>', {
      url: 'file:///rail-menu.html?profile=oracle',
    });
    const oldWindow = globalThis.window,
      oldDocument = globalThis.document;
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
    });
    try {
      UI.forEach((row, i) => {
        const profile = {
          id: 'oracle',
          name: row.Name,
          hostname: row.Hostname,
          origin: 'http://oracle:7070/',
          accent: '',
          cpu: null,
        };
        const label = identityLabel(profile),
          glyph = greekGlyphForHostname(label, used);
        used.add(glyph);
        renderRailMenu({
          profile,
          health: row.Health as 'up' | 'down' | 'unknown',
          unread: 0,
        });
        expect(actual[i].Label).toBe(label);
        expect(actual[i].Glyph).toBe(glyph);
        expect(actual[i].Status).toBe(
          dom.window.document.querySelector('.rail-menu-status')?.textContent,
        );
        if (row.Theme === '') expect(actual[i].Text).toContain('228;227;233');
        if (row.Health !== 'up')
          expect(actual[i].Rail).toContain('120;118;138');
      });
      expect(canonicalHostname('faß.local')).toBe('FASS');
    } finally {
      Object.assign(globalThis, { window: oldWindow, document: oldDocument });
      dom.window.close();
    }
  });

  it('bare hostname, implicit Phi port, explicit default port and multi-server paste match desktop', () => {
    const inputs = [
      'jupiter',
      'JUPITER.local',
      'https://jupiter',
      'http://jupiter:80',
      'https://jupiter:443',
      'jupiter:8080',
      'jupiter\r\nhttps://charon\t[::1]:9090',
      'example.com/a/..',
      'http://user:password@host',
      'http://host/path',
      'http://host?',
      'http://host#',
      'bad://host',
      'http://[oops] good.local',
      '\ufeff東京.example\u00a0charon',
    ];
    expect(native(inputs)).toEqual(oracle(inputs));
  });
  it('differentially checks URL normalization and controller validation across a generated corpus', () => {
    const inputs: string[] = [];
    const schemes = ['', 'http://', 'https://', 'HTTP://', 'ftp://'];
    const hosts = [
      'jupiter',
      'my_server.local',
      'EXAMPLE.COM.',
      'tést.example',
      'faß.de',
      '東京.example',
      '127.0.0.1',
      '127.1',
      '0x7f000001',
      '0127.0.0.1',
      '[0:0:0:0:0:0:0:1]',
      '[::ffff:192.0.2.1]',
      '',
      'bad..name',
      '-bad',
      'a-.b',
      '%65xample.com',
      'user@host',
    ];
    const ports = [
      '',
      ':7070',
      ':80',
      ':443',
      ':00080',
      ':07070',
      ':0',
      ':65536',
      ':',
      ':bad',
    ];
    const paths = ['', '/', '/a/..', '/a', '?', '#', '\\', '/./'];
    for (const scheme of schemes)
      for (const host of hosts)
        for (const port of ports)
          for (const suffix of paths) {
            inputs.push(scheme + host + port + suffix);
          }
    const expected = oracle(inputs),
      actual = native(inputs);
    const differences = inputs.flatMap((input, i) =>
      JSON.stringify(actual[i]) === JSON.stringify(expected[i])
        ? []
        : [{ input, actual: actual[i], expected: expected[i] }],
    );
    expect(differences.slice(0, 20)).toEqual([]);
    expect(differences).toHaveLength(0);
  });
});
