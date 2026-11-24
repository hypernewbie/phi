/**
 * macOS Dock safe-area trim (src/dockSafeArea.ts).
 *
 * The trim is injected user CSS from the desktop main process — these
 * tests pin the three invariants the feature rests on:
 *   1. macOS-only wiring lives in the host (views/desktop), never in the
 *      CSS itself being shipped — the stylesheet is fixed text whose
 *      body-view rule is scoped to html[data-phi-desktop], so a plain
 *      browser (no attribute, no injection) can never match it.
 *   2. The sheet is inserted as a user stylesheet immediately AND
 *      re-armed after every navigation/reload (did-finish-load), so
 *      reloadAll and legacy-server navigations keep the trim.
 *   3. Low power mode cannot affect it: the trim is static padding with
 *      no transition/animation, and the low-power controller only kills
 *      effects and throttles rAF — nothing here observes those.
 */
import { describe, expect, it } from 'vitest';
import type { WebContents } from 'electron';
import {
  DOCK_SAFE_AREA_CSS,
  DOCK_SAFE_AREA_PX,
  installDockSafeArea,
} from '../src/dockSafeArea.js';

interface RecordingContents {
  wc: WebContents;
  insertCalls: Array<{ css: string; cssOrigin?: string }>;
  listeners: Map<string, Array<() => void>>;
}

function makeRecordingContents(withInsert = true): RecordingContents {
  const insertCalls: RecordingContents['insertCalls'] = [];
  const listeners = new Map<string, Array<() => void>>();
  const wc = {
    insertCSS: withInsert
      ? (css: string, options?: { cssOrigin?: string }) => {
          insertCalls.push({ css, cssOrigin: options?.cssOrigin });
          return Promise.resolve('1');
        }
      : undefined,
    on: (event: string, listener: () => void) => {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
  };
  return { wc: wc as unknown as WebContents, insertCalls, listeners };
}

function fireLoad(rec: RecordingContents): void {
  for (const listener of rec.listeners.get('did-finish-load') ?? []) listener();
}

describe('dockSafeArea stylesheet', () => {
  it('lifts the app column with a bottom trim, never a resize', () => {
    expect(DOCK_SAFE_AREA_PX).toBeGreaterThan(0);
    expect(DOCK_SAFE_AREA_CSS).toContain(
      `html[data-phi-desktop] .app-container { padding-bottom: ${DOCK_SAFE_AREA_PX}px; }`,
    );
    // padding, not height: the terminal grid keeps its rows and the
    // strip is painted by the page's own background.
    expect(DOCK_SAFE_AREA_CSS).not.toContain('height');
    expect(DOCK_SAFE_AREA_CSS).not.toContain('transform');
  });

  it('covers the desktop rail and stays desktop-only', () => {
    // The rail is desktop-local chrome (no data-phi-desktop attribute),
    // so its rule is id-scoped instead.
    expect(DOCK_SAFE_AREA_CSS).toContain(
      `#rail { padding-bottom: ${DOCK_SAFE_AREA_PX}px; }`,
    );
    // Body-view rules are scoped to the desktop-hosted page marker, so
    // the same text cannot match a plain browser page: every
    // .app-container rule must carry the html[data-phi-desktop] scope.
    const appRules = DOCK_SAFE_AREA_CSS.split('\n').filter((line) =>
      line.includes('.app-container'),
    );
    expect(appRules.length).toBeGreaterThan(0);
    expect(
      appRules.every((line) => line.startsWith('html[data-phi-desktop]')),
    ).toBe(true);
  });

  it('is static layout the low-power controller cannot touch', () => {
    // No transition/animation: the low-power `* { transition: none }`
    // kill set has nothing to disable, and the frame pacer only
    // throttles rAF — the padding applies on the next layout, rAF or
    // not.
    expect(DOCK_SAFE_AREA_CSS).not.toContain('transition');
    expect(DOCK_SAFE_AREA_CSS).not.toContain('animation');
  });
});

describe('installDockSafeArea', () => {
  it('inserts the author-origin stylesheet immediately and re-arms on every did-finish-load', () => {
    const rec = makeRecordingContents();
    installDockSafeArea(rec.wc);
    // Immediate insert, author origin: the page's own `* { padding: 0 }`
    // reset is author-normal, and a user-normal sheet would lose that
    // cascade level outright. An author sheet inserted after the page's
    // own wins on order and specificity.
    expect(rec.insertCalls).toHaveLength(1);
    expect(rec.insertCalls[0]).toEqual({
      css: DOCK_SAFE_AREA_CSS,
      cssOrigin: 'author',
    });
    // Navigation replaces the document — the sheet must come back.
    fireLoad(rec);
    fireLoad(rec);
    expect(rec.insertCalls).toHaveLength(3);
    expect(rec.insertCalls.every((c) => c.css === DOCK_SAFE_AREA_CSS)).toBe(
      true,
    );
  });

  it('skips webContents without insertCSS (unit-test fakes) silently', () => {
    const rec = makeRecordingContents(false);
    expect(() => installDockSafeArea(rec.wc)).not.toThrow();
    expect(rec.insertCalls).toHaveLength(0);
    expect(rec.listeners.size).toBe(0);
  });

  it('never throws on a null-ish webContents', () => {
    expect(() =>
      installDockSafeArea(null as unknown as WebContents),
    ).not.toThrow();
  });
});
