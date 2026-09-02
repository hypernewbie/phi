/* Φ phi — pure, framework-free helpers (unit-tested in test-js/) */

// A Vikunja kanban bucket shape. The runtime narrows `is_done` with
// `bucket.is_done === true` rather than a truthy check, so the field
// can be unknown (string, number, bool at the wire). We type it as
// `unknown` to mirror that defensive behaviour.
export interface VikunjaBucketLike {
    title: string;
    is_done?: unknown;
}

// projectWorktreeLabel renders a short "project/worktree" label from a cwd.
// Pure: no DOM, no `this`. Handles mixed \ and / separators, drops empty
// segments, and falls back to the em-dash sentinel for empty input.
export function projectWorktreeLabel(cwd: string | null | undefined): string {
    if (!cwd) return '—';
    const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length === 0) return '—';
    if (parts.length >= 2) {
        return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    }
    return parts[parts.length - 1] || '—';
}

// WORKTREE_GLYPHS is the pool of glyphs worktreeGlyph() picks from.
// 96 real Egyptian Hieroglyphs from the Unicode block U+13000-U+1342F,
// sampled evenly across the block for category variety and width-filtered
// for legibility. Same cwd always gets the same glyph (FNV-1a hash mod
// pool length); users build a mental map of hieroglyph <-> worktree
// after seeing a few of them. Collision rate at typical workloads
// (4-10 worktrees): <5%, vs the old 12-entry geometric pool where it
// was ~30%+.
export const WORKTREE_GLYPHS: readonly string[] = [
    '𓀀',
    '𓀊',
    '𓀔',
    '𓀞',
    '𓀨',
    '𓀲',
    '𓀼',
    '𓁇',
    '𓁑',
    '𓁛',
    '𓁥',
    '𓁯',
    '𓁹',
    '𓂃',
    '𓂎',
    '𓂘',
    '𓂢',
    '𓂬',
    '𓂹',
    '𓃃',
    '𓃏',
    '𓃙',
    '𓃣',
    '𓃭',
    '𓃷',
    '𓄁',
    '𓄋',
    '𓄕',
    '𓄡',
    '𓄫',
    '𓄵',
    '𓅀',
    '𓅊',
    '𓅖',
    '𓅠',
    '𓅫',
    '𓅵',
    '𓆀',
    '𓆋',
    '𓆕',
    '𓆟',
    '𓆩',
    '𓆵',
    '𓇃',
    '𓇏',
    '𓇚',
    '𓇫',
    '𓇵',
    '𓈀',
    '𓈊',
    '𓈕',
    '𓈟',
    '𓈩',
    '𓈳',
    '𓈽',
    '𓉇',
    '𓉑',
    '𓉛',
    '𓉦',
    '𓉰',
    '𓉿',
    '𓊉',
    '𓊓',
    '𓊝',
    '𓊪',
    '𓊴',
    '𓊾',
    '𓋉',
    '𓋓',
    '𓋝',
    '𓋧',
    '𓋱',
    '𓋼',
    '𓌍',
    '𓌛',
    '𓌪',
    '𓌶',
    '𓍀',
    '𓍎',
    '𓍞',
    '𓍬',
    '𓍶',
    '𓎀',
    '𓎏',
    '𓎞',
    '𓎨',
    '𓎳',
    '𓎽',
    '𓏈',
    '𓏔',
    '𓏟',
    '𓏱',
    '𓏾',
    '𓐌',
    '𓐖',
    '𓐠',
];

