/**
 * Pure unit tests for src/shortcuts.ts (rail-selection chord resolution
 * and the terminal-focus probe) plus the static terminal-safety evidence
 * guard: the always-safe digits must not be forwardable to the PTY by
 * web/terminal.js `_forwardKeyToPty` or by xterm's own key evaluation,
 * and the conditional chords must be exactly the live-terminal ones.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALWAYS_SAFE_RAIL_CHORDS,
  CONDITIONAL_RAIL_CHORDS,
  TERMINAL_FOCUS_SCRIPT,
  resolveRailChord,
  type RailChordInput,
} from '../src/shortcuts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');
const terminalSource = readFileSync(path.join(repoRoot, 'web', 'terminal.js'), 'utf8');
const xtermSource = readFileSync(path.join(repoRoot, 'web', 'vendor', 'xterm.js'), 'utf8');

function chord(overrides: Partial<RailChordInput>): RailChordInput {
  return { type: 'keyDown', key: '1', shift: false, control: true, alt: false, meta: false, ...overrides };
}

describe('chord split', () => {
  it('splits the digits into always-safe and conditional sets, with Tab conditional', () => {
    expect([...ALWAYS_SAFE_RAIL_CHORDS].sort()).toEqual(['1', '2', '9']);
    expect([...CONDITIONAL_RAIL_CHORDS].sort()).toEqual(['3', '4', '5', '6', '7', '8', 'Tab']);
  });

  it('covers exactly Ctrl+1..9 plus Tab, disjoint', () => {
    const digits = [...ALWAYS_SAFE_RAIL_CHORDS, ...CONDITIONAL_RAIL_CHORDS].filter((k) => k !== 'Tab');
    expect([...digits].sort()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    for (const key of ALWAYS_SAFE_RAIL_CHORDS) {
      expect(CONDITIONAL_RAIL_CHORDS.has(key)).toBe(false);
    }
  });
});

describe('resolveRailChord (digit selection)', () => {
  it('maps every Ctrl+1..9 to the 0-based rail index', () => {
    for (let d = 1; d <= 9; d++) {
      expect(resolveRailChord(chord({ key: String(d) }), 9)).toEqual({ kind: 'index', index: d - 1 });
    }
  });

  it('resolves null when the digit exceeds the profile count (no-op)', () => {
    expect(resolveRailChord(chord({ key: '3' }), 2)).toBeNull();
    expect(resolveRailChord(chord({ key: '9' }), 1)).toBeNull();
  });

  it('requires an exact Ctrl-only modifier set', () => {
    expect(resolveRailChord(chord({ control: false }), 9)).toBeNull();
    expect(resolveRailChord(chord({ shift: true }), 9)).toBeNull();
    expect(resolveRailChord(chord({ alt: true }), 9)).toBeNull();
    expect(resolveRailChord(chord({ meta: true }), 9)).toBeNull();
    expect(resolveRailChord(chord({ type: 'keyUp' }), 9)).toBeNull();
    expect(resolveRailChord(chord({ key: 'a' }), 9)).toBeNull();
    expect(resolveRailChord(chord({ key: '0' }), 9)).toBeNull();
  });
});

describe('resolveRailChord (next/prev cycling)', () => {
  it('maps Ctrl+Tab to next and Ctrl+Shift+Tab to prev', () => {
    expect(resolveRailChord(chord({ key: 'Tab' }), 3)).toEqual({ kind: 'next' });
    expect(resolveRailChord(chord({ key: 'Tab', shift: true }), 3)).toEqual({ kind: 'prev' });
  });

  it('resolves null for cycling with no profiles', () => {
    expect(resolveRailChord(chord({ key: 'Tab' }), 0)).toBeNull();
    expect(resolveRailChord(chord({ key: 'Tab', shift: true }), 0)).toBeNull();
  });
});

describe('terminal-focus probe', () => {
  it('is a fixed constant gating on the active element inside .xterm', () => {
    expect(TERMINAL_FOCUS_SCRIPT).toContain('document.activeElement');
    expect(TERMINAL_FOCUS_SCRIPT).toContain("el.closest('.xterm')");
  });
});

describe('terminal-safety evidence guard (the mandatory gate)', () => {
  it('keeps the always-safe digits out of every PTY path', () => {
    // _forwardKeyToPty forwards a fixed key map plus Shift+Tab and
    // Ctrl+c/o/p/t; the plain-keys lookup is not modifier-gated.
    const forwardIdx = terminalSource.indexOf('_forwardKeyToPty(e, tab)');
    expect(forwardIdx).toBeGreaterThan(-1);
    const region = terminalSource.slice(forwardIdx, forwardIdx + 1800);
    const forwardMap = region.match(/'([^']+)':\s*'[^']*'/g) ?? [];
    const ctrlBranch = region.slice(region.indexOf('ctrlKeys'));
    for (const key of ALWAYS_SAFE_RAIL_CHORDS) {
      expect(forwardMap.some((m) => m.startsWith(`'${key}':`))).toBe(false);
      expect(ctrlBranch).not.toContain(`'${key}':`);
    }
  });

  it('pins the live-terminal mappings that make Ctrl+3..8 and Tab conditional', () => {
    const forwardIdx = terminalSource.indexOf('_forwardKeyToPty(e, tab)');
    const region = terminalSource.slice(forwardIdx, forwardIdx + 1800);
    expect(region).toContain("'Tab': '\\t'");
    expect(region).toContain("'\\x1b[Z'");
    // evaluateKeyboardEvent's ctrl-only branch: keyCode 51-55 ->
    // ESC..US and keyCode 56 -> DEL. A focused terminal therefore
    // produces live bytes for Ctrl+3..8 even though _forwardKeyToPty
    // never forwards digits.
    const evIdx = xtermSource.indexOf('evaluateKeyboardEvent=function');
    expect(evIdx).toBeGreaterThan(-1);
    const evRegion = xtermSource.slice(evIdx, evIdx + 6000);
    expect(evRegion).toContain(
      'e.keyCode>=51&&e.keyCode<=55?o.key=String.fromCharCode(e.keyCode-51+27)',
    );
    expect(evRegion).toContain('56===e.keyCode?o.key=s.C0.DEL');
    for (const digit of ['3', '4', '5', '6', '7', '8']) {
      expect(ALWAYS_SAFE_RAIL_CHORDS.has(digit)).toBe(false);
      expect(CONDITIONAL_RAIL_CHORDS.has(digit)).toBe(true);
    }
  });

  it('keeps Ctrl+L, zoom, reload, close, reopen, Escape and typing out of both sets', () => {
    for (const key of ['+', '-', '0', 'r', 'R', 'F5', 'w', 'W', 't', 'T', 'Escape', 'l', 'L']) {
      expect(ALWAYS_SAFE_RAIL_CHORDS.has(key)).toBe(false);
      expect(CONDITIONAL_RAIL_CHORDS.has(key)).toBe(false);
    }
    // Ctrl+L is a live clear-screen chord: evaluateKeyboardEvent maps
    // keyCode 76 (ctrl) to '\x0c' (form feed).
    const evIdx = xtermSource.indexOf('evaluateKeyboardEvent=function');
    const region = xtermSource.slice(evIdx, evIdx + 6000);
    expect(region).toContain('e.keyCode>=65&&e.keyCode<=90?o.key=String.fromCharCode(e.keyCode-64)');
  });
});
