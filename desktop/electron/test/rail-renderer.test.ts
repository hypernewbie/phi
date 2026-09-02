/**
 * Rail renderer tests (vitest + jsdom). Parses the rail page
 * (src/renderer.html + src/rail.css) and asserts the rail structure: a
 * fixed 72px sidebar (#rail) with the server-list placeholder
 * (#rail-list) and the add button (#rail-add), over Phi's dark palette
 * mirrored from web/style.css. Exercises the renderer module
 * (src/renderer.ts — compiled to dist/renderer.js) against a JSDOM
 * document with a recording-fake preload bridge, and pins the rail IPC
 * contract:
 *
 *   - main -> renderer: 'phi:rail-state' — RailState snapshots pushed on
 *     every controller event (the main-process push is asserted in
 *     test/main.test.ts and exercised end-to-end by test/smoke.test.ts;
 *     this file pins the channel string in src/preload.ts and the
 *     renderer's re-render-on-snapshot behavior);
 *   - renderer -> main: 'phi:select-profile' (a rail item click posts
 *     the profile id via window.electron.postSelectProfile),
 *     'phi:open-picker' (the add button posts the picker intent).
 *
 * Test isolation (documented): NO real browser is spun up — the page is
 * parsed with jsdom and the renderer module is imported directly under
 * vitest (its auto-boot guards on the preload bridge, so importing is
 * inert; tests call boot()/render() explicitly with a recording-fake
 * bridge). No Electron module is imported at runtime.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import {
  badgeText,
  boot,
  canonicalHostname,
  greekGlyphForHostname,
  identityLabel,
  render,
} from '../src/renderer.js';
import type { RailState } from '../src/electron.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const htmlSource = readFileSync(path.join(srcDir, 'renderer.html'), 'utf8');
const cssSource = readFileSync(path.join(srcDir, 'rail.css'), 'utf8');
const preloadSource = readFileSync(path.join(srcDir, 'preload.ts'), 'utf8');

const SNAPSHOT: RailState = {
  profiles: [
    {
      id: 'a',
      name: 'Alpha Phi',
      origin: 'http://127.0.0.1:7070/',
      hostname: 'charon.local',
      accent: '#e76f51',
      cpu: 62,
    },
    {
      id: 'b',
      name: 'Beta',
      origin: 'http://10.0.0.5:8080/',
      hostname: '',
      accent: '',
      cpu: null,
    },
  ],
  activeId: 'b',
  health: { a: 'up', b: 'down' },
  unread: { a: 12, b: 1 },
};

afterEach(() => {
  // Restore any withPage-managed document before the recording-fake
  // bridge is cleared (the bridge and the swap are independent).
  const pending = pendingDocRestore;
  pendingDocRestore = null;
  if (pending) Object.defineProperty(globalThis, 'document', pending);
  delete (window as { electron?: unknown }).electron;
});

// Pending withPage swap: when the helper closes over JSDOM globals that
// renderer handlers also read at dispatch time, the global document must
// remain pointed at the JSDOM document for the whole test, not be
// reverted on withPage's frame exit. The previous implementation
// reverted immediately, which broke the contextmenu / drag-and-drop
// suites (event handlers captured globalThis.document and got back the
// vitest-jsdom env document instead of the active rail document).
let pendingDocRestore: PropertyDescriptor | null = null;

/** Points the jsdom globals at a parsed page for the duration of a test. */
function withPage<T>(html: string, fn: (doc: Document) => T): T {
  const dom = new JSDOM(html, { url: 'file:///renderer.html' });
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    value: dom.window.document,
    configurable: true,
    writable: true,
  });
  // Restore from afterEach instead of fn's finally so dispatched event
  // listeners (which read globalThis.document) see the same JSDOM doc.
  pendingDocRestore = prevDoc ?? null;
  try {
    return fn(dom.window.document);
  } catch (err) {
    pendingDocRestore = null;
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    throw err;
  }
}

