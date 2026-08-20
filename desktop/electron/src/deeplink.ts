/**
 * phi:// deep-link parsing and dispatch for the Electron main process —
 * parity with the Wails `desktop/internal/deeplink` package.
 *
 * Grammar (constrained on purpose — no arbitrary URLs, no credentials):
 *
 *   phi://profile/<profile-id>
 *   phi://profile/<profile-id>/session/<digits>
 *   phi://profile/<profile-id>/worktree/<worktree-ref>
 *   phi://profile            (no id -> open the picker)
 *
 * <profile-id> uses the profile id charset ([a-z0-9][a-z0-9-]*), exactly
 * the charset profile.IDForOrigin produces, so links can address every
 * profile the client stores. Route refs are a single URL-escaped path
 * segment without slashes. Unknown profiles and unroutable routes are
 * reported by the caller as a non-modal error (see the shell package).
 */

/** IPC channel parsed deep links are dispatched on. */
export const DEEPLINK_CHANNEL = 'phi:deeplink';

export type DeepLinkKind = 'profile' | 'session' | 'worktree' | 'picker';

/** A parsed deep link. */
export interface DeepLink {
  kind: DeepLinkKind;
  profileId: string;
  /** Route reference (session number or worktree ref); absent for plain links. */
  ref?: string;
}

export type ParseDeepLinkResult =
  | ({ ok: true } & DeepLink)
  | { ok: false; error: string };

/** The window surface dispatchDeepLink needs (BrowserWindow satisfies it). */
export interface DeepLinkWindow {
  webContents: {
    send(channel: string, payload: unknown): void;
    isDestroyed(): boolean;
  };
}

// Charsets mirrored from the Wails deeplink package (same rules, same
// rejection semantics).
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const REF_RE = /^[A-Za-z0-9._~-]+$/;
const DIGITS_RE = /^[0-9]+$/;

/** Splits an escaped path into decoded segments, dropping empty ones. */
function splitSegments(escapedPath: string): string[] {
  const segs: string[] = [];
  for (const seg of escapedPath.split('/')) {
    if (seg === '') continue;
    let dec = seg;
    try {
      dec = decodeURIComponent(seg);
    } catch {
      // Keep the raw segment on a bad escape; the charset checks reject it.
    }
    segs.push(dec);
  }
  return segs;
}

/**
 * Parses and validates raw as a phi:// deep link. Mirrors the Wails
 * deeplink.Parse grammar and rejection rules: scheme check (phi, case
 * insensitive), host '' or 'profile' only, no userinfo/query/fragment, no
 * empty path segments, then segment-count dispatch with charset
 * validation. A link with no id resolves to the picker.
 */
export function parseDeepLink(raw: string): ParseDeepLinkResult {
  const input = raw.trim();
  if (input === '') return { ok: false, error: 'deeplink: empty link' };

  // Scheme: the part before the first ':' must be "phi" (case-insensitive,
  // like Go's url.Parse). The authority must be present (phi:// form).
  const colon = input.indexOf(':');
  if (colon <= 0) {
    return {
      ok: false,
      error: `deeplink: "${input}" must use the "phi" scheme`,
    };
  }
  if (input.slice(0, colon).toLowerCase() !== 'phi') {
    return {
      ok: false,
      error: `deeplink: "${input}" must use the "phi" scheme`,
    };
  }
  const rest = input.slice(colon + 1);
  if (!rest.startsWith('//')) {
    return {
      ok: false,
      error: `deeplink: "${input}" must use the "phi://" form`,
    };
  }

  // Authority ends at the first '/', '?' or '#'; the rest is path + more.
  const body = rest.slice(2);
  const sep = body.search(/[/?#]/);
  const authority = sep === -1 ? body : body.slice(0, sep);
  const pathAndMore = sep === -1 ? '' : body.slice(sep);

  if (pathAndMore.includes('?')) {
    return {
      ok: false,
      error: `deeplink: "${input}" must not contain a query string`,
    };
  }
  if (pathAndMore.includes('#')) {
    return {
      ok: false,
      error: `deeplink: "${input}" must not contain a fragment`,
    };
  }
  // Host: '' or 'profile' only (Go lowercases the host; unknown hosts,
  // userinfo and explicit ports are all rejected here).
  const host = authority.toLowerCase();
  if (host !== '' && host !== 'profile') {
    return {
      ok: false,
      error: `deeplink: "${input}" has an unknown host "${authority}"`,
    };
  }
  if (pathAndMore.includes('//')) {
    return {
      ok: false,
      error: `deeplink: "${input}" contains an empty path segment`,
    };
  }

  const segs = splitSegments(pathAndMore);
  if (segs.length === 0) {
    // phi://profile (with or without a trailing slash): "open the picker".
    return { ok: true, kind: 'picker', profileId: '' };
  }
  if (segs.length === 1) {
    const profileId = segs[0];
    if (!ID_RE.test(profileId)) {
      return {
        ok: false,
        error: `deeplink: invalid profile id "${profileId}" in "${input}"`,
      };
    }
    return { ok: true, kind: 'profile', profileId };
  }
  if (segs.length === 3 && segs[1] === 'session') {
    const profileId = segs[0];
    const ref = segs[2];
    if (!ID_RE.test(profileId)) {
      return {
        ok: false,
        error: `deeplink: invalid profile id "${profileId}" in "${input}"`,
      };
    }
    if (!DIGITS_RE.test(ref)) {
      return {
        ok: false,
        error: `deeplink: session ref must be digits, got "${ref}" in "${input}"`,
      };
    }
    return { ok: true, kind: 'session', profileId, ref };
  }
  if (segs.length === 3 && segs[1] === 'worktree') {
    const profileId = segs[0];
    const ref = segs[2];
    if (!ID_RE.test(profileId)) {
      return {
        ok: false,
        error: `deeplink: invalid profile id "${profileId}" in "${input}"`,
      };
    }
    if (!REF_RE.test(ref)) {
      return {
        ok: false,
        error: `deeplink: invalid route reference "${ref}" in "${input}"`,
      };
    }
    return { ok: true, kind: 'worktree', profileId, ref };
  }
  return {
    ok: false,
    error: `deeplink: "${input}" is not a valid phi://profile link`,
  };
}

/**
 * Posts a parsed deep link to a window's renderer on the deeplink channel.
 * A null or destroyed window is a no-op (the window may not exist yet when
 * a link arrives during startup).
 */
export function dispatchDeepLink(
  window: DeepLinkWindow | null,
  link: DeepLink,
): void {
  if (!window || window.webContents.isDestroyed()) return;
  window.webContents.send(DEEPLINK_CHANNEL, link);
}
