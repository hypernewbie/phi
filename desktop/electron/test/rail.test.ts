// @vitest-environment node
/**
 * Rail chrome contract tests (vitest + node). Pins that the rail's
 * styling matches the browser Phi's button / surface vocabulary
 * byte-for-byte. The rail is desktop-only DOM,
 * but its CSS must trace every radius / gradient / glow property to
 * the browser Phi's `web/style.css` selectors — no hand-tuned
 * sidecar values that don't match `web/`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.join(here, '..');
const webRoot = path.join(electronRoot, '..', '..', 'web');
const railCss = readFileSync(path.join(electronRoot, 'src', 'rail.css'), 'utf8');
const webCss = readFileSync(path.join(webRoot, 'style.css'), 'utf8');
const vendorWebCss = readFileSync(path.join(electronRoot, 'web', 'style.css'), 'utf8');

function ruleBody(css: string, selector: string): string | null {
  // Match the selector preceded by start-of-line, whitespace, or
  // `}`, optionally followed by whitespace, then `{`. The selector
  // must NOT be followed by other selector characters (so
  // `.header-btn:hover` matches but `.header-btn:hover::before`
  // doesn't).
  const re = new RegExp(`(^|[\\s}])${escapeRegex(selector)}\\s*\\{`, '');
  const m = re.exec(css);
  if (!m) return null;
  return extractBody(css, m.index + m[1].length);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractBody(css: string, openBraceIdx: number): string {
  const braceOpen = css.indexOf('{', openBraceIdx);
  if (braceOpen < 0) return '';
  let depth = 1;
  let i = braceOpen + 1;
  while (i < css.length && depth > 0) {
    const close = css.indexOf('}', i);
    if (close < 0) return '';
    const open = css.indexOf('{', i);
    if (open >= 0 && open < close) {
      depth += 1;
      i = open + 1;
    } else {
      depth -= 1;
      i = close + 1;
    }
  }
  return css.slice(braceOpen + 1, i - 1);
}

function cssValue(body: string, prop: string): string | null {
  const re = new RegExp(`${prop}\\s*:\\s*([^;]+?)\\s*(?:;|$)`, 'm');
  const m = body.match(re);
  return m ? m[1].trim() : null;
}

describe('rail.css: matches web/ button / surface vocabulary', () => {
  it('#rail background uses the same radial gradient as web’s <body>', () => {
    const railBody = ruleBody(railCss, '#rail');
    expect(railBody).not.toBeNull();
    const railGrad = cssValue(railBody!, 'background');
    const webBody = ruleBody(webCss, 'html, body');
    expect(webBody).not.toBeNull();
    const webGrad = cssValue(webBody!, 'background');
    expect(railGrad).toBe(webGrad);
    const vendorBody = ruleBody(vendorWebCss, 'html, body');
    expect(vendorBody).not.toBeNull();
    expect(cssValue(vendorBody!, 'background')).toBe(webGrad);
  });

  it('.rail-item uses the same border-radius / border / background as .header-btn', () => {
    const railBody = ruleBody(railCss, '.rail-item');
    expect(railBody).not.toBeNull();
    const btnBody = ruleBody(webCss, '.header-btn');
    expect(btnBody).not.toBeNull();
    expect(cssValue(railBody!, 'border-radius')).toBe(cssValue(btnBody!, 'border-radius'));
    expect(cssValue(railBody!, 'background-color')).toBe(cssValue(btnBody!, 'background-color'));
    expect(cssValue(railBody!, 'border')).toBe(cssValue(btnBody!, 'border'));
  });

  it('#rail-add uses the same border-radius / border / background as .header-btn', () => {
    const railBody = ruleBody(railCss, '#rail-add');
    expect(railBody).not.toBeNull();
    const btnBody = ruleBody(webCss, '.header-btn');
    expect(btnBody).not.toBeNull();
    expect(cssValue(railBody!, 'border-radius')).toBe(cssValue(btnBody!, 'border-radius'));
    expect(cssValue(railBody!, 'background-color')).toBe(cssValue(btnBody!, 'background-color'));
    expect(cssValue(railBody!, 'border')).toBe(cssValue(btnBody!, 'border'));
  });

  it(':hover transform matches .header-btn:hover for non-active entries', () => {
    // Hover rule is scoped under `#rail` and excludes the active entry so
    // hovering any other server never demotes the selected server.
    const railHover = ruleBody(railCss, '#rail .rail-item:not(.active):hover');
    expect(railHover).not.toBeNull();
    const btnHover = ruleBody(webCss, '.header-btn:hover');
    expect(btnHover).not.toBeNull();
    // The transform lifts the chip the same way .header-btn does
    // (browser button hover treatment).
    expect(cssValue(railHover!, 'transform')).toBe(cssValue(btnHover!, 'transform'));
    // Both rules box-shadow on the accent token (the rail uses
    // --entry-accent, the per-server hover-preview accent set by the
    // renderer; the browser uses the global --accent-glow).
    expect(railHover!).toMatch(/box-shadow/);
    expect(btnHover!).toMatch(/box-shadow/);
    expect(railHover!).toMatch(/var\(--/);
    expect(btnHover!).toMatch(/var\(--/);
  });

  it(':active transform matches .header-btn:active', () => {
    const railActive = ruleBody(railCss, '.rail-item:active');
    expect(railActive).not.toBeNull();
    const btnActive = ruleBody(webCss, '.header-btn:active');
    expect(btnActive).not.toBeNull();
    expect(cssValue(railActive!, 'transform')).toBe(cssValue(btnActive!, 'transform'));
  });

  it('.rail-item.active uses the same accent tokens as .header-btn.active', () => {
    const railActive = ruleBody(railCss, '.rail-item.active');
    expect(railActive).not.toBeNull();
    const btnActive = ruleBody(webCss, '.header-btn.active');
    expect(btnActive).not.toBeNull();
    expect(railActive!).toMatch(/--accent-trace/);
    expect(railActive!).toMatch(/--accent-glow/);
    expect(btnActive!).toMatch(/--accent-trace/);
    expect(btnActive!).toMatch(/--accent-glow/);
  });

  it('#rail:hover surfaces every non-active entry’s own accent as a quiet preview glow', () => {
    // When the cursor is over the rail, every non-active .rail-item shows
    // a faint shadow of its own observed accent (--entry-accent). The
    // selected entry is excluded so rail hover cannot demote it.
    const rule = ruleBody(railCss, '#rail:hover .rail-item:not(.active)');
    expect(rule).not.toBeNull();
    expect(rule!).toMatch(/--entry-accent/);
    expect(rule!).toMatch(/border-color/);
    // The glow uses color-mix, not the raw accent — the preview is
    // a *shadow* of the accent, not the accent itself.
    expect(rule!).toMatch(/color-mix/);
  });

  it('#rail-add stays neutral on hover (does NOT adopt the active accent)', () => {
    // Fix: the '+' button used to pick up `var(--accent)` on hover,
    // making it read as the active server's colour and confusing the
    // rail. The generic add action must read neutral regardless of
    // which server is active.
    const addHover = ruleBody(railCss, '#rail-add:hover');
    expect(addHover).not.toBeNull();
    expect(addHover!).not.toMatch(/var\(--accent\)/);
    // The hover border and box-shadow stay off the accent tokens.
    expect(addHover!).not.toMatch(/box-shadow/);
    // The transform lift still matches the browser button language.
    expect(cssValue(addHover!, 'transform')).toBe(
      'translateY(-1px) scale(1.02)',
    );
  });

  it('#rail-add has no ::before accent-glow pseudo (the colour lift is gone)', () => {
    // Fix sister: removing the accent-glow ::before was the way the
    // earlier version hid the active-accent recolour. Pin it absent
    // so a regression that re-adds it is caught (the colour-on-hover
    // bug returns silently with the pseudo restored).
    expect(railCss).not.toMatch(/#rail-add::before\s*\{/);
  });

  it('every gradient in rail.css traces back to web/style.css (no sidecar gradients)', () => {
    const railGradients = [...railCss.matchAll(/(linear-gradient|radial-gradient)\([^)]*\)/g)].map(
      (m) => m[0],
    );
    expect(railGradients.length).toBeGreaterThan(0);
    for (const g of railGradients) {
      expect(webCss, `rail gradient "${g.slice(0, 40)}..." not in web/`).toContain(g);
    }
  });

  it('rail.css does not declare @font-face (fonts come from web/vendor/fonts/)', () => {
    expect(railCss).not.toMatch(/@font-face/);
  });
});