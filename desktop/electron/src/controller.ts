/**
 * Profile controller for the Electron main process — the host-loop
 * equivalent of the Wails `desktop/internal/controller` package (with the
 * `internal/profile` store and the `internal/endpoint.Parse` validation).
 * **Pure TypeScript: this module
 * never imports Electron**, so vitest runs it directly and the host loop
 * (src/main.ts) is the only place the controller meets the desktop
 * surfaces (the Wails host-loop convention).
 *
 * Scope (migration step 5):
 *   - a non-secret profile store persisted as one JSON file at
 *     `persistPath` with atomic writes (temp file + fsync + rename), a
 *     `.bak` copy of the previous good state before every save, and
 *     corruption recovery that moves the corrupt file aside
 *     (`.corrupt-<ts>`, never deleted — nothing is silently destroyed)
 *     before falling back to the backup, mirroring the Wails
 *     `internal/profile.Load` pattern;
 *   - profile CRUD: `add` (strict endpoint.Parse-equivalent validation;
 *     re-adding the exact same origin is allowed and returns the existing
 *     profile; any distinct origin — scheme, host and port — is addable
 *     under normal browser origin rules; the Wails-only same-host rule
 *     does not apply), `remove`, `rename`, `setLastUsed`, `setActive`,
 *     `setUnread`;
 *   - a subscribe/emit event bus (`active-changed`, `unread-changed`,
 *     `profiles-changed`, `health-changed`) that the host loop wires to
 *     the tray (notify-on-mutation, fire-and-forget);
 *   - a health slice (`updateHealth`) that runs an injected checker — the
 *     slice ships a placeholder (`unknownHealthChecker`) that reports
 *     `unknown` for every origin (no real HTTP anywhere in this slice);
 *     the real liveness checker lands in step 8.
 *
 * Deliberately not in this slice (later steps): window navigation on
 * activation (step 6 retained views), startup restore of the
 * most-recently-used profile (step 6), the real HTTP health checker
 * (step 8), the tray menu rebuild hook (step 6) and the health-aware tray
 * menu (step 8).
 *
 * Persisted schema (one file): `{ "profiles": [ { "id", "name",
 * "origin", "lastUsed" } ], "closeToTray": true, "syncAlerts": true }` — ids, display
 * names, normalized origins, a last-used stamp, and the non-secret
 * close-to-tray (default true) and sync-board-alert (default true)
 * preferences. Profiles never carry
 * passwords, verifiers, cookies or tokens: Phi remains the authority
 * for authentication, and the desktop client never receives the
 * server's secret material (the Wails trust model).
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';

/** Health status of one profile origin (mirrors the Wails health package). */
export type HealthStatus = 'up' | 'down' | 'unknown';

/** Canonical persisted desktop-pet zoom configuration. */
export const PET_ZOOM_MIN_PERCENT = 50;
export const PET_ZOOM_MAX_PERCENT = 300;
export const PET_ZOOM_DEFAULT_PERCENT = 100;
export const PET_ZOOM_STEP_PERCENT = 25;
export const PET_BASE_VISUAL_WIDTH_DIP = 192;
export const PET_IDLE_DWELL_MIN_SECONDS = 1;
export const PET_IDLE_DWELL_MAX_SECONDS = 3600;
export const PET_IDLE_DWELL_DEFAULT_SECONDS = 10;

/** One saved, non-secret Phi server profile (the tray/rail-relevant slice). */
export interface ProfileMeta {
  /** Stable local id derived from the origin (IDForOrigin parity). */
  id: string;
  /** Display name (defaults to host[:port]). */
  name: string;
  /** Normalized origin URL: scheme://host[:port]/ (endpoint.Parse output form). */
  origin: string;
}

/** The controller's immutable snapshot (`state()` returns a deep copy). */
export interface ControllerState {
  /** Saved profiles in insertion (rail) order. */
  profiles: ProfileMeta[];
  /** Active profile id; '' when none. */
  activeId: string;
  /** Per-profile connection health (Maps, not plain objects — React-friendly later). */
  health: Map<string, HealthStatus>;
  /** Per-profile unread attention counts (>= 0). */
  unread: Map<string, number>;
  /** The persisted close-to-tray preference (default true). */
  closeToTray: boolean;
  /** The persisted sync-board desktop-alert preference (default true). */
  syncAlerts: boolean;
  /** The persisted low-memory mode preference (default false, auto true if <10GB RAM). */
  lowMemoryMode: boolean;
  /** The persisted desktop-pet preference (default false). */
  petEnabled: boolean;
  /** The persisted desktop-pet zoom percentage (default 100). */
  petZoomPercent: number;
  /** The persisted unattended-rest interval in milliseconds. */
  petIdleDwellSeconds: number;
}

