// Phase-1 shell-page unit test (vitest + jsdom). Asserts the local shell
// HTML parses, carries the expected sidebar structure (left aside sized by
// a width variable, right main pane with id="pane"), uses Phi's documented
// CSS tokens for the sidebar background, and shows the phase-1 placeholder
// text.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const htmlSource = readFileSync(path.join(srcDir, 'shell.html'), 'utf8');
const cssSource = readFileSync(path.join(srcDir, 'shell.css'), 'utf8');
const captionHtmlSource = readFileSync(path.join(srcDir, 'caption.html'), 'utf8');
const captionCssSource = readFileSync(path.join(srcDir, 'caption.css'), 'utf8');
const titleHtmlSource = readFileSync(path.join(srcDir, 'title.html'), 'utf8');
const titleCssSource = readFileSync(path.join(srcDir, 'title.css'), 'utf8');

describe('shell.html (phase-1 local shell page)', () => {
  it('parses without throwing and renders the sidebar + pane structure', () => {
    // JSDOM's HTML5 parser throws on unusable input; constructing it is the
    // parse assertion.
    const doc = new JSDOM(htmlSource, { url: 'file:///shell.html' }).window.document;

    const aside = doc.querySelector('aside.rail');
    expect(aside).not.toBeNull();
    expect(aside?.getAttribute('aria-label')).toBe('Server rail');

    const pane = doc.getElementById('pane');
    expect(pane).not.toBeNull();

    expect(doc.title).toBe('Phi');
  });

  it('sizes the left sidebar with a width variable', () => {
    expect(cssSource).toMatch(/--rail-width:\s*64px/);
    expect(cssSource).toMatch(/width:\s*var\(--rail-width\)/);
  });

  it('mirrors the documented Phi CSS variables for the sidebar background', () => {
    // Tokens come from web/style.css with the same names/values: the rail
    // background is the panel token, the divider is the border token, the
    // Φ mark uses the accent token, text uses the primary token.
    expect(cssSource).toMatch(/--bg-panel:\s*#0d0d10/);
    expect(cssSource).toMatch(/background:\s*var\(--bg-panel\)/);
    expect(cssSource).toMatch(/--bg-border:\s*#1f1f26/);
    expect(cssSource).toMatch(/--accent:\s*#7c6af7/);
    expect(cssSource).toMatch(/--text-primary:\s*#e4e3e9/);
  });

  it('shows the phase-1 placeholder text in the right pane', () => {
    const pane = new JSDOM(htmlSource).window.document.getElementById('pane');
    expect(pane?.textContent ?? '').toContain('phi-desktop electron shell — phase 1');
  });
});

describe('caption.html (the caption-controls island)', () => {
  it('parses and renders exactly three window-control buttons wired to the preload bridge', () => {
    // JSDOM's HTML5 parser throws on unusable input; constructing it is the
    // parse assertion.
    const doc = new JSDOM(captionHtmlSource, { url: 'file:///caption.html' }).window.document;
    const buttons = doc.querySelectorAll('button');
    expect(buttons.length).toBe(3);
    expect(doc.getElementById('caption-minimize')).not.toBeNull();
    expect(doc.getElementById('caption-maximize')).not.toBeNull();
    expect(doc.getElementById('caption-close')).not.toBeNull();
    // The page drives the window only through the sandboxed preload bridge.
    expect(captionHtmlSource).toContain('postWindowMinimize');
    expect(captionHtmlSource).toContain('postWindowToggleMaximize');
    expect(captionHtmlSource).toContain('postWindowClose');
    expect(captionHtmlSource).toContain('onWindowState');
  });

  it('uses the Phi design tokens (panel background, elevated hover, primary text)', () => {
    expect(captionCssSource).toMatch(/--bg-panel:\s*#0d0d10/);
    expect(captionCssSource).toMatch(/--bg-border:\s*#1f1f26/);
    expect(captionCssSource).toMatch(/--accent:\s*#7c6af7/);
    expect(captionCssSource).toMatch(/--text-primary:\s*#e4e3e9/);
    expect(captionCssSource).toMatch(/background:\s*var\(--bg-panel\)/);
  });
});

describe('title.html (the title/drag island)', () => {
  it('parses and shows the Φ phi mark with a draggable body and no-drag text', () => {
    const doc = new JSDOM(titleHtmlSource, { url: 'file:///title.html' }).window.document;
    expect(doc.querySelector('.title-mark')?.textContent?.trim()).toBe('Φ');
    expect(doc.getElementById('title-text')).not.toBeNull();
    expect(titleHtmlSource).toContain('onWindowTitle');
    // The body is the frameless window's drag region; the text opts out.
    expect(titleCssSource).toMatch(/-webkit-app-region:\s*drag/);
    expect(titleCssSource).toMatch(/-webkit-app-region:\s*no-drag/);
  });

  it('uses the Phi design tokens', () => {
    expect(titleCssSource).toMatch(/--bg-panel:\s*#0d0d10/);
    expect(titleCssSource).toMatch(/--bg-border:\s*#1f1f26/);
    expect(titleCssSource).toMatch(/--accent:\s*#7c6af7/);
    expect(titleCssSource).toMatch(/--text-primary:\s*#e4e3e9/);
  });
});
