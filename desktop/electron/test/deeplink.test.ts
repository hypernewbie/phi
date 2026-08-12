/**
 * Unit tests for phi:// deep-link parsing and dispatch
 * (src/deeplink.ts) — parity with the Wails deeplink package's tests.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEEPLINK_CHANNEL,
  parseDeepLink,
  dispatchDeepLink,
  type DeepLinkWindow,
} from '../src/deeplink.js';

function fakeWindow(overrides: Partial<DeepLinkWindow> = {}): DeepLinkWindow {
  return { webContents: { send: vi.fn(), isDestroyed: () => false }, ...overrides };
}

describe('parseDeepLink valid forms', () => {
  const cases: Array<{ raw: string; kind: 'profile' | 'session' | 'worktree'; profileId: string; ref?: string }> = [
    { raw: 'phi://profile/home', kind: 'profile', profileId: 'home' },
    { raw: 'phi://profile/127-0-0-1-7070', kind: 'profile', profileId: '127-0-0-1-7070' },
    { raw: 'phi://profile/home/session/123', kind: 'session', profileId: 'home', ref: '123' },
    { raw: 'phi://profile/home/worktree/feature-x', kind: 'worktree', profileId: 'home', ref: 'feature-x' },
    { raw: 'phi://profile/home/worktree/feat.1_2~3', kind: 'worktree', profileId: 'home', ref: 'feat.1_2~3' },
    { raw: '  phi://profile/home  ', kind: 'profile', profileId: 'home' },
  ];
  for (const c of cases) {
    it(`parses ${JSON.stringify(c.raw)}`, () => {
      const parsed = parseDeepLink(c.raw);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.kind).toBe(c.kind);
        expect(parsed.profileId).toBe(c.profileId);
        if (c.ref !== undefined) expect(parsed.ref).toBe(c.ref);
      }
    });
  }
});

describe('parseDeepLink picker', () => {
  for (const raw of ['phi://profile', 'phi://profile/']) {
    it(`parses ${JSON.stringify(raw)} as the picker`, () => {
      expect(parseDeepLink(raw)).toEqual({ ok: true, kind: 'picker', profileId: '' });
    });
  }
});

describe('parseDeepLink invalid forms', () => {
  const bad = [
    '',
    'http://profile/home',
    'phi://other/home',
    'phi://profile//',
    'phi://profile/Home',
    'phi://profile/home/session',
    'phi://profile/home/session/x',
    'phi://profile/home/worktree',
    'phi://profile/home/worktree/a/b',
    'phi://profile/home?x=1',
    'phi://profile/home#frag',
    'phi://user@profile/home',
    'phi://profile/..',
    'phi://profile/home/session/123/extra',
    'phi:profile/home',
    'not a link',
  ];
  for (const raw of bad) {
    it(`rejects ${JSON.stringify(raw)}`, () => {
      expect(parseDeepLink(raw).ok).toBe(false);
    });
  }
});

describe('parseDeepLink escaped refs', () => {
  it('decodes a percent-escaped ref and validates the decoded form', () => {
    const parsed = parseDeepLink('phi://profile/home/worktree/feature%5Fx');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.ref).toBe('feature_x');
    // Escapes that decode to characters outside the ref charset are rejected.
    expect(parseDeepLink('phi://profile/home/worktree/feature%20x').ok).toBe(false);
  });
});

describe('dispatchDeepLink', () => {
  it('posts the parsed link on the deeplink channel', () => {
    const send = vi.fn();
    const win = fakeWindow({ webContents: { send, isDestroyed: () => false } });
    dispatchDeepLink(win, { kind: 'profile', profileId: 'home' });
    expect(send).toHaveBeenCalledWith(DEEPLINK_CHANNEL, { kind: 'profile', profileId: 'home' });
  });

  it('is a no-op for a null or destroyed window', () => {
    dispatchDeepLink(null, { kind: 'profile', profileId: 'home' });
    const send = vi.fn();
    const win = fakeWindow({ webContents: { send, isDestroyed: () => true } });
    dispatchDeepLink(win, { kind: 'profile', profileId: 'home' });
    expect(send).not.toHaveBeenCalled();
  });

  it('exposes the documented deeplink channel constant', () => {
    expect(DEEPLINK_CHANNEL).toBe('phi:deeplink');
  });
});