/** One controller event (posted to subscribers after every mutation). */
export type ControllerEvent =
  | { kind: 'active-changed'; id: string }
  | { kind: 'unread-changed'; id: string; n: number }
  | { kind: 'profiles-changed' }
  | { kind: 'health-changed' }
  | { kind: 'close-to-tray-changed' }
  | { kind: 'sync-alerts-changed' }
  | { kind: 'low-memory-changed' }
  | { kind: 'pet-enabled-changed' }
  | { kind: 'pet-zoom-changed' }
  | { kind: 'pet-idle-dwell-changed'; dwellSeconds: number };

/** A subscription callback (fire-and-forget; never awaited by the controller). */
export type ControllerListener = (event: ControllerEvent) => void;

/** The health checker seam: given a normalized origin, returns its status. */
export interface HealthChecker {
  check(origin: string): HealthStatus | Promise<HealthStatus>;
}

/** Diagnostics logger (the host loop passes console.log). */
export type ControllerLog = (msg: string) => void;

/** Constructor options. */
export interface ControllerOptions {
  /** The profiles JSON file path (atomic writes + .bak + .corrupt-* recovery). */
  persistPath: string;
  /** Diagnostics logger (defaults to a no-op). */
  log?: ControllerLog;
}

/** The result of parseEndpoint (the normalized origin parts). */
export interface ParsedEndpoint {
  /** Normalized origin: scheme://host[:port]/ (trailing root, lowercase host). */
  origin: string;
  scheme: 'http' | 'https';
  /** host[:port] — the display-name / profile-id input (Wails u.Host parity). */
  host: string;
  /** Lowercase hostname without IPv6 brackets (Wails Hostname() parity). */
  hostname: string;
  /** Explicit port as written; null when absent. */
  port: string | null;
}

/** Typed error kinds (mirror the Wails ActionError kinds). */
export type ControllerErrorKind =
  | 'invalid_url'
  | 'unknown_profile'
  | 'invalid_name'
  | 'persist';

/** Base typed controller error. Every controller failure is one of these. */
export class ControllerError extends Error {
  readonly kind: ControllerErrorKind;
  constructor(kind: ControllerErrorKind, message: string) {
    super(message);
    this.name = 'ControllerError';
    this.kind = kind;
  }
}

/** The URL failed endpoint.Parse-equivalent validation (Wails ErrInvalidAdd). */
export class InvalidUrlError extends ControllerError {
  constructor(message: string) {
    super('invalid_url', message);
    this.name = 'InvalidUrlError';
  }
}

/** The referenced profile id does not exist (Wails ErrUnknownProfile). */
export class UnknownProfileError extends ControllerError {
  constructor(message: string) {
    super('unknown_profile', message);
    this.name = 'UnknownProfileError';
  }
}

/** The profile name failed ValidateName-equivalent validation (Wails ErrInvalidName). */
export class InvalidNameError extends ControllerError {
  constructor(message: string) {
    super('invalid_name', message);
    this.name = 'InvalidNameError';
  }
}

/** Max runes in a profile display name (Wails MaxNameRunes parity). */
export const MAX_NAME_RUNES = 64;

/** The slice's placeholder checker: reports unknown for every origin (no HTTP). */
export const unknownHealthChecker: HealthChecker = {
  check: () => 'unknown',
};

/**
 * hostnameRe: RFC-1123-style hostnames with optional underscore labels
 * (seen on intranets) and an optional trailing dot (FQDN form). Each
 * label is non-empty and does not start or end with a separator — the
 * Wails `validHostname` regex, ported verbatim.
 */
const hostnameRe =
  /^[A-Za-z0-9]([A-Za-z0-9_-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9_-]*[A-Za-z0-9])?)*\.?$/;

/** idRe: legal profile ids (used in deep links and directory names later). */
const idRe = /^[a-z0-9][a-z0-9-]*$/;

/** Internal profile record (ProfileMeta + the persisted last-used stamp). */
interface InternalProfile {
  id: string;
  name: string;
  origin: string;
  /** ISO-8601 last-used stamp, or null when never used. */
  lastUsed: string | null;
}

/** validHostname: plain hostname, IPv4 literal, or IPv6 literal (zone stripped). */
function validHostname(hostname: string): boolean {
  if (hostname.includes(':')) {
    let h = hostname;
    if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
    const zone = h.lastIndexOf('%');
    if (zone >= 0) h = h.slice(0, zone);
    return isIP(h) === 6;
  }
  return hostnameRe.test(hostname);
}

/**
 * The raw authority of an absolute http(s) URL (scheme://authority,
 * authority ends at the first '/', '?' or '#'). Null when the URL has no
 * '://' (WHATWG would mangle such inputs into a valid-looking origin that
 * Go's url.Parse rejects — the Wails parser requires a real authority).
 */
function rawAuthority(raw: string): string | null {
  const m = raw.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*/);
  if (!m) return null;
  return m[0].slice(m[0].indexOf('://') + 3);
}

/**
 * The explicit port from an authority: '' marks an empty port (Go's
 * `strings.HasSuffix(u.Host, ":")` case), null means no explicit port.
 * The WHATWG URL parser normalizes default ports (and leading zeros)
 * away, so the port is recovered from the raw authority — Go's url.Parse
 * keeps it in u.Host and endpoint.Parse preserves it in the origin.
 */