// worktreeGlyph returns one of WORKTREE_GLYPHS deterministically from
// cwd. FNV-1a 32-bit hash, mod pool length. Pure, no DOM. Same cwd
// always returns the same glyph; different cwds usually return
// different glyphs.
export function worktreeGlyph(cwd: string | null | undefined): string {
    if (!cwd) return '◆'; // fallback for falsy cwd (em-dash never reached here)
    let h = 2166136261;
    for (let i = 0; i < cwd.length; i++) {
        h ^= cwd.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return WORKTREE_GLYPHS[h % WORKTREE_GLYPHS.length];
}

// relativeToCwd converts a file path to one relative to cwd (both with \
// normalized to /). Pure. NOTE: two long-standing quirks are preserved by
// design — do NOT "fix" them here without a dedicated test + commit:
//   1. Case-sensitive prefix match (unlike normalizePath, which lowercases).
//   2. Naive startsWith: cwd '/foo' also matches path '/foobar' -> 'bar'.
// Also mirrors the original: a nullish `path` throws (no defensive guard).
export function relativeToCwd(path: string, cwd: string): string {
    const cleanPath = path.replace(/\\/g, '/');
    const cleanCwd = (cwd || '').replace(/\\/g, '/');
    let relPath = cleanPath;
    if (cleanCwd && cleanPath.startsWith(cleanCwd)) {
        relPath = cleanPath.slice(cleanCwd.length);
        if (relPath.startsWith('/')) {
            relPath = relPath.slice(1);
        }
    }
    return relPath;
}

// escapeHtml escapes the five HTML-sensitive characters (attribute-safe) and
// returns '' for falsy input. Shared by kanban + sync, whose impls were
// byte-identical.
export function escapeHtml(str: string | null | undefined): string {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// PriorityMeta is the badge shape returned by priorityMeta.
export interface PriorityMeta {
    label: string;
    className: string;
}

// priorityMeta maps a Vikunja priority to its badge {label, className}. Pure.
// Priorities 1..5 -> Low/Medium/High/Urgent/DOOM; anything else falls back to
// the 'P0' label. className always uses the raw priority value (e.g.
// 'priority-6' for 6), matching the original renderCard behavior.
export function priorityMeta(priority: number): PriorityMeta {
    const className = `priority-${priority}`;
    let label = 'P0';
    if (priority === 1) label = 'Low';
    else if (priority === 2) label = 'Medium';
    else if (priority === 3) label = 'High';
    else if (priority === 4) label = 'Urgent';
    else if (priority === 5) label = 'DOOM';
    return { label, className };
}

// isDoneBucket reports whether a Vikunja bucket represents "done". Pure and
// null-safe: returns false for a nullish bucket WITHOUT touching .title (the
// `bucket &&` short-circuit is load-bearing). Uses strict is_done === true.
export function isDoneBucket(
    bucket: VikunjaBucketLike | null | undefined,
): boolean {
    return !!(
        bucket &&
        (bucket.is_done === true || bucket.title.toLowerCase() === 'done')
    );
}

// safeHexColor validates a 3/6-character hex color string from an external
// source (Vikunja label.hex_color). Returns the cleaned color (no leading #)
// if it matches /^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/, else an empty string so
// callers can skip the inline-style attribute entirely. Pure.
//
// `unknown` here because the original does `typeof c !== 'string'` early-out:
// the wire value may be a number / null / undefined and the call must still
// return '' rather than throw.
export function safeHexColor(c: unknown): string {
    if (typeof c !== 'string') return '';
    if (!/^([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c)) return '';
    return c;
}

// extractVikunjaError turns a Vikunja error response body into a readable
// one-liner for the user. Vikunja returns shapes like:
//   { "message": "method not allowed error" }           // single error
//   { "message": "...", "code": 7 }                     // with code
//   { "code": 4, "message": "..." }                     // same, reordered
//   { "messages": { "field": ["msg1", "msg2"] } }       // per-field map
// Falls back to the raw text (truncated) if none parse. Pure.
export function extractVikunjaError(
    text: string | null | undefined,
    status: number,
): string {
    if (!text) return `Request failed with status ${status}`;
    let s = text;
    try {
        const obj = JSON.parse(text);
        if (obj && typeof obj === 'object') {
            if (typeof obj.message === 'string' && obj.message) {
                s = obj.message;
            } else if (obj.messages && typeof obj.messages === 'object') {
                const parts: string[] = [];
                for (const [field, val] of Object.entries(obj.messages)) {
                    if (Array.isArray(val))
                        parts.push(`${field}: ${val.join(', ')}`);
                    else if (typeof val === 'string')
                        parts.push(`${field}: ${val}`);
                }
                if (parts.length) s = parts.join('; ');
            }
        }
    } catch (_) {
        // Not JSON — keep the raw text, but trim obvious HTML pages.
        s = s
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }
    if (s.length > 240) s = `${s.slice(0, 240)}...`;
    return s || `Request failed with status ${status}`;
}

// toVikunjaId coerces a Vikunja resource id into a positive integer, or null
// when it is absent or unparseable. Guards the case that produces Vikunja's
// opaque 400 "Invalid model provided.": parseInt(null, 10) is NaN, which
// interpolates into a request path as the literal text "NaN". Pure.
export function toVikunjaId(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const n = typeof value === 'number' ? value : parseInt(String(value), 10);
    if (!Number.isInteger(n) || n <= 0) return null;
    return n;
}

// getLastFolderName returns the final path segment (splitting on / and \).
// Pure. QUIRK preserved: a trailing separator yields an empty last segment,
// so it falls back to returning the FULL original path.
export function getLastFolderName(path: string): string {
    if (!path) return '';
    const parts = path.split(/[/\\]/);
    return parts[parts.length - 1] || path;
}

// formatWorkspaceLabel renders a workspace's display label: normally the last
// folder name, but disambiguated as "folder (parent)" when another workspace
// in allWorkspaces shares the same last-folder name. Pure.
export function formatWorkspaceLabel(
    ws: string,
    allWorkspaces?: readonly string[] | null,
): string {
    if (!ws) return '';
    const folderName = getLastFolderName(ws);
    if (!allWorkspaces || !Array.isArray(allWorkspaces)) return folderName;
    const duplicates = allWorkspaces.filter(
        (w) => getLastFolderName(w) === folderName,
    );
    if (duplicates.length > 1) {
        const parts = ws.split(/[/\\]/);
        if (parts.length >= 2) {
            const parent = parts[parts.length - 2];
            return `${folderName} (${parent})`;
        }
    }
    return folderName;
}

// cpuLevel maps a CPU utilization percentage to a brand-logo indicator class.
// Pure. Thresholds: >90 critical, >70 high, >30 moderate, else idle.
export function cpuLevel(cpuPercent: number): string {
    if (cpuPercent > 90) return 'cpu-critical';
    if (cpuPercent > 70) return 'cpu-high';
    if (cpuPercent > 30) return 'cpu-moderate';
    return 'cpu-idle';
}

// TerminalActivityTabLike is deliberately narrow: terminal.js has a large,
// dynamic TabInfo object, but title/status rendering needs only these three
// facts. Keeping the boundary tiny lets the presentation grammar stay pure.
export interface TerminalActivityTabLike {
    isDead?: boolean;
    isBusy?: boolean;
    isAttention?: boolean;
    coder?: string;
    isBtop?: boolean;
}

export interface TerminalActivityState {
    hasActivity: boolean;
    hasAttention: boolean;
}

// isTerminalActivityEligible returns false for shell/btop tabs whose PTY
// output is user-driven or constant (btop redraws forever). Only coding-agent
// tabs (pi, claude, agy, opencode) should drive the global "working" signal.
// UI-only tabs (review, kanban) are not PTY-backed and never carry isBusy.
function isTerminalActivityEligible(tab: TerminalActivityTabLike): boolean {
    if (tab.isBtop) return false;
    const coder = tab.coder;
    if (coder === 'bash' || coder === 'pwsh') return false;
    if (coder === 'review' || coder === 'kanban') return false;
    return true;
}

// getTerminalActivityState reduces an iterable of terminal tabs into the two
// independent signals used by the browser chrome. "Activity" means a live PTY
// emitted output recently; a dead tab cannot keep the live marker awake, and
// shell/btop tabs are excluded so a running btop or an interactive shell
// cannot pin the global "working" indicator on. "Attention" deliberately
// survives a dead tab, matching the existing completion-notification
// contract until the user clears it.
export function getTerminalActivityState(
    tabs: Iterable<TerminalActivityTabLike | null | undefined>,
): TerminalActivityState {
    let hasActivity = false;
    let hasAttention = false;
    for (const tab of tabs) {
        if (!tab) continue;
        if (tab.isAttention) hasAttention = true;
        if (!tab.isDead && tab.isBusy && isTerminalActivityEligible(tab))
            hasActivity = true;
        if (hasActivity && hasAttention) break;
    }
    return { hasActivity, hasAttention };
}

// phiActivityGlyph is the compact visual language shared by the browser title
// and favicon. Capital Phi is the settled mark; curly Phi means terminal output
// is flowing. The existing leading ● remains reserved for done/attention.
export function phiActivityGlyph(hasActivity: boolean): string {
    return hasActivity ? 'ϕ' : 'Φ';
}

// formatTerminalActivityTitle composes the browser title without mutating
// prior title text. This makes the two states composable:
//   Φ host   quiet        ϕ host   output now
//   ● Φ host attention    ● ϕ host attention + output elsewhere
// displayHostname trims the mDNS/Bonjour suffix macOS appends to the system
// hostname, so `studio.local` shows as `studio`. Purely cosmetic: phi labels a
// single machine, so the suffix is noise in every surface that shows it. The
// raw value is left untouched everywhere it actually identifies the host.
//
// Also handles the fully-qualified trailing dot (`studio.local.`), and refuses
// to strip itself down to nothing if the hostname is literally `.local`.
export function displayHostname(hostname: string | null | undefined): string {
    const raw = (hostname ?? '').toString().trim();
    if (!raw) return '';
    const trimmed = raw.replace(/\.local\.?$/i, '');
    return trimmed || raw;
}

export function formatTerminalActivityTitle(
    hostname: string | null | undefined,
    state: TerminalActivityState,
): string {
    const host = displayHostname(hostname) || 'phi';
    const attention = state.hasAttention ? '● ' : '';
    return `${attention}${phiActivityGlyph(state.hasActivity)} ${host}`;
}

// buildPhiFaviconSvg produces the dynamic data-URI payload used by App.
// The favicon follows the title's Φ ↔ ϕ state but stays static between real
// quiet/output transitions; browser tabs should not become a spinner.
export function buildPhiFaviconSvg(
    accent: string,
    accentDim: string,
    hasActivity: boolean,
): string {
    const glyph = phiActivityGlyph(hasActivity);
    return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <defs>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${accent}" />
      <stop offset="100%" stop-color="${accentDim}" />
    </radialGradient>
  </defs>
  <rect width="32" height="32" rx="8" fill="url(#glow)"/>
  <text x="50%" y="60%" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="bold" fill="#ffffff" text-anchor="middle">${glyph}</text>
</svg>
    `.trim();
}

// buildProxyUrl composes the local /api/proxy URL for a sync-coordinator
// request: strips one trailing slash off the coordinator base, appends the
// endpoint, and URL-encodes the result as the ?url= param. Pure.
export function buildProxyUrl(coordinator: string, endpoint: string): string {
    const targetUrl = coordinator.replace(/\/$/, '') + endpoint;
    return `/api/proxy?url=${encodeURIComponent(targetUrl)}`;
}

// SelfHud is the data the brand-logo hover popover renders. All fields
// are computed from local state — no fetch is made to populate it. See
// buildSelfHud() for the assembler.
export interface SelfHud {
    hostname: string;
    version: string;
    sessions: number;
    busy: number;
    attention: number;
    cpuPercent: number | null; // null = unknown / not yet sampled
    lastActivityMin: number | null; // minutes since most recent tab output, null if no tabs ever emitted
}

// buildSelfHud assembles the hover-popover payload from a tab map and a
// few preloaded app fields. Pure — no DOM, no fetch — so the unit test
// surface is small and the same logic powers future variants (sidebar
// stat tile, status bar, etc.) without re-deriving from a TabManager.
//
// TabLike is intentionally narrow: anything with the four status fields
// we care about, so tests can pass plain objects.
export interface TabLikeForHud {
    isDead?: boolean;
    isBusy?: boolean;
    isAttention?: boolean;
    lastOutputAt?: number;
}

// formatDurationMin renders a duration in the largest sensible unit.
// "4m" / "23s" / "—" — null → em-dash (nothing to show). Exported: the
// tab hover card's busy/idle status line uses it too.
export function formatDurationMin(ms: number | null): string {
    if (ms == null) return '—';
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h`;
    return `${Math.floor(hr / 24)}d`;
}

export function buildSelfHud(args: {
    hostname: string;
    version: string;
    cpuPercent: number | null;
    tabs: Iterable<TabLikeForHud | null | undefined>;
    now?: number; // overridable for tests
}): SelfHud {
    const now = args.now ?? Date.now();
    let sessions = 0;
    let busy = 0;
    let attention = 0;
    let mostRecentOutputMs: number | null = null;
    for (const t of args.tabs) {
        if (!t || t.isDead) continue;
        sessions += 1;
        if (t.isBusy) busy += 1;
        if (t.isAttention) attention += 1;
        if (typeof t.lastOutputAt === 'number') {
            const age = now - t.lastOutputAt;
            if (
                age >= 0 &&
                (mostRecentOutputMs === null || age < mostRecentOutputMs)
            ) {
                mostRecentOutputMs = age;
            }
        }
    }
    return {
        hostname: displayHostname(args.hostname) || 'phi',
        version: args.version || '',
        sessions,
        busy,
        attention,
        cpuPercent: args.cpuPercent,
        lastActivityMin: mostRecentOutputMs,
    };
}

// formatHudLine composes the "Xm ago" / "now" footer string. Pure.
export function formatHudLine(hud: SelfHud): string {
    if (hud.lastActivityMin == null) return 'no recent activity';
    return `last activity ${formatDurationMin(hud.lastActivityMin)} ago`;
}

// formatHudCpu returns "cpu 23%" or "cpu —" if unknown. Pure.
export function formatHudCpu(hud: SelfHud): string {
    if (hud.cpuPercent == null) return 'cpu —';
    return `cpu ${Math.round(hud.cpuPercent)}%`;
}