describe('renderer.html (the rail page)', () => {
  it('parses and renders the fixed 72px rail with the server-list placeholder and the add button', () => {
    const doc = new JSDOM(htmlSource, { url: 'file:///renderer.html' }).window
      .document;
    const rail = doc.getElementById('rail');
    expect(rail?.tagName.toLowerCase()).toBe('aside');
    expect(doc.getElementById('rail-list')).not.toBeNull();
    expect(doc.getElementById('rail-add')).not.toBeNull();
    expect(doc.title).toBe('Phi');
  });

  it('sizes the rail at exactly 72px with position fixed and mirrors Phi tokens', () => {
    expect(cssSource).toMatch(/width:\s*72px/);
    expect(cssSource).toMatch(/position:\s*fixed/);
    // The palette mirrors web/style.css (same names, same values).
    expect(cssSource).toMatch(/--bg:\s*#08080a/);
    expect(cssSource).toMatch(/--panel:\s*#0d0d10/);
    expect(cssSource).toMatch(/--text:\s*#e4e3e9/);
  });

  it('keeps the rail accent neutral until the active server accent is observed (no default purple)', () => {
    expect(cssSource).toMatch(/--accent:\s*transparent/);
    expect(cssSource).toMatch(/--accent-fallback:\s*transparent/);
    expect(cssSource).not.toMatch(/--accent-fallback:\s*#7c6af7/);
    expect(cssSource).not.toMatch(/--accent:\s*#7c6af7/);
  });

  it('constrains the server list to a scroll region and bottom-anchors the add control', () => {
    expect(cssSource).toMatch(/#rail\s*\{[^}]*display:\s*flex[^}]*\}/s);
    expect(cssSource).toMatch(
      /#rail\s*\{[^}]*flex-direction:\s*column[^}]*\}/s,
    );
    expect(cssSource).toMatch(
      /#rail-list\s*\{[^}]*flex:\s*1\s+1\s+auto[^}]*\}/s,
    );
    expect(cssSource).toMatch(/#rail-list\s*\{[^}]*overflow-y:\s*auto[^}]*\}/s);
    const addRule = /#rail-add\s*\{([^}]*)\}/s.exec(cssSource);
    expect(addRule).not.toBeNull();
    expect(addRule?.[1]).toMatch(/height:\s*40px/);
    expect(addRule?.[1]).not.toMatch(/flex/);
    const listIdx = htmlSource.indexOf('<ul id="rail-list"');
    const addIdx = htmlSource.indexOf('<button id="rail-add"');
    expect(listIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(listIdx);
  });

  it('loads the compiled renderer module (ESM) from ./renderer.js', () => {
    expect(htmlSource).toContain(
      '<script type="module" src="./renderer.js"></script>',
    );
  });
});

describe('rail shape language and health treatment (src/rail.css)', () => {
  it('reuses the browser header-button material for rail entries: same radius, elevated background, border', () => {
    const itemRule = /\.rail-item\s*\{([^}]*)\}/s.exec(cssSource);
    expect(itemRule).not.toBeNull();
    // .header-btn mirror (web/style.css): 6px radius, flat elevated
    // background, 1px bg-border border — no hand-tuned gradient stack.
    expect(itemRule?.[1]).toMatch(/border-radius:\s*6px/);
    expect(itemRule?.[1]).not.toMatch(/border-radius:\s*50%/);
    expect(itemRule?.[1]).toMatch(/background-color:\s*var\(--bg-elevated\)/);
    expect(itemRule?.[1]).toMatch(/border:\s*1px solid var\(--bg-border\)/);
    expect(itemRule?.[1]).not.toMatch(/linear-gradient|radial-gradient/);
    expect(itemRule?.[1]).not.toMatch(/rgba\(24,\s*24,\s*27/);
  });

  it("renders the rail over Phi's obsidian field — the same radial gradient as the web body", () => {
    expect(cssSource).toMatch(
      /#rail\s*\{[^}]*radial-gradient\(circle at 50% 0%, #16161c 0%, #08080a 70%\)/s,
    );
  });

  it('carries no rail brand mark (no railcap) and no meander band', () => {
    expect(cssSource).not.toMatch(/\.rail-brand/);
    expect(htmlSource).not.toMatch(/rail-brand/);
    expect(cssSource).not.toMatch(/data:image\/svg\+xml/);
  });

  it('marks health diegetically: offline entries mute the chip; attention keeps the entry-accent lozenge without clipping', () => {
    const item = /\.rail-item\s*\{([^}]*)\}/s.exec(cssSource);
    expect(item).not.toBeNull();
    expect(item?.[1]).not.toMatch(/overflow:\s*hidden/);
    const offline = /\.rail-item\.offline\s*\{([^}]*)\}/s.exec(cssSource);
    expect(offline).not.toBeNull();
    expect(offline?.[1]).toMatch(/opacity:\s*0\.55/);
    expect(offline?.[1]).toMatch(/var\(--bg-border\)/);
    // No status block element remains in the stylesheet.
    expect(cssSource).not.toMatch(/\.rail-item\s+\.dot/);
    const attention = /\.rail-item\s+\.attention\s*\{([^}]*)\}/s.exec(
      cssSource,
    );
    expect(attention?.[1]).toMatch(/transform:\s*rotate\(45deg\)/);
    expect(attention?.[1]).toMatch(/var\(--entry-accent/);
    expect(attention?.[1]).toMatch(/var\(--accent/);
  });

  it('keeps no green/red health palette in the rail stylesheet', () => {
    expect(cssSource).not.toMatch(/--green/);
    expect(cssSource).not.toMatch(/--red/);
    expect(cssSource).not.toMatch(/#38bdf8/i);
    expect(cssSource).not.toMatch(/#ef4444/i);
  });

  it('never lets rail hover selectors demote the active server', () => {
    expect(cssSource).toMatch(/#rail:hover\s+\.rail-item:not\(\.active\)/);
    expect(cssSource).toMatch(/#rail\s+\.rail-item:not\(\.active\):hover/);
    expect(cssSource).not.toMatch(/#rail:hover\s+\.rail-item\s*\{/);
    expect(cssSource).not.toMatch(/#rail\s+\.rail-item:hover\s*\{/);
  });
});

describe('renderer module (src/renderer.ts)', () => {
  it('badgeText caps the unread display at "9+" — Wails railmodel parity', () => {
    expect(badgeText(0)).toBe('');
    expect(badgeText(3)).toBe('3');
    expect(badgeText(9)).toBe('9');
    expect(badgeText(10)).toBe('9+');
    expect(badgeText(42)).toBe('9+');
  });

  it('render rebuilds one rail item per profile in snapshot order with active ring, diegetic health, attention marker and title', () => {
    withPage('<ul id="rail-list"></ul>', (doc) => {
      const list = doc.getElementById('rail-list')!;
      render(SNAPSHOT, list);
      const items = list.querySelectorAll('li.rail-item');
      expect(items).toHaveLength(2);
      expect((items[0] as HTMLElement).dataset.id).toBe('a');
      expect((items[1] as HTMLElement).dataset.id).toBe('b');
      // Active ring only on the active profile.
      expect(items[0].classList.contains('active')).toBe(false);
      expect(items[1].classList.contains('active')).toBe(true);
      // Server glyphs: a stable Greek letter per hostname, no monograms.
      const used = new Set<string>();
      const g0 = greekGlyphForHostname('CHARON', used);
      used.add(g0);
      const g1 = greekGlyphForHostname('BETA', used);
      expect(items[0].querySelector('.mono')?.textContent).toBe(g0);
      expect(items[1].querySelector('.mono')?.textContent).toBe(g1);
      // Diegetic health: 'down' mutes the chip, 'up' keeps the glow.
      expect(items[0].classList.contains('offline')).toBe(false);
      expect(items[1].classList.contains('offline')).toBe(true);
      expect(items[0].querySelector('.dot')).toBeNull();
      // Unread attention marker: textless, shown only when unread > 0.
      const marker = items[0].querySelector('.attention') as HTMLElement | null;
      expect(marker).not.toBeNull();
      expect(marker?.getAttribute('aria-label')).toBe('Terminal done');
      expect(marker?.title).toBe('Terminal done');
      expect(marker?.textContent).toBe('');
      expect(items[1].querySelector('.attention')).toBeNull();
      // No numeric badge is rendered.
      expect(items[0].querySelector('.badge')).toBeNull();
      expect((items[0] as HTMLElement).title).toBe(
        'CHARON · http://127.0.0.1:7070/ · CPU 62%',
      );
      expect((items[0] as HTMLElement).getAttribute('aria-label')).toBe(
        'CHARON · CPU 62%',
      );
      expect((items[1] as HTMLElement).title).toBe(
        'Beta · http://10.0.0.5:8080/',
      );
      expect((items[1] as HTMLElement).getAttribute('aria-label')).toBe('Beta');
    });
  });

  it('a rail item click dispatches phi:select-profile with the profile id (recording-fake bridge)', () => {
    const sent: string[] = [];
    (
      window as { electron?: { postSelectProfile(id: string): void } }
    ).electron = {
      postSelectProfile: (id) => sent.push(id),
    };
    try {
      withPage('<ul id="rail-list"></ul>', (doc) => {
        const list = doc.getElementById('rail-list')!;
        render(SNAPSHOT, list);
        const items = list.querySelectorAll('li.rail-item');
        (items[1] as HTMLElement).click();
        expect(sent).toEqual(['b']);
      });
    } finally {
      delete (window as { electron?: unknown }).electron;
    }
  });

  it('boot opens the native picker through postOpenPicker', () => {
    const stateCbs: Array<(state: RailState) => void> = [];
    const opened: number[] = [];
    (
      window as {
        electron?: {
          onRailState(cb: (state: RailState) => void): () => void;
          postOpenPicker(): void;
        };
      }
    ).electron = {
      onRailState: (cb) => {
        stateCbs.push(cb);
        return () => {};
      },
      postOpenPicker: () => opened.push(1),
    };
    try {
      withPage(htmlSource, (doc) => {
        boot();
        expect(stateCbs).toHaveLength(1);
        stateCbs[0](SNAPSHOT);
        expect(doc.querySelectorAll('li.rail-item')).toHaveLength(2);
        (doc.getElementById('rail-add') as HTMLButtonElement).click();
        expect(opened).toEqual([1]);
      });
    } finally {
      delete (window as { electron?: unknown }).electron;
    }
  });
});

describe('rail identity and accent (src/renderer.ts)', () => {
  it('canonicalHostname uppercases and strips .local, port and scheme (IPv6 colons kept)', () => {
    expect(canonicalHostname('charon.local')).toBe('CHARON');
    expect(canonicalHostname('  charon:7070 ')).toBe('CHARON');
    expect(canonicalHostname('https://charon:7070')).toBe('CHARON');
    expect(canonicalHostname('atlas')).toBe('ATLAS');
    expect(canonicalHostname('')).toBe('');
    expect(canonicalHostname('::1')).toBe('::1');
  });

  it('identityLabel prefers the canonical hostname and falls back to the profile name', () => {
    expect(
      identityLabel({
        id: 'a',
        name: 'Alpha Phi',
        origin: 'http://127.0.0.1:7070/',
        hostname: 'charon.local',
        accent: '#e76f51',
        cpu: null,
      }),
    ).toBe('CHARON');
    expect(
      identityLabel({
        id: 'b',
        name: 'Beta',
        origin: 'http://10.0.0.5:8080/',
        hostname: '',
        accent: '',
        cpu: null,
      }),
    ).toBe('Beta');
  });

  it('carries no brand mark (no railcap): the rail starts at the server list', () => {
    expect(htmlSource).not.toContain('rail-brand');
    expect(htmlSource.indexOf('<ul id="rail-list"')).toBeGreaterThan(-1);
    const brandIdx = htmlSource.indexOf('Φ');
    const listIdx = htmlSource.indexOf('<ul id="rail-list"');
    // No Φ glyph above the list.
    expect(brandIdx).toBe(-1);
    expect(listIdx).toBeGreaterThan(-1);
  });

  it('greekGlyphForHostname derives a stable single Greek letter from the canonical hostname, never Φ', () => {
    const g1 = greekGlyphForHostname('CHARON');
    const g2 = greekGlyphForHostname('charon.local');
    const g3 = greekGlyphForHostname('charon:7070');
    // Deterministic: same hostname, same glyph regardless of casing/port/.local.
    expect(g1).toBe(g2);
    expect(g1).toBe(g3);
    expect([...g1]).toHaveLength(1);
    expect(/^[Α-Ωα-ως]$/u.test(g1)).toBe(true);
    // Phi is reserved for the brand.
    expect(g1).not.toBe('Φ');
    expect(g1).not.toBe('φ');
    const g4 = greekGlyphForHostname('MINERVA');
    expect([...g4]).toHaveLength(1);
    expect(/^[Α-Ωα-ως]$/u.test(g4)).toBe(true);
    expect(g4).not.toBe('Φ');
    expect(g4).not.toBe('φ');
  });

  it('greekGlyphForHostname resolves collisions case-first, then Greek numeral marks', () => {
    // Force a collision: hash the same hostname twice into the used set.
    const used = new Set<string>([greekGlyphForHostname('CHARON')]);
    const second = greekGlyphForHostname('CHARON', used);
    expect(used.has(second)).toBe(false);
    expect([...second].length).toBeGreaterThanOrEqual(1);
    // The resolved glyph is either the case-swapped letter or a numeral-marked one.
    const base = greekGlyphForHostname('CHARON');
    expect(
      second === base ||
        second === base.toUpperCase() ||
        second === base.toLowerCase() ||
        second.includes('ʹ'),
    ).toBe(true);
  });

  it('renders a Greek glyph for endpoint-looking identities, never raw characters or Φ', () => {
    const ipGlyph = greekGlyphForHostname('127.0.0.1:7070');
    expect([...ipGlyph]).toHaveLength(1);
    expect(/^[Α-Ωα-ως]$/u.test(ipGlyph)).toBe(true);
    expect(ipGlyph).not.toBe('Φ');
    expect(ipGlyph).not.toBe('φ');
  });

  it('drives the rail chrome from the active server accent and stores each entry accent for hover preview', () => {
    withPage(htmlSource, (doc) => {
      const list = doc.getElementById('rail-list')!;
      const rail = doc.getElementById('rail');
      render(SNAPSHOT, list);
      expect(rail?.style.getPropertyValue('--accent')).toBe('');
      const itemA = list.querySelector('li[data-id="a"]') as HTMLElement;
      const itemB = list.querySelector('li[data-id="b"]') as HTMLElement;
      expect(itemA.style.getPropertyValue('--entry-accent')).toBe('#e76f51');
      expect(itemB.style.getPropertyValue('--entry-accent')).toBe('');
      render({ ...SNAPSHOT, activeId: 'a' }, list);
      expect(rail?.style.getPropertyValue('--accent')).toBe('#e76f51');
    });
  });

  it('renders a Greek glyph for an IP-looking name and keeps the conservative text label', () => {
    withPage('<ul id="rail-list"></ul>', (doc) => {
      const list = doc.getElementById('rail-list')!;
      const unknown: RailState = {
        profiles: [
          {
            id: 'c',
            name: '127.0.0.1:7070',
            origin: 'http://127.0.0.1:7070/',
            hostname: '',
            accent: '',
            cpu: null,
          },
        ],
        activeId: 'c',
        health: { c: 'unknown' },
        unread: { c: 0 },
      };
      render(unknown, list);
      const item = list.querySelector('li.rail-item') as HTMLElement;
      expect(item.querySelector('.mono')?.textContent).toBe(
        greekGlyphForHostname('127.0.0.1:7070'),
      );
      expect(item.querySelector('.mono')?.textContent).not.toBe('Φ');
      expect(item.title).toBe('127.0.0.1:7070 · http://127.0.0.1:7070/');
      expect(item.getAttribute('aria-label')).toBe('127.0.0.1:7070');
      expect(item.style.getPropertyValue('--entry-accent')).toBe('');
      // Unknown health renders the entry muted like offline.
      expect(item.classList.contains('offline')).toBe(true);
    });
  });
});

describe('rail CPU intensity (src/renderer.ts + src/rail.css)', () => {
  it('scales the entry accent/glow from its own CPU reading and keeps the precise percent in the accessible labels', () => {
    withPage('<ul id="rail-list"></ul>', (doc) => {
      const list = doc.getElementById('rail-list')!;
      render(SNAPSHOT, list);
      const items = list.querySelectorAll('li.rail-item');
      const busy = items[0] as HTMLElement;
      expect(busy.style.getPropertyValue('--entry-cpu')).toBe('62');
      expect(busy.title).toBe('CHARON · http://127.0.0.1:7070/ · CPU 62%');
      expect(busy.getAttribute('aria-label')).toBe('CHARON · CPU 62%');
      const quiet = items[1] as HTMLElement;
      expect(quiet.style.getPropertyValue('--entry-cpu')).toBe('');
      expect(quiet.title).toBe('Beta · http://10.0.0.5:8080/');
      expect(quiet.getAttribute('aria-label')).toBe('Beta');
    });
  });

  it('clamps an out-of-range CPU reading for the intensity and the label', () => {
    withPage('<ul id="rail-list"></ul>', (doc) => {
      const list = doc.getElementById('rail-list')!;
      const state: RailState = {
        profiles: [
          {
            id: 'x',
            name: 'X',
            origin: 'http://x/',
            hostname: '',
            accent: '',
            cpu: 137,
          },
        ],
        activeId: 'x',
        health: { x: 'up' },
        unread: { x: 0 },
      };
      render(state, list);
      const item = list.querySelector('li.rail-item') as HTMLElement;
      expect(item.style.getPropertyValue('--entry-cpu')).toBe('100');
      expect(item.title).toBe('X · http://x/ · CPU 100%');
    });
  });

  it('derives the intensity from the existing accent tokens only, statically (no warning palette, no animation)', () => {
    const itemRule = /\.rail-item\s*\{([^}]*)\}/s.exec(cssSource);
    expect(itemRule).not.toBeNull();
    expect(itemRule?.[1]).toContain('--cpu-strength');
    expect(itemRule?.[1]).toMatch(/var\(--entry-cpu,\s*0\)/);
    expect(itemRule?.[1]).toContain('var(--entry-accent, var(--accent))');
    // Static intensity at the sampling cadence: no transition/animation.
    expect(cssSource).not.toMatch(/\.rail-item[^{]*\{[^}]*transition/);
    expect(cssSource).not.toMatch(/--warn|--danger|--critical/i);
  });
});

describe('rail entry context menu (src/renderer.ts)', () => {
  it('opens the shell-level popup for the targeted profile and blocks the default menu', () => {
    const calls: Array<[string, number, number]> = [];
    const stateCbs: Array<(state: RailState) => void> = [];
    (window as { electron?: unknown }).electron = {
      onRailState: (cb: (state: RailState) => void): (() => void) => {
        stateCbs.push(cb);
        return () => {};
      },
      postSelectProfile: () => {},
      postOpenRailMenu: (id: string, x: number, y: number) =>
        calls.push([id, x, y]),
      postOpenPicker: () => {},
      postRenameProfile: () => {},
      postRemoveProfile: () => {},
      postReorderProfile: () => {},
      postOpenServerSessions: () => {},
      postReloadServer: () => {},
      postReloadAllServers: () => {},
    };
    const doc = withPage(htmlSource, (d) => {
      boot();
      stateCbs[0](SNAPSHOT);
      return d;
    });
    const item = doc.querySelectorAll('li.rail-item')[1] as HTMLElement;
    const evt = new doc.defaultView.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      screenX: 31,
      screenY: 97,
    });
    expect(item.dispatchEvent(evt)).toBe(false);
    expect(calls).toEqual([['b', 31, 97]]);
    expect(doc.getElementById('rail-menu')).toBeNull();
  });
});

describe('rail drag-and-drop reorder (src/renderer.ts)', () => {
  /** jsdom reports zero rects, so pin item i to [i*48, i*48+40] for
   * deterministic top/bottom-half drop slots. */
  function bootPage(): {
    doc: Document;
    reorder: Array<[string, string | null]>;
  } {
    const reorder: Array<[string, string | null]> = [];
    const stateCbs: Array<(state: RailState) => void> = [];
    (window as { electron?: unknown }).electron = {
      onRailState: (cb: (state: RailState) => void): (() => void) => {
        stateCbs.push(cb);
        return () => {};
      },
      postSelectProfile: () => {},
      postOpenPicker: () => {},
      postRenameProfile: () => {},
      postRemoveProfile: () => {},
      postReorderProfile: (id: string, beforeId: string | null) =>
        reorder.push([id, beforeId]),
    };
    const doc = withPage(htmlSource, (d) => {
      boot();
      stateCbs[0](SNAPSHOT);
      d.querySelectorAll('li.rail-item').forEach((el, i) => {
        (el as HTMLElement).getBoundingClientRect = () => ({
          x: 0,
          y: i * 48,
          top: i * 48,
          bottom: i * 48 + 40,
          left: 0,
          right: 0,
          width: 40,
          height: 40,
          toJSON: () => ({}),
        });
      });
      return d;
    });
    return { doc, reorder };
  }

  function drag(
    doc: Document,
    target: HTMLElement,
    type: string,
    clientY: number,
  ): void {
    target.dispatchEvent(
      new doc.defaultView.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientY,
      }),
    );
  }

  it('renders every rail entry as draggable', () => {
    const { doc } = bootPage();
    const items = doc.querySelectorAll('li.rail-item');
    expect((items[0] as HTMLElement).draggable).toBe(true);
    expect((items[1] as HTMLElement).draggable).toBe(true);
  });

  it('marks the dragged entry while the drag is live and clears it on dragend', () => {
    const { doc } = bootPage();
    const items = doc.querySelectorAll('li.rail-item');
    drag(doc, items[0] as HTMLElement, 'dragstart', 20);
    expect(items[0].classList.contains('dragging')).toBe(true);
    drag(doc, items[0] as HTMLElement, 'dragend', 20);
    expect(items[0].classList.contains('dragging')).toBe(false);
  });

  it('shows the insertion slot: drop-before on the top half, drop-after on the bottom half', () => {
    const { doc } = bootPage();
    const items = doc.querySelectorAll('li.rail-item');
    drag(doc, items[0] as HTMLElement, 'dragstart', 20);
    drag(doc, items[1] as HTMLElement, 'dragover', 55);
    expect(items[1].classList.contains('drop-before')).toBe(true);
    drag(doc, items[1] as HTMLElement, 'dragover', 80);
    expect(items[1].classList.contains('drop-after')).toBe(true);
    expect(items[1].classList.contains('drop-before')).toBe(false);
    drag(doc, items[0] as HTMLElement, 'dragend', 20);
  });

  it('dropping on the top half posts phi:reorder-profile before that entry', () => {
    const { doc, reorder } = bootPage();
    const items = doc.querySelectorAll('li.rail-item');
    drag(doc, items[0] as HTMLElement, 'dragstart', 20);
    drag(doc, items[1] as HTMLElement, 'drop', 55);
    expect(reorder).toEqual([['a', 'b']]);
  });

  it('dropping on the bottom half posts phi:reorder-profile after that entry (before its next sibling)', () => {
    const { doc, reorder } = bootPage();
    const items = doc.querySelectorAll('li.rail-item');
    drag(doc, items[0] as HTMLElement, 'dragstart', 20);
    drag(doc, items[1] as HTMLElement, 'drop', 80);
    expect(reorder).toEqual([['a', null]]);
  });

  it('dropping in the empty list area below the last entry posts phi:reorder-profile to the end', () => {
    const { doc, reorder } = bootPage();
    const items = doc.querySelectorAll('li.rail-item');
    drag(doc, items[0] as HTMLElement, 'dragstart', 20);
    const list = doc.getElementById('rail-list') as HTMLElement;
    drag(doc, list, 'drop', 120);
    expect(reorder).toEqual([['a', null]]);
  });

  it('styles the drag affordance: dragged opacity and an accent insertion line', () => {
    expect(cssSource).toMatch(/\.rail-item\.dragging\s*\{[^}]*opacity:\s*0\.4/);
    expect(cssSource).toMatch(/\.rail-item\.drop-before::before\s*\{/);
    expect(cssSource).toMatch(/\.rail-item\.drop-after::after\s*\{/);
  });
});

describe('rail IPC contract (channel strings)', () => {
  it('exposes the documented rail channels in the preload bridge source', () => {
    expect(preloadSource).toContain("'phi:rail-state'");
    expect(preloadSource).toContain("'phi:rail-menu-state'");
    expect(preloadSource).toContain("'phi:open-rail-menu'");
    expect(preloadSource).toContain("'phi:close-rail-menu'");
    expect(preloadSource).toContain("'phi:select-profile'");
    expect(preloadSource).toContain("'phi:open-picker'");
    expect(preloadSource).toContain("'phi:add-server'");
    expect(preloadSource).toContain("'phi:rename-profile'");
    expect(preloadSource).toContain("'phi:remove-profile'");
    expect(preloadSource).toContain("'phi:open-server-sessions'");
    expect(preloadSource).toContain('postOpenServerSessions');
    expect(preloadSource).toContain("'phi:reorder-profile'");
    expect(preloadSource).toContain('postReorderProfile');
    expect(preloadSource).toContain("'phi:reload-profile'");
    expect(preloadSource).toContain('postReloadServer');
    expect(preloadSource).toContain("'phi:reload-all-servers'");
    expect(preloadSource).toContain('postReloadAllServers');
  });
});