function rawPort(authority: string): string | null {
  if (authority.endsWith(':')) return '';
  const closeBracket = authority.lastIndexOf(']');
  const colon = authority.lastIndexOf(':');
  if (colon <= closeBracket) return null;
  const port = authority.slice(colon + 1);
  return /^\d+$/.test(port) ? port : null;
}

/** sha256 hex digest (profile-id collision suffixes). */
function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Wails IDForOrigin parity: the id is the sanitized lowercase host[:port]
 * (every non-[a-z0-9] run collapses to '-', leading/trailing '-' trimmed,
 * 'server' when empty); when the result is not a legal id a short origin
 * hash is appended so ids stay unambiguous.
 */
function idForOrigin(origin: string, host: string): string {
  let base = host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (base === '') base = 'server';
  if (idRe.test(base)) return base;
  return `${base}-${sha256Hex(origin).slice(0, 6)}`;
}

/**
 * Wails profile.HostnameKey parity: the lowercase hostname of a
 * normalized origin — the host-part key that groups origins sharing a
 * host. Returns '' when the origin cannot be parsed.
 */
export function hostnameKey(origin: string): string {
  try {
    const u = new URL(origin);
    let h = u.hostname.toLowerCase();
    if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
    return h;
  } catch {
    return '';
  }
}

/** Wails profile.ValidateName parity: non-empty, <= 64 runes, no control characters. */
function validateName(name: string): void {
  if (name.trim() === '')
    throw new InvalidNameError('profile name must not be empty');
  if ([...name].length > MAX_NAME_RUNES) {
    throw new InvalidNameError(
      `profile name must be at most ${MAX_NAME_RUNES} runes`,
    );
  }
  for (const ch of name) {
    if (ch.charCodeAt(0) < 0x20) {
      throw new InvalidNameError(
        'profile name must not contain control characters',
      );
    }
  }
}

/**
 * parseEndpoint — the endpoint.Parse-equivalent validator/normalizer.
 *
 * Accepted: an absolute http/https URL with an origin-grade hostname, an
 * optional explicit port (1-65535, preserved even when it is the scheme
 * default, like Go), and an optional trailing slash. Rejected: userinfo,
 * any query (a literal '?'), any fragment (a literal '#'), non-root
 * paths, other schemes, hostless URLs, and invalid hostnames/ports. The
 * returned origin is always scheme://host[:port]/ with a lowercase host.
 *
 * Throws InvalidUrlError with a Wails-style message naming the raw URL.
 */
export function parseEndpoint(raw: string): ParsedEndpoint {
  let u: URL;
  try {
    u = new URL(raw);
  } catch (err) {
    throw new InvalidUrlError(`invalid server URL "${raw}": ${String(err)}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new InvalidUrlError(
      `server URL "${raw}" must use the http or https scheme`,
    );
  }
  const authority = rawAuthority(raw);
  if (u.hostname === '' || authority === null || authority === '') {
    throw new InvalidUrlError(`server URL "${raw}" has no hostname`);
  }
  if (!validHostname(u.hostname)) {
    throw new InvalidUrlError(`server URL "${raw}" has an invalid hostname`);
  }
  if (u.username !== '' || u.password !== '') {
    throw new InvalidUrlError(`server URL "${raw}" must not contain userinfo`);
  }
  if (raw.includes('?')) {
    throw new InvalidUrlError(
      `server URL "${raw}" must not contain a query string`,
    );
  }
  if (raw.includes('#')) {
    throw new InvalidUrlError(
      `server URL "${raw}" must not contain a fragment`,
    );
  }
  if (u.pathname !== '/') {
    throw new InvalidUrlError(
      `server URL "${raw}" must use the root path (Phi serves /api and /ws at the origin)`,
    );
  }
  const port = rawPort(authority);
  if (port === '') {
    throw new InvalidUrlError(`server URL "${raw}" has an empty port`);
  }
  if (port !== null) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new InvalidUrlError(
        `server URL "${raw}" has an invalid port "${port}"`,
      );
    }
  }
  const scheme = u.protocol.slice(0, -1) as 'http' | 'https';
  // WHATWG lowercases hostnames; Go keeps the raw casing but the task rule
  // is "lowercase host", so the WHATWG normalization is the desired one.
  const host = u.hostname + (port === null ? '' : `:${port}`);
  const hostname = (() => {
    let h = u.hostname.toLowerCase();
    if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
    return h;
  })();
  return { origin: `${scheme}://${host}/`, scheme, host, hostname, port };
}

/** Moves a corrupt store file aside for diagnostics (never deleted). */
function setAsideCorrupt(filePath: string, log: ControllerLog): void {
  const aside = `${filePath}.corrupt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    renameSync(filePath, aside);
  } catch (err) {
    log(`controller: could not move corrupt file ${filePath}: ${String(err)}`);
  }
}

/** One parsed store file: the profile list plus the desktop preferences. */
interface LoadedStore {
  profiles: InternalProfile[];
  closeToTray: boolean;
  syncAlerts: boolean;
  lowMemoryMode: boolean;
  petEnabled: boolean;
  petZoomPercent: number;
  petIdleDwellSeconds: number;
}

function isPetIdleDwellSeconds(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= PET_IDLE_DWELL_MIN_SECONDS &&
    value <= PET_IDLE_DWELL_MAX_SECONDS
  );
}

function isPetZoomPercent(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= PET_ZOOM_MIN_PERCENT &&
    value <= PET_ZOOM_MAX_PERCENT &&
    (value - PET_ZOOM_MIN_PERCENT) % PET_ZOOM_STEP_PERCENT === 0
  );
}

function isLegacyPetScaleTick(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 7
  );
}

function migrateLegacyPetScaleTick(value: unknown): number {
  if (!isLegacyPetScaleTick(value)) return PET_ZOOM_DEFAULT_PERCENT;
  const legacyPercent = 80 + value * 10;
  const snapped =
    PET_ZOOM_MIN_PERCENT +
    PET_ZOOM_STEP_PERCENT *
      Math.round(
        (legacyPercent - PET_ZOOM_MIN_PERCENT) / PET_ZOOM_STEP_PERCENT,
      );
  return Math.min(
    PET_ZOOM_MAX_PERCENT,
    Math.max(PET_ZOOM_MIN_PERCENT, snapped),
  );
}

/**
 * Reads the store file, moving corrupt files aside and falling back to
 * the backup (Wails internal/profile.Load pattern). Never throws: every
 * failure is logged and yields an empty store (close-to-tray defaults
 * true).
 */
function readStore(
  filePath: string,
  isBackup: boolean,
  log: ControllerLog,
): LoadedStore {
  let data: string;
  try {
    data = readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(`controller: cannot read ${filePath}: ${String(err)}`);
    }
    return {
      profiles: [],
      closeToTray: true,
      syncAlerts: true,
      lowMemoryMode: false,
      petEnabled: false,
      petZoomPercent: PET_ZOOM_DEFAULT_PERCENT,
      petIdleDwellSeconds: PET_IDLE_DWELL_DEFAULT_SECONDS,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (err) {
    if (isBackup) {
      log(
        `controller: ${filePath} is corrupt (${String(err)}); starting with an empty store`,
      );
      setAsideCorrupt(filePath, log);
      return {
        profiles: [],
        closeToTray: true,
        syncAlerts: true,
        lowMemoryMode: false,
        petEnabled: false,
        petZoomPercent: PET_ZOOM_DEFAULT_PERCENT,
        petIdleDwellSeconds: PET_IDLE_DWELL_DEFAULT_SECONDS,
      };
    }
    log(
      `controller: ${filePath} is corrupt (${String(err)}); trying ${filePath}.bak`,
    );
    setAsideCorrupt(filePath, log);
    return readStore(`${filePath}.bak`, true, log);
  }
  const obj = parsed as {
    profiles?: unknown;
    closeToTray?: unknown;
    syncAlerts?: unknown;
    petEnabled?: unknown;
    petZoomPercent?: unknown;
    petIdleDwellSeconds?: unknown;
    petScaleTick?: unknown;
  } | null;
  if (obj === null || typeof obj !== 'object' || !Array.isArray(obj.profiles)) {
    if (isBackup) {
      log(
        `controller: ${filePath} has an unusable schema; starting with an empty store`,
      );
      setAsideCorrupt(filePath, log);
      return {
        profiles: [],
        closeToTray: true,
        syncAlerts: true,
        lowMemoryMode: false,
        petEnabled: false,
        petZoomPercent: PET_ZOOM_DEFAULT_PERCENT,
        petIdleDwellSeconds: PET_IDLE_DWELL_DEFAULT_SECONDS,
      };
    }
    log(
      `controller: ${filePath} has an unusable schema; trying ${filePath}.bak`,
    );
    setAsideCorrupt(filePath, log);
    return readStore(`${filePath}.bak`, true, log);
  }
  const syncAlerts =
    typeof obj.syncAlerts === 'boolean' ? obj.syncAlerts : true;
  const lowMemoryMode =
    typeof (obj as Record<string, unknown>).lowMemoryMode === 'boolean'
      ? ((obj as Record<string, unknown>).lowMemoryMode as boolean)
      : false;
  const petEnabled =
    typeof obj.petEnabled === 'boolean' ? obj.petEnabled : false;
  const hasZoomPercent = Object.hasOwn(obj, 'petZoomPercent');
  const petZoomPercent = isPetZoomPercent(obj.petZoomPercent)
    ? obj.petZoomPercent
    : hasZoomPercent
      ? PET_ZOOM_DEFAULT_PERCENT
      : migrateLegacyPetScaleTick(obj.petScaleTick);
  const petIdleDwellSeconds = isPetIdleDwellSeconds(obj.petIdleDwellSeconds)
    ? obj.petIdleDwellSeconds
    : PET_IDLE_DWELL_DEFAULT_SECONDS;
  const profiles: InternalProfile[] = [];
  const seen = new Set<string>();
  for (const entry of obj.profiles) {
    const p = entry as {
      id?: unknown;
      name?: unknown;
      origin?: unknown;
      lastUsed?: unknown;
    };
    if (
      p === null ||
      typeof p !== 'object' ||
      typeof p.id !== 'string' ||
      p.id === '' ||
      typeof p.origin !== 'string' ||
      p.origin === ''
    ) {
      log(`controller: skipping invalid profile entry in ${filePath}`);
      continue;
    }
    if (seen.has(p.id)) {
      log(`controller: skipping duplicate profile id "${p.id}" in ${filePath}`);
      continue;
    }
    seen.add(p.id);
    profiles.push({
      id: p.id,
      name: typeof p.name === 'string' && p.name !== '' ? p.name : p.origin,
      origin: p.origin,
      lastUsed:
        typeof p.lastUsed === 'string' && p.lastUsed !== '' ? p.lastUsed : null,
    });
  }
  if (isBackup) {
    log(`controller: recovered ${profiles.length} profile(s) from ${filePath}`);
  }
  return {
    profiles,
    closeToTray: typeof obj.closeToTray === 'boolean' ? obj.closeToTray : true,
    syncAlerts,
    lowMemoryMode,
    petEnabled,
    petZoomPercent,
    petIdleDwellSeconds,
  };
}

/**
 * Atomic save (Wails Store.Save parity): the current file is first copied
 * to the backup, then a temp file is written, fsynced and renamed over
 * the final path. Throws ControllerError('persist', ...) on failure; the
 * temp file is removed on the way out.
 */
function saveStore(
  persistPath: string,
  profiles: InternalProfile[],
  closeToTray: boolean,
  syncAlerts: boolean,
  lowMemoryMode: boolean,
  petEnabled: boolean,
  petZoomPercent: number,
  petIdleDwellSeconds: number,
): void {
  const dir = path.dirname(persistPath);
  mkdirSync(dir, { recursive: true });
  const backup = `${persistPath}.bak`;
  if (existsSync(persistPath)) {
    try {
      rmSync(backup, { force: true });
      copyFileSync(persistPath, backup);
    } catch (err) {
      throw new ControllerError(
        'persist',
        `controller: backup: ${String(err)}`,
      );
    }
  }
  const tmp = path.join(dir, `profiles.json.tmp-${process.pid}-${Date.now()}`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'w');
    writeFileSync(
      fd,
      JSON.stringify(
        {
          profiles: profiles.map((p) => ({
            id: p.id,
            name: p.name,
            origin: p.origin,
            ...(p.lastUsed === null ? {} : { lastUsed: p.lastUsed }),
          })),
          closeToTray,
          syncAlerts,
          lowMemoryMode,
          petEnabled,
          petZoomPercent,
          petIdleDwellSeconds,
        },
        null,
        2,
      ),
    );
    fsyncSync(fd);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw new ControllerError(
      'persist',
      `controller: write ${tmp}: ${String(err)}`,
    );
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
  try {
    renameSync(tmp, persistPath);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw new ControllerError('persist', `controller: rename: ${String(err)}`);
  }
}

/** The id of the most recently used profile ('' when none); ties resolve to the first. */
function mostRecentlyUsed(profiles: InternalProfile[]): string {
  if (profiles.length === 0) return '';
  let best = profiles[0];
  for (const p of profiles.slice(1)) {
    // ISO-8601 stamps compare lexicographically.
    if ((p.lastUsed ?? '') > (best.lastUsed ?? '')) best = p;
  }
  return best.id;
}

function toMeta(p: InternalProfile): ProfileMeta {
  return { id: p.id, name: p.name, origin: p.origin };
}

/**
 * The host-loop profile controller. Every mutating method persists
 * immediately (atomic write); load never throws (corrupt files are moved
 * aside and the backup is tried first). Mutation failures throw typed
 * ControllerError subclasses; save failures after an in-memory change
 * roll the change back for add/remove (Wails parity) or throw for
 * rename/setLastUsed/setActive (Wails parity: rename and the last-used
 * stamp do not roll back; a failed activation stamp is logged and the
 * activation continues).
 */
export class Controller {
  private readonly persistPath: string;
  private readonly log: ControllerLog;
  private profiles: InternalProfile[] = [];
  private byID = new Map<string, InternalProfile>();
  private activeId = '';
  private health = new Map<string, HealthStatus>();
  private unread = new Map<string, number>();
  private closeToTray = true;
  private syncAlerts = true;
  private lowMemoryMode = false;
  private petEnabled = false;
  private petZoomPercent = PET_ZOOM_DEFAULT_PERCENT;
  private petIdleDwellSeconds = PET_IDLE_DWELL_DEFAULT_SECONDS;
  private listeners = new Set<ControllerListener>();

  constructor(opts: ControllerOptions) {
    this.persistPath = opts.persistPath;
    this.log = opts.log ?? (() => {});
    const store = readStore(this.persistPath, false, this.log);
    this.closeToTray = store.closeToTray;
    this.syncAlerts = store.syncAlerts;
    this.lowMemoryMode = store.lowMemoryMode;
    this.petEnabled = store.petEnabled;
    this.petZoomPercent = store.petZoomPercent;
    this.petIdleDwellSeconds = store.petIdleDwellSeconds;
    for (const p of store.profiles) {
      this.profiles.push(p);
      this.byID.set(p.id, p);
      // Mirror shell.New: every loaded profile starts 'unknown' / 0.
      this.health.set(p.id, 'unknown');
      this.unread.set(p.id, 0);
    }
  }

  /**
   * Adds (or reuses) a profile for rawUrl and persists. Validation is the
   * endpoint.Parse-equivalent (see parseEndpoint); re-adding the exact
   * same origin returns the existing profile. Every distinct origin
   * (scheme, host and port) is addable under normal browser origin rules;
   * same-host different-port servers do not conflict. A failed write
   * rolls the in-memory change back.
   */
  add(rawUrl: string): ProfileMeta {
    const parsed = parseEndpoint(rawUrl);
    const existing =
      this.profiles.find((p) => p.origin === parsed.origin) ?? null;
    if (existing) return toMeta(existing);
    let id = idForOrigin(parsed.origin, parsed.host);
    if (this.byID.has(id)) id = `${id}-${sha256Hex(parsed.origin).slice(0, 6)}`;
    const profile: InternalProfile = {
      id,
      name: parsed.host,
      origin: parsed.origin,
      lastUsed: null,
    };
    this.profiles.push(profile);
    this.byID.set(id, profile);
    this.health.set(id, 'unknown');
    this.unread.set(id, 0);
    try {
      saveStore(
        this.persistPath,
        this.profiles,
        this.closeToTray,
        this.syncAlerts,
        this.lowMemoryMode,
        this.petEnabled,
        this.petZoomPercent,
        this.petIdleDwellSeconds,
      );
    } catch (err) {
      this.profiles.pop();
      this.byID.delete(id);
      this.health.delete(id);
      this.unread.delete(id);
      throw err;
    }
    this.emit({ kind: 'profiles-changed' });
    return toMeta(profile);
  }

  /**
   * Removes a profile (desktop metadata only — never remote Phi state).
   * Removing the active profile falls back to the most recently used
   * remaining profile ('' when none remain) — Wails shell parity. A
   * failed write rolls the removal back.
   */
  remove(id: string): void {
    const idx = this.profiles.findIndex((p) => p.id === id);
    if (idx < 0)
      throw new UnknownProfileError(`controller: unknown profile "${id}"`);
    const removed = this.profiles[idx];
    const wasActive = this.activeId === id;
    const removedHealth = this.health.get(id) ?? null;
    const removedUnread = this.unread.get(id) ?? null;
    this.profiles.splice(idx, 1);
    this.byID.delete(id);
    this.health.delete(id);
    this.unread.delete(id);
    try {
      saveStore(
        this.persistPath,
        this.profiles,
        this.closeToTray,
        this.syncAlerts,
        this.lowMemoryMode,
        this.petEnabled,
        this.petZoomPercent,
        this.petIdleDwellSeconds,
      );
    } catch (err) {
      this.profiles.splice(idx, 0, removed);
      this.byID.set(id, removed);
      if (removedHealth !== null) this.health.set(id, removedHealth);
      if (removedUnread !== null) this.unread.set(id, removedUnread);
      throw err;
    }
    if (wasActive) {
      this.activeId = mostRecentlyUsed(this.profiles);
      this.emit({ kind: 'active-changed', id: this.activeId });
    }
    this.emit({ kind: 'profiles-changed' });
  }

  /**
   * Renames a profile (desktop metadata only) and persists. Names are
   * validated with the ValidateName-equivalent rules. Wails parity: a
   * failed write is thrown without rolling the in-memory name back.
   */
  rename(id: string, name: string): void {
    const p = this.byID.get(id);
    if (!p)
      throw new UnknownProfileError(`controller: unknown profile "${id}"`);
    validateName(name);
    p.name = name;
    saveStore(
      this.persistPath,
      this.profiles,
      this.closeToTray,
      this.syncAlerts,
      this.lowMemoryMode,
      this.petEnabled,
      this.petZoomPercent,
      this.petIdleDwellSeconds,
    );
    this.emit({ kind: 'profiles-changed' });
  }

  /**
   * Moves a profile to sit immediately before `beforeId` (or to the end
   * when beforeId is null) within the persisted rail order and emits
   * profiles-changed. Unknown ids throw UnknownProfileError; a move that
   * leaves the order unchanged is a no-op. A failed write rolls the
   * in-memory move back.
   */
  reorder(id: string, beforeId: string | null): void {
    if (!this.byID.has(id))
      throw new UnknownProfileError(`controller: unknown profile "${id}"`);
    if (beforeId !== null && !this.byID.has(beforeId)) {
      throw new UnknownProfileError(
        `controller: unknown profile "${beforeId}"`,
      );
    }
    const from = this.profiles.findIndex((p) => p.id === id);
    const to =
      beforeId === null
        ? this.profiles.length
        : this.profiles.findIndex((p) => p.id === beforeId);
    // Already directly before the target, or last when moving to the end.
    if (from === to || from + 1 === to) return;
    const [moved] = this.profiles.splice(from, 1);
    const insertAt =
      beforeId === null
        ? this.profiles.length
        : this.profiles.findIndex((p) => p.id === beforeId);
    this.profiles.splice(insertAt, 0, moved);
    try {
      saveStore(
        this.persistPath,
        this.profiles,
        this.closeToTray,
        this.syncAlerts,
        this.lowMemoryMode,
        this.petEnabled,
        this.petZoomPercent,
        this.petIdleDwellSeconds,
      );
    } catch (err) {
      this.profiles.splice(insertAt, 1);
      this.profiles.splice(from, 0, moved);
      throw err;
    }
    this.emit({ kind: 'profiles-changed' });
  }

  /** Stamps the profile's last-used timestamp and persists. */
  setLastUsed(id: string): void {
    const p = this.byID.get(id);
    if (!p)
      throw new UnknownProfileError(`controller: unknown profile "${id}"`);
    p.lastUsed = new Date().toISOString();
    saveStore(
      this.persistPath,
      this.profiles,
      this.closeToTray,
      this.syncAlerts,
      this.lowMemoryMode,
      this.petEnabled,
      this.petZoomPercent,
      this.petIdleDwellSeconds,
    );
    this.emit({ kind: 'profiles-changed' });
  }

  /**
   * Activates a profile by id: stamps last-used (a failed stamp persist
   * is logged and the activation continues — Wails parity), sets the
   * active id and emits `{kind:'active-changed', id}` — the host loop's
   * tray picks it up via subscribe.
   */
  setActive(id: string): void {
    const p = this.byID.get(id);
    if (!p)
      throw new UnknownProfileError(`controller: unknown profile "${id}"`);
    p.lastUsed = new Date().toISOString();
    try {
      saveStore(
        this.persistPath,
        this.profiles,
        this.closeToTray,
        this.syncAlerts,
        this.lowMemoryMode,
        this.petEnabled,
        this.petZoomPercent,
        this.petIdleDwellSeconds,
      );
    } catch (err) {
      this.log(`controller: record last-used: ${String(err)}`);
    }
    this.activeId = id;
    this.emit({ kind: 'active-changed', id });
  }

  /**
   * The most recently used profile, or null when the store is empty —
   * the step-6 startup-restore input (Wails MRU parity): the host loop
   * activates this profile when none is active yet, which creates and
   * loads its retained view immediately.
   */
  mostRecent(): ProfileMeta | null {
    const id = mostRecentlyUsed(this.profiles);
    if (id === '') return null;
    const p = this.byID.get(id);
    return p ? toMeta(p) : null;
  }

  /**
   * The persisted close-to-tray preference (default true): whether the
   * main-window close button hides the window to the tray instead of
   * quitting.
   */
  getCloseToTray(): boolean {
    return this.closeToTray;
  }

  /**
   * Persists the close-to-tray preference and emits
   * `{kind:'close-to-tray-changed'}` (the host loop's tray menu rebuild
   * hook refreshes the checkbox state). A no-op when the value is
   * unchanged.
   */
  setCloseToTray(value: boolean): void {
    if (value === this.closeToTray) return;
    this.closeToTray = value;
    saveStore(
      this.persistPath,
      this.profiles,
      this.closeToTray,
      this.syncAlerts,
      this.lowMemoryMode,
      this.petEnabled,
      this.petZoomPercent,
      this.petIdleDwellSeconds,
    );
    this.emit({ kind: 'close-to-tray-changed' });
  }

  /**
   * The persisted sync-board desktop-alert preference (default true):
   * whether PHI_NOTIF / PHI_ALARM Sync Board markers surface as desktop
   * notifications.
   */
  getSyncAlerts(): boolean {
    return this.syncAlerts;
  }

  /**
   * Persists the sync-alert preference and emits
   * `{kind:'sync-alerts-changed'}` (the host loop's tray menu rebuild
   * hook refreshes the checkbox state). A no-op when the value is
   * unchanged.
   */
  setSyncAlerts(value: boolean): void {
    if (value === this.syncAlerts) return;
    this.syncAlerts = value;
    saveStore(
      this.persistPath,
      this.profiles,
      this.closeToTray,
      this.syncAlerts,
      this.lowMemoryMode,
      this.petEnabled,
      this.petZoomPercent,
      this.petIdleDwellSeconds,
    );
    this.emit({ kind: 'sync-alerts-changed' });
  }

  getLowMemoryMode(): boolean {
    return this.lowMemoryMode;
  }

  setLowMemoryMode(value: boolean): void {
    if (value === this.lowMemoryMode) return;
    this.lowMemoryMode = value;
    saveStore(
      this.persistPath,
      this.profiles,
      this.closeToTray,
      this.syncAlerts,
      this.lowMemoryMode,
      this.petEnabled,
      this.petZoomPercent,
      this.petIdleDwellSeconds,
    );
    this.emit({ kind: 'low-memory-changed' });
  }

  /**
   * The persisted desktop-pet preference (default false): whether the
   * optional pet overlay window is shown.
   */
  getPetEnabled(): boolean {
    return this.petEnabled;
  }

  /**
   * Persists the desktop-pet preference and emits
   * `{kind:'pet-enabled-changed'}` (the host loop rebuilds the tray
   * checkbox and mirrors the window state). A no-op when unchanged.
   */
  setPetEnabled(value: boolean): void {
    if (value === this.petEnabled) return;
    this.petEnabled = value;
    saveStore(
      this.persistPath,
      this.profiles,
      this.closeToTray,
      this.syncAlerts,
      this.lowMemoryMode,
      this.petEnabled,
      this.petZoomPercent,
      this.petIdleDwellSeconds,
    );
    this.emit({ kind: 'pet-enabled-changed' });
  }

  /** The canonical persisted desktop-pet zoom percentage. */
  getPetZoomPercent(): number {
    return this.petZoomPercent;
  }

  /**
   * Persists the desktop-pet zoom percentage. Invalid values are rejected
   * without mutation; persistence failures restore the prior percentage and
   * rethrow.
   */
  setPetZoomPercent(percent: number): boolean {
    if (!isPetZoomPercent(percent)) return false;
    if (percent === this.petZoomPercent) return true;
    const oldPercent = this.petZoomPercent;
    this.petZoomPercent = percent;
    try {
      saveStore(
        this.persistPath,
        this.profiles,
        this.closeToTray,
        this.syncAlerts,
        this.lowMemoryMode,
        this.petEnabled,
        this.petZoomPercent,
        this.petIdleDwellSeconds,
      );
    } catch (err) {
      this.petZoomPercent = oldPercent;
      throw err;
    }
    this.emit({ kind: 'pet-zoom-changed' });
    return true;
  }

  getPetIdleDwellSeconds(): number {
    return this.petIdleDwellSeconds;
  }

  setPetIdleDwellSeconds(value: number): boolean {
    if (!isPetIdleDwellSeconds(value)) return false;
    if (value === this.petIdleDwellSeconds) return true;
    const oldValue = this.petIdleDwellSeconds;
    this.petIdleDwellSeconds = value;
    try {
      saveStore(
        this.persistPath,
        this.profiles,
        this.closeToTray,
        this.syncAlerts,
        this.lowMemoryMode,
        this.petEnabled,
        this.petZoomPercent,
        this.petIdleDwellSeconds,
      );
    } catch (err) {
      this.petIdleDwellSeconds = oldValue;
      throw err;
    }
    this.emit({ kind: 'pet-idle-dwell-changed', dwellSeconds: value });
    return true;
  }

  /**
   * Sets a profile's unread count (clamped at 0) and emits
   * `{kind:'unread-changed', id, n}`. The active profile's unread shows
   * in the tray tooltip suffix through the receiver wiring.
   */
  setUnread(id: string, n: number): void {
    const clamped = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    this.unread.set(id, clamped);
    this.emit({ kind: 'unread-changed', id, n: clamped });
  }

  /**
   * The health slice: probes every profile once via checker (default: the
   * slice's placeholder, which reports unknown for every origin — no real
   * HTTP anywhere in this slice; the real liveness checker lands in step
   * 8), applies the statuses and emits `{kind:'health-changed'}`.
   */
  async updateHealth(checker?: HealthChecker): Promise<void> {
    const check = checker ?? unknownHealthChecker;
    const targets = this.profiles.map((p) => ({ id: p.id, origin: p.origin }));
    const results = await Promise.all(
      targets.map(async (t) => ({
        id: t.id,
        status: await check.check(t.origin),
      })),
    );
    for (const r of results) {
      const status: HealthStatus =
        r.status === 'up' || r.status === 'down' ? r.status : 'unknown';
      this.health.set(r.id, status);
    }
    this.emit({ kind: 'health-changed' });
  }

  /** Returns a deep-copy snapshot of the controller state. */
  state(): ControllerState {
    return {
      profiles: this.profiles.map(toMeta),
      activeId: this.activeId,
      health: new Map(this.health),
      unread: new Map(this.unread),
      closeToTray: this.closeToTray,
      syncAlerts: this.syncAlerts,
      lowMemoryMode: this.lowMemoryMode,
      petEnabled: this.petEnabled,
      petZoomPercent: this.petZoomPercent,
      petIdleDwellSeconds: this.petIdleDwellSeconds,
    };
  }

  /**
   * Subscribes to controller events (notify-on-mutation, fire-and-forget:
   * a throwing subscriber is logged and never breaks the mutation).
   * Returns an unsubscribe function (no teardown required by tests).
   */
  subscribe(fn: ControllerListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(event: ControllerEvent): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(event);
      } catch (err) {
        this.log(`controller: subscriber error: ${String(err)}`);
      }
    }
  }
}
